#!/usr/bin/env node
// 合并同作用域重复候选（来源预检 + 并集 + 身份冲突守卫 + 后端缺陷绕行）。
//
// 取代此前三个按批次生成的合并脚本（merge_lossless_union / merge_expression_then_downstream /
// merge_downstream_dups）——它们 80% 逻辑重复，且各自只认一类清单。
//
// 用法：
//   node mf-merge.mjs --from-report <gap-report.json> [--kinds expression,medium,track] [--apply --sources <sources.json>] [--reviews <identity-reviews.json>]
//   node mf-merge.mjs --pairs <pairs.json>              # [{kind, keep, lose, scopeNote}]
//   node mf-merge.mjs --merge <keepId> <loseId> [--apply --sources <sources.json>]
//
// 默认 dry-run。**按依赖顺序**处理：expression → content_unit → medium → track
//（track 的 400 duplicate_position 会随其 expression 归拢而消失）。
//
// 铁律：
//   · 身份冲突（同键异值的外部标识，或 duration/版次类属性不同）**一律拒绝合并**；
//   · 作用域不同一律拒绝（work 之外的结构实体必须同归属）；
//   · 遇 status=merged 直接跳过（幂等），不重复提交。

import { auditOutputDirectory } from "./mf-output.mjs";
import fs from "node:fs";
import { dirname } from "node:path";
import {
  KINDS, getEntityRetry, identityConflicts, mergeEntity, pickKeeper, scopeKey, sleep,
} from "./mf-lib.mjs";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const APPLY = flag("--apply");
const REPORT = opt("--from-report");
const PAIRS = opt("--pairs");
const MERGE = opt("--merge");
const SOURCES_FILE = opt("--sources");
const mergeSources = SOURCES_FILE ? JSON.parse(fs.readFileSync(SOURCES_FILE, "utf8")) : [];
const REVIEWS_FILE = opt("--reviews");
const mergeReviews = REVIEWS_FILE ? JSON.parse(fs.readFileSync(REVIEWS_FILE, "utf8")) : {};
if (!mergeReviews || typeof mergeReviews !== "object" || Array.isArray(mergeReviews))
  throw new Error("--reviews 必须是按 entity:<保留方UUID> 提供已审查 canonical ID 数组的对象");
if (APPLY && (!Array.isArray(mergeSources) || mergeSources.length === 0)) {
  throw new Error("--apply 必须通过 --sources <sources.json> 提供已核验的真实来源；不能仅凭审计重复候选或 self 合并");
}
// 依赖顺序：先表达，再篇章/载体/曲目
const ORDER = ["expression", "content_unit", "medium", "track", "work", "release", "collection", "agent"];

const log = [];
const out = `${auditOutputDirectory()}/mf-merge-${APPLY ? "applied" : "dryrun"}.json`;
function saveLog() {
  fs.mkdirSync(dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ apply: APPLY, atomic: false, merged, skipped, failed, log }, null, 2), "utf8");
}
let merged = 0, skipped = 0, failed = 0;

async function handlePair(kind, keepId, loseId, scopeNote) {
  const keep = await getEntityRetry(keepId);
  const lose = await getEntityRetry(loseId);
  if (!keep || !lose) { skipped += 1; log.push({ kind, keepId, loseId, result: "skip: 实体不存在" }); return; }
  if (keep.state === "merged" || lose.state === "merged") { skipped += 1; log.push({ kind, keepId, loseId, result: "skip: 已合并（幂等）" }); return; }
  if (keep.state !== "active") { skipped += 1; log.push({ kind, keepId, loseId, result: `skip: 保留方 status=${keep.state}（须 active）` }); return; }

  const note = scopeNote ?? `${kind} 同作用域`;
  if (kind !== "work" && kind !== "agent" && kind !== "collection") {
    if (scopeKey(kind, keep) !== scopeKey(kind, lose)) {
      skipped += 1; log.push({ kind, keepId, loseId, result: "skip: 作用域不同" }); return;
    }
  }
  const conflicts = identityConflicts(keep, lose);
  if (conflicts.length) {
    skipped += 1; log.push({ kind, keepId, loseId, result: `skip: 身份冲突 ${conflicts.join(",")}`, conflicts }); return;
  }

  const r = await mergeEntity({ kind, keep, lose, scopeNote: note, dryRun: !APPLY, sources: mergeSources,
    reviewedCandidateIDs: mergeReviews[`entity:${keepId}`] ?? [] });
  if (r.ok) {
    if (r.reason === "merged") merged += 1; else skipped += 1;
    log.push({ kind, keepId, loseId, result: r.reason, ...r });
  } else {
    failed += 1;
    log.push({ kind, keepId, loseId, result: r.reason, ...r });
    if (APPLY) {
      saveLog();
      console.error(JSON.stringify({ atomic: false, failedPair: { kind, keepId, loseId }, result: r }, null, 2));
      throw new Error("合并失败：停止后续批次；检查 completedSteps 与 partial，勿自动重跑写入");
    }
  }
  await sleep(80);
}

if (MERGE) {
  const [keepId, loseId] = MERGE.split(",").length === 2 ? MERGE.split(",") : [opt("--merge"), argv[argv.indexOf("--merge") + 2]];
  const keep = await getEntityRetry(keepId);
  if (!keep) throw new Error(`保留方不存在：${keepId}`);
  await handlePair(keep.kind, keepId, loseId, opt("--scope"));
} else if (PAIRS) {
  const pairs = JSON.parse(fs.readFileSync(PAIRS, "utf8"));
  for (const kind of ORDER) {
    for (const p of pairs.filter((x) => x.kind === kind)) {
      await handlePair(kind, p.keep, p.lose, p.scopeNote);
    }
  }
} else if (REPORT) {
  const rep = JSON.parse(fs.readFileSync(REPORT, "utf8"));
  const only = (opt("--kinds") || "").split(",").filter(Boolean);
  for (const kind of ORDER) {
    if (only.length && !only.includes(kind)) continue;
    const groups = rep.duplicates?.[kind]?.same_scope ?? [];
    if (!groups.length) continue;
    for (const grp of groups) {
      const live = [];
      for (const it of grp.items ?? []) {
        if (it.state && it.state !== "active") continue;
        const e = await getEntityRetry(it.id);
        if (e && e.state === "active") live.push(e);
      }
      if (live.length < 2) { skipped += 1; continue; }
      const keep = pickKeeper(live);
      for (const lose of live.filter((e) => e.id !== keep.id)) {
        await handlePair(kind, keep.id, lose.id, `${kind} 同作用域（审计报告组「${grp.key}」）`);
      }
    }
  }
} else {
  console.error("用法：node mf-merge.mjs --from-report <gap-report.json> [--kinds a,b] [--apply --sources <sources.json>] [--reviews <identity-reviews.json>]");
  console.error("      node mf-merge.mjs --pairs <pairs.json> [--apply --sources <sources.json>] [--reviews <identity-reviews.json>]");
  console.error("      node mf-merge.mjs --merge <keepId>,<loseId> [--apply --sources <sources.json>] [--reviews <identity-reviews.json>]");
  process.exit(2);
}

console.log(`=== ${APPLY ? "APPLY" : "DRY-RUN"} === merged=${merged} skipped=${skipped} failed=${failed}`);
const byReason = {};
for (const r of log) byReason[String(r.result).split(":")[0]] = (byReason[String(r.result).split(":")[0]] ?? 0) + 1;
console.log("结果分布:", JSON.stringify(byReason));
for (const r of log.filter((x) => /skip|HTTP|失败/.test(String(x.result))).slice(0, 25)) {
  console.log(`  ${String(r.result).padEnd(34)} | ${r.kind ?? "?"} | ${String(r.keepId ?? "").slice(0, 13)}`);
}
saveLog();
console.log("明细写入", out);
