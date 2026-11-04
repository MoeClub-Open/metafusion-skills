"""Independent HTTP fixture checks; no remote instance or credentials needed."""
import contextlib
import importlib.util
import io
import json
import os
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from uuid import UUID

spec = importlib.util.spec_from_file_location('relationship_cli', Path(__file__).with_name('query_relationships.py'))
cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cli)
IDS = [str(UUID(int=i)) for i in range(1, 9)]
EXPRESSION, TRACK1, TRACK2, MEDIUM1, MEDIUM2, RELEASE1, RELEASE2, UNAVAILABLE = IDS
ENTITIES = {
    id: {'id': id, 'kind': kind, 'version': 1, 'title': title,
         'original_language': 'zh-CN', 'translations': {}}
    for id, kind, title in zip(IDS[:7],
        ['expression', 'track', 'track', 'medium', 'medium', 'release', 'release'],
        ['同一录音', '曲目甲', '曲目乙', '普通版 CD', '限定版 BD', '普通版', '限定版'])
}
EDGES = [
    {'source_id': source, 'target_id': target, 'rule_code': code, 'class': 'inclusion' if code == 'structure:track_content' else 'ownership', 'key': f'fixture-{i}',
     'position': i, 'locator': {}, 'attributes': {}}
    for i, (source, target, code) in enumerate([
        (TRACK1, EXPRESSION, 'structure:track_content'),
        (TRACK2, EXPRESSION, 'structure:track_content'),
        (MEDIUM1, TRACK1, 'structure:medium_track'),
        (MEDIUM2, TRACK2, 'structure:medium_track'),
        (RELEASE1, MEDIUM1, 'structure:release_medium'),
        (RELEASE2, MEDIUM2, 'structure:release_medium'),
    ], 1)
]


class FixtureHandler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        self.respond(None)

    def do_POST(self):
        self.respond(json.loads(self.rfile.read(int(self.headers['Content-Length']))))

    def respond(self, payload):
        fixture = self.server.fixture
        fixture.requests.append((self.path, payload, self.headers.get('Authorization')))
        if fixture.mode == 'redirect':
            self.send_response(302)
            self.send_header('Location', fixture.destination + '/other-origin')
            self.end_headers()
            return
        if isinstance(fixture.mode, int):
            self.send_response(fixture.mode)
            self.send_header('Retry-After', fixture.retry_after)
            self.end_headers()
            self.wfile.write(json.dumps({'error': fixture.secret}).encode())
            return
        if fixture.mode == 'invalid-json':
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'not json')
            return
        if payload is None:
            result = {'etag': 'fixture-etag', 'relationship_rules': [
                {'code': code, 'read_only': True, 'enabled': True}
                for code in sorted({edge['rule_code'] for edge in EDGES})]}
        else:
            result = {'definition_etag': 'fixture-etag', 'pages': [], 'entities': {}, 'unavailable_ids': []}
            for subject in payload['ids']:
                if subject not in ENTITIES:
                    result['unavailable_ids'].append(subject)
                    continue
                result['entities'][subject] = ENTITIES[subject]
                found = []
                for edge in EDGES:
                    if subject not in (edge['source_id'], edge['target_id']):
                        continue
                    direction = 'outgoing' if edge['source_id'] == subject else 'incoming'
                    peer = edge['target_id'] if direction == 'outgoing' else edge['source_id']
                    if payload['direction'] not in ('both', direction):
                        continue
                    if payload.get('classes') and edge['class'] not in payload['classes']:
                        continue
                    if payload.get('peer_kinds') and ENTITIES[peer]['kind'] not in payload['peer_kinds']:
                        continue
                    if payload.get('rule_codes') and edge['rule_code'] not in payload['rule_codes']:
                        continue
                    found.append(dict(edge, direction=direction))
                offset, limit = payload['offset'], payload['limit']
                items = found[offset:offset + limit]
                for edge in items:
                    for endpoint in (edge['source_id'], edge['target_id']):
                        result['entities'][endpoint] = ENTITIES[endpoint]
                result['pages'].append({'subject_id': subject, 'items': items,
                    'limit': limit, 'offset': offset, 'has_more': offset + limit < len(found)})
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(result, ensure_ascii=False).encode('utf-8'))


class RelationshipQueryHTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mode = 'normal'
        cls.requests = []
        # A syntactically plausible machine error code must still never echo a token.
        cls.secret = 'mfp_' + 'a' * 32
        cls.retry_after = '3'
        cls.destination_requests = []
        class Destination(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass
            def do_GET(self):
                cls.destination_requests.append(self.headers.get('Authorization'))
                self.send_response(200)
                self.end_headers()
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), FixtureHandler)
        cls.server.fixture = cls
        cls.other = ThreadingHTTPServer(('127.0.0.1', 0), Destination)
        cls.base = f'http://127.0.0.1:{cls.server.server_port}'
        cls.destination = f'http://127.0.0.1:{cls.other.server_port}'
        for server in (cls.server, cls.other):
            threading.Thread(target=server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        for server in (cls.server, cls.other):
            server.shutdown()
            server.server_close()

    def setUp(self):
        type(self).mode = 'normal'
        type(self).retry_after = '3'
        self.requests.clear()
        self.destination_requests.clear()

    def invoke(self, *args, token=''):
        out, err = io.StringIO(), io.StringIO()
        with patch.dict(os.environ, {'MF_API_TOKEN': token}), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            result = cli.main(['--base-url', self.base, *args])
        return result, out.getvalue(), err.getvalue()

    def test_paginated_expression_track_medium_release_traversal(self):
        pending, visited, collected, pages = [(EXPRESSION, 'track')], set(), [], 0
        while pending:
            subject, kind = pending.pop(0)
            if (subject, kind) in visited:
                continue
            visited.add((subject, kind))
            offset = 0
            while True:
                status, out, err = self.invoke('--id', subject, '--direction', 'incoming', '--peer-kind', kind,
                                               '--limit', '1', '--offset', str(offset))
                self.assertEqual(status, 0, err)
                result = json.loads(out)
                page = result['pages'][0]
                pages += 1
                self.assertLessEqual(pages, 20)
                for edge in page['items']:
                    self.assertEqual(edge['target_id'], subject)
                    self.assertEqual(edge['direction'], 'incoming')
                    self.assertIn('rule_code', edge)
                    self.assertIn(edge['class'], ('ownership', 'inclusion'))
                    self.assertNotIn('code', edge)
                    collected.append(edge)
                    if kind in ('track', 'medium'):
                        pending.append((edge['source_id'], 'medium' if kind == 'track' else 'release'))
                if not page['has_more']:
                    break
                offset += page['limit']
        self.assertEqual(pages, 6)
        self.assertEqual({e['source_id'] for e in collected if e['rule_code'] == 'structure:release_medium'}, {RELEASE1, RELEASE2})
        self.assertTrue(all(auth is None for _, _, auth in self.requests))

    def test_batch_filter_payload_and_outgoing_direction(self):
        status, out, err = self.invoke('--id', RELEASE1, '--id', RELEASE1,
            '--direction', 'outgoing', '--class', 'ownership', '--class', 'ownership',
            '--rule-code', 'structure:release_medium',
            '--rule-code', 'structure:release_medium', '--peer-kind', 'medium', '--peer-kind', 'medium')
        self.assertEqual(status, 0, err)
        payload = self.requests[-1][1]
        self.assertEqual(payload['ids'], [RELEASE1])
        self.assertEqual(payload['classes'], ['ownership'])
        self.assertEqual(payload['rule_codes'], ['structure:release_medium'])
        self.assertEqual(payload['peer_kinds'], ['medium'])
        edge = json.loads(out)['pages'][0]['items'][0]
        self.assertEqual(edge['direction'], 'outgoing')
        self.assertEqual(edge['source_id'], RELEASE1)
        self.assertEqual(edge['target_id'], MEDIUM1)
        status, out, err = self.invoke('--id', EXPRESSION, '--class', 'ownership')
        self.assertEqual(status, 0, err)
        self.assertEqual(json.loads(out)['pages'][0]['items'], [])

    def test_rules_unavailable_and_unicode(self):
        status, out, err = self.invoke('--rules')
        self.assertEqual(status, 0, err)
        self.assertEqual(len(json.loads(out)['relationship_rules']), 3)
        status, out, err = self.invoke('--id', UNAVAILABLE, '--id', EXPRESSION)
        self.assertEqual(status, 0, err)
        result = json.loads(out)
        self.assertEqual(result['unavailable_ids'], [UNAVAILABLE])
        self.assertNotIn(UNAVAILABLE, result['entities'])
        self.assertIn('同一录音', out)
        self.assertEqual(out.encode('utf-8').decode('utf-8'), out)

    def test_http_failures_and_bounded_429_without_secret_echo(self):
        for code in (400, 401, 403, 404, 429, 500):
            with self.subTest(code=code):
                type(self).mode = code
                before = len(self.requests)
                status, out, err = self.invoke('--id', EXPRESSION, token=self.secret)
                self.assertEqual(status, 1)
                self.assertIn(f'HTTP {code}', err)
                self.assertNotIn(self.secret, out + err)
                self.assertEqual(len(self.requests), before + 1)
                self.assertEqual(self.requests[-1][2], 'Bearer ' + self.secret)
                if code == 429:
                    self.assertIn('Retry-After=3', err)
        type(self).retry_after = self.secret
        _, out, err = self.invoke('--id', EXPRESSION, token=self.secret)
        self.assertNotIn(self.secret, out + err)
        type(self).mode = 429
        type(self).retry_after = '123456'
        status, out, err = self.invoke('--id', EXPRESSION, token='123456')
        self.assertEqual(status, 1)
        self.assertNotIn('123456', out + err)

    def test_cross_origin_redirect_never_receives_authorization(self):
        type(self).mode = 'redirect'
        status, out, err = self.invoke('--rules', token=self.secret)
        self.assertEqual(status, 1)
        self.assertIn('HTTP 302', err)
        self.assertEqual(self.destination_requests, [])
        self.assertNotIn(self.secret, out + err)

    def test_invalid_json_is_incomplete_not_empty(self):
        type(self).mode = 'invalid-json'
        status, out, err = self.invoke('--rules')
        self.assertEqual(status, 1)
        self.assertEqual(out, '')
        self.assertIn('Invalid JSON response', err)

    def test_deep_relationship_page_is_sent_to_the_api(self):
        status, out, err = self.invoke('--id', EXPRESSION, '--offset', '10001')
        self.assertEqual(status, 0, err)
        self.assertEqual(self.requests[-1][1]['offset'], 10001)
        page = json.loads(out)['pages'][0]
        self.assertEqual(page['offset'], 10001)
        self.assertEqual(page['items'], [])
        self.assertFalse(page['has_more'])

    def test_invalid_cli_parameters_make_no_http_requests(self):
        for args in (('--id', 'bad'), ('--id', EXPRESSION, '--limit', '101'),
                     ('--id', EXPRESSION, '--offset', '-1'), ('--rules', '--id', EXPRESSION),
                     ('--id', EXPRESSION, '--class', 'unknown'), ('--rules', '--class', 'semantic')):
            with self.subTest(args=args), contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as failure:
                    self.invoke(*args)
                self.assertEqual(failure.exception.code, 2)
        self.assertEqual(self.requests, [])


if __name__ == '__main__':
    unittest.main()
