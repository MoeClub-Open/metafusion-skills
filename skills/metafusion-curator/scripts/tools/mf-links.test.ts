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

test("links reader reports later-page failure without returning a complete graph", async () => {
  await assert.rejects(readEntityLinks("publisher", { requestFn: async (path: string) => path.endsWith("offset=0")
    ? { status: 200, body: { subject_id: "publisher", limit: 100, items: [], entities: {}, has_more: true } }
    : { status: 403, body: { error: "forbidden" } } }), /HTTP 403/);
});
