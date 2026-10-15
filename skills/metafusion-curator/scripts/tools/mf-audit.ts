#!/usr/bin/env node
// 全站数据质量审计（纯只读）：只发 GET；不创建/修改/删除任何实体。
//
// 产出（默认系统临时目录，可用 MF_AUDIT_OUT 指定任务目录）：
//   缺封面 / 缺语种 / 结构断链（区分 missing·soft_deleted·merged·kind_mismatch）/
//   Release.subjects 未覆盖 / 裸母体 Work / 孤儿子级 / 同作用域真重复组。
//
// 用法：node mf-audit.ts
//
// 口径：列表接口默认不含软删除实体；凡"被引用但不在可见集合里"的目标都逐条 GET 复核。
// 分页 limit 上限 100（传 200 会 400 invalid_limit）。
import { auditOutputDirectory } from "./mf-output.ts";
import fs from "node:fs";
import path from "node:path";
import { collectPages } from "../metafusion-api.ts";

// ── 客户端：统一走技能自带 metafusion-api.ts（PAT 认证），本脚本不再自带 HTTP 客户端 ──
import { call as mfCall, scopeKey as entityScopeKey } from "./mf-lib.ts";

const BASE = (process.env.MF_BASE || "").replace(/\/+$/, "") || "（由 metafusion-api 的 credentials.json 决定）";
const OUT_DIR = auditOutputDirectory();
const KINDS = ["work", "content_unit", "expression", "release", "medium", "track", "agent", "collection"];
// 可选的任务清单；不读取技能安装目录中的历史批次产物。
const KNOWN13_FILE = process.env.MF_KNOWN_PACKAGES || null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let detailGets = 0;

/** 只读 GET 包装：非 2xx 直接抛错（绝不把失败静默成空数据）。 */
async function call(p) {
  const r = await mfCall(p);
  if (r.status !== 200 && r.status !== 404) {
    throw new Error(`GET ${p} -> HTTP ${r.status} ${r.body?.error ?? ""}`.trim());
  }
  return { status: r.status, body: r.body };
}

async function collectKind(kind) {
  let first = true;
  return collectPages("/api/catalog/entities", {
    params: { kind },
    limit: 100,
    requestFn: async (pathname) => {
      if (!first) await sleep(100);
      first = false;
      return mfCall(pathname);
    },
  });
}

const resolved = new Map();
async function resolveTarget(id) {
  if (resolved.has(id)) return resolved.get(id);
  detailGets++;
  const r = await call("/api/catalog/entities/" + id);
  let out;
  if (r.status === 404) out = { id: id, resolution: "missing", http: 404 };
  else if (r.status === 200 && r.body) out = { id: id, resolution: r.body.state === "deleted" ? "soft_deleted" : (r.body.state === "merged" ? "merged" : "exists_other"), http: 200, kind: r.body.kind, status: r.body.state, title: r.body.title };
  else out = { id: id, resolution: "unresolved", http: r.status };
  resolved.set(id, out);
  return out;
}

const normTitle = (s) => String(s || "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
const hasPics = (e) => Array.isArray(e.pictures) && e.pictures.length > 0;
const hasText = (e, lang) => {
  const t = e.translations && e.translations[lang];
  return !!(t && String(t.title || "").trim());
};
const richTitle = (e) => {
  const out = { zhCN: e.title, zhTW: null, ja: null, enUS: null };
  const t = e.translations || {};
  for (const k of ["zh-CN", "zh-TW", "ja", "ja-JP", "en-US"]) {
    if (t[k] && String(t[k].title || "").trim()) out[k === "ja-JP" ? "ja" : (k === "zh-CN" ? "zhCN" : (k === "zh-TW" ? "zhTW" : "enUS"))] = t[k].title;
  }
  return out;
};
const t0 = Date.now();
const byKind: Record<string, any> = {};
const all = new Map();
const listMeta: Record<string, any> = {};
for (const kind of KINDS) {
  const { items, coverage } = await collectKind(kind);
  if (!coverage.complete) {
    const statuses = [...new Set(coverage.failures.map((failure) => failure.status).filter((status) => Number.isInteger(status) && status > 0))];
    const statusText = statuses.length ? ` HTTP ${statuses.join(",")}` : "";
    const error: Error & { coverage?: unknown } = new Error(`列表读取不完整 kind=${kind}${statusText}；coverage=${JSON.stringify(coverage)}`);
    error.coverage = coverage;
    throw error;
  }
  byKind[kind] = items;
  for (const it of items) all.set(it.id, it);
  listMeta[kind] = coverage;
  console.log("  " + kind.padEnd(13) + " total=" + coverage.total + " raw=" + coverage.rawCount + " unique=" + coverage.uniqueCount + " pages=" + coverage.pages
    + (coverage.complete ? "" : "  !! coverage 不完整"));
}
console.log("共 " + all.size + " 个可见实体；用时 " + ((Date.now() - t0) / 1000).toFixed(1) + "s");

const label = (e) => ({ id: e.id, kind: e.kind, title: e.title, status: e.state });
const titleOf = (id) => { const e = all.get(id); return e ? e.title : "(父级不可见)"; };

// ===== 1. 缺封面 =====
const noPic: Record<string, any> = {};
let noPicTotal = 0;
for (const kind of KINDS) {
  const miss = byKind[kind].filter((e) => !hasPics(e));
  noPic[kind] = { count: miss.length, total: byKind[kind].length, items: miss.slice(0, 200).map(label), truncated: miss.length > 200 };
  noPicTotal += miss.length;
}
console.log("缺封面: " + noPicTotal + " / " + all.size);

// ===== 2. 标题缺四语 =====
const missingLang = [];
const langCounts = { "zh-CN": 0, "zh-TW": 0, ja: 0, "en-US": 0 };
for (const kind of KINDS) {
  for (const e of byKind[kind]) {
    const miss = [];
    if (!hasText(e, "zh-CN")) miss.push("zh-CN");
    if (!hasText(e, "zh-TW")) miss.push("zh-TW");
    if (!hasText(e, "ja") && !hasText(e, "ja-JP")) miss.push("ja");
    if (!hasText(e, "en-US")) miss.push("en-US");
    if (miss.length) {
      for (const m of miss) langCounts[m]++;
      missingLang.push({ id: e.id, kind: kind, title: e.title, missing: miss, have: richTitle(e) });
    }
  }
}
console.log("标题不齐(至少缺一语): " + missingLang.length);

// ===== 3. 结构断链 =====
const REFS = [];
const addRef = (from, field, targetId, expectKind, via) => { REFS.push({ from: from, field: field, targetId: targetId || null, expectKind: expectKind, via: via }); };
for (const e of byKind.content_unit) addRef(e, "work_id", e.work_id, "work", "cu.work_id");
for (const e of byKind.expression) {
  addRef(e, "work_id", e.work_id, "work", "expression.work_id");
  if (e.content_unit_id) addRef(e, "content_unit_id", e.content_unit_id, "content_unit", "expression.content_unit_id");
}
for (const e of byKind.medium) addRef(e, "release_id", e.release_id, "release", "medium.release_id");
for (const e of byKind.track) {
  addRef(e, "medium_id", e.medium_id, "medium", "track.medium_id");
  for (const c of (Array.isArray(e.contents) ? e.contents : [])) addRef(e, "contents[].expression_id", c && c.expression_id, "expression", "track.contents");
}
for (const e of byKind.release) for (const s of (Array.isArray(e.subjects) ? e.subjects : [])) addRef(e, "subjects[].work_id", s && s.work_id, "work", "release.subjects");

const breaks: Record<string, any> = {};
const pushBreak = (key, row) => { if (!breaks[key]) breaks[key] = []; breaks[key].push(row); };
const unresolvedIds = new Set();
for (const ref of REFS) {
  if (!ref.targetId) { pushBreak("empty_ref", Object.assign(label(ref.from), { field: ref.field, via: ref.via, target_id: null, detail: "字段为空/缺失" })); continue; }
  const tgt = all.get(ref.targetId);
  if (tgt) {
    if (tgt.kind !== ref.expectKind) pushBreak("kind_mismatch", Object.assign(label(ref.from), { field: ref.field, via: ref.via, target_id: ref.targetId, target_kind: tgt.kind, expect_kind: ref.expectKind }));
    continue;
  }
  unresolvedIds.add(ref.targetId);
}
console.log("需逐条复核的不可见引用目标: " + unresolvedIds.size);
const unresolvedArr = [...unresolvedIds];
let ui = 0;
await Promise.all(Array.from({ length: 6 }, async () => {
  while (ui < unresolvedArr.length) {
    const id = unresolvedArr[ui++];
    await resolveTarget(id);
    if (ui % 40 === 0) console.log("  复核 " + ui + "/" + unresolvedArr.length);
    await sleep(50);
  }
}));
const seenRefKey = new Set();
for (const ref of REFS) {
  if (!ref.targetId) continue;
  if (all.has(ref.targetId)) continue;
  const k = ref.from.id + "|" + ref.field + "|" + ref.targetId;
  if (seenRefKey.has(k)) continue;
  seenRefKey.add(k);
  const res = resolved.get(ref.targetId) || { resolution: "unresolved" };
  pushBreak(res.resolution, Object.assign(label(ref.from), {
    field: ref.field, via: ref.via, target_id: ref.targetId, target_resolution: res.resolution,
    target_http: res.http, target_kind: res.kind || null, target_status: res.status || null,
    target_title: res.title || null, expect_kind: ref.expectKind,
  }));
}
for (const k of Object.keys(breaks)) {
  const uniq = new Map();
  for (const r of breaks[k]) uniq.set(r.id + "|" + r.field + "|" + r.target_id, r);
  breaks[k] = [...uniq.values()];
}

// ===== 3b. Release.subjects 未覆盖 Track 引用的 Work =====
const undeclared = [];
const releaseCoverMiss = [];
for (const e of byKind.track) {
  const med = e.medium_id ? all.get(e.medium_id) : null;
  const rel = med && med.release_id ? all.get(med.release_id) : null;
  for (const c of (Array.isArray(e.contents) ? e.contents : [])) {
    const expr = c && c.expression_id ? all.get(c.expression_id) : null;
    if (!expr) { releaseCoverMiss.push({ track_id: e.id, expression_id: c?.expression_id, reason: "expression 不可见，未核验 subjects 覆盖" }); continue; }
    const workId = expr.work_id;
    if (!rel) { releaseCoverMiss.push({ track_id: e.id, medium_id: e.medium_id, release_id: med && med.release_id, work_id: workId, reason: "medium/release 不可见" }); continue; }
    const declared = Array.isArray(rel.subjects) && rel.subjects.some((s) => s && s.work_id === workId);
    if (!declared) undeclared.push({ release_id: rel.id, release_title: rel.title, track_id: e.id, track_title: e.title, expression_id: expr.id, work_id: workId, work_title: titleOf(workId) });
  }
}
const undeclaredByRelease = new Map();
for (const u of undeclared) {
  if (!undeclaredByRelease.has(u.release_id)) undeclaredByRelease.set(u.release_id, { release_id: u.release_id, release_title: u.release_title, affected_tracks: 0, missing_work_ids: new Set(), samples: [] });
  const g = undeclaredByRelease.get(u.release_id);
  g.affected_tracks++; g.missing_work_ids.add(u.work_id);
  if (g.samples.length < 5) g.samples.push({ track_id: u.track_id, track_title: u.track_title, work_id: u.work_id, work_title: u.work_title });
}
const undeclaredGroups = [...undeclaredByRelease.values()].map((g) => Object.assign({}, g, { missing_work_ids: [...g.missing_work_ids] }));
console.log("Release.subjects 未覆盖: " + undeclared.length + " 条 track 引用 / " + undeclaredGroups.length + " 个 release");

// ===== 4. 裸母体 Work =====
const cuWork = new Set(byKind.content_unit.map((e) => e.work_id).filter(Boolean));
const exprWork = new Set(byKind.expression.map((e) => e.work_id).filter(Boolean));
const relWork = new Set();
for (const e of byKind.release) for (const s of (Array.isArray(e.subjects) ? e.subjects : [])) if (s && s.work_id) relWork.add(s.work_id);
let known13 = [];
try {
  const a = KNOWN13_FILE ? JSON.parse(fs.readFileSync(KNOWN13_FILE, "utf8")) : [];
  known13 = Array.isArray(a) ? a.map((x) => (x && (x.id || (x.work && x.work.id))) || null).filter(Boolean) : [];
} catch (e3) {}
const known13Set = new Set(known13);
const bareWorks = byKind.work.filter((w) => !cuWork.has(w.id) && !exprWork.has(w.id) && !relWork.has(w.id))
  .map((w) => ({ id: w.id, title: w.title, original_language: w.original_language || null, known_pending: known13Set.has(w.id) }));
const bareKnown = bareWorks.filter((w) => w.known_pending);
const bareOther = bareWorks.filter((w) => !w.known_pending);
console.log("裸母体 Work: " + bareWorks.length + "（已知待补 " + bareKnown.length + " / 其它 " + bareOther.length + "）");

// ===== 5. 孤儿子级 =====
const orphans = { content_unit: [], expression: [], medium: [], track: [] };
const pushOrphan = (bucket, e, field, tid) => {
  let res = "empty";
  if (tid) { const r = resolved.get(tid); res = r ? r.resolution : "unresolved"; }
  bucket.push({ id: e.id, title: e.title, field: field, target_id: tid || null, target_resolution: res });
};
for (const e of byKind.content_unit) if (!e.work_id || !all.has(e.work_id)) pushOrphan(orphans.content_unit, e, "work_id", e.work_id);
for (const e of byKind.expression) {
  if (!e.work_id || !all.has(e.work_id)) pushOrphan(orphans.expression, e, "work_id", e.work_id);
  if (e.content_unit_id && !all.has(e.content_unit_id)) pushOrphan(orphans.expression, e, "content_unit_id", e.content_unit_id);
}
for (const e of byKind.medium) if (!e.release_id || !all.has(e.release_id)) pushOrphan(orphans.medium, e, "release_id", e.release_id);
for (const e of byKind.track) {
  if (!e.medium_id || !all.has(e.medium_id)) pushOrphan(orphans.track, e, "medium_id", e.medium_id);
  for (const c of (Array.isArray(e.contents) ? e.contents : [])) {
    const xid = c && c.expression_id;
    if (xid && !all.has(xid)) pushOrphan(orphans.track, e, "contents[].expression_id", xid);
  }
}
const orphanStats: Record<string, any> = {};
for (const k of Object.keys(orphans)) {
  const byRes: Record<string, any> = {};
  for (const r of orphans[k]) byRes[r.target_resolution] = (byRes[r.target_resolution] || 0) + 1;
  orphanStats[k] = { count: orphans[k].length, by_resolution: byRes };
}
console.log("孤儿子级: " + JSON.stringify(orphanStats));

// ===== 6. 可能重复 =====
const scopeKey = entityScopeKey;
function dupGroups(kind) {
  const m = new Map();
  for (const e of byKind[kind]) {
    const titleKey = normTitle(e.title);
    const k = titleKey;
    if (!k) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(e);
  }
  const groups = [];
  for (const [k, list] of m) {
    if (list.length < 2) continue;
    const isScoped = ["content_unit", "expression", "medium", "track", "release"].includes(kind);
    const scopes = new Set(list.map((e) => scopeKey(kind, e)));
    groups.push({ key: k, count: list.length, same_scope: isScoped ? scopes.size === 1 : true, scopes: [...scopes].filter(Boolean), items: list.map(label) });
  }
  return groups;
}
const duplicates: Record<string, any> = {};
for (const kind of KINDS) {
  const exact = dupGroups(kind);
  const sameScope = exact.filter((g) => g.same_scope);
  const crossScope = exact.filter((g) => !g.same_scope);
  duplicates[kind] = {
    groups: exact.length,
    entities: exact.reduce((a, g) => a + g.count, 0),
    same_scope_groups: sameScope.length,
    same_scope: sameScope.slice(0, 2000),
    cross_scope_groups: crossScope.length,
    cross_scope_sample: crossScope.slice(0, 300),
    cross_scope_total_entities: crossScope.reduce((a, g) => a + g.count, 0),
  };
}
const dupTotalGroups = Object.values(duplicates).reduce((a, d) => a + d.groups, 0);
const dupSameScope = Object.values(duplicates).reduce((a, d) => a + d.same_scope_groups, 0);
console.log("题名完全重复（归一化）组数: " + dupTotalGroups + "（同作用域 " + dupSameScope + "）");

// ===== 7. 附加统计（派活优先级用）=====
const missingTrByKind: Record<string, any> = {};
for (const it of missingLang) missingTrByKind[it.kind] = (missingTrByKind[it.kind] || 0) + 1;
const exprNoCU = byKind.expression.filter((e) => !e.content_unit_id);
const exprNoCUByWork: Record<string, any> = {};
for (const e of exprNoCU) { const w = e.work_id || "(无 work_id)"; exprNoCUByWork[w] = (exprNoCUByWork[w] || 0) + 1; }
const trackExprIds = new Set();
for (const e of byKind.track) for (const c of (Array.isArray(e.contents) ? e.contents : [])) if (c && c.expression_id) trackExprIds.add(c.expression_id);
const exprNoCUUsedInTrack = exprNoCU.filter((e) => trackExprIds.has(e.id)).length;
const exprNoCUTopWorks = Object.entries(exprNoCUByWork).sort((a, b) => b[1] - a[1]).slice(0, 20).map((x) => ({ work_id: x[0], work_title: titleOf(x[0]), count: x[1] }));
const PICTURE_KINDS = ["work", "release", "agent", "collection"];
const pictureGapDisplay = PICTURE_KINDS.reduce((a, k) => a + noPic[k].count, 0);
const pictureGapStructural = noPicTotal - pictureGapDisplay;
const sameScopeDup = [];
for (const k of KINDS) for (const g of duplicates[k].same_scope) sameScopeDup.push(Object.assign({ kind: k }, g));
const dupPrefix: Record<string, any> = {};
for (const g of sameScopeDup) for (const pf of new Set<string>(g.items.map((i) => i.id.slice(0, 8)))) dupPrefix[pf] = (dupPrefix[pf] || 0) + 1;
const dupPrefixTop = Object.entries(dupPrefix).sort((a, b) => b[1] - a[1]).slice(0, 12).map((x) => ({ prefix: x[0], groups: x[1] }));
const extras = {
  missing_translations_by_kind: missingTrByKind,
  picture_gap: { display_kinds: PICTURE_KINDS, display_kind_gap: pictureGapDisplay, structural_kind_gap: pictureGapStructural },
  expression_without_content_unit: { count: exprNoCU.length, used_by_track: exprNoCUUsedInTrack, distinct_works: Object.keys(exprNoCUByWork).length, top_works: exprNoCUTopWorks },
  duplicate_same_scope_total_groups: sameScopeDup.length,
  duplicate_id_prefix_top: dupPrefixTop,
};
console.log("附加统计：展示型 kind 缺封面 " + pictureGapDisplay + " / 结构型 " + pictureGapStructural + " / 无 content_unit 的 expression " + exprNoCU.length + "(其中被 track 引用 " + exprNoCUUsedInTrack + ")");

// ---------- 写出 ----------
fs.mkdirSync(OUT_DIR, { recursive: true });
const listComplete = Object.values(listMeta).every((m) => m.complete);
const report = {
  coverage: { basis: "仅当前调用者可见的实体列表范围；不证明全库、来源或身份完整",
    list_complete: listComplete, by_kind: listMeta, subject_checks_unknown: releaseCoverMiss.length,
    current_sources_verified: false, cover_rights_verified: false, duplicate_identity_verified: false },
  generated_at: new Date().toISOString(),
  base: BASE,
  mode: "read-only",
  note: "GET 只读审计；未创建/修改/删除任何实体。detail GET 次数 " + detailGets,
  totals: { entities: all.size, by_kind: Object.fromEntries(KINDS.map((k) => [k, byKind[k].length])) },
  list_meta: listMeta,
  summary: {
    missing_pictures_total: noPicTotal,
    missing_pictures_by_kind: Object.fromEntries(KINDS.map((k) => [k, noPic[k].count])),
    missing_translations_total: missingLang.length,
    missing_translation_lang_counts: langCounts,
    dangling_refs: {
      missing: (breaks.missing || []).length,
      soft_deleted: (breaks.soft_deleted || []).length,
      merged: (breaks.merged || []).length,
      kind_mismatch: (breaks.kind_mismatch || []).length,
      empty_ref: (breaks.empty_ref || []).length,
      exists_other: (breaks.exists_other || []).length,
      unresolved: (breaks.unresolved || []).length,
    },
    undeclared_release_subjects_tracks: undeclared.length,
    undeclared_release_subjects_releases: undeclaredGroups.length,
    bare_works_total: bareWorks.length,
    bare_works_known_pending: bareKnown.length,
    bare_works_other: bareOther.length,
    orphans: orphanStats,
    duplicate_groups: dupTotalGroups,
    duplicate_same_scope_groups: dupSameScope,
  },
  missing_pictures: noPic,
  missing_translations: { count: missingLang.length, items: missingLang.slice(0, 3000), truncated: missingLang.length > 3000 },
  structural: {
    breaks: breaks,
    undeclared_release_subjects: { track_count: undeclared.length, releases: undeclaredGroups, raw_sample: undeclared.slice(0, 500) },
    release_cover_miss: releaseCoverMiss.slice(0, 500),
    detail_get_count: detailGets,
  },
  bare_works: { total: bareWorks.length, known_pending: bareKnown, other: bareOther, known13_file: KNOWN13_FILE, known13_ids: known13 },
  orphans: { stats: orphanStats, lists: orphans },
  duplicates: duplicates,
  extras: extras,
};
fs.writeFileSync(path.join(OUT_DIR, "gap-report.json"), JSON.stringify(report, null, 2), "utf8");

// ---------- Markdown ----------
const pct = (n, d) => d ? (100 * n / d).toFixed(1) + "%" : "-";
const L = [];
L.push("# 全站数据质量缺口清单（只读审计）");
L.push("");
L.push("- 生成时间：" + report.generated_at);
L.push("- 目标实例：" + BASE);
L.push("- 口径：纯只读，只发 GET /api/catalog/entities（分页 limit=100）与 GET /api/catalog/entities/{id}（复核不可见父级）。coverage 仅代表当前调用者可见列表范围；未创建/修改/删除任何实体。");
L.push(`- 机读版：${OUT_DIR}/gap-report.json`);
L.push("");
L.push("## 0. 总量与分页核对");
L.push("");
L.push("| kind | total | raw | 唯一 id | 页数 | 分页完整 |");
L.push("| --- | --- | --- | --- | --- | --- |");
let sumK = 0;
for (const k of KINDS) { sumK += byKind[k].length; L.push("| " + k + " | " + (listMeta[k].total == null ? "-" : listMeta[k].total) + " | " + listMeta[k].rawCount + " | " + listMeta[k].uniqueCount + " | " + listMeta[k].pages + " | " + (listMeta[k].complete ? "是" : "否") + " |"); }
const allListMeta = Object.values(listMeta);
const totalSum = allListMeta.every((m) => m.total !== null) ? allListMeta.reduce((sum, m) => sum + m.total, 0) : null;
const rawSum = allListMeta.reduce((sum, m) => sum + m.rawCount, 0);
const uniqueSum = allListMeta.reduce((sum, m) => sum + m.uniqueCount, 0);
L.push("| 合计 | " + (totalSum ?? "-") + " | " + rawSum + " | " + uniqueSum + " | — | " + (listComplete ? "是" : "否") + " |");
L.push("");
L.push("## 1. 缺封面（pictures 为空）");
L.push("");
L.push("| kind | 缺封面 | 占该 kind | 该 kind 总数 |");
L.push("| --- | --- | --- | --- |");
for (const k of KINDS) L.push("| " + k + " | " + noPic[k].count + " | " + pct(noPic[k].count, noPic[k].total) + " | " + noPic[k].total + " |");
L.push("| 合计 | " + noPicTotal + " | " + pct(noPicTotal, all.size) + " | " + all.size + " |");
L.push("");
L.push("> 每类前 200 个 id/题名见 JSON missing_pictures[kind].items。");
L.push("");
L.push("## 2. 标题缺四语（zh-CN / zh-TW / ja 或 ja-JP / en-US）");
L.push("");
L.push("| 缺失语种 | 实体数 |");
L.push("| --- | --- |");
for (const k of Object.keys(langCounts)) L.push("| " + k + " | " + langCounts[k] + " |");
L.push("");
L.push("至少缺一语的实体共 " + missingLang.length + " / " + all.size + "。明细（含已有语种）见 JSON missing_translations.items。");
L.push("");
L.push("| kind | 缺至少一语 | 该 kind 总数 |");
L.push("| --- | --- | --- |");
for (const k of KINDS) L.push("| " + k + " | " + (missingTrByKind[k] || 0) + " | " + byKind[k].length + " |");
L.push("");
L.push("> 基字段 title 不计入 translations；按需求口径只统计 translations 里是否有该语种。");
L.push("");
L.push("## 3. 结构断链");
L.push("");
const bname = { missing: "当前调用者不可见或目标不存在（404）", soft_deleted: "目标已软删除（行仍在，不算断链）", merged: "目标已合并", kind_mismatch: "目标 kind 不符", empty_ref: "字段为空/缺失", exists_other: "目标存在但状态异常", unresolved: "无法判定" };
L.push("| 判定 | 引用条数 |");
L.push("| --- | --- |");
for (const k of ["missing", "soft_deleted", "merged", "kind_mismatch", "empty_ref", "exists_other", "unresolved"]) L.push("| " + bname[k] + " | " + ((breaks[k] || []).length) + " |");
L.push("");
L.push("> 软删除不计作断链，单列。列表接口默认不返回软删除实体；凡引用目标不在可见集合中的都逐条 GET 复核。");
L.push("");
L.push("### 3.1 Release.subjects 未覆盖其 Track 引用的 Work");
L.push("");
L.push("- 涉及 track 引用：" + undeclared.length + " 条；涉及 release：" + undeclaredGroups.length + " 个。");
if (undeclaredGroups.length) {
  L.push("");
  L.push("| release_id | 题名 | 受影响 track | 未声明的 work 数 |");
  L.push("| --- | --- | --- | --- |");
  for (const g of undeclaredGroups.slice(0, 80)) L.push("| " + g.release_id + " | " + String(g.release_title || "").replace(/\|/g, " ") .slice(0, 60) + " | " + g.affected_tracks + " | " + g.missing_work_ids.length + " |");
}
L.push("");
L.push("## 4. 裸母体 Work（无 ContentUnit / Expression / Release）");
L.push("");
L.push("- 合计 " + bareWorks.length + "；其中清单内待补 = " + bareKnown.length + "，其余需排查 = " + bareOther.length + "。");
L.push("");
L.push("### 4.1 清单内待补（清单共 " + known13.length + " 个 id）");
L.push("");
for (const w of bareKnown) L.push("- " + w.id + " " + w.title);
L.push("");
L.push("### 4.2 其余裸母体（" + bareOther.length + " 个，需人工判断）");
L.push("");
for (const w of bareOther) L.push("- " + w.id + " " + w.title);
L.push("");
L.push("## 5. 孤儿子级");
L.push("");
L.push("| kind | 孤儿条数 | 判定分布 |");
L.push("| --- | --- | --- |");
for (const k of Object.keys(orphans)) L.push("| " + k + " | " + orphanStats[k].count + " | " + JSON.stringify(orphanStats[k].by_resolution) + " |");
L.push("");
L.push("## 6. 可能重复（题名归一化后完全相同）");
L.push("");
L.push("| kind | 组数 | 涉及实体 | 同作用域组(候选) | 跨作用域组(一般正常) |");
L.push("| --- | --- | --- | --- | --- |");
for (const k of KINDS) L.push("| " + k + " | " + duplicates[k].groups + " | " + duplicates[k].entities + " | " + duplicates[k].same_scope_groups + " | " + duplicates[k].cross_scope_groups + " |");
L.push("| 合计 | " + dupTotalGroups + " | | " + dupSameScope + " | " + Object.values(duplicates).reduce((a, d) => a + d.cross_scope_groups, 0) + " |");
L.push("");
L.push("> 同作用域 = 结构实体（CU/Expression 同 work_id、Medium 同 release_id、Track 同 medium_id、Release 同 subjects），同名仅代表重复候选，标签只提供线索，身份仍须官方来源核验；跨作用域多为不同作品下的同名篇目（如各动画的第1话），一般正常。完整 id 列表见 JSON duplicates。");
L.push("");
L.push("### 6.1 同作用域重复按 id 前缀聚合（定位重复批次）");
L.push("");
for (const x of dupPrefixTop) L.push("- 前缀 " + x.prefix + "：涉及 " + x.groups + " 组");
L.push("");
L.push("## 7. 缺封面口径拆分");
L.push("");
L.push("- 展示型 kind（work / release / agent / collection，详情页有封面位）：缺 " + pictureGapDisplay + " 个。");
L.push("- 结构型 kind（content_unit / expression / medium / track）：缺 " + pictureGapStructural + " 个；是否需要封面依实体用途与权利证据判断，缺图数量不等于事实错误。");
L.push("");
L.push("## 8. Expression 缺 content_unit_id（" + exprNoCU.length + " 个）");
L.push("");
L.push("- definitions 里 expression 的必填字段只有 work_id；content_unit_id 为选填（scoped_by work_id）。");
L.push("- 此引用为选填，未填写本身不是断链或实现缺口；其中被 track.contents 引用的有 " + exprNoCUUsedInTrack + " 个。是否应关联篇目须按内容身份核验。");
L.push("- 涉及 " + Object.keys(exprNoCUByWork).length + " 个 Work，最集中的：");
L.push("");
for (const w of exprNoCUTopWorks.slice(0, 10)) L.push("- " + w.work_id + " " + w.work_title + "：" + w.count + " 个");
L.push("");
L.push("## 9. 候选缺口汇总（须按来源与用途复核）");
L.push("");
L.push("1. 标题缺四语 " + missingLang.length + " 个实体（zh-TW 缺 " + langCounts["zh-TW"] + "、en-US 缺 " + langCounts["en-US"] + "、zh-CN 缺 " + langCounts["zh-CN"] + "）——几乎每个详情页与列表的多语言回退都受影响。");
L.push("2. 展示型 kind 缺封面 " + pictureGapDisplay + " 个（work " + noPic.work.count + " / release " + noPic.release.count + " / agent " + noPic.agent.count + " / collection " + noPic.collection.count + "）。");
L.push("3. 同作用域重复候选 " + sameScopeDup.length + " 组（work " + duplicates.work.same_scope_groups + " / content_unit " + duplicates.content_unit.same_scope_groups + " / expression " + duplicates.expression.same_scope_groups + " / release " + duplicates.release.same_scope_groups + " / agent " + duplicates.agent.same_scope_groups + "）——搜索结果与详情分叉。");
L.push("4. 裸母体 Work " + bareWorks.length + " 个（清单内待补 " + bareKnown.length + " 个；其余 " + bareOther.length + " 个无任何子级，详情页空壳）。");
L.push("5. Expression 未挂 content_unit_id " + exprNoCU.length + " 个（选填字段，未判定为错误）。");
L.push("");
L.push("> 本次结构检查：不可见或不存在 " + (breaks.missing || []).length + "、已停用 " + (breaks.soft_deleted || []).length
  + "、kind 不符 " + (breaks.kind_mismatch || []).length + "、无法判定 " + (breaks.unresolved || []).length
  + "；subjects 未覆盖 " + undeclared.length + " 条，未能核验 " + releaseCoverMiss.length + " 条；列表完整性 " + (listComplete ? "已核对" : "未确认") + "。");
L.push("> 未核验当前修订的逐字段 CORE-P1、图片使用权或重复对象的真实身份；此报告不能直接作为发布、计数或合并依据。");
L.push("");
fs.writeFileSync(path.join(OUT_DIR, "gap-report.md"), L.join("\n"), "utf8");

console.log("");
console.log("=== 审计完成 ===");
console.log("用时 " + ((Date.now() - t0) / 1000).toFixed(1) + "s；detail GET " + detailGets + " 次");
console.log("缺封面 " + noPicTotal + " / 标题不齐 " + missingLang.length + " / 断链明细 " + JSON.stringify(report.summary.dangling_refs) + " / subjects 未覆盖 " + undeclared.length + " / 裸母体 " + bareWorks.length + " / 重复组 " + dupTotalGroups);
console.log("写入 " + OUT_DIR + "/gap-report.json 与 gap-report.md");
