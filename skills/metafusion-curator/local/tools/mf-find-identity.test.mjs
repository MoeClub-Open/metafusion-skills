import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { findIdentity, runCli } from "./mf-find-identity.mjs";

const entity = (id, extra = {}) => ({ id, kind: "work", title: "夜明け", status: "published", version: 1, ...extra });
const response = (records = [], overrides = {}) => ({ status: 200, body: {
  basis: "postgres_repeatable_read", total: records.length, complete: true,
  items: records.map((item) => ({ matched: item, canonical: item })), ...overrides } });
const query = (result, calls = []) => async (path, options) => {
  calls.push({ path, options });
  assert.equal(path, "/api/catalog/entities/candidates");
  assert.equal(options.method, "POST");
  assert.equal(options.tries, 1);
  return result;
};

test("一次候选查询查基础题名、翻译、别名与规范化空白；不再分页或单独 resolve", async () => {
  const item = entity("w", { title: "Different", translations: { ja: { title: "Other", aliases: ["  STAR\tSong　"] } } });
  const calls = [];
  const report = await findIdentity({ titles: ["star song"], requestFn: query(response([item]), calls) });
  assert.equal(calls.length, 1);
  assert.equal(report.coverage.complete, true);
  assert.equal(report.coverage.pages, 1);
  assert.equal(report.candidates[0].matched_reasons[0].matched_field, "translations.ja.aliases[0]");
  assert.equal(report.candidates[0].matched_reasons[0].strength, "weak_title_candidate");
  assert.equal(report.identity_confirmed, false);
});

test("同名候选分别保留，canonical 汇聚保留原始 ID 与理由", async () => {
  const old = entity("old"), current = entity("current"), other = entity("other");
  const report = await findIdentity({ titles: ["夜明け"], requestFn: query(response([], {
    total: 3, items: [{ matched: old, canonical: current }, { matched: current, canonical: current }, { matched: other, canonical: other }],
  })) });
  assert.deepEqual(report.candidates.map((item) => item.canonical_id), ["current", "other"]);
  assert.deepEqual(report.candidates[0].matched_original_ids, ["current", "old"]);
});

test("外部 ID、数字属性和数组属性仍保留独立匹配理由", async () => {
  const item = entity("w", { external_links: { wikidata: "Q123" }, attributes: { duration: 213, version_label: ["live", "studio"] } });
  const report = await findIdentity({ titles: ["夜明け"], externalIds: [{ kind: "wikidata", value: "Q123" }],
    attributes: [{ key: "duration", value: "213" }, { key: "version_label", value: "live" }], requestFn: query(response([item])) });
  assert.deepEqual(new Set(report.candidates[0].matched_reasons.map((r) => r.query_mode)),
    new Set(["title_normalized_equality", "external_id_exact", "attribute_exact"]));
  assert.equal(report.candidates[0].entity.attributes.duration, 213);
});

test("Expression 作用域和录音版本保留，跨 Work 或错误 kind 响应阻断结论", async () => {
  const a = entity("studio", { kind: "expression", work_id: "work-1", attributes: { version_label: "studio" } });
  const b = entity("live", { kind: "expression", work_id: "work-1", attributes: { version_label: "live" } });
  const calls = [];
  const report = await findIdentity({ kind: "expression", titles: ["夜明け"], workId: "work-1", limit: 37,
    requestFn: query(response([a, b]), calls) });
  assert.equal(report.candidates.length, 2);
  assert.equal(calls[0].options.body.work_id, "work-1");
  assert.equal(calls[0].options.body.limit, 37);
  for (const bad of [entity("bad"), { ...a, work_id: "work-2" }]) {
    const r = await findIdentity({ kind: "expression", titles: ["夜明け"], workId: "work-1", requestFn: query(response([bad])) });
    assert.equal(r.decision, "needs_evidence");
    assert.ok(r.unknown.length);
  }
});

test("截断、错误响应和失败不伪装为无重复，旧实例不回退全表扫描", async () => {
  const partial = await findIdentity({ titles: ["夜明け"], limit: 1, requestFn: query(response([entity("w")], { total: 2, complete: false })) });
  assert.equal(partial.coverage.complete, false);
  assert.equal(partial.coverage.failures[0].reason, "candidate_limit_exceeded");
  assert.equal(partial.decision, "needs_evidence");
  for (const result of [{ status: 404, body: { error: "not_found" } }, { status: 429, body: {} }, { status: 503, body: {} },
    { status: 200, body: { items: [], total: 0 } }, response([], { total: 1 }), response([entity("w"), entity("w")])]) {
    const calls = [];
    const r = await findIdentity({ titles: ["夜明け"], requestFn: query(result, calls) });
    assert.equal(r.decision, "needs_evidence");
    assert.ok(r.unknown.length);
    assert.equal(calls.length, 1);
  }
  const r = await findIdentity({ titles: ["x"], requestFn: async () => { throw new Error("network failed"); } });
  assert.equal(r.coverage.complete, false);
  assert.ok(r.errors.length);
});

test("未解析 canonical、已删除终点或无法核验的命中必须停止依赖写入", async () => {
  const original = entity("old");
  for (const row of [{ matched: original, canonical: null, resolution_error: "canonical_identity_unverified" },
    { matched: original, canonical: entity("target", { status: "deleted" }) },
    { matched: entity("unrelated", { title: "Unrelated" }), canonical: original }]) {
    const r = await findIdentity({ titles: ["夜明け"], requestFn: query(response([], { total: 1, items: [row] })) });
    assert.equal(r.decision, "needs_evidence");
    assert.ok(r.unknown.length);
  }
});

test("完整快照零候选只说明当前可见范围；并发改变无关数据不影响 coverage", async () => {
  let unrelatedTotal = 6611;
  for (let i = 0; i < 30; i++) {
    unrelatedTotal++;
    const r = await findIdentity({ titles: ["Missing"], requestFn: query(response()) });
    assert.equal(r.decision, "no_visible_candidate");
    assert.equal(r.coverage.complete, true);
    assert.match(r.decision_note, /不证明真实实例中不存在/u);
  }
  assert.equal(unrelatedTotal, 6641);
});

test("CLI 不完整响应非零；候选可返回零；结果文件仍为结构化 JSON", async () => {
  assert.equal(await runCli(["--title", "夜明け"], { stdout: () => {}, requestFn: query(response([], { total: 1, complete: false })) }), 2);
  const dir = await mkdtemp(join(tmpdir(), "mf-candidates-"));
  try {
    const out = join(dir, "result.json");
    const code = await runCli(["--title", "夜明け", "--out", out], { stdout: () => {}, requestFn: query(response([entity("w")])) });
    assert.equal(code, 0);
    const serialized = await readFile(out, "utf8");
    assert.ok(serialized.endsWith("\n"));
    assert.equal(JSON.parse(serialized).candidates[0].canonical_id, "w");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("帮助与导入无需凭据或网络", () => {
  const env = { ...process.env }; delete env.MF_PAT; delete env.MF_CREDENTIALS; delete env.MF_BASE;
  const script = fileURLToPath(new URL("./mf-find-identity.mjs", import.meta.url));
  for (const cwd of [process.cwd(), fileURLToPath(new URL(".", import.meta.url))]) {
    const help = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8", env, cwd });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /候选上限/u);
  }
});
