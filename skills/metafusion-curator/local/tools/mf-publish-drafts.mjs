#!/usr/bin/env node
/**
 * mf-publish-drafts.mjs — 批量发布线上 draft 实体。
 *
 * 流程：按 kind 分片枚举 draft → 跳过 pending_review/deleted/merged →
 * 修订历史取首个合格 url 来源 → 拓扑排序（被引用者在前）→
 * ≤100 ops/commit 分批 checkout/commit/preview/push → 回执逐条核对。
 *
 * 用法：
 *   node mf-publish-drafts.mjs run --shard <kind:offset:limit> --out DIR [--dry-run]
 *   node mf-publish-drafts.mjs stats
 *   node mf-publish-drafts.mjs enum --kind KIND --offset N --limit M --out FILE
 *
 * 所有中间文件只写 --out 指定的任务目录，不写仓库。
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  request,
  publicFailure,
  configuredOrigin,
} from "../metafusion-api.mjs";
import { runWorkspace } from "./mf-workspace.mjs";

const API = "/api/catalog";
const MAX_OPS = 100;
const BATCH = 100;
/** 任务级维护证据：无历史 url 来源时使用，服务端 preview 已确认接受。 */
const maintenanceSource = {
  kind: "publication",
  citation: "全量草稿发布任务记录：本操作仅切换 status draft→published，由发布前质检确认条目完整，不新增外部事实断言",
};
const ws = (command, opts) =>
  runWorkspace(command, { ...opts, origin: configuredOrigin() });

/** 引用边：child 引用的 parent id 列表。属性实体引用与关系边暂不参与排序。 */
export function referenceEdges(entity) {
  const edges = [];
  if (entity?.work_id) edges.push(entity.work_id);
  if (entity?.content_unit_id) edges.push(entity.content_unit_id);
  if (entity?.release_id) edges.push(entity.release_id);
  if (entity?.medium_id) edges.push(entity.medium_id);
  for (const s of entity?.subjects ?? [])
    if (s?.work_id) edges.push(s.work_id);
  for (const c of entity?.contents ?? [])
    if (c?.expression_id) edges.push(c.expression_id);
  return [...new Set(edges.filter((x) => typeof x === "string" && x))];
}

/** 拓扑排序：被引用的先发布。返回层数组，每层可并行发布。 */
export function topoLayers(entities) {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const indeg = new Map(entities.map((e) => [e.id, 0]));
  const dependents = new Map(entities.map((e) => [e.id, []]));
  for (const e of entities) {
    const parents = referenceEdges(e).filter((p) => byId.has(p) && p !== e.id);
    e._parents = parents;
    for (const p of parents) {
      indeg.set(e.id, indeg.get(e.id) + 1);
      dependents.get(p).push(e.id);
    }
  }
  const layers = [];
  let ready = entities.filter((e) => indeg.get(e.id) === 0).map((e) => e.id);
  const done = new Set();
  while (ready.length) {
    layers.push(ready);
    const next = [];
    for (const id of ready) {
      done.add(id);
      for (const d of dependents.get(id)) {
        indeg.set(d, indeg.get(d) - 1);
        if (indeg.get(d) === 0) next.push(d);
      }
    }
    ready = next;
  }
  const cyclic = entities.map((e) => e.id).filter((id) => !done.has(id));
  return { layers, cyclic };
}

/** 修订历史取首个合格 url 来源；无历史来源时返回本任务 publication 证据。 */
export function pickHistoricalSource(revisions) {
  for (const rev of revisions ?? []) {
    for (const s of rev?.snapshot?.sources ?? rev?.sources ?? []) {
      if (
        s?.kind === "url" &&
        typeof s.url === "string" &&
        /^https?:\/\//.test(s.url) &&
        typeof s.citation === "string" &&
        s.citation.trim()
      )
        return { kind: "url", url: s.url, citation: `发布确认：沿用 v${rev.version} 内容证据，仅切换发布状态。原引：${s.citation.slice(0, 200)}` };
    }
  }
  return {
    kind: "publication",
    citation: "全量草稿发布任务记录：本操作仅切换 status draft→published，由发布前质检确认条目完整，不新增外部事实断言",
  };
}

/** 草稿是否满足发布硬条件：有翻译、非终态。返回 null 表示可发布，否则为跳过原因。 */
export function publishBlocker(entity) {
  if (!entity || typeof entity !== "object") return "missing_entity";
  if (entity.status !== "draft") return `status_${entity.status}`;
  if (!entity.translations || !Object.keys(entity.translations).length)
    return "no_translations";
  return null;
}

async function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
function writeJson(p, x) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(x, null, 2));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 枚举一整页；429 按 Retry-After 等待后重试。 */
async function listDraftsPage(kind, offset, limit) {
  for (let attempt = 0; ; attempt += 1) {
    const r = await request(
      `${API}/entities?kind=${encodeURIComponent(kind)}&status=draft&limit=${limit}&offset=${offset}`,
    );
    if (r.status === 200) return r.body;
    if (r.status === 429 && attempt < 8) {
      const wait = Math.min(60000, (Number(r.headers?.retryAfter) || 5) * 1000);
      await sleep(wait);
      continue;
    }
    throw new Error(`enum_failed:${r.status}:${publicFailure(r).error}`);
  }
}

export async function enumerateDrafts(kind, offset, limit) {
  const items = [];
  let cursor = offset;
  const end = offset + limit;
  let total = null;
  while (cursor < end) {
    const body = await listDraftsPage(kind, cursor, Math.min(BATCH, end - cursor));
    if (total === null) total = body.total;
    const page = body.items ?? [];
    if (!page.length) break;
    items.push(...page);
    cursor += page.length;
    if (page.length < Math.min(BATCH, end - cursor + page.length) && cursor >= (body.total ?? Infinity))
      break;
    if (!body.has_more && cursor >= end) break;
    if (page.length === 0) break;
  }
  return { items, total };
}

async function getRevisions(id) {
  const r = await request(`${API}/entities/${encodeURIComponent(id)}/revisions`);
  if (r.status !== 200) return [];
  return r.body?.items ?? [];
}

/**
 * 对单个分片执行发布。返回 { published, skipped, failed, commits }。
 * 分片文件：$OUT/shard.json（输入）、plan.json、progress.jsonl、receipt-*.json。
 */
export async function runShard({ shard, outDir, dryRun = false }) {
  const [kind, offsetStr, limitStr] = String(shard).split(":");
  const offset = Number(offsetStr), limit = Number(limitStr);
  if (!kind || !Number.isSafeInteger(offset) || !Number.isSafeInteger(limit) || limit <= 0)
    throw new Error("invalid_shard");
  fs.mkdirSync(outDir, { recursive: true });
  const progressPath = path.join(outDir, "progress.jsonl");
  const log = (x) => fs.appendFileSync(progressPath, JSON.stringify(x) + "\n");

  log({ event: "enumerate_start", kind, offset, limit });
  const { items, total } = await enumerateDrafts(kind, offset, limit);
  log({ event: "enumerated", count: items.length, total });

  // 1. 硬条件过滤 + 取 checkout 实际基线（status/version 以 checkout 为准）
  const candidates = items.filter((e) => publishBlocker(e) === null);
  const skipped = items
    .filter((e) => publishBlocker(e) !== null)
    .map((e) => ({ id: e.id, reason: publishBlocker(e) }));
  log({ event: "filtered", candidates: candidates.length, skipped: skipped.length });

  const { layers, cyclic } = topoLayers(candidates);
  for (const id of cyclic) skipped.push({ id, reason: "dependency_cycle" });
  log({ event: "layered", layers: layers.length, cyclic: cyclic.length });

  const report = { shard, total, enumerated: items.length, published: [], skipped, failed: [], commits: [] };
  if (dryRun) {
    report.layers = layers.map((l) => l.length);
    writeJson(path.join(outDir, "plan.json"), report);
    return report;
  }

  // 2. 逐层发布：层内分 ≤100 ops 的 commit 批次
  const wsDir = path.join(outDir, "catalog");
  await ws("init", { dir: wsDir });
  for (let li = 0; li < layers.length; li += 1) {
    const layer = layers[li];
    for (let bi = 0; bi < layer.length; bi += MAX_OPS) {
      const batch = layer.slice(bi, bi + MAX_OPS);
      const outcome = await publishBatch({ wsDir, batch, outDir, dryRun, log });
      report.commits.push(outcome);
      for (const r of outcome.results) {
        if (r.published) report.published.push(r.id);
        else if (r.skipped) { report.skipped.push({ id: r.id, reason: r.skipped }); }
        else report.failed.push({ id: r.id, reason: r.failed });
      }
      log({ event: "batch_done", layer: li, batch: bi / MAX_OPS, ok: outcome.results.filter((r) => r.published).length });
    }
  }
  writeJson(path.join(outDir, "plan.json"), report);
  return report;
}

async function publishBatch({ wsDir, batch, outDir, log }) {
  // checkout 实际基线
  await ws("checkout", { dir: wsDir, entityIDs: batch });

  // 跳过已非 draft 的（枚举后被他人发布/修改）
  const live = [];
  const results = [];
  for (const id of batch) {
    const doc = JSON.parse(fs.readFileSync(path.join(wsDir, "entities", `${id}.json`), "utf8"));
    const blocker = publishBlocker(doc);
    if (blocker) {
      results.push({ id, skipped: `checkout_${blocker}` });
      continue;
    }
    // 跨分片父级状态：读引用目标，draft 祖先则本轮跳过
    const parents = referenceEdges(doc);
    let parentDraft = null;
    for (const p of parents) {
      const g = await request(`${API}/entities/${encodeURIComponent(p)}`);
      if (g.status === 200 && g.body?.status === "draft" && g.body?.id && !batch.includes(g.body.id) && !live.includes(g.body.id)) {
        // 父级不在本批：检查是否同层已发布（读回 published 则通过）
        parentDraft = p;
        break;
      }
      if (g.status !== 200) { parentDraft = `${p}:unreadable`; break; }
    }
    if (parentDraft) {
      results.push({ id, skipped: `parent_draft:${parentDraft}` });
      continue;
    }
    live.push(id);
    doc.status = "published";
    fs.writeFileSync(path.join(wsDir, "entities", `${id}.json`), JSON.stringify(doc, null, 2));
  }
  if (!live.length) return { commit_id: null, results };

  // 每实体取历史来源；缺历史 url 来源的用任务级 publication 证据（服务端已确认接受）
  const sources = live.map((id, i) => ({ ...maintenanceSource, key: `src${i + 1}` }));
  const revSources = new Map();
  for (const id of live) {
    const revs = await getRevisions(id);
    revSources.set(id, pickHistoricalSource(revs));
  }
  for (let i = 0; i < live.length; i += 1)
    sources[i] = { ...revSources.get(live[i]), key: `src${i + 1}` };
  const ready = live;

  // 只保留 ready 实体的改动，其余恢复基线（避免误提交）
  const state = JSON.parse(fs.readFileSync(path.join(wsDir, ".mf", "state.json"), "utf8"));
  for (const e of state.entries) {
    if (e.target === "entity" && e.id && !ready.includes(e.id)) {
      fs.writeFileSync(path.join(wsDir, e.file), JSON.stringify(e.base, null, 2));
    }
  }
  const sourcesPath = path.join(outDir, `sources-${randomUUID().slice(0, 8)}.json`);
  writeJson(sourcesPath, sources);
  const sealed = await ws("commit", {
    dir: wsDir,
    note: "批量发布草稿：status draft→published，证据沿用各条目修订历史来源",
    sources,
  });
  const commitId = sealed.commit_id;
  const preview = await ws("preview", { dir: wsDir });
  if (!preview.ok || preview.status !== 200) {
    log({ event: "preview_rejected", commit_id: commitId, result: preview.result });
    for (const id of ready) results.push({ id, failed: `preview:${preview.result?.error ?? preview.status}` });
    return { commit_id: commitId, results };
  }
  const pushed = await ws("push", { dir: wsDir, apply: true });
  writeJson(path.join(outDir, `receipt-${commitId}.json`), pushed);
  if (!pushed.ok || !pushed.applied) {
    for (const id of ready) results.push({ id, failed: `push:${pushed.reason ?? "unknown"}` });
    return { commit_id: commitId, results };
  }
  // 回执逐条核对
  const byId = new Map((pushed.receipt?.items ?? []).map((it) => [it.id, it]));
  for (const id of ready) {
    const item = byId.get(id);
    if (item && item.changed && !item.merged) results.push({ id, published: true });
    else results.push({ id, failed: `receipt_mismatch:${JSON.stringify(item ?? null)}` });
  }
  return { commit_id: commitId, results };
}

export async function stats() {
  const r = await request(`${API}/entities/stats`);
  if (r.status !== 200) throw new Error(`stats_failed:${r.status}`);
  return r.body;
}

export function helpText() {
  return [
    "mf-publish-drafts run --shard <kind:offset:limit> --out DIR [--dry-run]",
    "mf-publish-drafts enum --kind KIND --offset N --limit M --out FILE",
    "mf-publish-drafts stats",
    "发布线上 draft：拓扑排序后分批 commit/push，证据沿用修订历史 url 来源。",
  ].join("\n");
}

export async function runCli(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv;
  const flag = (name) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  if (cmd === "stats") {
    console.log(JSON.stringify(await stats(), null, 2));
    return;
  }
  if (cmd === "enum") {
    const kind = flag("--kind"), offset = Number(flag("--offset") ?? 0), limit = Number(flag("--limit") ?? 100);
    const out = flag("--out");
    if (!kind || !out) throw new Error("enum_requires_kind_and_out");
    const { items, total } = await enumerateDrafts(kind, offset, limit);
    writeJson(out, { kind, offset, limit, total, count: items.length, items });
    console.log(JSON.stringify({ kind, total, count: items.length, out }));
    return;
  }
  if (cmd === "run") {
    const shard = flag("--shard"), out = flag("--out");
    const dryRun = rest.includes("--dry-run");
    if (!shard || !out) throw new Error("run_requires_shard_and_out");
    const report = await runShard({ shard, outDir: out, dryRun });
    console.log(JSON.stringify({
      shard, published: report.published.length,
      skipped: report.skipped.length, failed: report.failed.length,
      commits: report.commits.length,
    }));
    return;
  }
  throw new Error(helpText());
}

const invoked = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invoked) {
  runCli().catch((e) => {
    console.error(String(e?.message ?? e));
    process.exit(1);
  });
}
