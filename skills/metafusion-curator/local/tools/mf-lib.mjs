// MetaFusion 编目工具共享原语。
//
// 设计约束：**不另建 HTTP 客户端**——全部走本技能自带的 ../metafusion-api.mjs（PAT 认证、
// 只在凭据存在时发请求、GET 按 Retry-After 重试）。这里只补齐编目任务反复需要、而通用客户端
// 不含的三类能力：
//   1. 常用读取原语（按 kind 分页、关系、失败时显式报错而不是返回空）；
//   2. 预检与并集合并引擎（含"身份冲突守卫"与两处后端缺陷绕行）；
//   3. 来源/证据构造小工具。
//
// 口径（写死在实现里，避免每个调用方各自解释）：
//   · **取数失败必须抛错**，绝不退化成 undefined/空集后被误读成"数据有问题"。
//   · **同键异值的外部标识 = 两侧指向不同真实对象**，合并前一律拒绝。
//   · 403/429 不等于失效；404 只表明当前调用者不可见或目标不存在。

import { request, listAll, publicFailure } from "../metafusion-api.mjs";

import { randomUUID } from "node:crypto";
import { diffDocument, identityPatch } from "./mf-workspace.mjs";
import { findIdentity } from "./mf-find-identity.mjs";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 统一调用：直接透传技能客户端的 request，便于脚本处理非 2xx。 */
export const call = (pathname, opts = {}) => request(pathname, opts);

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

/** 来源/证据构造（与 reference-source-policy.md 一致）。 */
export const src = (url, citation) => ({ kind: "url", url, citation });
export const selfEvidence = (citation) => ({ kind: "self", citation });

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
  const r = await request(
    `/api/catalog/entities/${encodeURIComponent(id)}/relations`,
  );
  if (r.status !== 200)
    throw new Error(`读取关系 ${id} 失败：HTTP ${r.status}`);
  return r.body?.items ?? [];
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
 * 返回 { entity, changes, conflicts } —— conflicts 是"同键异值、保留本方"的项（会写进 edit_note）。
 */
export function unionInto(keep, lose, { kind } = {}) {
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
    if (seen.has(key)) continue;
    const existing = keepBy.get(link.kind) || [];
    if (existing.length && !existing.some((e) => linkIdentityValue(e) === linkIdentityValue(link))) {
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
 * 合并一个重复对：先预检当前实体、版本、身份和关系，再并集/删重复边/lifecycle。
 * 这是多个独立 API 事务；返回 atomic=false 与 completedSteps，失败后停止，不自动回滚或重试写入。
 * sources 必须由调用者核验，覆盖两端身份、保留字段与图片使用权；self 不足以支撑合并事实。
 */
export async function mergeEntity({
  kind,
  keep,
  lose,
  scopeNote,
  dryRun = true,
  relationType = "same-scope duplicate",
  sources = [],
  reviewedCandidateIDs = [],
}) {
  let changes = [],
    conflicts = [],
    edgeDeletes = 0;
  const completedSteps = [];
  const result = (ok, reason, extra = {}) => ({
    ok,
    reason,
    changes,
    conflicts,
    edgeDeletes,
    atomic: false,
    partial: !ok && completedSteps.length > 0,
    completedSteps: [...completedSteps],
    ...extra,
  });
  const evidenceValid =
    Array.isArray(sources) &&
    sources.length > 0 &&
    sources.every((s) => {
      if (
        !["url", "publication"].includes(s?.kind) ||
        !String(s.citation || "").trim()
      )
        return false;
      if (s.kind === "publication") return true;
      try {
        const url = new URL(s.url);
        return (
          ["https:", "http:"].includes(url.protocol) &&
          !url.username &&
          !url.password
        );
      } catch {
        return false;
      }
    });
  if (!dryRun && !evidenceValid)
    return result(
      false,
      "evidence_required: 提供已核验的真实 url/publication 来源，不能使用 self",
    );
  if (!keep?.id || !lose?.id || keep.id === lose.id)
    return result(false, "invalid_merge_pair");
  if (!Array.isArray(reviewedCandidateIDs)) return result(false, "invalid_identity_review");

  // 两端版本和关系都在任何写入前检查，防止把过时并集覆盖到刚读取的新版本上。
  const [currentKeep, currentLose] = await Promise.all([
    getEntity(keep.id),
    getEntity(lose.id),
  ]);
  if (!currentKeep || !currentLose)
    return result(false, "实体对当前调用者不可见或不存在");
  if (currentLose.status === "merged") return result(true, "already-merged");
  if (
    currentKeep.version !== keep.version ||
    currentLose.version !== lose.version
  )
    return result(false, "version_conflict: 预检版本已改变，回读后重新审查");
  if (
    kind !== currentKeep.kind ||
    kind !== currentLose.kind ||
    currentKeep.status !== "published" ||
    ["deleted", "merged"].includes(currentLose.status)
  )
    return result(false, "invalid_kind_or_status");
  if (
    currentKeep.title !== currentLose.title ||
    scopeKey(kind, currentKeep) !== scopeKey(kind, currentLose)
  )
    return result(false, "identity_or_scope_mismatch");
  conflicts = identityConflicts(currentKeep, currentLose);
  for (const key of ["number", "position"]) {
    if (
      ["content_unit", "medium", "track"].includes(kind) &&
      j(currentKeep[key]) !== j(currentLose[key])
    )
      conflicts.push(key);
  }
  if (conflicts.length) return result(false, "identity_conflict");
  const union = unionInto(currentKeep, currentLose, { kind });
  changes = union.changes;
  conflicts = union.conflicts;
  if (conflicts.length)
    return result(false, "field_conflict: 不自动丢弃对侧不同值");
  const mergedEntity = { ...currentKeep, ...union.entity },
    patch = diffDocument(currentKeep, mergedEntity, "entity");
  let identityReview;
  if (identityPatch(patch)) {
    if (!Array.isArray(reviewedCandidateIDs) || reviewedCandidateIDs.length > 1000 ||
        new Set(reviewedCandidateIDs).size !== reviewedCandidateIDs.length ||
        reviewedCandidateIDs.some((id) => id === keep.id || typeof id !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)))
      return result(false, "invalid_identity_review");
    const scope = ["expression", "content_unit"].includes(kind)
      ? { workId: mergedEntity.work_id }
      : kind === "medium" ? { releaseId: mergedEntity.release_id }
      : kind === "track" ? { mediumId: mergedEntity.medium_id } : {};
    if (Object.values(scope).some((id) => typeof id !== "string" || !id))
      return result(false, "identity_scope_unverified");
    const review = await findIdentity({
      kind, ...scope,
      titles: [mergedEntity.title, ...Object.values(mergedEntity.translations ?? {}).map((t) => t?.title).filter(Boolean)],
      externalIds: linksToCriteria(mergedEntity.external_links),
    });
    if (!review.coverage.complete || review.unknown.length || review.errors.length)
      return result(false, "identity_review_unverified", { identity_review: review });
    const candidateIDs = review.candidates
      .filter((c) => c.canonical_id !== keep.id)
      .map((c) => c.canonical_id).sort();
    if (candidateIDs.some((id) => typeof id !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)))
      return result(false, "identity_review_unverified", { identity_review: review });
    const allowed = new Set([lose.id, ...reviewedCandidateIDs]),
      unreviewed = candidateIDs.filter((id) => !allowed.has(id));
    if (unreviewed.length)
      return result(false, "identity_review_required", {
        identity_review: review, unreviewed_candidate_ids: unreviewed,
      });
    if (reviewedCandidateIDs.some((id) => id !== lose.id && !candidateIDs.includes(id)))
      return result(false, "identity_candidates_changed", { identity_review: review });
    // Choosing this duplicate pair explicitly reviews lose; third identities
    // require the caller's explicit review, never automatic acceptance.
    identityReview = candidateIDs;
  } else if (reviewedCandidateIDs.length) return result(false, "invalid_identity_review");
  const [keepRels, loseRels] = await Promise.all([
    relationsOf(keep.id),
    relationsOf(lose.id),
  ]);
  const key = (r, selfId) =>
    `${r.source_id === selfId ? "out" : "in"}|${r.type}|${r.source_id === selfId ? r.target_id : r.source_id}|${j(r.attributes)}`;
  const keepSet = new Set(keepRels.map((r) => key(r, keep.id)));
  const duplicateEdges = loseRels.filter((r) => keepSet.has(key(r, lose.id)));
  if (
    loseRels.some(
      (r) =>
        (r.source_id === lose.id ? keep.id : r.source_id) ===
        (r.target_id === lose.id ? keep.id : r.target_id),
    )
  ) {
    return result(false, "merge_would_create_self_loop");
  }
  if (duplicateEdges.some((r) => !r.id || !Number.isInteger(r.version)))
    return result(false, "invalid_relation_version");
  const baseNote =
    `合并重复（${relationType}）：同 kind、同作用域（${scopeNote}）、题名逐字相同` +
    (changes.length
      ? `；并入已核验的对侧独有值（${changes.join("；")}）`
      : "") +
    "；多步非原子操作";
  if (dryRun)
    return result(true, "dry-run", {
      applicable: evidenceValid,
      plannedEdgeDeletes: duplicateEdges.length,
      evidenceRequired: !evidenceValid,
      entity: { ...(await writable(currentKeep)), ...union.entity },
      ...(identityReview !== undefined ? { reviewed_candidate_ids: identityReview } : {}),
    });

  try {
    if (changes.length) {
      const defs = await request("/api/catalog/definitions");
      if (defs.status !== 200 || !defs.body?.etag)
        return result(false, "definitions_unavailable");
      const commit = {
        id: randomUUID(),
        definitions_etag: defs.body.etag,
        edit_note: baseNote,
        sources,
        operations: [
          {
            target: "entity",
            action: "update",
            id: keep.id,
            base_version: currentKeep.version,
            patch,
            ...(identityReview !== undefined ? { reviewed_candidate_ids: identityReview } : {}),
          },
        ],
      };
      const w = await request("/api/catalog/commits", {
        method: "POST",
        body: commit,
        tries: 1,
      });
      if (w.status === 0 || w.status >= 500)
        return result(false, "commit_push_unknown", {
          commit_id: commit.id,
          applied: null,
        });
      if (
        w.status === 200 &&
        (w.body?.applied !== true ||
          w.body.id !== commit.id ||
          w.body.items?.length !== 1)
      )
        return result(false, "commit_receipt_invalid", {
          commit_id: commit.id,
          applied: null,
        });
      if (w.status < 200 || w.status >= 300)
        return w.status === 409 && w.body?.error === "identity_candidates_changed"
          ? result(false, "identity_candidates_changed", { identity_review: publicFailure(w).identity_review })
          : result(
          false,
          `并集 commit HTTP ${w.status} ${w.body?.error ?? ""}`.trim(),
        );
      completedSteps.push("keep_union");
      const readback = await getEntity(keep.id);
      if (
        !readback ||
        readback.version !== w.body?.items?.[0]?.version ||
        Object.entries(union.entity).some(([k, v]) => j(readback[k]) !== j(v))
      ) {
        return result(false, "readback_mismatch: 并集写后未核验，停止");
      }
    }
    for (const r of duplicateEdges) {
      const d = await request(
        `/api/catalog/relations/${encodeURIComponent(r.id)}`,
        {
          method: "DELETE",
          body: {
            expected_version: r.version,
            edit_note:
              "合并前置：删除与保留方同方向、同类型、同属性的冗余关系边；多步非原子操作",
            sources,
          },
        },
      );
      if (d.status < 200 || d.status >= 300)
        return result(false, `删冗余边失败 HTTP ${d.status}；停止后续合并`);
      edgeDeletes += 1;
      completedSteps.push(`delete_relation:${r.id}`);
    }
    const current = await getEntity(lose.id);
    if (
      !current ||
      current.version !== currentLose.version ||
      current.status === "merged"
    )
      return result(false, "version_conflict: 合并前对象已改变；停止");
    const m = await request(
      `/api/catalog/entities/${encodeURIComponent(lose.id)}/lifecycle`,
      {
        method: "POST",
        body: {
          expected_version: current.version,
          target_id: keep.id,
          edit_note: baseNote,
          sources,
        },
      },
    );
    if (m.status !== 200)
      return result(
        false,
        `合并 HTTP ${m.status} ${m.body?.error ?? ""}`.trim(),
      );
    completedSteps.push("lifecycle");
    return result(true, "merged");
  } catch (error) {
    return result(
      false,
      `合并步骤读取或回读失败：${String(error)}；停止后续写入`,
    );
  }
}

async function writable(entity) {
  // 交给技能客户端剔除只读投影字段，避免整实体 PUT 被 DisallowUnknownFields 拒绝。
  const { writableEntity } = await import("../metafusion-api.mjs");
  return writableEntity(entity);
}

/** 从重复组里挑保留方：published 优先，其次字段更全。 */
export function pickKeeper(entities) {
  const score = (e) =>
    (e.status === "published" ? 1000 : 0) +
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
