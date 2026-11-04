import assert from "node:assert/strict";
import { test } from "node:test";
import { readEntityLinks } from "./mf-links.ts";
import { runPlan, validatePlan } from "./mf-platform.ts";

test("links reader follows has_more and preserves publisher references and editable versions", async () => {
  const calls: string[] = [];
  const requestFn = async (path: string) => {
    calls.push(path);
    const second = path.endsWith("offset=100");
    return { status: 200, body: { subject_id: "publisher", limit: 100, has_more: !second,
      items: second
        ? [{ key: "credit", class: "semantic", rule_code: "relation:credit_for", version: 5, attributes: { credit_role: "発売元" } }]
        : [{ key: "publisher-reference", class: "reference", rule_code: "attribute:publisher", source_id: "release", target_id: "publisher" }],
      entities: second ? { release: { title: "棘アリ [通常盤]" } } : { publisher: { title: "Publisher" } },
    } };
  };
  const result = await readEntityLinks("publisher", { requestFn });
  assert.equal(calls.length, 2);
  assert.equal(result.items.length, 2);
  assert.equal(result.items[1].version, 5);
  assert.equal(result.entities.release.title, "棘アリ [通常盤]");
  const plan = await runPlan({ action: "entity.links", id: "publisher" }, { requestFn });
  assert.equal(plan.ok, true);
  assert.notEqual(validatePlan({ action: "entity.relations", id: "publisher" }), null);
});

test("links reader forwards direction, classes, rule_codes and peer_kinds filters", async () => {
  const calls: string[] = [];
  const requestFn = async (path: string) => {
    calls.push(path);
    return {
      status: 200,
      body: { subject_id: "work-1", limit: 100, has_more: false, items: [], entities: { "work-1": { title: "Work" } } },
    };
  };
  const plan = await runPlan(
    {
      action: "entity.links",
      id: "work-1",
      params: { direction: "outgoing", classes: ["semantic", "reference"], rule_codes: ["relation:credit"], peer_kinds: ["agent"] },
    },
    { requestFn },
  );
  assert.equal(plan.ok, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /direction=outgoing/);
  assert.match(calls[0], /classes=semantic%2Creference/);
  assert.match(calls[0], /rule_codes=relation%3Acredit/);
  assert.match(calls[0], /peer_kinds=agent/);
  assert.ok(calls[0].endsWith("offset=0"));
  assert.equal(validatePlan({ action: "entity.links", id: "work-1", params: { classes: ["bad"] } }), "invalid_link_params");
});

test("links reader reports later-page failure without returning a complete graph", async () => {
  await assert.rejects(readEntityLinks("publisher", { requestFn: async (path: string) => path.endsWith("offset=0")
    ? { status: 200, body: { subject_id: "publisher", limit: 100, items: [], entities: {}, has_more: true } }
    : { status: 403, body: { error: "forbidden" } } }), /HTTP 403/);
});
