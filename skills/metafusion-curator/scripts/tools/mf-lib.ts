// MetaFusion 编目工具共享原语。
//
// 设计约束：**不另建 HTTP 客户端**——全部走本技能自带的 ../metafusion-api.ts（PAT 认证、
// 只在凭据存在时发请求、GET 按 Retry-After 重试）。这里只补齐编目任务反复需要、而通用客户端
// 不含的能力：
//   1. 常用读取原语（按 kind 分页、关系、失败时显式报错而不是返回空）；
//   2. 重复身份合并的只读预检与副本提交。
//
// 口径（写死在实现里，避免每个调用方各自解释）：
//   · **取数失败必须抛错**，绝不退化成 undefined/空集后被误读成"数据有问题"。
//   · **同键异值的外部标识 = 两侧指向不同真实对象**，合并前一律拒绝。
//   · 403/429 不等于失效；404 只表明当前调用者不可见或目标不存在。

import { request, listAll } from "../metafusion-api.ts";

import { randomUUID } from "node:crypto";
import { diffDocument } from "./mf-workspace.ts";
import { readEntityLinks } from "./mf-links.ts";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 统一调用：直接透传技能客户端的 request，便于脚本处理非 2xx。 */
export const call = (pathname, opts: Record<string, any> = {}) => request(pathname, opts);

export const KINDS = [
  "agent",
  "collection",
  "work",
  "content_unit",
  "expression",
  "release",
  "medium",
  "track",
];

/** 读取单个实体；404 返回 null，其它非 200 一律抛错。 */
export async function getEntity(id) {
  const r = await request(`/api/catalog/entities/${encodeURIComponent(id)}`);
  if (r.status === 200) return r.body;
  if (r.status === 404) return null;
  throw new Error(
    `读取实体 ${id} 失败：HTTP ${r.status} ${r.body?.error ?? ""}`.trim(),
  );
}

/** 分页读取某 kind 的全部可见实体（失败即抛错，绝不静默截断）。 */
export async function listKind(kind, params = {}) {
  return listAll("/api/catalog/entities", { kind, ...params });
}

/** 某实体的关系边；失败即抛错。 */
export async function relationsOf(id) {
  const page = await readEntityLinks(id);
  return page.items.filter((link) => link.class === "semantic").map((link) => ({
    id: link.key, version: link.version, type: link.rule_code.slice("relation:".length),
    source_id: link.source_id, target_id: link.target_id, position: link.position,
    attributes: link.attributes || {},
  }));
}

/** 带重试的实体读取（用于并发写入场景下取最新 version）。 */
export async function getEntityRetry(id, tries = 4) {
  let last;
  for (let i = 0; i < tries; i += 1) {
    try {
      return await getEntity(id);
    } catch (error) {
      last = error;
      await sleep(400 * (i + 1));
    }
  }
  throw last;
}

// ── 合并引擎 ────────────────────────────────────────────────────────────────

/** 参与"身份"判定、同键异值即视为不同对象的字段码。 */
export const IDENTITY_KEYS = [
  "bangumi",
  "musicbrainz",
  "wikidata",
  "anilist",
  "myanimelist",
  "imdb",
  "imdb_person",
  "isbndb",
  "isrc",
  "steam",
  "vgmdb",
  "vndb",
  "discogs",
  "tmdb",
  "apple_music",
];

/** 参与"身份"判定的属性码：这些值不同即不是同一版次/同一物。 */
export const IDENTITY_ATTRS = [
  "duration",
  "edition_date",
  "barcode",
  "isbn",
  "catalog_number",
  "edition_type",
  "version_label",
];

/**
 * expression 的 version_label 是"录音版本"身份字段（2026-10-03 merge-safe-apply 实证：
 * 22 组被审计判为同作用域重复的 expression 实为录音室/现场/不同公演的不同表达，
 * "一侧有标签一侧无"同样不可并——unionInto 会把现场标签盖到录音室表达上）。
 * 因此对 kind=expression，任何一侧非空且两侧不相等（含 null/"" vs 有值）即身份冲突。
 */
export function expressionVersionLabelConflict(keep, lose) {
  const a = keep?.attributes?.version_label ?? null;
  const b = lose?.attributes?.version_label ?? null;
  if (a == null && b == null) return null;
  if (a == null || b == null) return "attributes.version_label(单侧缺失)";
  return j(a) === j(b) ? null : "attributes.version_label";
}

const canonical = (v) =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canonical(v[k])]),
        )
      : v;
const j = (v) => JSON.stringify(canonical(v ?? null));

/**
 * 计算两侧的"身份冲突"。返回冲突字段列表——非空即**不得合并**。
 * 依据：同键异值的外部标识说明两侧各自指向不同真实对象（同名≠同一物）；
 * duration/版次类属性不同说明是不同物或不同版次。
 */

/** external_links 数组工具：按 kind+url 识别，external_id 作身份比对。 */
export function linkIdentityValue(link) {
  if (!link || typeof link !== "object") return "";
  return String(link.external_id || link.url || "").trim();
}
export function linksByKind(links) {
  const out = new Map();
  for (const link of Array.isArray(links) ? links : []) {
    if (!link?.kind) continue;
    const list = out.get(link.kind) || [];
    list.push(link);
    out.set(link.kind, list);
  }
  return out;
}
export function linksToCriteria(links) {
  return (Array.isArray(links) ? links : [])
    .map((link) => ({
      kind: link.kind,
      value: linkIdentityValue(link),
    }))
    .filter((c) => c.kind && c.value);
}

export function identityConflicts(keep, lose) {
  const out = [];
  const keepBy = linksByKind(keep.external_links);
  const loseBy = linksByKind(lose.external_links);
  for (const k of IDENTITY_KEYS) {
    const aVals = new Set((keepBy.get(k) || []).map(linkIdentityValue).filter(Boolean));
    const bVals = new Set((loseBy.get(k) || []).map(linkIdentityValue).filter(Boolean));
    if (aVals.size && bVals.size && ![...aVals].some((v) => bVals.has(v)))
      out.push(`external_links.${k}`);
  }
  for (const k of IDENTITY_ATTRS) {
    const a = keep.attributes?.[k];
    const b = lose.attributes?.[k];
    if (a != null && b != null && j(a) !== j(b)) out.push(`attributes.${k}`);
  }
  if (
    String(keep.kind || "").toLowerCase() === "expression" ||
    String(lose.kind || "").toLowerCase() === "expression"
  ) {
    const c = expressionVersionLabelConflict(keep, lose);
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

/**
 * 并集候选：把 lose 侧独有的值并入 keep；conflicts 非空时实际合并拒绝。
 * pictures 取并集；translations 语种内**逐键**并集；attributes 数组并集/对象浅并集；
 * external_links 按键并集；track 的 contents 按 expression_id + locator 区分收录。
 * 返回 { entity, changes, conflicts } —— conflicts 是"同键异值、保留本方"的项。
 */
export function unionInto(keep, lose, { kind }: Record<string, any> = {}) {
  const changes = [];
  const conflicts = [];

  const pics = [...(keep.pictures ?? [])];
  const seenPic = new Set(pics.map((p) => p?.url).filter(Boolean));
  for (const p of lose.pictures ?? []) {
    if (p?.url && !seenPic.has(p.url)) {
      pics.push(p);
      seenPic.add(p.url);
    } else if (p?.url && j(pics.find((x) => x.url === p.url)) !== j(p))
      conflicts.push(`pictures.${p.url}`);
  }
  if (pics.length !== (keep.pictures ?? []).length)
    changes.push(`pictures+${pics.length - (keep.pictures ?? []).length}`);

  const tr = JSON.parse(JSON.stringify(keep.translations ?? {}));
  for (const [loc, val] of Object.entries(lose.translations ?? {})) {
    if (!tr[loc]) {
      tr[loc] = val;
      continue;
    }
    for (const [k, v] of Object.entries(val ?? {})) {
      if (!(k in tr[loc])) tr[loc][k] = v;
      else if (j(tr[loc][k]) !== j(v))
        conflicts.push(`translations.${loc}.${k}`);
    }
  }
  const trTouched = Object.keys(tr).filter(
    (l) => j(tr[l]) !== j(keep.translations?.[l]),
  );
  if (trTouched.length) changes.push(`translations~${trTouched.join("/")}`);

  const attrs = JSON.parse(JSON.stringify(keep.attributes ?? {}));
  for (const [k, v] of Object.entries(lose.attributes ?? {})) {
    if (!(k in attrs)) {
      attrs[k] = v;
      continue;
    }
    if (Array.isArray(attrs[k]) && Array.isArray(v)) {
      for (const x of v)
        if (!attrs[k].some((y) => j(y) === j(x))) attrs[k].push(x);
    } else if (
      attrs[k] &&
      v &&
      typeof attrs[k] === "object" &&
      typeof v === "object" &&
      !Array.isArray(attrs[k]) &&
      !Array.isArray(v)
    ) {
      for (const [kk, vv] of Object.entries(v)) {
        if (!(kk in attrs[k])) attrs[k][kk] = vv;
        else if (j(attrs[k][kk]) !== j(vv))
          conflicts.push(`attributes.${k}.${kk}`);
      }
    } else if (j(attrs[k]) !== j(v)) {
      conflicts.push(`attributes.${k}`);
    }
  }
  const attrTouched = Object.keys(attrs).filter(
    (k) => j(attrs[k]) !== j(keep.attributes?.[k]),
  );
  if (attrTouched.length) changes.push(`attributes~${attrTouched.join("/")}`);

  const ext = [...(Array.isArray(keep.external_links) ? keep.external_links : [])];
  const seen = new Set(ext.map((l) => `${l.kind}\0${l.url}`));
  const keepBy = linksByKind(keep.external_links);
  const extAdded = [];
  for (const link of Array.isArray(lose.external_links) ? lose.external_links : []) {
    if (!link?.kind || !link?.url) continue;
    const key = `${link.kind}\0${link.url}`;
    if (seen.has(key)) {
      if (j(ext.find((value) => `${value.kind}\0${value.url}` === key)) !== j(link))
        conflicts.push(`external_links.${link.kind}`);
      continue;
    }
    const existing = keepBy.get(link.kind) || [];
    if (existing.length) {
      conflicts.push(`external_links.${link.kind}`);
      continue;
    }
    if (!existing.length) {
      ext.push(link);
      seen.add(key);
      extAdded.push(link.kind);
    }
  }
  if (extAdded.length) changes.push(`external_links+${extAdded.join("/")}`);

  let contents = keep.contents;
  if (kind === "track") {
    contents = [...(keep.contents ?? [])];
    for (const c of lose.contents ?? []) {
      const existing = contents.find(
        (x) =>
          x.expression_id === c.expression_id && j(x.locator) === j(c.locator),
      );
      if (existing) {
        if (j(existing.attributes) !== j(c.attributes))
          conflicts.push(`contents.${c.expression_id}.attributes`);
        continue;
      }
      const added = structuredClone(c);
      if (contents.some((x) => x.position === added.position)) {
        added.position =
          Math.max(0, ...contents.map((x) => Number(x.position) || 0)) + 1;
      }
      contents.push(added);
    }
    if (j(contents) !== j(keep.contents ?? [])) changes.push("contents+");
  }

  return {
    entity: {
      translations: tr,
      attributes: attrs,
      external_links: ext,
      pictures: pics,
      ...(kind === "track" ? { contents } : {}),
    },
    changes,
    conflicts,
  };
}

/**
 * 合并重复身份属于管理员生命周期动作。预合并事实和冗余边先在同一服务器副本
 * 暂存、提交、push；只有已应用时才继续身份合并。二者不是跨服务原子事务。
 * pending PR、冲突或未知结果都会停止，不自动重放写入；来源仅为可选元数据。
 */
export async function mergeEntity({
  kind, keep, lose, scopeNote = "", dryRun = true,
  relationType = "same-scope duplicate", sources = [], requestFn = request,
}: Record<string, any>) {
  let changes = [], conflicts = [], edgeDeletes = 0;
  const completedSteps = [];
  let mainChanged = false, workspaceID, commitID;
  const result = (ok, reason, extra = {}) => ({
    ok, reason, changes, conflicts, edgeDeletes, atomic: false,
    partial: !ok && mainChanged, completedSteps: [...completedSteps],
    ...(workspaceID ? { workspace_id: workspaceID } : {}),
    ...(commitID ? { commit_id: commitID } : {}), ...extra,
  });
  const readEntity = async (id) => {
    const r = await requestFn(`/api/catalog/entities/${encodeURIComponent(id)}`);
    if (r.status !== 200) throw new Error(`entity_read_failed:${r.status}`);
    return r.body;
  };
  const write = (pathname, method, body) => requestFn(pathname, { method, body, tries: 1 });
  const checkWrite = (r, step) => {
    if (!r || r.status === 0 || r.status >= 500) throw new Error(`${step}_result_unknown`);
    if (r.status < 200 || r.status >= 300) throw new Error(`${step}_rejected:${r.status}:${r.body?.error ?? ""}`);
    return r.body;
  };
  if (!keep?.id || !lose?.id || keep.id === lose.id) return result(false, "invalid_merge_pair");
  try {
    const [currentKeep, currentLose] = await Promise.all([readEntity(keep.id), readEntity(lose.id)]);
    if (currentLose.state === "merged") return result(true, "already-merged");
    if (currentKeep.version !== keep.version || currentLose.version !== lose.version)
      return result(false, "version_conflict: 回读后重新计算并集");
    if (kind !== currentKeep.kind || kind !== currentLose.kind ||
        currentKeep.state !== "active" || currentLose.state !== "active")
      return result(false, "invalid_kind_or_state");
    if (currentKeep.title !== currentLose.title || scopeKey(kind, currentKeep) !== scopeKey(kind, currentLose))
      return result(false, "identity_or_scope_mismatch");
    conflicts = identityConflicts(currentKeep, currentLose);
    for (const key of ["number", "position"]) {
      if (["content_unit", "medium", "track"].includes(kind) && j(currentKeep[key]) !== j(currentLose[key])) conflicts.push(key);
    }
    if (conflicts.length) return result(false, "identity_conflict");
    const union = unionInto(currentKeep, currentLose, { kind });
    changes = union.changes;
    conflicts = union.conflicts;
    if (conflicts.length) return result(false, "field_conflict: 不自动丢弃不同值");
    const patch = diffDocument(currentKeep, { ...currentKeep, ...union.entity }, "entity");
    const links = await Promise.all([readEntityLinks(keep.id, { requestFn }), readEntityLinks(lose.id, { requestFn })]);
    const edges = links.map((page) => page.items.filter((l) => l.class === "semantic").map((l) => ({
      id: l.key, version: l.version, type: l.rule_code.slice("relation:".length),
      source_id: l.source_id, target_id: l.target_id, position: l.position, attributes: l.attributes ?? {},
    })));
    const key = (r, self) => `${r.source_id === self ? "out" : "in"}|${r.type}|${r.source_id === self ? r.target_id : r.source_id}|${j(r.attributes)}`;
    const keepSet = new Set(edges[0].map((r) => key(r, keep.id)));
    const duplicateEdges = edges[1].filter((r) => keepSet.has(key(r, lose.id)));
    if (edges[1].some((r) => (r.source_id === lose.id ? keep.id : r.source_id) === (r.target_id === lose.id ? keep.id : r.target_id)))
      return result(false, "merge_would_create_self_loop");
    if (duplicateEdges.some((r) => !r.id || !Number.isInteger(r.version))) return result(false, "invalid_relation_version");
    const operations = [
      ...(patch.length ? [{ target: "entity", action: "update", id: keep.id, patch }] : []),
      ...duplicateEdges.map((r) => ({ target: "relation", action: "delete", id: r.id })),
    ];
    const message = `合并重复（${relationType}）：${scopeNote || kind}；保留 ${keep.id}，归并 ${lose.id}`;
    if (dryRun) return result(true, "dry-run", { operations, plannedEdgeDeletes: duplicateEdges.length });
    if (operations.length) {
      let workspace = checkWrite(await write("/api/catalog/workspaces", "POST", {
        name: message, entity_ids: [keep.id, lose.id], relation_ids: duplicateEdges.map((r) => r.id),
      }), "workspace_create");
      workspaceID = workspace?.id;
      if (!workspaceID || !Number.isInteger(workspace.version) || !Array.isArray(workspace.objects))
        return result(false, "workspace_receipt_invalid", { applied: false });
      completedSteps.push("workspace_created");
      const expectedObjects = [
        { target: "entity", id: keep.id, version: currentKeep.version },
        { target: "entity", id: lose.id, version: currentLose.version },
        ...duplicateEdges.map((r) => ({ target: "relation", id: r.id, version: r.version })),
      ];
      if (expectedObjects.some((o) => workspace.objects.find((x) => x.target === o.target && x.id === o.id)?.base_version !== o.version))
        return result(false, "version_conflict: fork基线已改变", { applied: false });
      const root = `/api/catalog/workspaces/${encodeURIComponent(workspaceID)}`;
      const staged = checkWrite(await write(`${root}/changes`, "PUT", { expected_version: workspace.version, operations }), "workspace_stage");
      workspace = staged?.workspace;
      if (!workspace || workspace.id !== workspaceID || !Number.isInteger(workspace.version))
        return result(false, "workspace_receipt_invalid", { applied: false });
      completedSteps.push("staged");
      commitID = randomUUID();
      const commit = checkWrite(await write(`${root}/commits`, "POST", { id: commitID, expected_version: workspace.version, message }), "workspace_commit");
      if (commit?.id !== commitID || commit.workspace_id !== workspaceID)
        return result(false, "commit_receipt_invalid", { applied: false });
      completedSteps.push("committed");
      const refreshed = await requestFn(root);
      if (refreshed.status !== 200 || refreshed.body?.head_commit_id !== commitID)
        return result(false, "workspace_head_unverified", { applied: false });
      workspace = refreshed.body;
      const pushed = checkWrite(await write(`${root}/push`, "POST", {
        expected_version: workspace.version, expected_head: commitID, title: message,
      }), "workspace_push");
      if (pushed?.applied === false && pushed?.pull_request?.id)
        return result(false, "pull_request_open_stop_merge", { applied: false, pull_request: pushed.pull_request });
      if (pushed?.applied !== true) return result(false, "push_receipt_invalid", { applied: null });
      mainChanged = true;
      completedSteps.push("workspace_merged");
      edgeDeletes = duplicateEdges.length;
      const readback = await readEntity(keep.id);
      if (Object.entries(union.entity).some(([k, v]) => j(readback[k]) !== j(v)))
        return result(false, "readback_mismatch: 停止身份合并", { applied: true });
    }
    const current = await readEntity(lose.id);
    if (current.version !== currentLose.version || current.state !== "active")
      return result(false, "version_conflict: 合并前对象已改变", { applied: mainChanged });
    const lifecycle = await write(`/api/catalog/entities/${encodeURIComponent(lose.id)}/lifecycle`, "POST", {
      expected_version: current.version, target_id: keep.id, edit_note: message,
      ...(sources.length ? { sources } : {}),
    });
    const merged = checkWrite(lifecycle, "lifecycle");
    if (lifecycle.status !== 200 || merged?.state !== "merged" || merged.redirect_id !== keep.id)
      return result(false, "lifecycle_receipt_invalid", { applied: mainChanged ? true : null });
    completedSteps.push("lifecycle");
    return result(true, "merged", { applied: true });
  } catch (error) {
    return result(false, String(error?.message ?? error), { applied: mainChanged ? true : null });
  }
}

/** 从重复组里挑保留方：正常条目优先，其次字段更全。 */
export function pickKeeper(entities) {
  const score = (e) =>
    (e.state === "active" ? 1000 : 0) +
    Object.keys(e.translations ?? {}).length * 5 +
    Object.keys(e.attributes ?? {}).length * 3 +
    (e.pictures ?? []).length * 2 +
    (e.contents ?? []).length * 2 +
    (e.version ?? 0);
  return [...entities].sort((a, b) => score(b) - score(a))[0];
}

/** 作用域键：合并要求两侧同归属。 */
export function scopeKey(kind, e) {
  switch (kind) {
    case "content_unit":
      return `${e.work_id}|${e.parent_id ?? ""}`;
    case "expression":
      return `${e.work_id}|${e.content_unit_id ?? ""}`;
    case "release":
      return j(
        (e.subjects ?? []).map((s) => [s.work_id, s.role, s.attributes]).sort(),
      );
    case "medium":
      return `${e.release_id ?? ""}|${e.parent_id ?? ""}`;
    case "track":
      return `${e.medium_id ?? ""}|${e.parent_id ?? ""}`;
    default:
      return "";
  }
}
