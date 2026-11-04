#!/usr/bin/env python3
"""Read-only MetaFusion relationship queries. Requires Python 3, no packages."""
import argparse
import json
import os
import re
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
from uuid import UUID

KINDS = ('agent', 'collection', 'work', 'content_unit', 'expression', 'release', 'medium', 'track')
CLASSES = ('ownership', 'placement', 'inclusion', 'semantic', 'reference')


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def unique(values):
    return list(dict.fromkeys(values))


def request(base, path, payload, timeout):
    headers = {'Accept': 'application/json', 'User-Agent': 'MetaFusion-Relationship-Query/1.0'}
    token = os.environ.get('MF_API_TOKEN', '').strip()
    if token:
        headers['Authorization'] = 'Bearer ' + token
    data = None
    if payload is not None:
        headers['Content-Type'] = 'application/json'
        data = json.dumps(payload, ensure_ascii=False).encode('utf-8')
    req = Request(base.rstrip('/') + path, data=data, headers=headers, method='POST' if data is not None else 'GET')
    try:
        with build_opener(NoRedirect()).open(req, timeout=timeout) as response:
            return json.load(response)
    except HTTPError as exc:
        # Error responses can contain caller-controlled text. Emit only a machine
        # code, never request/response headers or arbitrary bodies containing secrets.
        code = ''
        try:
            body = json.loads(exc.read(65536))
            candidate = body.get('error', '') if isinstance(body, dict) else ''
            if isinstance(candidate, str) and re.fullmatch(r'[a-z][a-z0-9_]{0,63}', candidate) and not (token and token in candidate):
                code = ' ' + candidate
        except (ValueError, OSError):
            pass
        retry = exc.headers.get('Retry-After', '')
        suffix = ' Retry-After=' + retry if re.fullmatch(r'[0-9]{1,8}', retry) and not (token and token in retry) else ''
        raise ValueError(f'HTTP {exc.code}{code}{suffix}') from None
    except (URLError, TimeoutError, OSError):
        raise ValueError('Network request failed; query is incomplete.') from None
    except (ValueError, UnicodeError):
        raise ValueError('Invalid JSON response; query is incomplete.') from None


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', required=True, help='Instance root URL, e.g. https://findverse.cc')
    parser.add_argument('--rules', action='store_true', help='Read live relationship rules instead of querying entities')
    parser.add_argument('--id', action='append', default=[], dest='ids', help='Entity UUID; repeat for a batch')
    parser.add_argument('--direction', choices=['both', 'outgoing', 'incoming'], default='both')
    parser.add_argument('--class', action='append', default=[], dest='classes', choices=CLASSES, help='Relationship class filter; repeat to combine')
    parser.add_argument('--rule-code', action='append', default=[])
    parser.add_argument('--peer-kind', action='append', default=[], choices=KINDS)
    parser.add_argument('--limit', type=int, default=25)
    parser.add_argument('--offset', type=int, default=0)
    parser.add_argument('--timeout', type=int, default=30)
    args = parser.parse_args(argv)
    url = urlsplit(args.base_url)
    if url.scheme not in ['http', 'https'] or not url.hostname or url.username or url.password or url.query or url.fragment:
        parser.error('--base-url must be an HTTP(S) instance URL without credentials, query or fragment')
    if not 1 <= args.timeout <= 120:
        parser.error('--timeout must be between 1 and 120 seconds')
    if not 1 <= args.limit <= 100 or args.offset < 0:
        parser.error('--limit must be 1..100 and --offset must be nonnegative')
    if args.rules and (args.ids or args.classes or args.rule_code or args.peer_kind or args.direction != 'both' or args.offset):
        parser.error('--rules cannot be combined with entity-query filters')
    try:
        if args.rules:
            result = request(args.base_url, '/api/catalog/definitions', None, args.timeout)
            if not isinstance(result, dict) or not isinstance(result.get('relationship_rules'), list) or not isinstance(result.get('etag'), str):
                raise ValueError('Definitions response does not expose relationship_rules and etag.')
            result = {'definition_etag': result['etag'], 'relationship_rules': result['relationship_rules']}
        else:
            if not args.ids or len(args.ids) > 20:
                parser.error('Provide 1..20 --id arguments')
            try:
                ids = unique([str(UUID(value)) for value in args.ids])
            except ValueError:
                parser.error('--id must be a valid UUID')
            payload = {'ids': ids, 'direction': args.direction, 'limit': args.limit, 'offset': args.offset}
            if args.classes:
                payload['classes'] = unique(args.classes)
            if args.rule_code:
                payload['rule_codes'] = unique(args.rule_code)
            if args.peer_kind:
                payload['peer_kinds'] = unique(args.peer_kind)
            result = request(args.base_url, '/api/catalog/relationships/query', payload, args.timeout)
            if not isinstance(result, dict) or not isinstance(result.get('pages'), list) or not isinstance(result.get('entities'), dict) or not isinstance(result.get('unavailable_ids'), list) or not isinstance(result.get('definition_etag'), str):
                raise ValueError('Relationship query response does not match the endpoint contract.')
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
    sys.exit(main())
