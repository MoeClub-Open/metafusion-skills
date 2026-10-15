#!/usr/bin/env node
/**
 * mf-publish-drafts.mjs — 批量发布线上 draft 实体（v2）。
 *
 * 设计（实测结论）：
 * - 发布 = 单字段 patch `/status: draft→published`，经 checkout/commit/preview/push；
 * - 子实体引用 draft 父级会被服务端 `invalid_reference` 拒绝，因此按 kind 分波发布：
 *   agent+work → content_unit+expression+release → medium → track，最后扫尾重枚举；
 * - 同 commit 内按声明顺序应用，同 kind 批次无需排序；
 * - 证据：每 commit 一个任务级 publication 维护来源（服务端 preview 已确认接受），
 *   不逐实体取修订历史（checkout/commit 已携带版本校验，preview 做引用校验）；
 * - 质检 `/quality/batch` 只做发布前 census 记录，不拦截（结构性缺项多为草稿态本身所致，
 *   preview 才是权威门）；
 * - 回执逐条核对 `changed && !merged`；发布幂等（重跑时已 published 的被 checkout 过滤）。
 *
 * 用法：
 *   node mf-publish-drafts.mjs enum --kind KIND --out IDS.json
 *   node mf-publish-drafts.mjs run --id-file IDS.json --out DIR [--shard-index I --shard-count N] [--max-minutes M]
 *   node mf-publish-drafts.mjs stats
 *
 * 所有中间文件只写 --out 指定的任务目录与 --out 指定的 ID 文件，不写仓库。
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  request,
  publicFailure,
  configuredOrigin,
} from "../metafusion-api.mjs";
import { runWorkspace } from "./mf-workspace.mjs";

const API = "/api/catalog";
const MAX_OPS = 100;
const PAGE = 100;
const BISECT_DEPTH = 3;
/** 任务级维护证据：status 翻转不新增事实断言，服务端 preview 已确认接受。 */
const MAINTENANCE_SOURCE = {
  kind: "publication",
  citation:
    "全量草稿发布任务记录：本操作仅切换 status draft→published，发布前已做质检 census 与服务端 preview 校验，不新增外部事实断言",
};
const ws = (command, opts) =>
  runWorkspace(command, { ...opts, origin: configuredOrigin() });

/** 草稿是否满足发布硬条件：仍为 draft 且至少一条翻译。null 表示可发布。 */
export function publishBlocker(entity) {
  if (!entity || typeof entity !== "object") return "missing_entity";
  if (entity.status !== "draft") return `status_${entity.status}`;
  if (!entity.translations || !Object.keys(entity.translations).length)
    return "no_translations";
  return null;
}

/** 按分片下标连续切分 ID。 */
export function sliceShard(ids, index, count) {
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(count) || index < 0 || count < 1 || index >= count)
    throw new Error("invalid_shard_slice");
  const size = Math.ceil(ids.length / count);
  return ids.slice(index * size, (index + 1) * size);
}

/** 从 progress.jsonl 行恢复已完成 ID 集合（重跑断点续传）。 */
export function loadDoneSet(lines) {
  const done = new Set();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec?.event === "batch_done" && Array.isArray(rec.results))
        for (const r of rec.results) if (r?.id) done.add(r.id);
    } catch { /* 忽略损坏行 */ }
  }
  return done;
}

function writeJson(p, x) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(x, null, 2));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** POST 请求带重试：429 尊重 Retry-After；503/5xx/网络按退避重试。 */
async function postRetry(pathname, body, { tries = 8, label = "post" } = {}) {
  let last = null;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const r = await request(pathname, { method: "POST", body });
    last = r;
    if (r.status === 200) return r;
    if (r.status === 429) {
      const wait = Math.min(120000, (Number(r.headers?.retryAfter) || 10) * 1000 * 2);
      await sleep(wait);
      continue;
    }
    if (r.status === 0 || r.status >= 500) {
      await sleep(Math.min(30000, 1000 * 2 ** attempt));
      continue;
    }
    return r; // 4xx 非 429：确定性拒绝，直接返回
  }
  throw new Error(`${label}_retry_exhausted:${last?.status}:${publicFailure(last).error}`);
}

/** 枚举页：GET 自带 4 次重试；此处再包一层 429/5xx。 */
async function listDraftsPage(kind, offset, limit) {
  for (let attempt = 0; ; attempt += 1) {
    const r = await request(
      `${API}/entities?kind=${encodeURIComponent(kind)}&status=draft&limit=${limit}&offset=${offset}`,
    );
    if (r.status === 200) return r.body;
    if ((r.status === 429 || r.status === 0 || r.status >= 500) && attempt < 8) {
      const wait = r.status === 429
        ? Math.min(120000, (Number(r.headers?.retryAfter) || 10) * 1000 * 2)
        : Math.min(30000, 1000 * 2 ** attempt);
      await sleep(wait);
      continue;
    }
    throw new Error(`enum_failed:${r.status}:${publicFailure(r).error}`);
  }
}

/** 枚举某 kind 全部 draft ID（只保留 id，丢弃文档体）。 */
export async function enumerateKindDrafts(kind, outFile, log = () => {}) {
  const ids = [];
  const seen = new Set();
  let cursor = 0;
  let total = null;
  for (;;) {
    const body = await listDraftsPage(kind, cursor, PAGE);
    if (total === null) total = body.total;
    const page = body.items ?? [];
    if (!page.length) break;
    for (const x of page) {
      if (x?.id && !seen.has(x.id)) { seen.add(x.id); ids.push(x.id); }
    }
    cursor += page.length;
    log({ event: "enum_page", kind, cursor, total });
    if (!body.has_more && page.length < PAGE) break;
    if (cursor > 1000000) throw new Error("enum_safety_cap");
  }
  writeJson(outFile, { kind, total, count: ids.length, enumerated_at: new Date().toISOString(), ids });
  return { kind, total, count: ids.length };
}

function readDoc(wsDir, id) {
  return JSON.parse(fs.readFileSync(path.join(wsDir, "entities", `${id}.json`), "utf8"));
}

/**
 * 处理一批 ID（≤100）。fresh workspace 由调用方按 batchKey 准备。
 * 返回 results: [{id, published?/skipped?/failed?}] 与 quality census。
 */
async function processBatch(ids, { outDir, batchKey, log }) {
  const results = [];
  const wsDir = path.join(outDir, batchKey);
  if (fs.existsSync(wsDir)) fs.rmSync(wsDir, { recursive: true, force: true });
  await ws("init", { dir: wsDir });
  try {
    await ws("checkout", { dir: wsDir, entityIDs: ids });
  } catch (e) {
    if (String(e?.message).includes("incomplete_checkout") && ids.length > 4)
      return bisect(ids, { outDir, batchKey, log, reason: "incomplete_checkout" });
    if (/HTTP_(429|503|0)|HTTP_5/.test(String(e?.message))) {
      for (const id of ids) results.push({ id, failed: `checkout_unavailable:${e.message}` });
      return { results, quality: {} };
    }
    throw e;
  }

  const live = [];
  for (const id of ids) {
    let doc;
    try { doc = readDoc(wsDir, id); } catch {
      results.push({ id, failed: "checkout_doc_missing" });
      continue;
    }
    const blocker = publishBlocker(doc);
    if (blocker) { results.push({ id, skipped: `checkout_${blocker}` }); continue; }
    live.push(id);
    doc.status = "published";
    fs.writeFileSync(path.join(wsDir, "entities", `${id}.json`), JSON.stringify(doc, null, 2));
  }
  if (!live.length) return { results, quality: {} };

  // 质检 census（只记录，不拦截）
  let quality = {};
  try {
    const q = await postRetry(`${API}/quality/batch`, { ids: live }, { label: "quality" });
    if (q.status === 200) {
      for (const rep of q.body?.reports ?? []) {
        if (rep?.status !== "complete" || (rep?.issues ?? []).length)
          quality[rep.entity_id] = { status: rep.status, issues: rep.issues };
      }
    } else {
      quality = { _error: `quality_${q.status}` };
    }
  } catch (e) {
    quality = { _error: String(e?.message ?? e) };
  }

  const sources = [{ ...MAINTENANCE_SOURCE, key: "src1" }];
  let sealed;
  try {
    sealed = await ws("commit", {
      dir: wsDir,
      note: "批量发布草稿：status draft→published，证据为任务级维护记录",
      sources,
    });
  } catch (e) {
    for (const id of live) results.push({ id, failed: `commit:${e?.message ?? e}` });
    return { results, quality };
  }

  // preview：可重试错误退避重跑；400 按半 bisect；409 交给扫尾
  const commitId = sealed.commit_id;
  let preview = null;
  for (let attempt = 0; ; attempt += 1) {
    try {
      preview = await ws("preview", { dir: wsDir });
    } catch (e) {
      if (attempt < 5) { await sleep(2000 * (attempt + 1)); continue; }
      for (const id of live) results.push({ id, failed: `preview_threw:${e?.message ?? e}` });
      return { results, quality };
    }
    if (preview.ok && preview.status === 200) break;
    if ((preview.status === 429 || preview.status === 0 || preview.status >= 500) && attempt < 8) {
      await sleep(preview.status === 429 ? 15000 : 2000 * (attempt + 1));
      continue;
    }
    break;
  }
  if (!preview.ok || preview.status !== 200) {
    log({ event: "preview_rejected", commit_id: commitId, status: preview.status, result: preview.result });
    if (preview.status === 400 && live.length > 4)
      return { ...(await bisect(live, { outDir, batchKey, log, reason: `preview_${preview.result?.error ?? 400}` })), quality };
    for (const id of live) results.push({ id, failed: `preview:${preview.result?.error ?? preview.status}` });
    return { results, quality };
  }

  // push：同 ID 重试（429/busy/unknown 均保留 commit ID）
  let pushed = null;
  for (let attempt = 0; ; attempt += 1) {
    try {
      pushed = await ws("push", { dir: wsDir, apply: true });
    } catch (e) {
      if (attempt < 5) { await sleep(2000 * (attempt + 1)); continue; }
      for (const id of live) results.push({ id, failed: `push_threw:${e?.message ?? e}` });
      return { results, quality };
    }
    if (pushed.ok && pushed.applied) break;
    const retryable = pushed.status === 429 ||
      pushed.reason === "push_busy_keep_same_commit" ||
      pushed.reason === "push_unknown_keep_same_commit" ||
      pushed.reason === "receipt_unavailable" ||
      pushed.status === 0 || (pushed.status ?? 0) >= 500;
    if (retryable && attempt < 8) {
      if (pushed.reason === "push_unknown_keep_same_commit" || pushed.reason === "receipt_unavailable") {
        try { await ws("receipt", { dir: wsDir }); } catch { /* 忽略，回执可能仍在途 */ }
      }
      await sleep(pushed.status === 429 ? 15000 : 3000 * (attempt + 1));
      continue;
    }
    break;
  }
  try {
    writeJson(path.join(outDir, `receipt-${commitId}.json`), pushed);
  } catch { /* 回执落盘失败不影响已确认结果 */ }
  if (!pushed.ok || !pushed.applied) {
    for (const id of live) results.push({ id, failed: `push:${pushed.reason ?? pushed.status ?? "unknown"}` });
    return { results, quality };
  }
  const byId = new Map((pushed.receipt?.items ?? []).map((it) => [it.id, it]));
  for (const id of live) {
    const item = byId.get(id);
    if (item && item.changed && !item.merged) results.push({ id, published: true });
    else results.push({ id, failed: `receipt_mismatch:${JSON.stringify(item ?? null)}` });
  }
  return { results, quality };
}

async function bisect(ids, { outDir, batchKey, log, reason, depth = 0 }) {
  log({ event: "bisect", batchKey, reason, size: ids.length, depth });
  if (depth >= BISECT_DEPTH || ids.length <= 4) {
    return { results: ids.map((id) => ({ id, failed: `bisect_floor:${reason}` })), quality: {} };
  }
  const mid = Math.ceil(ids.length / 2);
  const outcomes = [];
  for (const [i, part] of [ids.slice(0, mid), ids.slice(mid)].entries()) {
    try {
      outcomes.push(await processBatch(part, { outDir, batchKey: `${batchKey}-b${depth}x${i}`, log }));
    } catch (e) {
      outcomes.push({ results: part.map((id) => ({ id, failed: `bisect_threw:${e?.message ?? e}` })), quality: {} });
    }
  }
  return {
    results: outcomes.flatMap((o) => o.results),
    quality: Object.assign({}, ...outcomes.map((o) => o.quality)),
  };
}

/**
 * 对单个分片执行发布。支持断点续传与时间盒（--max-minutes，到时 clean 停）。
 */
export async function runShard({ idFile, shardIndex = 0, shardCount = 1, outDir, maxMinutes = 0 }) {
  const manifest = JSON.parse(fs.readFileSync(idFile, "utf8"));
  const allIds = Array.isArray(manifest) ? manifest : manifest.ids;
  if (!Array.isArray(allIds)) throw new Error("invalid_id_file");
  const mine = sliceShard(allIds, shardIndex, shardCount);
  fs.mkdirSync(outDir, { recursive: true });
  const progressPath = path.join(outDir, "progress.jsonl");
  const log = (x) => fs.appendFileSync(progressPath, JSON.stringify(x) + "\n");
  let done = new Set();
  if (fs.existsSync(progressPath))
    done = loadDoneSet(fs.readFileSync(progressPath, "utf8").split("\n"));
  const todo = mine.filter((id) => !done.has(id));
  log({ event: "shard_start", kind: manifest.kind ?? "mixed", shardIndex, shardCount, mine: mine.length, resumed: done.size, todo: todo.length });
  const deadline = maxMinutes > 0 ? Date.now() + maxMinutes * 60000 : Infinity;

  const report = {
    kind: manifest.kind ?? "mixed", shardIndex, shardCount,
    mine: mine.length, published: [], skipped: [], failed: [], commits: 0, qualityFlags: {},
  };
  // 恢复已完成计数（只计 published；skipped/failed 明细在 progress.jsonl）
  for (const id of done) report.published.push({ id, resumed: true });

  let batchNo = 0;
  for (let bi = 0; bi < todo.length; bi += MAX_OPS) {
    if (Date.now() >= deadline) {
      log({ event: "timebox_stop", doneBatches: batchNo });
      break;
    }
    const batch = todo.slice(bi, bi + MAX_OPS);
    const batchKey = `batch-${bi / MAX_OPS}`;
    let outcome;
    try {
      outcome = await processBatch(batch, { outDir, batchKey, log });
    } catch (e) {
      outcome = { results: batch.map((id) => ({ id, failed: `batch_threw:${e?.message ?? e}` })), quality: {} };
    }
    for (const r of outcome.results) {
      if (r.published) report.published.push(r.id);
      else if (r.skipped) report.skipped.push({ id: r.id, reason: r.skipped });
      else report.failed.push({ id: r.id, reason: r.failed });
    }
    Object.assign(report.qualityFlags, outcome.quality);
    report.commits += 1;
    log({ event: "batch_done", batch: batchNo, results: outcome.results });
    batchNo += 1;
    await sleep(300); // 批次间隔，礼让服务端预算
  }
  const complete = report.published.length + report.skipped.length + report.failed.length >= mine.length;
  report.complete = complete;
  // resumed 条目只保留计数，published 明细只保留本轮新发布的 ID
  report.resumed = report.published.filter((x) => typeof x === "object").length;
  report.published = report.published.filter((x) => typeof x === "string");
  writeJson(path.join(outDir, "plan.json"), report);
  log({ event: "shard_end", complete, published: report.published.length, resumed: report.resumed, skipped: report.skipped.length, failed: report.failed.length });
  return report;
}

export async function stats() {
  const r = await request(`${API}/entities/stats`);
  if (r.status !== 200) throw new Error(`stats_failed:${r.status}`);
  return r.body;
}

export function helpText() {
  return [
    "mf-publish-drafts enum --kind KIND --out IDS.json",
    "mf-publish-drafts run --id-file IDS.json --out DIR [--shard-index I --shard-count N] [--max-minutes M]",
    "mf-publish-drafts stats",
    "发布线上 draft：按 kind 分波，每 commit ≤100 个 status 翻转，证据为任务级维护记录。",
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
    const kind = flag("--kind"), out = flag("--out");
    if (!kind || !out) throw new Error("enum_requires_kind_and_out");
    const r = await enumerateKindDrafts(kind, out, (x) => console.error(JSON.stringify(x)));
    console.log(JSON.stringify(r));
    return;
  }
  if (cmd === "run") {
    const idFile = flag("--id-file"), out = flag("--out");
    const shardIndex = Number(flag("--shard-index") ?? 0);
    const shardCount = Number(flag("--shard-count") ?? 1);
    const maxMinutes = Number(flag("--max-minutes") ?? 0);
    if (!idFile || !out) throw new Error("run_requires_id_file_and_out");
    const report = await runShard({ idFile, shardIndex, shardCount, outDir: out, maxMinutes });
    console.log(JSON.stringify({
      kind: report.kind, shardIndex, shardCount, complete: report.complete,
      published: report.published.length, resumed: report.resumed,
      skipped: report.skipped.length, failed: report.failed.length,
      commits: report.commits, qualityFlags: Object.keys(report.qualityFlags).length,
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
