import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { test } from "node:test";
import { runWorkspace, diffDocument, rebasePatch } from "./mf-workspace.ts";

const origin = "https://example.com";
const entityID = "10000000-0000-0000-0000-000000000001";
const workspaceID = "20000000-0000-0000-0000-000000000001";
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mf-workspace-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let workspace: any = { id: workspaceID, owner_id: "author", name: "Task", version: 1,
    head_commit_id: null, state: "active", members: [], objects: [], dirty_count: 0 };
  const commits = new Map<string, any>();
  const calls: any[] = [];
  const main: any = { title: "Original", version: 4 };
  let mode = "direct", throwAfter = "";
  const requestFn: any = async (pathname, options: any = {}) => {
    calls.push({ pathname, ...structuredClone(options) });
    const { method = "GET", body } = options;
    const result = (status, response) => ({ status, body: structuredClone(response) });
    if (pathname === "/api/catalog/workspaces" && method === "POST") {
      return result(201, workspace);
    }
    if (pathname === "/api/catalog/workspaces" || pathname === "/api/catalog/pull-requests") {
      return result(200, { items: [], total: 0, limit: 20, offset: 0 });
    }
    if (pathname.startsWith("/api/catalog/commits/")) {
      const commit = commits.get(pathname.split("/").at(-1));
      return result(commit ? 200 : 404, commit ?? { error: "not_found" });
    }
    if (pathname === `/api/catalog/workspaces/${workspaceID}` && method === "GET") return result(200, workspace);
    if (body.expected_version !== workspace.version) return result(409, { error: "workspace_version_conflict" });
    if (pathname.endsWith("/checkout")) {
      workspace.objects = [{ target: "entity", id: entityID, base_version: 4, base: structuredClone(main),
        committed: structuredClone(main), document: structuredClone(main), dirty: false }];
      workspace.version++;
      return result(200, workspace);
    }
    if (pathname.endsWith("/changes")) {
      const operation = body.operations[0];
      const object = workspace.objects[0];
      if (operation.action === "update") object.document = rebasePatch(object.document, object.document, operation.patch).working;
      object.dirty = true;
      workspace.dirty_count = 1;
      workspace.version++;
      const response = result(200, { workspace, refs: {} });
      if (throwAfter === "stage") { throwAfter = ""; throw new Error("network interruption"); }
      return response;
    }
    if (pathname.endsWith("/commits") && method === "POST") {
      const commit = { id: body.id, workspace_id: workspace.id, parent_id: workspace.head_commit_id,
        author: { id: "author", name: "Author" }, authors: [{ id: "author", name: "Author" }], message: body.message, changes: workspace.objects.map((object) => ({
          target: object.target, id: object.id, base_version: object.base_version, before: object.committed, after: object.document
        })), kind: "commit", created_at: "2026-10-18T00:00:00Z", merged_at: null, merged_by: null, pull_request_id: null };
      commits.set(body.id, structuredClone(commit));
      workspace.head_commit_id = body.id;
      workspace.dirty_count = 0;
      workspace.objects.forEach((object) => { object.committed = structuredClone(object.document); object.dirty = false; });
      workspace.version++;
      if (throwAfter === "commit") { throwAfter = ""; throw new Error("network interruption"); }
      return result(201, commit);
    }
    if (pathname.endsWith("/push")) {
      if (body.expected_head !== workspace.head_commit_id) return result(409, { error: "workspace_head_conflict" });
      if (mode === "conflict") return result(409, { error: "workspace_conflict", conflicts: [{ pointer: "/title", base: "Original", proposed: "Mine", current: "Theirs" }] });
      if (mode === "pr") return result(202, { applied: false, workspace, commits: [...commits.values()], pull_request: { id: "pr", status: "open" } });
      Object.assign(main, workspace.objects[0].document);
      for (const commit of commits.values()) { commit.merged_at = "2026-10-18T01:00:00Z"; commit.merged_by = "maintainer"; }
      return result(200, { applied: true, workspace, commits: [...commits.values()], pull_request: null });
    }
    return result(400, { error: "unexpected_request" });
  };
  const options = { dir, origin, requestFn };
  const readState = () => JSON.parse(fs.readFileSync(path.join(dir, ".mf-workspace.json"), "utf8"));
  return { dir, options, requestFn, calls, commits, main, readState, get workspace() { return workspace; },
    setMode(value) { mode = value; }, throwAfter(value) { throwAfter = value; } };
}
async function prepared(t) {
  const f = fixture(t);
  assert.equal((await runWorkspace("init", f.options)).ok, true);
  assert.equal((await runWorkspace("checkout", { ...f.options, entityIDs: [entityID] })).ok, true);
  return f;
}

test("native rebase preserves an explicit empty replay order and the observed CAS guards", async (t) => {
  const f = await prepared(t);
  const id="30000000-0000-0000-0000-000000000001";
  let body: any;
  const result=await runWorkspace("rebase",{...f.options,commitID:id,edit:{onto_commit_id:entityID,order:[]},requestFn:async(pathname,options:any)=>{
    if(!pathname.endsWith("/rebase"))return f.requestFn(pathname,options);
    body=options.body;
    return {status:200,body:{workspace:{...f.workspace,version:f.workspace.version+1,head_commit_id:id},commit:{id}}};
  }});
  assert.equal(result.ok,true);
  assert.deepEqual(body.order,[]);
  assert.equal(body.onto_commit_id,entityID);
  assert.equal(body.expected_version,f.workspace.version);
  assert.equal(body.expected_head,"");
  assert.equal(body.id,id);
});
const operation = (title) => [{ target: "entity" as const, action: "update" as const, id: entityID, patch: [{ path: "/title", value: title }] }];

test("multiple server stages and immutable commits leave main unchanged until push", async (t) => {
  const f = await prepared(t);
  await runWorkspace("stage", { ...f.options, operations: operation("First") });
  await runWorkspace("stage", { ...f.options, operations: operation("Mine") });
  const first = await runWorkspace("commit", { ...f.options, message: "Title correction" });
  assert.equal(first.ok, true);
  assert.equal(f.main.title, "Original");
  assert.equal(f.commits.size, 1);
  await runWorkspace("stage", { ...f.options, operations: operation("Final") });
  const second = await runWorkspace("commit", { ...f.options, message: "Follow-up correction" });
  assert.equal(second.ok, true);
  assert.equal(f.commits.size, 2);
  const list = [...f.commits.values()];
  assert.equal(list[1].parent_id, list[0].id);
  assert.equal(list[0].changes[0].after.title, "Mine");
  assert.equal(list[0].author.id, "author");
  const pushed = await runWorkspace("push", f.options);
  assert.equal(pushed.result.applied, true);
  assert.equal(f.main.title, "Final");
  assert.ok(f.calls.every((call) => !call.pathname.includes("/commits/preview")));
  assert.ok(f.calls.every((call) => !(call.pathname === "/api/catalog/commits" && call.method === "POST")));
  const staged = f.calls.filter((call) => call.pathname.endsWith("/changes"));
  assert.ok(staged.every((call) => !Object.hasOwn(call.body.operations[0], "source_refs")));
});

test("ordinary push opens PR and preserves published facts", async (t) => {
  const f = await prepared(t);
  await runWorkspace("stage", { ...f.options, operations: operation("Mine") });
  await runWorkspace("commit", { ...f.options, message: "Correction" });
  f.setMode("pr");
  const pushed = await runWorkspace("push", { ...f.options, title: "Fix title" });
  assert.equal(pushed.status, 202);
  assert.equal(pushed.ok, true);
  assert.equal(pushed.result.applied, false);
  assert.equal(pushed.result.pull_request.status, "open");
  assert.equal(f.main.title, "Original");
});

test("a reviewer accepts workspace:null without fetching or substituting a live worktree", async (t) => {
  const f = await prepared(t);
  const before = structuredClone(f.readState().workspace);
  const calls: Array<{ pathname: string; method: string }> = [];
  const requestFn: any = async (pathname, options: any = {}) => {
    calls.push({ pathname, method: options.method ?? "GET" });
    if (pathname === "/api/catalog/pull-requests/review-target")
      return { status: 200, body: { id: "review-target", workspace_id: "foreign-private-workspace", version: 3, source_head_id: "frozen-head" } };
    if (pathname === "/api/catalog/pull-requests/review-target/merge") {
      assert.deepEqual(options.body, { expected_version: 3, expected_head: "frozen-head" });
      return { status: 200, body: { applied: true, workspace: null, commits: [], pull_request: { id: "review-target", status: "merged" } } };
    }
    return f.requestFn(pathname, options);
  };
  const result = await runWorkspace("pr-merge", { ...f.options, pullRequestID: "review-target", requestFn });
  assert.equal(result.ok, true);
  assert.equal(result.workspace, null);
  assert.equal(result.result.workspace, null);
  assert.deepEqual(f.readState().workspace, before);
  assert.equal(calls.filter((call) => call.method === "GET" && call.pathname.includes("/workspaces/")).length, 0);
});

test("a concurrent editor cannot silently replace the last observed workspace", async (t) => {
  const f = await prepared(t);
  f.workspace.version++;
  const staged = await runWorkspace("stage", { ...f.options, operations: operation("Mine") });
  assert.equal(staged.status, 409);
  assert.equal(f.workspace.objects[0].document.title, "Original");
  assert.equal(f.readState().workspace.version, 2);
  await runWorkspace("status", f.options);
  assert.equal(f.readState().workspace.version, 3);
});

test("a lost commit response recovers the same immutable ID without reposting", async (t) => {
  const f = await prepared(t);
  await runWorkspace("stage", { ...f.options, operations: operation("Mine") });
  f.throwAfter("commit");
  const pending = await runWorkspace("commit", { ...f.options, message: "Correction" });
  assert.equal(pending.ok, false);
  const id = f.readState().pending.body.id;
  assert.equal(f.commits.size, 1);
  await assert.rejects(runWorkspace("commit", { ...f.options, message: "Again" }), /request_result_unknown/);
  const receipt = await runWorkspace("receipt", f.options);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.commit.id, id);
  assert.equal(f.readState().pending, undefined);
  assert.equal(f.calls.filter((call) => call.pathname.endsWith("/commits") && call.method === "POST").length, 1);
});

test("same-field conflict preserves the fork and presents the complete server conflict", async (t) => {
  const f = await prepared(t);
  await runWorkspace("stage", { ...f.options, operations: operation("Mine") });
  await runWorkspace("commit", { ...f.options, message: "Correction" });
  f.setMode("conflict");
  const result = await runWorkspace("push", f.options);
  assert.equal(result.status, 409);
  assert.equal(f.workspace.objects[0].document.title, "Mine");
  assert.equal(f.main.title, "Original");
  // publicFailure preserves structured conflict details for human resolution.
  assert.ok(JSON.stringify(result.result).includes("workspace_conflict"));
});

test("local snapshot is instance-bound and files contain no credentials", async (t) => {
  const f = await prepared(t);
  await assert.rejects(runWorkspace("status", { ...f.options, origin: "https://other.example" }), /origin_mismatch/);
  assert.deepEqual(fs.readdirSync(f.dir), [".mf-workspace.json"]);
  assert.equal(Object.hasOwn(f.readState(), "token"), false);
});

test("sparse patches preserve omitted languages; deletion is explicit", () => {
  const base = { title: "Original", translations: { "en-US": { title: "Original", body: "Article" }, ja: { title: "原名" } }, attributes: { year: 2025 } };
  assert.deepEqual(diffDocument(base, { ...base, translations: { "en-US": { title: "Correct" } } }, "entity"), [{ path: "/translations/en-US/title", value: "Correct" }]);
  assert.deepEqual(diffDocument(base, { ...base, attributes: {} }, "entity", ["/attributes/year"]), [{ path: "/attributes/year", remove: true }]);
});

test("three-way merge ignores reverted local edits, merges independent paths, exposes actual conflicts", () => {
  assert.deepEqual(rebasePatch({ title: "A" }, { title: "B" }, [{ path: "/title", value: "A" }]), { working: { title: "B" }, conflicts: [] });
  assert.deepEqual(rebasePatch({ title: "A", body: "a" }, { title: "B", body: "a" }, [{ path: "/body", value: "b" }]), { working: { title: "B", body: "b" }, conflicts: [] });
  assert.deepEqual(rebasePatch({ title: "A" }, { title: "B" }, [{ path: "/title", value: "C" }]).conflicts, ["/title"]);
});


test("version reads work without a local copy and preserve server filters", async () => {
  const cases: [string, Record<string, any>, string][] = [
    ["head", {}, "/api/catalog/head"],
    ["history", {recordID:entityID, authorID:workspaceID, since:"2026-10-20T00:00:00Z", until:"2026-10-21T00:00:00Z", limit:1, offset:20}, `/api/catalog/history?limit=1&offset=20&record_id=${entityID}&author_id=${workspaceID}&since=2026-10-20T00%3A00%3A00Z&until=2026-10-21T00%3A00%3A00Z`],
    ["snapshot", {commitID:workspaceID, target:"entity", recordID:entityID}, `/api/catalog/commits/${workspaceID}/snapshot?target=entity&record_id=${entityID}`],
    ["commit-diff", {commitID:workspaceID, offset:20}, `/api/catalog/commits/${workspaceID}/diff?offset=20`],
    ["pr-diff", {pullRequestID:workspaceID, target:"relation"}, `/api/catalog/pull-requests/${workspaceID}/diff?target=relation`],
    ["pr-commits", {pullRequestID:workspaceID, authorID:entityID}, `/api/catalog/pull-requests/${workspaceID}/commits?author_id=${entityID}`],
    ["revisions", {recordID:entityID, version:125}, `/api/catalog/entities/${entityID}/revisions?version=125`],
  ];
  for (const [command, options, expected] of cases) {
    let calls = 0;
    const result = await runWorkspace(command, {origin, ...options, requestFn: async (pathname, opts) => {
      calls++;
      assert.equal(pathname, expected);
      assert.equal(opts?.method, "GET");
      assert.equal(opts?.body, undefined);
      return {status:200, body:{items:[], total:125, limit:1, offset:20}};
    }});
    assert.equal(result.ok, true);
    assert.equal(result.result.total, 125);
    assert.equal(calls, 1);
  }
  await assert.rejects(runWorkspace("history", {origin, limit:101}), /invalid_limit/);
});
