import assert from "node:assert/strict";
import test from "node:test";
import {
  runPlan,
  validatePlan,
  listOperations,
  schemaFor,
  runCli,
} from "./mf-platform.mjs";
const entity = {
  id: "work-id",
  kind: "work",
  title: "work",
  status: "published",
  version: 2,
};
test("platform is read-only and old mutation plans fail before any HTTP", async () => {
  let calls = 0;
  const requestFn = async () => {
    calls++;
    throw new Error("unexpected");
  };
  for (const action of [
    "entity.create",
    "entity.update",
    "relation.create",
    "track-content.add",
  ]) {
    const result = await runPlan({ action }, { requestFn });
    assert.equal(result.ok, false);
    assert.match(result.reason, /mf_workspace/);
  }
  assert.equal(calls, 0);
  assert.equal(
    listOperations().every((x) => x.mode === "read"),
    true,
  );
});
test("closed read plan schema rejects arbitrary methods and filter pagination", () => {
  assert.equal(
    validatePlan({ action: "entity.get", id: "id", method: "PUT" }),
    "invalid_plan",
  );
  assert.equal(
    validatePlan({ action: "entity.list", params: { offset: 20 } }),
    "invalid_list_params",
  );
  assert.equal(
    validatePlan({ action: "entity.list", limit: 101 }),
    "invalid_limit",
  );
  assert.equal(schemaFor("entity.get").additionalProperties, false);
});
test("GET verifies identity and canonical state", async () => {
  assert.equal(
    (
      await runPlan(
        { action: "entity.get", id: entity.id },
        { requestFn: async () => ({ status: 200, body: entity }) },
      )
    ).ok,
    true,
  );
  assert.equal(
    (
      await runPlan(
        { action: "entity.get", id: "other" },
        { requestFn: async () => ({ status: 200, body: entity }) },
      )
    ).ok,
    false,
  );
  assert.equal(
    (
      await runPlan(
        { action: "entity.resolve", id: entity.id },
        {
          requestFn: async () => ({
            status: 200,
            body: { ...entity, status: "merged" },
          }),
        },
      )
    ).ok,
    false,
  );
});
test("partial pagination and read failures never mean absence", async () => {
  const requestFn = async () => ({
    status: 429,
    body: { error: "rate_limited" },
  });
  const result = await runPlan(
    { action: "entity.list", params: { kind: "work" } },
    { requestFn },
  );
  assert.equal(result.ok, false);
  assert.equal(result.coverage.complete, false);
  const unavailable = await runPlan(
    { action: "entity.get", id: entity.id },
    {
      requestFn: async () => {
        throw new Error("network");
      },
    },
  );
  assert.equal(unavailable.outcome, "unknown");
});
test("revision is selected by entity version, not list position", async () => {
  const r = await runPlan(
    { action: "entity.current-revision", id: entity.id },
    {
      requestFn: async (p) => ({
        status: 200,
        body: p.endsWith("revisions")
          ? {
              items: [
                { id: 5, version: 1, snapshot: { ...entity, version: 1 } },
                { id: 7, version: 2, snapshot: entity },
              ],
            }
          : entity,
      }),
    },
  );
  assert.equal(r.ok, true);
  assert.equal(r.revision.id, 7);
});
test("definitions and contract require current envelope", async () => {
  assert.equal(
    (
      await runPlan(
        { action: "definitions" },
        {
          requestFn: async () => ({
            status: 200,
            body: { etag: "v", document: { fields: {} } },
          }),
        },
      )
    ).ok,
    true,
  );
  assert.equal(
    (
      await runPlan(
        { action: "contract" },
        {
          requestFn: async () => ({
            status: 200,
            body: { openapi: "3.1.0", paths: {} },
          }),
        },
      )
    ).ok,
    true,
  );
  assert.equal(
    (
      await runPlan(
        { action: "definitions" },
        { requestFn: async () => ({ status: 200, body: {} }) },
      )
    ).ok,
    false,
  );
});
test("--apply is removed from read CLI", async () => {
  await assert.rejects(
    runCli(["--plan", "unused.json", "--apply"]),
    /unknown_argument/,
  );
});
