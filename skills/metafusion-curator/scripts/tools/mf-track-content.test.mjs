import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { addTrackContent, runCli, validatePlan } from "./mf-track-content.mjs";

const TOOL_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "mf-track-content.mjs");
const TRACK_ID = "track-1";
const MEDIUM_ID = "medium-1";
const RELEASE_ID = "release-1";
const EXPRESSION_ID = "expression-new";
const WORK_ID = "work-1";

const clone = (value) => JSON.parse(JSON.stringify(value));

function plan(overrides = {}) {
  return {
    track_id: TRACK_ID,
    expected_version: 7,
    inclusion: {
      expression_id: EXPRESSION_ID,
      position: 2,
      locator: { relative_to: "track", time_start_ms: 0, time_end_ms: 1000 },
      attributes: {},
    },
    edit_note: "依据发行方曲目表增加表达收录",
    sources: [{
      kind: "url",
      url: "https://publisher.example/releases/r1",
      citation: "发行方曲目表支持 Track.contents 收录",
    }],
    ...overrides,
  };
}

function fixture({
  releaseSubjects = [{ work_id: WORK_ID, role: "primary", position: 0 }],
  contents,
  actualVersion = 7,
  trackStatus = 200,
  trackThrows = false,
  postMode = "commit",
  omitTocTarget = false,
  omitOccurrenceTarget = false,
  tocTrackVersion,
  tocExpressionWorkId = WORK_ID,
} = {}) {
  const old = {
    expression_id: "expression-old",
    position: 1,
    locator: { relative_to: "track", time_start_ms: 0, time_end_ms: 800 },
    attributes: {},
    sources: [{ kind: "publication", citation: "包装目录，原有收录" }],
  };
  let track = {
    id: TRACK_ID,
    kind: "track",
    version: actualVersion,
    status: "published",
    title: "Track one",
    medium_id: MEDIUM_ID,
    position: 1,
    attributes: { duration: 1 },
    translations: { "en-US": { title: "Track one" } },
    contents: clone(contents === undefined ? [old] : contents),
    created_by: "fixture-user",
    updated_at: "2026-01-01T00:00:00Z",
  };
  const medium = { id: MEDIUM_ID, kind: "medium", release_id: RELEASE_ID, position: 1 };
  const release = { id: RELEASE_ID, kind: "release", subjects: clone(releaseSubjects) };
  const expression = { id: EXPRESSION_ID, kind: "expression", work_id: WORK_ID, title: "Expression" };
  const calls = [];
  let posts = 0;

  function response(status, body) { return { status, body }; }
  function revisions() {
    return response(200, { items: [
      { id: "revision-older", version: track.version - 1, snapshot: { id: TRACK_ID }, sources: [] },
      { id: `revision-${track.version}`, version: track.version, snapshot: clone(track), sources: clone(plan().sources) },
    ] });
  }
  function toc() {
    const tocTrack = clone(track);
    if (tocTrackVersion !== undefined) tocTrack.version = tocTrackVersion;
    if (omitTocTarget) tocTrack.contents = tocTrack.contents.filter((item) => item.expression_id !== EXPRESSION_ID);
    const expressions = omitTocTarget ? {} : { [EXPRESSION_ID]: { ...clone(expression), work_id: tocExpressionWorkId } };
    return response(200, {
      release: clone(release),
      media: [{ medium: clone(medium), tracks: [tocTrack] }],
      expressions,
    });
  }
  function occurrences() {
    let found = track.contents.filter((item) => item.expression_id === EXPRESSION_ID);
    if (omitOccurrenceTarget) found = [];
    return response(200, { items: found.map((item) => ({
      ...clone(item),
      track: { id: TRACK_ID, kind: "track", medium_id: MEDIUM_ID },
      medium: { id: MEDIUM_ID, kind: "medium", release_id: RELEASE_ID },
      release: { id: RELEASE_ID, kind: "release" },
    })) });
  }

  const requestFn = async (pathname, options = {}) => {
    calls.push({ pathname, options: clone(options) });
    if (options.method === "POST") {
      posts += 1;
      if (postMode === "conflict") return response(409, { error: "version_conflict" });
      const inclusion = clone(options.body.inclusion);
      track.contents.push({
        ...inclusion,
        attributes: inclusion.attributes ?? {},
        sources: inclusion.sources ?? clone(options.body.sources),
      });
      track.version += 1;
      if (postMode === "throw-after-commit") throw new Error("connection lost after commit");
      if (postMode === "500-after-commit") return response(500, { error: "internal_error" });
      return response(200, { version: track.version });
    }
    if (pathname === "/api/openapi.json") {
      return response(200, { paths: { "/api/catalog/tracks/{id}/contents": { post: { operationId: "addTrackContent" } } } });
    }
    if (pathname === `/api/catalog/entities/${TRACK_ID}/revisions`) return revisions();
    if (pathname === `/api/catalog/entities/${EXPRESSION_ID}/occurrences`) return occurrences();
    if (pathname === `/api/catalog/releases/${RELEASE_ID}/toc`) return toc();
    if (pathname === `/api/catalog/entities/${TRACK_ID}`) {
      if (trackThrows) throw new Error("read failed");
      if (trackStatus !== 200) return response(trackStatus, { error: "forbidden" });
      return response(200, clone(track));
    }
    if (pathname === `/api/catalog/entities/${MEDIUM_ID}`) return response(200, clone(medium));
    if (pathname === `/api/catalog/entities/${RELEASE_ID}`) return response(200, clone(release));
    if (pathname === `/api/catalog/entities/${EXPRESSION_ID}`) return response(200, clone(expression));
    return response(404, { error: "not_found" });
  };

  return { requestFn, calls, get posts() { return posts; }, get track() { return clone(track); }, old };
}

test("preview performs all preflight reads but never POSTs", async () => {
  const mock = fixture();
  const result = await addTrackContent({ plan: plan(), requestFn: mock.requestFn });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "preview");
  assert.equal(result.applied, false);
  assert.equal(mock.posts, 0);
  assert.equal(result.request.method, "POST");
  assert.equal(result.request.body.inclusion.sources, undefined);
});

test("plan validator accepts add and explicitly rejects replace/delete", () => {
  assert.equal(validatePlan(plan()), null);
  assert.equal(validatePlan({ ...plan(), operation: "replace" }), "unsupported_operation");
  assert.equal(validatePlan({ ...plan(), action: "delete" }), "unsupported_operation");
});

test("rejects an expression Work absent from Release.subjects without writing", async () => {
  const mock = fixture({ releaseSubjects: [] });
  const result = await addTrackContent({ plan: plan(), apply: true, requestFn: mock.requestFn });
  assert.equal(result.reason, "undeclared_release_subject");
  assert.equal(mock.posts, 0);
});

test("rejects duplicate expression+locator and occupied position", async () => {
  const duplicate = fixture({ contents: [{
    expression_id: EXPRESSION_ID,
    position: 9,
    locator: clone(plan().inclusion.locator),
  }] });
  const duplicateResult = await addTrackContent({ plan: plan(), requestFn: duplicate.requestFn });
  assert.equal(duplicateResult.reason, "duplicate_content");
  assert.equal(duplicate.posts, 0);

  const positionConflict = fixture({ contents: [{
    expression_id: "expression-other",
    position: 2,
    locator: {},
  }] });
  const positionResult = await addTrackContent({ plan: plan(), requestFn: positionConflict.requestFn });
  assert.equal(positionResult.reason, "position_conflict");
  assert.equal(positionConflict.posts, 0);
});

test("rejects stale expected_version before POST", async () => {
  const mock = fixture({ actualVersion: 8 });
  const result = await addTrackContent({ plan: plan(), apply: true, requestFn: mock.requestFn });
  assert.equal(result.outcome, "version_conflict");
  assert.equal(result.currentVersion, 8);
  assert.equal(mock.posts, 0);
});

test("success preserves old contents and finds the current revision when it is not first", async () => {
  const mock = fixture();
  const result = await addTrackContent({ plan: plan(), apply: true, requestFn: mock.requestFn });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "verified");
  assert.equal(result.version, 8);
  assert.equal(result.verification.track.contents.oldContentsPreserved, true);
  assert.equal(result.verification.track.version.ok, true);
  assert.equal(result.verification.revision.version, 8);
  assert.equal(result.verification.revision.revisionIdPresent, true);
  assert.equal(result.verification.toc.mediumOwnershipMatches, true);
  assert.equal(result.verification.occurrences.trackOwnershipMatches, true);
  assert.deepEqual(mock.track.contents[0], mock.old);
  assert.equal(mock.posts, 1);
});

test("missing target in TOC is partial, never successful", async () => {
  const mock = fixture({ omitTocTarget: true });
  const result = await addTrackContent({ plan: plan(), apply: true, requestFn: mock.requestFn });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "partial");
  assert.equal(result.verification.toc.state, "failed");
});

test("missing target in occurrences is partial, never successful", async () => {
  const mock = fixture({ omitOccurrenceTarget: true });
  const result = await addTrackContent({ plan: plan(), apply: true, requestFn: mock.requestFn });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "partial");
  assert.equal(result.verification.occurrences.requestedReferencePresent, false);
});

test("TOC with a different Track version or Expression Work is partial", async () => {
  for (const config of [
    { tocTrackVersion: 99 },
    { tocExpressionWorkId: "work-from-another-release" },
  ]) {
    const mock = fixture(config);
    const result = await addTrackContent({ plan: plan(), apply: true, requestFn: mock.requestFn });
    assert.equal(result.ok, false);
    assert.equal(result.outcome, "partial");
    assert.equal(result.verification.toc.state, "failed");
  }
});

test("a 500 after commit remains unknown even when readback sees the requested inclusion", async () => {
  const mock = fixture({ postMode: "500-after-commit" });
  const result = await addTrackContent({ plan: plan(), apply: true, requestFn: mock.requestFn });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "unknown");
  assert.equal(result.applied, null);
  assert.equal(result.recheck.track.requestedInclusionVisible, true);
  assert.equal(mock.posts, 1);
});

test("a network exception after commit remains unknown and is never retried", async () => {
  const mock = fixture({ postMode: "throw-after-commit" });
  const result = await addTrackContent({ plan: plan(), apply: true, requestFn: mock.requestFn });
  assert.equal(result.outcome, "unknown");
  assert.equal(result.applied, null);
  assert.equal(result.recheck.track.requestedInclusionVisible, true);
  assert.equal(mock.posts, 1);
});

test("409 performs read-only recheck and never retries POST", async () => {
  const mock = fixture({ postMode: "conflict" });
  const result = await addTrackContent({ plan: plan(), apply: true, requestFn: mock.requestFn });
  assert.equal(result.outcome, "conflict");
  assert.equal(result.reason, "version_conflict_no_replay");
  assert.equal(mock.posts, 1);
  assert.ok(mock.calls.some((call) => call.pathname.endsWith("/revisions")));
});

test("403 and thrown Track reads are unavailable, never treated as empty contents", async () => {
  for (const config of [{ trackStatus: 403 }, { trackThrows: true }]) {
    const mock = fixture(config);
    const result = await addTrackContent({ plan: plan(), apply: true, requestFn: mock.requestFn });
    assert.equal(result.outcome, "preflight_failed");
    assert.equal(result.reason, "track_unavailable_or_invalid");
    assert.equal(mock.posts, 0);
  }
});

test("missing or malformed contents prevents position guesses", async () => {
  for (const contents of [null, [{ expression_id: EXPRESSION_ID, position: "next", locator: {} }]]) {
    const mock = fixture({ contents });
    const result = await addTrackContent({ plan: plan(), apply: true, requestFn: mock.requestFn });
    assert.equal(result.reason, "track_contents_missing_or_invalid");
    assert.equal(mock.posts, 0);
  }
});

test("self-only sources are rejected and source URLs require valid HTTP(S) without credentials", async () => {
  const selfOnly = plan({ sources: [{ kind: "self", citation: "已核对" }] });
  const selfResult = await addTrackContent({ plan: selfOnly, requestFn: fixture().requestFn });
  assert.equal(selfResult.reason, "invalid_sources");

  const badUrl = plan({ sources: [{ kind: "url", url: "https://name:secret@publisher.example/", citation: "官方目录" }] });
  const urlResult = await addTrackContent({ plan: badUrl, requestFn: fixture().requestFn });
  assert.equal(urlResult.reason, "invalid_sources");
});

test("--help works without credentials", () => {
  const result = spawnSync(process.execPath, [TOOL_PATH, "--help"], {
    encoding: "utf8",
    env: {
      ...process.env,
      MF_BASE: "",
      MF_PAT: "",
      MF_CREDENTIALS: path.join(os.tmpdir(), "mf-track-content-no-credentials.json"),
    },
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /仅支持新增/u);
  assert.doesNotMatch(result.stdout, /缺少 MetaFusion 凭据/u);
});

test("importing the module does not execute the CLI", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(TOOL_PATH).href)});`], {
    encoding: "utf8",
    env: {
      ...process.env,
      MF_BASE: "",
      MF_PAT: "",
      MF_CREDENTIALS: path.join(os.tmpdir(), "mf-track-content-no-credentials.json"),
    },
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("--out reserves the result path before requests and writes the full preview", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mf-track-content-test-"));
  try {
    const planPath = path.join(directory, "plan.json");
    const outPath = path.join(directory, "result.json");
    fs.writeFileSync(planPath, JSON.stringify(plan()), "utf8");
    const mock = fixture();
    const stdout = [];
    const stderr = [];
    const exitCode = await runCli(["--plan", planPath, "--out", outPath], {
      requestFn: mock.requestFn,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });
    assert.equal(exitCode, 0);
    assert.equal(stderr.length, 0);
    assert.equal(JSON.parse(fs.readFileSync(outPath, "utf8")).outcome, "preview");
    assert.equal(JSON.parse(stdout[0]).outcome, "preview");
    assert.equal(mock.posts, 0);

    fs.writeFileSync(outPath, "preserve me", "utf8");
    const callsBefore = mock.calls.length;
    const blockedCode = await runCli(["--plan", planPath, "--apply", "--out", outPath], {
      requestFn: mock.requestFn,
      stdout: () => {},
      stderr: (line) => stderr.push(line),
    });
    assert.equal(blockedCode, 2);
    assert.equal(fs.readFileSync(outPath, "utf8"), "preserve me");
    assert.equal(mock.calls.length, callsBefore);
    assert.equal(mock.posts, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
