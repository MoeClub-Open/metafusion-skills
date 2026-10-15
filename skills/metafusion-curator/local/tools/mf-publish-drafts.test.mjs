import test from "node:test";
import assert from "node:assert/strict";
import {
  publishBlocker,
  sliceShard,
  loadDoneSet,
} from "./mf-publish-drafts.mjs";

test("publishBlocker 拦截非 draft 与无翻译", () => {
  assert.equal(publishBlocker({ status: "draft", translations: { en: {} } }), null);
  assert.equal(publishBlocker({ status: "published", translations: { en: {} } }), "status_published");
  assert.equal(publishBlocker({ status: "draft", translations: {} }), "no_translations");
  assert.equal(publishBlocker({ status: "draft" }), "no_translations");
  assert.equal(publishBlocker(null), "missing_entity");
});

test("sliceShard 连续切分无遗漏无重叠", () => {
  const ids = Array.from({ length: 10 }, (_, i) => `id${i}`);
  const parts = [0, 1, 2].map((i) => sliceShard(ids, i, 3));
  assert.deepEqual(parts.map((p) => p.length), [4, 4, 2]);
  assert.deepEqual([...parts[0], ...parts[1], ...parts[2]].sort(), ids.sort());
  assert.throws(() => sliceShard(ids, 3, 3), /invalid_shard_slice/);
  assert.throws(() => sliceShard(ids, 0, 0), /invalid_shard_slice/);
});

test("loadDoneSet 从 progress 行恢复已完成", () => {
  const lines = [
    JSON.stringify({ event: "shard_start", todo: 3 }),
    JSON.stringify({ event: "batch_done", batch: 0, results: [{ id: "a", published: true }, { id: "b", skipped: "x" }] }),
    "not json {{{",
    JSON.stringify({ event: "batch_done", batch: 1, results: [{ id: "c", failed: "y" }] }),
  ];
  assert.deepEqual([...loadDoneSet(lines)].sort(), ["a", "b", "c"]);
  assert.deepEqual([...loadDoneSet([])], []);
});
