import test from "node:test";
import assert from "node:assert/strict";
import {
  referenceEdges,
  topoLayers,
  pickHistoricalSource,
  publishBlocker,
} from "./mf-publish-drafts.mjs";

test("referenceEdges 收集全部结构引用", () => {
  const e = {
    work_id: "w1", content_unit_id: "c1", release_id: "r1", medium_id: "m1",
    subjects: [{ work_id: "w2" }, {}],
    contents: [{ expression_id: "e1" }, {}],
  };
  assert.deepEqual(
    referenceEdges(e).sort(),
    ["c1", "e1", "m1", "r1", "w1", "w2"].sort(),
  );
  assert.deepEqual(referenceEdges({}), []);
  assert.deepEqual(referenceEdges(null), []);
});

test("topoLayers 父级在前、层内可并行", () => {
  const work = { id: "w" };
  const expr = { id: "e", work_id: "w" };
  const track = { id: "t", medium_id: "m", contents: [{ expression_id: "e" }] };
  const medium = { id: "m", release_id: "r" };
  const release = { id: "r", subjects: [{ work_id: "w" }] };
  const { layers, cyclic } = topoLayers([track, expr, work, medium, release]);
  assert.deepEqual(cyclic, []);
  assert.deepEqual(layers[0], ["w"]);
  const flat = layers.flat();
  assert.ok(flat.indexOf("e") > flat.indexOf("w"));
  assert.ok(flat.indexOf("r") > flat.indexOf("w"));
  assert.ok(flat.indexOf("m") > flat.indexOf("r"));
  assert.ok(flat.indexOf("t") > flat.indexOf("m"));
  assert.ok(flat.indexOf("t") > flat.indexOf("e"));
});

test("topoLayers 自引用不死锁、环单独报告", () => {
  const { cyclic } = topoLayers([
    { id: "a", work_id: "b" },
    { id: "b", work_id: "a" },
  ]);
  assert.deepEqual(cyclic.sort(), ["a", "b"]);
  const self = topoLayers([{ id: "x", work_id: "x" }]);
  assert.deepEqual(self.cyclic, []);
  assert.deepEqual(self.layers, [["x"]]);
});

test("pickHistoricalSource 只取 url 来源，无则回退 publication", () => {
  const revs = [
    { version: 2, snapshot: { sources: [{ kind: "self", citation: "x" }] } },
    { version: 1, sources: [{ kind: "url", url: "https://example.org/a", citation: "官方" }] },
  ];
  const src = pickHistoricalSource(revs);
  assert.equal(src.url, "https://example.org/a");
  assert.match(src.citation, /v1/);
  const fallback = pickHistoricalSource([]);
  assert.equal(fallback.kind, "publication");
  assert.match(fallback.citation, /仅切换 status/);
  const fallback2 = pickHistoricalSource([{ version: 1, snapshot: { sources: [{ kind: "self", citation: "x" }] } }]);
  assert.equal(fallback2.kind, "publication");
});

test("publishBlocker 拦截非 draft 与无翻译", () => {
  assert.equal(publishBlocker({ status: "draft", translations: { en: {} } }), null);
  assert.equal(publishBlocker({ status: "published", translations: { en: {} } }), "status_published");
  assert.equal(publishBlocker({ status: "draft", translations: {} }), "no_translations");
  assert.equal(publishBlocker({ status: "draft" }), "no_translations");
  assert.equal(publishBlocker(null), "missing_entity");
});
