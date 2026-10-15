#!/usr/bin/env node
// 全站来源审计（只读）：逐个可见实体读修订历史，按"创建时的 edit_note"判定来源类别。
//
// 回答的是编目最要紧的那个问题：**线上还剩下哪些不是真实可获得的数据**。
// 不猜标题、不改任何东西；判定只依据 revisions 最早一条的 edit_note 与题名特征。
//
// 用法：node mf-audit-provenance.mjs
// 产出：系统临时目录中的 provenance-audit.json；MF_AUDIT_OUT 可指定任务目录

import { auditOutputDirectory } from "./mf-output.mjs";
import fs from "node:fs";
import { KINDS, call, listKind, sleep } from "./mf-lib.mjs";

const OUT_DIR = auditOutputDirectory();
const CONCURRENCY = Number(process.env.MF_CONCURRENCY || 20);
if (!Number.isInteger(CONCURRENCY) || CONCURRENCY < 1 || CONCURRENCY > 100) throw new Error("MF_CONCURRENCY 必须为 1–100 整数");

// 已废弃的合成管线自己写的备注（mass_ingest / wave_runner / scale_engine 测试包）
const PIPELINE = /规模拓扑注入|大规模数据注入|Scale engine verification/i;
// 探针/仿真/示例类（历史会话留下的测试痕迹）
const TESTY = /probe|探针|仿真|smoke|dummy|sample|示例|样例|test[- ]?data/i;

/** 只读 GET；非 2xx 抛错（不静默当空修订）。 */
async function get(p) {
  const r = await call(p);
  if (r.status !== 200) throw new Error(`GET ${p} -> HTTP ${r.status}`);
  return r.body;
}

const all = [];
for (const k of KINDS) {
  const items = await listKind(k);
  console.log(`${k}: ${items.length}`);
  for (const it of items) all.push({ id: it.id, kind: k, title: it.title, status: it.state });
}
console.log("可见实体合计: " + all.length);

const flagged = [];
const unknown = [];
let idx = 0, done = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (idx < all.length) {
    const e = all[idx++];
    let items = [];
    try { items = (await get(`/api/catalog/entities/${e.id}/revisions`))?.items ?? []; }
    catch (error) { unknown.push({ id: e.id, kind: e.kind, reason: String(error) }); }
    if (items.length === 0 && !unknown.some((u) => u.id === e.id)) unknown.push({ id: e.id, kind: e.kind, reason: "未取得修订记录" });
    const first = items.length ? items[items.length - 1] : null;   // 最早一条 = 创建时备注
    const note = first?.edit_note ?? "";
    const hit = PIPELINE.test(note) ? "pipeline"
      : TESTY.test(note) ? "testy"
      : TESTY.test(e.title ?? "") ? "testy_title" : "";
    if (hit) flagged.push({ id: e.id, kind: e.kind, title: e.title, note, hit, at: first?.created_at });
    done += 1;
    if (done % 500 === 0) console.log(`  progress ${done}/${all.length}`);
    if (done % 100 === 0) await sleep(60);
  }
}));

fs.mkdirSync(OUT_DIR, { recursive: true });
const out = `${OUT_DIR}/provenance-audit.json`;
fs.writeFileSync(out, JSON.stringify({ scope: "创建时备注的历史线索，不判定当前事实权威性", current_sources_verified: false, total: all.length, flagged: flagged.length, unknown: unknown.length, unknown_items: unknown, items: flagged }, null, 2), "utf8");
const byHit = {};
for (const f of flagged) byHit[f.hit] = (byHit[f.hit] ?? 0) + 1;
console.log(`=== 历史备注待核线索：${flagged.length} / ${all.length} ===`);
console.log("未能检查:", unknown.length, "；未核验当前修订的逐字段 P1，不作为来源通过或不通过结论");
console.log("分类:", JSON.stringify(byHit));
for (const f of flagged.slice(0, 40)) console.log(`  ${f.kind.padEnd(12)} | ${String(f.title).slice(0, 36).padEnd(36)} | ${f.hit} | ${String(f.note).slice(0, 60)}`);
console.log("写入", out);
