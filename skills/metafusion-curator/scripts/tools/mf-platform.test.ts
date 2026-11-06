import assert from "node:assert/strict";
import test from "node:test";
import {
  runPlan,
  validatePlan,
  listOperations,
  schemaFor,
  runCli,
} from "./mf-platform.ts";
const entity = {
  id: "work-id",
  kind: "work",
  title: "work",
  state: "active", review_status: "reviewed",
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
    validatePlan({ action: "entity.list", params: { state: "active" } }),
    null,
  );
  assert.equal(
    validatePlan({ action: "entity.list", params: { ids: "a,b", tags_mode: "all" } }),
    null,
  );
  assert.equal(
    validatePlan({
      action: "entity.list",
      params: { field: "creation_form", values: "anime_tv,anime_movie", exclude_field: "creation_form", exclude_values: "song" },
    }),
    null,
  );
  assert.equal(
    validatePlan({ action: "entity.list", params: { status: "published" } }),
    "invalid_list_params",
  );
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
test("entity.batch validates 1-100 IDs and verifies returned entity keys", async () => {
  assert.equal(validatePlan({ action: "entity.batch", ids: [] }), "invalid_batch_ids");
  assert.equal(
    validatePlan({ action: "entity.batch", ids: Array.from({ length: 101 }, (_, i) => `id-${i}`) }),
    "invalid_batch_ids",
  );
  let captured: any = null;
  const res = await runPlan(
    { action: "entity.batch", ids: [entity.id, entity.id, "missing-id"] },
    {
      requestFn: async (p, opts) => {
        captured = { p, opts };
        return {
          status: 200,
          body: { items: { [entity.id]: entity }, missing: ["missing-id"] },
        };
      },
    },
  );
  assert.equal(res.ok, true);
  assert.equal(captured.p, "/api/catalog/entities/batch");
  assert.equal(captured.opts.method, "POST");
  assert.deepEqual(captured.opts.body, { ids: [entity.id, "missing-id"] });
  assert.deepEqual(res.data.missing, ["missing-id"]);
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
            body: { ...entity, state: "merged" },
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
        body: p.endsWith("/revisions?version=2&limit=1")
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
