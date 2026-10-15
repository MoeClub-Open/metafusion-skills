#!/usr/bin/env node
// Read-only, bounded catalog snapshot and release structure audit.

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { collectPages, request } from "../metafusion-api.mjs";

const KINDS = new Set(["agent", "collection", "work", "content_unit", "expression", "release", "medium", "track"]);
const RELEASE_LIST_PATH = "/api/catalog/entities";
const USAGE = `用法：node mf-catalog-snapshot.mjs (--all | --publisher <agent-id> [--catalog-prefix <prefix>] | --catalog-prefix <prefix> | --include-release <release-id>) [筛选...] [--out <file>]

--publisher <agent-id>       发行主体 ID；与 --catalog-prefix 同时指定时按 AND 筛选
--catalog-prefix <prefix>     品番前缀；与 --publisher 同时指定时按 AND 筛选
--include-release <id>        明确补入发行 ID，可重复；与基础筛选按 OR 合并
--all                         明确扫描全部可见发行
--out <file>                  将完整 JSON 写到指定文件；不指定时只打印摘要
--help                        显示帮助，不读取凭据或请求实例`;

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function normalizePublisher(value) {
  if (typeof value === "string") return value.trim();
  if (isRecord(value) && typeof value.id === "string") return value.id.trim();
  return "";
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJson(value[key])]));
  return value;
}

function cliValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} 需要一个值`);
  return value;
}

export function parseArgs(argv) {
  const options = { all: false, includeRelease: [], help: false, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--all") options.all = true;
    else if (arg === "--publisher") options.publisher = cliValue(argv, i++, arg).trim();
    else if (arg === "--catalog-prefix") options.catalogPrefix = cliValue(argv, i++, arg).trim();
    else if (arg === "--include-release") options.includeRelease.push(cliValue(argv, i++, arg).trim());
    else if (arg === "--out") options.out = cliValue(argv, i++, arg);
    else throw new Error(`未知参数：${arg}`);
  }
  options.includeRelease = [...new Set(options.includeRelease.filter(Boolean))];
  if (options.help) return options;
  if (options.publisher !== undefined && !options.publisher) throw new Error("--publisher 不能为空");
  if (options.catalogPrefix !== undefined && !options.catalogPrefix) throw new Error("--catalog-prefix 不能为空");
  if (options.all && (options.publisher || options.catalogPrefix || options.includeRelease.length)) {
    throw new Error("--all 不能与 --publisher、--catalog-prefix 或 --include-release 同时使用");
  }
  if (!options.all && !options.publisher && !options.catalogPrefix && options.includeRelease.length === 0) {
    throw new Error("请指定 --all、至少一个范围筛选，或明确的 --include-release");
  }
  return options;
}

/** 收集一个 kind 的实体，并返回统一分页 coverage；失败页不会伪装成空集合。 */
export async function collectEntities({ kind, params = {}, limit = 100, requestFn = request } = {}) {
  if (!KINDS.has(kind)) throw new Error(`未知实体 kind：${kind ?? "(缺失)"}`);
  if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("collectEntities params 必须是对象");
  if (params.kind !== undefined && params.kind !== kind) throw new Error(`params.kind 与 kind 不一致：${params.kind} != ${kind}`);
  const collected = await collectPages(RELEASE_LIST_PATH, {
    params: { ...params, kind },
    limit,
    requestFn,
  });
  for (const item of collected.items) {
    if (item.kind !== kind) {
      collected.coverage.failures.push({ reason: "kind_mismatch", id: item.id, expected: kind, actual: item.kind ?? null });
    }
  }
  if (collected.coverage.failures.length) collected.coverage.complete = false;
  return collected;
}

/** 范围筛选条件之间为 AND；明确 includeRelease ID 是额外 OR。 */
export function selectReleases(releases, {
  all = false,
  publisher,
  catalogPrefix,
  includeRelease = [],
} = {}) {
  const publisherFilter = publisher?.trim() || "";
  const prefixFilter = catalogPrefix?.trim() || "";
  const included = new Set(includeRelease);
  if (all && (publisherFilter || prefixFilter || included.size)) {
    throw new Error("--all 不能与其它发行筛选同时使用");
  }
  if (!all && !publisherFilter && !prefixFilter && included.size === 0) {
    throw new Error("无筛选时必须明确指定 --all 或 --include-release");
  }

  const byId = new Map();
  const reasons = {};
  const filterMatchedIds = new Set();
  const includeMatchedIds = new Set();
  const normalizedPrefix = prefixFilter.toUpperCase();

  for (const release of releases) {
    if (!isRecord(release) || typeof release.id !== "string" || !release.id.trim() || release.kind !== "release") {
      throw new Error("发行筛选收到 kind/id 不合法的实体；请检查 collection coverage");
    }
    const attributes = isRecord(release.attributes) ? release.attributes : {};
    const publisherMatches = !publisherFilter || normalizePublisher(attributes.publisher) === publisherFilter;
    const catalogNumber = typeof attributes.catalog_number === "string" ? attributes.catalog_number.trim() : "";
    const prefixMatches = !normalizedPrefix || catalogNumber.toUpperCase().startsWith(normalizedPrefix);
    const matchesFilters = publisherMatches && prefixMatches;
    const selectedByBase = all || (Boolean(publisherFilter || normalizedPrefix) && matchesFilters);
    const selectedByInclude = included.has(release.id);
    if (!selectedByBase && !selectedByInclude) continue;

    byId.set(release.id, release);
    const selectedReasons = [];
    if (all) selectedReasons.push({ type: "all" });
    else if (selectedByBase) selectedReasons.push({
      type: "scope_filters",
      ...(publisherFilter ? { publisher: publisherFilter } : {}),
      ...(prefixFilter ? { catalog_prefix: prefixFilter } : {}),
    });
    if (selectedByInclude) {
      selectedReasons.push({ type: "include_release", id: release.id });
      includeMatchedIds.add(release.id);
    }
    reasons[release.id] = selectedReasons;
    if (selectedByBase) filterMatchedIds.add(release.id);
  }

  return {
    items: [...byId.values()],
    selectionReasons: reasons,
    scope: {
      mode: all ? "all" : (publisherFilter || prefixFilter ? "filtered" : "explicit_ids"),
      publisher: publisherFilter || null,
      catalog_prefix: prefixFilter || null,
      filter_logic: "AND",
      include_logic: "OR",
      include_release: [...included],
      filter_matched_count: filterMatchedIds.size,
      include_matched_count: includeMatchedIds.size,
      selected_count: byId.size,
    },
  };
}

function addUnknown(result, reason, details = {}) {
  result.unknown.push({ reason, ...details });
}

function addFinding(result, reason, details = {}) {
  result.findings.push({ reason, ...details });
}

/** 只读审计 Release TOC DTO；不请求 relations，直接检查 Track.contents。 */
export async function auditReleaseTOC(releaseId, { requestFn = request } = {}) {
  const result = {
    releaseId,
    complete: false,
    counts: { media: 0, tracks: 0, contents: 0, expressionReferences: 0, visibleExpressions: 0, emptyContentsTracks: 0 },
    findings: [],
    unknown: [],
    untraversed: [],
    failure: null,
  };
  let response;
  try {
    response = await requestFn(`/api/catalog/releases/${encodeURIComponent(releaseId)}/toc`);
  } catch (error) {
    result.failure = { reason: "request_threw", errorName: error?.name ?? "Error" };
    addUnknown(result, "toc_request_failed", { release_id: releaseId });
    return result;
  }
  if (response?.status !== 200 || !isRecord(response.body)) {
    result.failure = {
      reason: "toc_request_failed",
      status: Number.isInteger(response?.status) && response.status > 0 ? response.status : null,
      code: response?.body?.error ?? response?.body?.code ?? null,
    };
    addUnknown(result, "toc_unavailable", { release_id: releaseId });
    return result;
  }

  const toc = response.body;
  const release = toc.release;
  if (!isRecord(release) || release.kind !== "release" || release.id !== releaseId) {
    addUnknown(result, "invalid_toc_release", { release_id: releaseId });
    return result;
  }

  let subjectsKnown = true;
  const subjectWorks = new Set();
  if (!hasOwn(release, "subjects") || !Array.isArray(release.subjects)) {
    subjectsKnown = false;
    addUnknown(result, "release_subjects_missing_or_invalid", { release_id: releaseId });
  } else {
    const pairs = new Set();
    for (let index = 0; index < release.subjects.length; index += 1) {
      const subject = release.subjects[index];
      if (!isRecord(subject) || typeof subject.work_id !== "string" || !subject.work_id) {
        subjectsKnown = false;
        addUnknown(result, "invalid_release_subject", { release_id: releaseId, index });
        continue;
      }
      subjectWorks.add(subject.work_id);
      const pair = `${subject.work_id}\u0000${String(subject.role ?? "")}`;
      if (pairs.has(pair)) addFinding(result, "duplicate_subject", { release_id: releaseId, work_id: subject.work_id, role: subject.role ?? null });
      pairs.add(pair);
    }
  }

  if (!Array.isArray(toc.media)) {
    addUnknown(result, "toc_media_missing_or_invalid", { release_id: releaseId });
    return result;
  }
  const expressionsKnown = isRecord(toc.expressions);
  if (!expressionsKnown) addUnknown(result, "toc_expressions_missing_or_invalid", { release_id: releaseId });
  const expressions = expressionsKnown ? toc.expressions : {};
  const visibleExpressionIds = new Set();
  const addUntraversed = (kind, id, reason, details = {}) => {
    if (typeof id !== "string" || !id.trim()) return;
    if (result.untraversed.some((item) => item.kind === kind && item.id === id && item.reason === reason)) return;
    result.untraversed.push({ kind, id, reason, ...details });
  };
  const markTracksUntraversed = (tracks, mediumId, fallbackReason, mediumIdKnown) => {
    if (!Array.isArray(tracks)) return;
    for (let index = 0; index < tracks.length; index += 1) {
      const track = tracks[index];
      if (!isRecord(track) || track.kind !== "track" || typeof track.id !== "string" || !track.id.trim()) {
        addUnknown(result, "invalid_toc_track", { release_id: releaseId, medium_id: mediumId, track_index: index });
        addUntraversed("track", track?.id, fallbackReason, { release_id: releaseId, medium_id: mediumId });
        continue;
      }
      result.counts.tracks += 1;
      if (mediumIdKnown && track.medium_id !== mediumId) {
        addUnknown(result, "track_medium_scope_mismatch", {
          release_id: releaseId,
          medium_id: mediumId,
          track_id: track.id,
          actual_medium_id: track.medium_id ?? null,
        });
        addUntraversed("track", track.id, "medium_scope_mismatch", { release_id: releaseId, medium_id: mediumId });
      } else {
        addUntraversed("track", track.id, fallbackReason, { release_id: releaseId, medium_id: mediumId });
      }
    }
  };
  const mediumPositions = new Map();

  for (let mediaIndex = 0; mediaIndex < toc.media.length; mediaIndex += 1) {
    const group = toc.media[mediaIndex];
    const groupMedium = isRecord(group) ? group.medium : null;
    const groupMediumId = isRecord(groupMedium) && typeof groupMedium.id === "string" ? groupMedium.id : null;
    if (!isRecord(group) || !isRecord(group.medium) || group.medium.kind !== "medium"
      || typeof group.medium.id !== "string" || !group.medium.id.trim()) {
      addUnknown(result, "invalid_toc_medium", { release_id: releaseId, media_index: mediaIndex });
      addUntraversed("medium", groupMediumId, "invalid_toc_medium", { release_id: releaseId });
      markTracksUntraversed(group?.tracks, groupMediumId, "medium_untraversable", Boolean(groupMediumId?.trim()));
      continue;
    }
    const medium = group.medium;
    result.counts.media += 1;
    if (medium.release_id !== releaseId) {
      addUnknown(result, "medium_release_scope_mismatch", {
        release_id: releaseId,
        medium_id: medium.id,
        actual_release_id: medium.release_id ?? null,
      });
      addUntraversed("medium", medium.id, "release_scope_mismatch", { release_id: releaseId });
      markTracksUntraversed(group.tracks, medium.id, "medium_scope_unverified", true);
      continue;
    }
    if (!Number.isInteger(medium.position)) {
      addUnknown(result, "invalid_medium_position", { release_id: releaseId, medium_id: medium.id });
    } else if (mediumPositions.has(medium.position)) {
      addFinding(result, "duplicate_medium_position", {
        release_id: releaseId,
        position: medium.position,
        medium_ids: [mediumPositions.get(medium.position), medium.id],
      });
    } else mediumPositions.set(medium.position, medium.id);

    if (!Array.isArray(group.tracks)) {
      addUnknown(result, "toc_tracks_missing_or_invalid", { release_id: releaseId, medium_id: medium.id });
      continue;
    }
    const trackPositions = new Map();
    for (let trackIndex = 0; trackIndex < group.tracks.length; trackIndex += 1) {
      const track = group.tracks[trackIndex];
      const knownTrackId = isRecord(track) && typeof track.id === "string" ? track.id : null;
      if (!isRecord(track) || track.kind !== "track" || typeof track.id !== "string" || !track.id.trim()) {
        addUnknown(result, "invalid_toc_track", { release_id: releaseId, medium_id: medium.id, track_index: trackIndex });
        addUntraversed("track", knownTrackId, "invalid_toc_track", { release_id: releaseId, medium_id: medium.id });
        continue;
      }
      result.counts.tracks += 1;
      if (track.medium_id !== medium.id) {
        addUnknown(result, "track_medium_scope_mismatch", {
          release_id: releaseId,
          medium_id: medium.id,
          track_id: track.id,
          actual_medium_id: track.medium_id ?? null,
        });
        addUntraversed("track", track.id, "medium_scope_mismatch", { release_id: releaseId, medium_id: medium.id });
        continue;
      }
      if (!Number.isInteger(track.position)) {
        addUnknown(result, "invalid_track_position", { release_id: releaseId, medium_id: medium.id, track_id: track.id });
      } else if (trackPositions.has(track.position)) {
        addFinding(result, "duplicate_track_position", {
          release_id: releaseId,
          medium_id: medium.id,
          position: track.position,
          track_ids: [trackPositions.get(track.position), track.id],
        });
      } else trackPositions.set(track.position, track.id);

      if (!hasOwn(track, "contents") || !Array.isArray(track.contents)) {
        addUnknown(result, "track_contents_missing_or_invalid", { release_id: releaseId, medium_id: medium.id, track_id: track.id });
        continue;
      }
      if (track.contents.length === 0) {
        result.counts.emptyContentsTracks += 1;
        addFinding(result, "empty_contents_track", { release_id: releaseId, medium_id: medium.id, track_id: track.id });
        continue;
      }

      const contentPositions = new Map();
      const contentKeys = new Set();
      for (let contentIndex = 0; contentIndex < track.contents.length; contentIndex += 1) {
        const content = track.contents[contentIndex];
        result.counts.contents += 1;
        if (!isRecord(content) || typeof content.expression_id !== "string" || !content.expression_id) {
          addUnknown(result, "invalid_track_content", { release_id: releaseId, track_id: track.id, content_index: contentIndex });
          continue;
        }
        result.counts.expressionReferences += 1;
        if (!Number.isInteger(content.position)) {
          addUnknown(result, "invalid_content_position", { release_id: releaseId, track_id: track.id, expression_id: content.expression_id });
        } else if (contentPositions.has(content.position)) {
          addFinding(result, "duplicate_content_position", {
            release_id: releaseId,
            track_id: track.id,
            position: content.position,
          });
        } else contentPositions.set(content.position, content.expression_id);

        if (!hasOwn(content, "locator") || !isRecord(content.locator)) {
          addUnknown(result, "content_locator_missing_or_invalid", { release_id: releaseId, track_id: track.id, expression_id: content.expression_id });
        } else {
          const contentKey = `${content.expression_id}\u0000${JSON.stringify(stableJson(content.locator))}`;
          if (contentKeys.has(contentKey)) addFinding(result, "duplicate_content", {
            release_id: releaseId,
            track_id: track.id,
            expression_id: content.expression_id,
            locator: content.locator,
          });
          contentKeys.add(contentKey);
        }

        const expression = expressions[content.expression_id];
        if (!expressionsKnown || !isRecord(expression)) {
          addUnknown(result, "expression_not_visible_in_toc", { release_id: releaseId, track_id: track.id, expression_id: content.expression_id });
          continue;
        }
        if (expression.kind !== "expression" || typeof expression.id !== "string"
          || !expression.id.trim() || expression.id !== content.expression_id) {
          addUnknown(result, "invalid_toc_expression", { release_id: releaseId, track_id: track.id, expression_id: content.expression_id });
          continue;
        }
        visibleExpressionIds.add(content.expression_id);
        if (typeof expression.work_id !== "string" || !expression.work_id) {
          addUnknown(result, "expression_work_missing", { release_id: releaseId, track_id: track.id, expression_id: content.expression_id });
        } else if (subjectsKnown && !subjectWorks.has(expression.work_id)) {
          addFinding(result, "expression_work_missing_from_subjects", {
            release_id: releaseId,
            track_id: track.id,
            expression_id: content.expression_id,
            work_id: expression.work_id,
          });
        }
      }
    }
  }

  result.counts.visibleExpressions = visibleExpressionIds.size;
  result.counts.untraversed = result.untraversed.length;
  result.complete = result.unknown.length === 0 && result.failure === null;
  return result;
}

async function resolveExplicitReleases(ids, knownReleases, requestFn) {
  const known = new Map(knownReleases.map((release) => [release.id, release]));
  const failures = [];
  for (const id of ids) {
    if (known.has(id)) continue;
    let response;
    try {
      response = await requestFn(`/api/catalog/entities/${encodeURIComponent(id)}`);
    } catch (error) {
      failures.push({ id, reason: "explicit_release_request_threw", errorName: error?.name ?? "Error" });
      continue;
    }
    const entity = response?.body;
    if (response?.status !== 200 || !isRecord(entity) || entity.kind !== "release" || entity.id !== id) {
      failures.push({
        id,
        reason: response?.status === 200 ? "explicit_id_not_release" : "explicit_release_unavailable",
        status: Number.isInteger(response?.status) && response.status > 0 ? response.status : null,
        code: entity?.error ?? entity?.code ?? null,
      });
      continue;
    }
    known.set(id, entity);
  }
  return { releases: [...known.values()], failures };
}

export async function buildSnapshot(options, { requestFn = request } = {}) {
  const collection = await collectEntities({ kind: "release", limit: 100, requestFn });
  const collectedReleases = collection.items.filter((item) => item.kind === "release");
  const explicit = options.includeRelease?.length
    ? await resolveExplicitReleases(options.includeRelease, collectedReleases, requestFn)
    : { releases: collectedReleases, failures: [] };
  const selection = selectReleases(explicit.releases, options);
  const audited = [];
  for (const release of selection.items) {
    const toc = await auditReleaseTOC(release.id, { requestFn });
    audited.push({
      release: { id: release.id, title: release.title ?? null },
      selection_reasons: selection.selectionReasons[release.id],
      toc,
    });
  }

  const tocComplete = audited.every((entry) => entry.toc.complete);
  const failures = [
    ...collection.coverage.failures.map((failure) => ({ stage: "release_collection", ...failure })),
    ...explicit.failures.map((failure) => ({ stage: "explicit_release", ...failure })),
    ...audited.filter((entry) => entry.toc.failure).map((entry) => ({ stage: "release_toc", release_id: entry.release.id, ...entry.toc.failure })),
  ];
  const unknown = audited.flatMap((entry) => entry.toc.unknown.map((item) => ({ release_id: entry.release.id, ...item })));
  const untraversed = audited.flatMap((entry) => entry.toc.untraversed.map((item) => ({ release_id: entry.release.id, ...item })));
  const findings = audited.flatMap((entry) => entry.toc.findings.map((item) => ({ release_id: entry.release.id, ...item })));
  const complete = collection.coverage.complete && explicit.failures.length === 0 && tocComplete;

  return {
    coverage_basis: "当前调用者可见的列表和 TOC 投影；不证明全库可见、来源权威性或身份完整",
    complete,
    scope: {
      ...selection.scope,
      selection_reasons: selection.selectionReasons,
      source_collection_kind: "release",
      source_collection_total: collection.coverage.total,
      source_collection_complete: collection.coverage.complete,
    },
    collectionCoverage: collection.coverage,
    tocCoverage: {
      selected: audited.length,
      complete: tocComplete,
      complete_count: audited.filter((entry) => entry.toc.complete).length,
      unknown_count: unknown.length,
    },
    counts: {
      media: audited.reduce((sum, entry) => sum + entry.toc.counts.media, 0),
      tracks: audited.reduce((sum, entry) => sum + entry.toc.counts.tracks, 0),
      contents: audited.reduce((sum, entry) => sum + entry.toc.counts.contents, 0),
      expression_references: audited.reduce((sum, entry) => sum + entry.toc.counts.expressionReferences, 0),
      visible_expressions: audited.reduce((sum, entry) => sum + entry.toc.counts.visibleExpressions, 0),
      findings: findings.length,
      unknown: unknown.length,
      untraversed_ids: untraversed.length,
    },
    failures,
    unknown,
    untraversed,
    findings,
    releases: audited,
  };
}

function summary(snapshot) {
  const coverage = snapshot.collectionCoverage;
  return `发行快照：选中 ${snapshot.scope.selected_count} 个；列表页 ${coverage.pages}、total ${coverage.total ?? "未知"}、raw ${coverage.rawCount}、unique ${coverage.uniqueCount}；TOC ${snapshot.counts.media} Medium/${snapshot.counts.tracks} Track、${snapshot.counts.expression_references} 引用/${snapshot.counts.visible_expressions} 个可见 Expression；遍历完整 ${snapshot.tocCoverage.complete_count}/${snapshot.tocCoverage.selected}；候选 ${snapshot.counts.findings}、未知 ${snapshot.counts.unknown}、未遍历 ID ${snapshot.counts.untraversed_ids}；${snapshot.complete ? "完整" : "不完整"}`;
}

export async function main(argv = process.argv.slice(2), { requestFn = request } = {}) {
  let options;
  try {
    options = parseArgs(argv);
    if (options.help) {
      console.log(USAGE);
      return 0;
    }
  } catch (error) {
    console.error(String(error?.message ?? error));
    console.error(USAGE);
    return 2;
  }

  const snapshot = await buildSnapshot(options, { requestFn });
  console.log(summary(snapshot));
  if (options.out) writeFileSync(path.resolve(options.out), `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  return snapshot.complete ? 0 : 1;
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  process.exitCode = await main();
}
