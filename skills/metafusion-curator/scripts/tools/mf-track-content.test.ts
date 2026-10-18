import assert from "node:assert/strict";
import test from "node:test";
import { addTrackContent, validatePlan, runCli } from "./mf-track-content.ts";

const clone = (x) => structuredClone(x);
const plan = () => ({ workspace_id: "workspace", expected_version: 3, track_id: "track", inclusion: {
  expression_id: "expression", position: 2, locator: { relative_to: "track", time_start_ms: 1000 },
} });
const old = { expression_id: "other", position: 1, locator: {}, sources: [{ kind: "publication", citation: "Existing" }] };
function fixture({ stageStatus = 200, stageThrows = false, invalidReceipt = false, version = 3 } = {}) {
  const workspace = { id: "workspace", version, objects: [{ target: "entity", id: "track", document: {
    id: "track", kind: "track", title: "Track", medium_id: "medium", contents: [clone(old)],
  } }] };
  const calls = [];
  const requestFn = async (path, options = {}) => {
    calls.push({ path, ...clone(options) });
    if ((options.method ?? "GET") === "GET") return { status: 200, body: clone(workspace) };
    assert.equal(path, "/api/catalog/workspaces/workspace/changes");
    assert.equal(options.method, "PUT");
    assert.equal(options.tries, 1);
    if (stageThrows) throw new Error("disconnected");
    if (stageStatus !== 200) return { status: stageStatus, body: { error: "version_conflict" } };
    const next = clone(workspace);
    next.version++;
    if (!invalidReceipt) next.objects[0].document.contents.push(clone(options.body.operations[0].content_change.inclusion));
    return { status: 200, body: { workspace: next, refs: {} } };
  };
  return { calls, requestFn, workspace };
}

test("preview reads a server copy and provides only a stage request", async () => {
  const mock = fixture();
  const result = await addTrackContent({ plan: plan(), requestFn: mock.requestFn });
  assert.equal(result.outcome, "preview");
  assert.equal(result.applied, false);
  assert.equal(result.request.path, "/api/catalog/workspaces/workspace/changes");
  assert.equal(result.request.method, "PUT");
  assert.equal(mock.calls.length, 1);
  assert.equal(result.request.body.operations[0].action, "content");
});

test("no source or identity review is required; apply only stages on the copy", async () => {
  const mock = fixture();
  const result = await addTrackContent({ plan: plan(), apply: true, requestFn: mock.requestFn });
  assert.equal(result.ok, true);
  assert.equal(result.applied, false);
  assert.equal(result.staged, true);
  assert.equal(result.workspace.version, 4);
  assert.deepEqual(result.workspace.objects[0].document.contents[0], old);
  assert.equal(mock.workspace.objects[0].document.contents.length, 1);
  assert.ok(mock.calls.every((call) => call.path.startsWith("/api/catalog/workspaces/")));
  assert.equal(mock.calls.some((call) => /commits|push|tracks/.test(call.path)), false);
});

test("existing optional source metadata is retained without generating evidence", async () => {
  const mock = fixture();
  const input = plan();
  input.inclusion.sources = [{ kind: "url", url: "https://example.org", citation: "Optional" }];
  const result = await addTrackContent({ plan: input, apply: true, requestFn: mock.requestFn });
  assert.equal(result.ok, true);
  assert.deepEqual(result.workspace.objects[0].document.contents[1].sources, input.inclusion.sources);
});

test("workspace CAS, duplicate and position conflicts never write", async () => {
  for (const [overrides, reason] of [
    [{ expected_version: 2 }, "workspace_version_conflict"],
    [{ inclusion: { expression_id: "other", position: 3 } }, "duplicate_content"],
    [{ inclusion: { expression_id: "expression", position: 1 } }, "position_conflict"],
  ]) {
    const mock = fixture();
    const result = await addTrackContent({ plan: { ...plan(), ...overrides }, apply: true, requestFn: mock.requestFn });
    assert.equal(result.reason, reason);
    assert.equal(mock.calls.length, 1);
  }
});

test("unknown or conflicting stages never replay and do not claim main changed", async () => {
  for (const options of [{ stageStatus: 409 }, { stageStatus: 500 }, { stageThrows: true }, { invalidReceipt: true }]) {
    const mock = fixture(options);
    const result = await addTrackContent({ plan: plan(), apply: true, requestFn: mock.requestFn });
    assert.equal(result.ok, false);
    assert.equal(result.applied, false);
    assert.equal(mock.calls.length, 2);
  }
});

test("only the workspace stage plan is accepted", () => {
  assert.equal(validatePlan(plan()), null);
  assert.equal(validatePlan({ ...plan(), edit_note: "old direct API" }), "invalid_plan");
  assert.equal(validatePlan({ ...plan(), workspace_id: undefined }), "invalid_plan");
  assert.equal(validatePlan({ ...plan(), inclusion: { expression_id: "x", position: -1 } }), "invalid_inclusion");
});

test("help does not access credentials or the network", async () => {
  const lines = [];
  assert.equal(await runCli(["--help"], { requestFn: () => { throw new Error("no request"); }, stdout: (s) => lines.push(s) }), 0);
  assert.match(lines.join(""), /workspace_id/);
});
