#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { request as apiRequest, writableEntity } from "../metafusion-api.mjs";

const CONTENTS_PATH = "/api/catalog/tracks/{id}/contents";
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isRevisionId = (value) => (typeof value === "string" && value.trim().length > 0)
  || (Number.isSafeInteger(value) && value > 0);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function same(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function cloneJson(value) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("not_json_serializable");
  return JSON.parse(serialized);
}

function validHttpUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function validSources(sources, { required = true } = {}) {
  if (!Array.isArray(sources) || (required && sources.length === 0)) return false;
  return sources.every((source) => isRecord(source)
    && Object.keys(source).every((key) => ["kind", "citation", "url"].includes(key))
    && ["url", "publication", "self"].includes(source.kind)
    && typeof source.citation === "string"
    && source.citation.trim().length > 0
    && (source.kind !== "url" || validHttpUrl(source.url))
    && (source.url === undefined || validHttpUrl(source.url)))
    && (!required || sources.some((source) => source.kind !== "self"));
}

export function validatePlan(plan) {
  if (!isRecord(plan)) return "invalid_plan";
  for (const operation of [plan.operation, plan.action]) {
    if (operation !== undefined && operation !== "add") return "unsupported_operation";
  }
  const planKeys = new Set(["track_id", "expected_version", "inclusion", "edit_note", "sources", "operation", "action"]);
  if (Object.keys(plan).some((key) => !planKeys.has(key))) return "invalid_plan";
  if (typeof plan.track_id !== "string" || !plan.track_id.trim()
    || !Number.isSafeInteger(plan.expected_version) || plan.expected_version < 1) return "invalid_plan";
  if (!isRecord(plan.inclusion)) return "invalid_inclusion";
  const inclusionKeys = new Set(["expression_id", "position", "locator", "attributes", "sources"]);
  if (Object.keys(plan.inclusion).some((key) => !inclusionKeys.has(key))) return "invalid_inclusion";
  if (typeof plan.inclusion.expression_id !== "string" || !plan.inclusion.expression_id.trim()
    || !Number.isSafeInteger(plan.inclusion.position) || plan.inclusion.position < 0) return "invalid_inclusion";
  if (has(plan.inclusion, "locator") && !isRecord(plan.inclusion.locator)) return "invalid_inclusion_locator";
  if (has(plan.inclusion, "attributes") && !isRecord(plan.inclusion.attributes)) return "invalid_inclusion_attributes";
  if (has(plan.inclusion, "sources") && !validSources(plan.inclusion.sources)) return "invalid_inclusion_sources";
  if (typeof plan.edit_note !== "string" || !plan.edit_note.trim()) return "edit_note_required";
  if (!validSources(plan.sources)) return "invalid_sources";
  try {
    cloneJson(plan);
  } catch {
    return "invalid_json_value";
  }
  return null;
}

function statusOf(response) {
  return Number.isInteger(response?.status) ? response.status : 0;
}

function safeCode(response) {
  const code = response?.body?.error ?? response?.body?.code;
  return typeof code === "string" && /^[a-zA-Z0-9_.-]{1,64}$/.test(code) ? code : undefined;
}

async function read(requestFn, pathname) {
  try {
    const response = await requestFn(pathname, { method: "GET" });
    return { status: statusOf(response), body: response?.body, threw: false };
  } catch {
    return { status: 0, body: null, threw: true };
  }
}

function entityPath(id) {
  return `/api/catalog/entities/${encodeURIComponent(id)}`;
}

function normalizedContent(item) {
  return {
    ...item,
    locator: has(item, "locator") ? item.locator : {},
    attributes: has(item, "attributes") ? item.attributes : {},
    sources: has(item, "sources") ? item.sources : [],
  };
}

function validContents(contents) {
  if (!Array.isArray(contents)) return false;
  const positions = new Set();
  for (const item of contents) {
    if (!isRecord(item) || typeof item.expression_id !== "string" || !item.expression_id.trim()
      || !Number.isSafeInteger(item.position) || item.position < 0
      || !isRecord(item.locator)
      || (has(item, "attributes") && !isRecord(item.attributes))
      || (has(item, "sources") && !Array.isArray(item.sources))) return false;
    if (positions.has(item.position)) return false;
    positions.add(item.position);
  }
  return true;
}

function planInclusion(plan) {
  const inclusion = {
    expression_id: plan.inclusion.expression_id,
    position: plan.inclusion.position,
    locator: cloneJson(plan.inclusion.locator ?? {}),
  };
  if (has(plan.inclusion, "attributes")) inclusion.attributes = cloneJson(plan.inclusion.attributes);
  if (has(plan.inclusion, "sources")) inclusion.sources = cloneJson(plan.inclusion.sources);
  return inclusion;
}

function expectedAddedContent(plan) {
  const requestInclusion = planInclusion(plan);
  return normalizedContent({
    ...requestInclusion,
    attributes: requestInclusion.attributes ?? {},
    sources: requestInclusion.sources ?? cloneJson(plan.sources),
  });
}

function matchMultiset(expected, actual, normalize = (value) => value) {
  if (!Array.isArray(expected) || !Array.isArray(actual) || expected.length !== actual.length) return false;
  const remaining = actual.map(normalize);
  for (const item of expected) {
    const wanted = normalize(item);
    const index = remaining.findIndex((candidate) => same(candidate, wanted));
    if (index < 0) return false;
    remaining.splice(index, 1);
  }
  return remaining.length === 0;
}

function compareTrackContents(beforeContents, afterContents, plan) {
  const checks = {
    oldContentsPreserved: beforeContents.every((item) => afterContents.some((candidate) => same(
      normalizedContent(item), normalizedContent(candidate),
    ))),
    countIsOneMore: afterContents.length === beforeContents.length + 1,
    newInclusionPresent: false,
  };
  const wanted = expectedAddedContent(plan);
  const matches = afterContents.filter((item) => same(normalizedContent(item), wanted));
  checks.newInclusionPresent = matches.length === 1;
  checks.contentsVerified = checks.oldContentsPreserved && checks.countIsOneMore && checks.newInclusionPresent;
  return checks;
}

function compareUnrequestedTrackFields(before, after) {
  const ignored = new Set(["version", "contents", "created_by", "redirect_id", "updated_at"]);
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const checks = [];
  for (const key of keys) {
    if (ignored.has(key)) continue;
    checks.push({ field: key, ok: has(before, key) === has(after, key) && same(before[key], after[key]) });
  }
  return checks;
}

function failure(reason, extra = {}) {
  return { ok: false, outcome: "preflight_failed", reason, applied: false, ...extra };
}

function openApiSupportsEndpoint(document, endpoint, method) {
  const supports = (path) => isRecord(document.paths[path]) && isRecord(document.paths[path][method]);
  if (supports(endpoint)) return true;

  for (const server of Array.isArray(document.servers) ? document.servers : []) {
    if (typeof server?.url !== "string") continue;
    let prefix;
    try {
      prefix = new URL(server.url, "https://metafusion.invalid").pathname.replace(/\/+$/, "");
    } catch {
      continue;
    }
    if (!prefix || !endpoint.startsWith(`${prefix}/`)) continue;
    if (supports(endpoint.slice(prefix.length))) return true;
  }
  return false;
}

async function preflight(plan, requestFn) {
  const openapiPath = "/api/openapi.json";
  const openapiResult = await read(requestFn, openapiPath);
  if (openapiResult.status !== 200 || !isRecord(openapiResult.body) || !isRecord(openapiResult.body.paths)) {
    return { error: failure("openapi_unavailable", { httpStatus: openapiResult.status }) };
  }
  if (!openApiSupportsEndpoint(openapiResult.body, CONTENTS_PATH, "post")) {
    return { error: failure("contents_add_endpoint_not_in_openapi", { httpStatus: 200 }) };
  }

  const trackResult = await read(requestFn, entityPath(plan.track_id));
  const track = trackResult.body;
  if (trackResult.status !== 200 || !isRecord(track) || track.id !== plan.track_id
    || track.kind !== "track" || !Number.isSafeInteger(track.version)) {
    return { error: failure("track_unavailable_or_invalid", { httpStatus: trackResult.status }) };
  }
  if (track.version !== plan.expected_version) {
    return { error: {
      ok: false, outcome: "version_conflict", reason: "expected_version_mismatch", applied: false,
      expectedVersion: plan.expected_version, currentVersion: track.version,
    } };
  }
  if (!has(track, "contents") || !validContents(track.contents)) {
    return { error: failure("track_contents_missing_or_invalid", { httpStatus: 200, currentVersion: track.version }) };
  }
  if (typeof track.medium_id !== "string" || !track.medium_id.trim()) {
    return { error: failure("track_medium_id_missing", { httpStatus: 200, currentVersion: track.version }) };
  }

  const mediumResult = await read(requestFn, entityPath(track.medium_id));
  const medium = mediumResult.body;
  if (mediumResult.status !== 200 || !isRecord(medium) || medium.id !== track.medium_id
    || medium.kind !== "medium" || typeof medium.release_id !== "string" || !medium.release_id.trim()) {
    return { error: failure("medium_unavailable_or_invalid", { httpStatus: mediumResult.status, mediumId: track.medium_id }) };
  }

  const releaseResult = await read(requestFn, entityPath(medium.release_id));
  const release = releaseResult.body;
  if (releaseResult.status !== 200 || !isRecord(release) || release.id !== medium.release_id
    || release.kind !== "release" || !Array.isArray(release.subjects)) {
    return { error: failure("release_unavailable_or_invalid", { httpStatus: releaseResult.status, releaseId: medium.release_id }) };
  }
  if (release.subjects.some((subject) => !isRecord(subject) || typeof subject.work_id !== "string" || !subject.work_id.trim())) {
    return { error: failure("release_subjects_invalid", { httpStatus: 200, releaseId: release.id }) };
  }

  const expressionResult = await read(requestFn, entityPath(plan.inclusion.expression_id));
  const expression = expressionResult.body;
  if (expressionResult.status !== 200 || !isRecord(expression) || expression.id !== plan.inclusion.expression_id
    || expression.kind !== "expression" || typeof expression.work_id !== "string" || !expression.work_id.trim()) {
    return { error: failure("expression_unavailable_or_invalid", { httpStatus: expressionResult.status, expressionId: plan.inclusion.expression_id }) };
  }
  if (!release.subjects.some((subject) => subject.work_id === expression.work_id)) {
    return { error: {
      ok: false, outcome: "rejected", reason: "undeclared_release_subject", applied: false,
      trackId: track.id, mediumId: medium.id, releaseId: release.id,
      expressionId: expression.id, expressionWorkId: expression.work_id,
    } };
  }

  const wanted = planInclusion(plan);
  if (track.contents.some((item) => item.expression_id === wanted.expression_id && same(item.locator, wanted.locator))) {
    return { error: {
      ok: false, outcome: "rejected", reason: "duplicate_content", applied: false,
      trackId: track.id, currentVersion: track.version,
    } };
  }
  if (track.contents.some((item) => item.position === wanted.position)) {
    return { error: {
      ok: false, outcome: "rejected", reason: "position_conflict", applied: false,
      trackId: track.id, currentVersion: track.version, position: wanted.position,
    } };
  }

  return {
    track: cloneJson(track),
    medium: cloneJson(medium),
    release: cloneJson(release),
    expression: cloneJson(expression),
    openapi: { endpoint: CONTENTS_PATH, method: "POST", supported: true },
  };
}

async function readonlyRecheck(plan, requestFn, writeStatus) {
  const entityResult = await read(requestFn, entityPath(plan.track_id));
  const track = entityResult.status === 200 && isRecord(entityResult.body)
    && entityResult.body.id === plan.track_id && entityResult.body.kind === "track"
    ? entityResult.body : null;
  let revision = { state: "not_checked" };
  if (track) {
    const revisionResult = await read(requestFn, `${entityPath(plan.track_id)}/revisions`);
    const items = revisionResult.body?.items;
    if (revisionResult.status !== 200 || !Array.isArray(items)) {
      revision = { state: "unavailable", httpStatus: revisionResult.status };
    } else {
      const found = items.find((item) => item?.version === track.version);
      revision = { state: found ? "current_revision_found" : "current_revision_missing", version: track.version };
    }
  }
  const requestedVisible = track && validContents(track.contents)
    ? track.contents.some((item) => item.expression_id === plan.inclusion.expression_id
      && item.position === plan.inclusion.position && same(item.locator, plan.inclusion.locator ?? {}))
    : null;
  return {
    writeStatus,
    track: {
      state: track ? "readable" : "unavailable",
      httpStatus: entityResult.status,
      currentVersion: track?.version ?? null,
      requestedInclusionVisible: requestedVisible,
    },
    revision,
    visibilityScope: "caller-visible projection only",
  };
}

function verifyTrackReadback(response, plan, before) {
  const track = response.status === 200 ? response.body : null;
  if (!isRecord(track) || track.id !== plan.track_id || track.kind !== "track"
    || !Number.isSafeInteger(track.version) || !validContents(track.contents)) {
    return { state: "failed", httpStatus: response.status, reason: "track_readback_unavailable_or_invalid" };
  }
  const expectedVersion = plan.expected_version + 1;
  const versionOk = track.version === expectedVersion;
  const reportedVersion = response.writeVersion;
  const responseVersionOk = reportedVersion === null || reportedVersion === track.version;
  const contentChecks = compareTrackContents(before.contents, track.contents, plan);
  const fieldChecks = compareUnrequestedTrackFields(before, track);
  const fieldsOk = fieldChecks.every((item) => item.ok);
  const ok = versionOk && responseVersionOk && contentChecks.contentsVerified && fieldsOk;
  return {
    state: ok ? "verified" : "failed",
    httpStatus: response.status,
    version: { expected: expectedVersion, actual: track.version, response: reportedVersion, ok: versionOk && responseVersionOk },
    contents: contentChecks,
    unrequestedFields: fieldChecks,
    visibleContentsCount: track.contents.length,
    entity: track,
    ok,
  };
}

function verifyRevisionReadback(response, trackCheck, plan) {
  if (response.status !== 200 || !Array.isArray(response.body?.items)) {
    return { state: "failed", httpStatus: response.status, reason: "revisions_unavailable_or_invalid" };
  }
  if (!trackCheck?.entity) return { state: "failed", httpStatus: response.status, reason: "track_unavailable_for_revision_match" };
  const matches = response.body.items.filter((item) => item?.version === trackCheck.entity.version);
  if (matches.length !== 1) {
    return { state: "failed", httpStatus: response.status, reason: "current_revision_missing_or_ambiguous", version: trackCheck.entity.version };
  }
  const revision = matches[0];
  const snapshot = isRecord(revision.snapshot) ? writableEntity(revision.snapshot) : null;
  const current = writableEntity(trackCheck.entity);
  const snapshotMatches = !!snapshot && same(snapshot, current);
  const sourcesMatch = same(revision.sources, plan.sources);
  const idValid = isRevisionId(revision.id);
  const ok = snapshotMatches && sourcesMatch && idValid;
  return {
    state: ok ? "verified" : "failed",
    httpStatus: response.status,
    version: revision.version,
    revisionIdPresent: idValid,
    snapshotMatches,
    sourcesMatch,
    ok,
  };
}

function findTocTrack(toc, mediumId, trackId) {
  for (const group of toc.media) {
    if (group?.medium?.id !== mediumId || !Array.isArray(group.tracks)) continue;
    const track = group.tracks.find((candidate) => candidate?.id === trackId);
    if (track) return track;
  }
  return null;
}

function verifyTocReadback(response, context, plan) {
  const toc = response.status === 200 ? response.body : null;
  if (!isRecord(toc) || toc.release?.id !== context.release.id || toc.release?.kind !== "release" || !Array.isArray(toc.media)
    || !isRecord(toc.expressions)) {
    return { state: "failed", httpStatus: response.status, reason: "toc_unavailable_or_invalid" };
  }
  const matchingGroups = toc.media.filter((candidate) => candidate?.medium?.id === context.medium.id);
  const group = matchingGroups.length === 1 ? matchingGroups[0] : null;
  const track = findTocTrack(toc, context.medium.id, plan.track_id);
  const mediumOwnershipMatches = !!group && group.medium.kind === "medium"
    && group.medium.release_id === context.release.id;
  const trackOwnershipMatches = !!track && track.kind === "track" && track.medium_id === context.medium.id;
  if (!track || !mediumOwnershipMatches || !trackOwnershipMatches || !validContents(track.contents)) {
    return { state: "failed", httpStatus: response.status, reason: "track_missing_or_contents_invalid_in_toc" };
  }
  const targetExpression = toc.expressions[plan.inclusion.expression_id];
  const targetExpressionWorkMatches = isRecord(targetExpression)
    && targetExpression.work_id === context.expression.work_id;
  const targetExpressionVisible = isRecord(targetExpression)
    && targetExpression.id === plan.inclusion.expression_id && targetExpression.kind === "expression";
  const trackVersionMatches = track.version === context.afterTrack.version;
  const trackWritableEntityMatches = same(writableEntity(track), writableEntity(context.afterTrack));
  const workDeclared = Array.isArray(toc.release.subjects)
    && toc.release.subjects.some((subject) => subject?.work_id === context.expression.work_id);
  const sameVisibleContents = matchMultiset(context.afterTrack.contents, track.contents, normalizedContent);
  const addedChecks = compareTrackContents(context.beforeTrack.contents, track.contents, plan);
  const ok = targetExpressionVisible && targetExpressionWorkMatches && workDeclared
    && trackVersionMatches && trackWritableEntityMatches && sameVisibleContents && addedChecks.contentsVerified;
  return {
    state: ok ? "verified" : "failed",
    httpStatus: response.status,
    trackFound: true,
    mediumOwnershipMatches,
    trackOwnershipMatches,
    targetExpressionVisible,
    targetExpressionWorkMatches,
    expressionWorkDeclared: workDeclared,
    trackVersionMatches,
    trackWritableEntityMatches,
    visibleContentsMatchTrackRead: sameVisibleContents,
    contents: addedChecks,
    visibleContentsCount: track.contents.length,
    ok,
  };
}

function occurrenceContent(item) {
  return normalizedContent({
    expression_id: item.expression_id,
    position: item.position,
    locator: item.locator ?? {},
    attributes: item.attributes ?? {},
    sources: item.sources ?? [],
  });
}

function verifyOccurrencesReadback(response, context, plan) {
  const items = response.status === 200 ? response.body?.items : null;
  if (!Array.isArray(items)) {
    return { state: "failed", httpStatus: response.status, reason: "occurrences_unavailable_or_invalid" };
  }
  const expected = context.afterTrack.contents.filter((item) => item.expression_id === plan.inclusion.expression_id);
  const observed = items.filter((item) => item?.track?.id === plan.track_id
    && item?.expression_id === plan.inclusion.expression_id);
  const ownershipMatches = observed.length > 0 && observed.every((item) => item.track?.kind === "track"
    && item.track.medium_id === context.medium.id
    && (item.medium === undefined || (item.medium?.id === context.medium.id
      && item.medium?.kind === "medium" && item.medium?.release_id === context.release.id))
    && (item.release === undefined || (item.release?.id === context.release.id && item.release?.kind === "release")));
  const matches = matchMultiset(expected, observed, occurrenceContent);
  const requestedPresent = observed.some((item) => item.position === plan.inclusion.position
    && same(item.locator ?? {}, plan.inclusion.locator ?? {}));
  const ok = matches && requestedPresent && ownershipMatches;
  return {
    state: ok ? "verified" : "failed",
    httpStatus: response.status,
    trackOccurrenceCount: observed.length,
    releaseId: context.release.id,
    mediumId: context.medium.id,
    trackOwnershipMatches: ownershipMatches,
    expressionOccurrencesMatchTrack: matches,
    requestedReferencePresent: requestedPresent,
    ok,
  };
}

async function postWriteVerification(plan, context, requestFn, writeResponse) {
  const [trackResponse, revisionResponse, tocResponse, occurrenceResponse] = await Promise.all([
    read(requestFn, entityPath(plan.track_id)),
    read(requestFn, `${entityPath(plan.track_id)}/revisions`),
    read(requestFn, `/api/catalog/releases/${encodeURIComponent(context.release.id)}/toc`),
    read(requestFn, `${entityPath(plan.inclusion.expression_id)}/occurrences`),
  ]);
  const writeVersion = Number.isSafeInteger(writeResponse?.body?.version)
    ? writeResponse.body.version : null;
  const trackCheck = verifyTrackReadback({ ...trackResponse, writeVersion }, plan, context.track);
  const afterTrack = trackCheck.entity;
  if (!afterTrack) {
    return {
      ok: false,
      outcome: "partial",
      reason: "post_write_verification_failed",
      applied: true,
      httpStatus: statusOf(writeResponse),
      verification: {
        track: trackCheck,
        revision: verifyRevisionReadback(revisionResponse, null, plan),
        toc: { state: "failed", httpStatus: tocResponse.status, reason: "track_readback_unavailable" },
        occurrences: { state: "failed", httpStatus: occurrenceResponse.status, reason: "track_readback_unavailable" },
        visibilityScope: "caller-visible projection only",
      },
    };
  }
  const checks = {
    track: trackCheck,
    revision: verifyRevisionReadback(revisionResponse, trackCheck, plan),
    toc: verifyTocReadback(tocResponse, { ...context, beforeTrack: context.track, afterTrack }, plan),
    occurrences: verifyOccurrencesReadback(occurrenceResponse, { ...context, afterTrack }, plan),
    visibilityScope: "caller-visible projection only",
  };
  const ok = [checks.track, checks.revision, checks.toc, checks.occurrences].every((item) => item.state === "verified");
  return {
    ok,
    outcome: ok ? "verified" : "partial",
    reason: ok ? undefined : "post_write_verification_failed",
    applied: true,
    httpStatus: statusOf(writeResponse),
    version: afterTrack.version,
    verification: checks,
  };
}

/**
 * Add exactly one Track.contents inclusion. apply is only an execution switch;
 * inject requestFn for offline fixtures. All HTTP goes through metafusion-api.mjs.
 */
export async function addTrackContent({ plan, apply = false, requestFn = apiRequest } = {}) {
  const invalid = validatePlan(plan);
  if (invalid) return { ok: false, outcome: "rejected", reason: invalid, applied: false };
  if (typeof requestFn !== "function") {
    return { ok: false, outcome: "rejected", reason: "invalid_request_function", applied: false };
  }

  const checked = await preflight(plan, requestFn);
  if (checked.error) return checked.error;
  const { track, medium, release, expression, openapi } = checked;
  const pathname = `/api/catalog/tracks/${encodeURIComponent(plan.track_id)}/contents`;
  const body = {
    inclusion: planInclusion(plan),
    expected_version: plan.expected_version,
    edit_note: plan.edit_note.trim(),
    sources: cloneJson(plan.sources),
  };
  const summary = {
    trackId: track.id,
    expectedVersion: plan.expected_version,
    expressionId: expression.id,
    expressionWorkId: expression.work_id,
    mediumId: medium.id,
    releaseId: release.id,
    position: plan.inclusion.position,
    visibleExistingContents: track.contents.length,
    visibilityScope: "caller-visible projection only",
  };
  if (!apply) {
    return {
      ok: true, outcome: "preview", applied: false, summary, openapi,
      request: { method: "POST", path: pathname, body },
    };
  }

  let response;
  try {
    response = await requestFn(pathname, { method: "POST", tries: 1, body });
  } catch {
    const recheck = await readonlyRecheck(plan, requestFn, 0);
    return { ok: false, outcome: "unknown", reason: "write_result_unknown", applied: null, summary, recheck };
  }
  const status = statusOf(response);
  if (status === 409) {
    const recheck = await readonlyRecheck(plan, requestFn, status);
    return { ok: false, outcome: "conflict", reason: "version_conflict_no_replay", applied: false, httpStatus: status, summary, recheck };
  }
  if (status === 0 || status >= 500 || (status >= 300 && status < 400)) {
    const recheck = await readonlyRecheck(plan, requestFn, status);
    return { ok: false, outcome: "unknown", reason: "write_result_unknown", applied: null, httpStatus: status, summary, recheck };
  }
  if (status < 200 || status >= 300) {
    return { ok: false, outcome: "rejected", reason: "write_rejected", applied: false, httpStatus: status, errorCode: safeCode(response), summary };
  }
  return postWriteVerification(plan, { track, medium, release, expression }, requestFn, response);
}

function usage() {
  return [
    "用法: node mf-track-content.mjs --plan <JSON文件> [--apply] [--out <结果JSON文件>]",
    "默认只做预检与预览；--apply 只表示执行开关，不代表已获写入授权。",
    "仅支持新增一条 Track.contents；replace/delete 明确不支持。",
    "plan: { track_id, expected_version, inclusion: { expression_id, position, locator?, attributes?, sources? }, edit_note, sources }",
    "--out 可保存完整结果；stdout 只输出简短 JSON。--help 不读取凭据。",
  ].join("\n");
}

export function parseArgs(argv) {
  const options = { apply: false, plan: null, out: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--apply") options.apply = true;
    else if (arg === "--replace" || arg === "--delete") throw new Error("unsupported_operation");
    else if (arg === "--plan" || arg === "--out") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("invalid_cli_arguments");
      options[arg === "--plan" ? "plan" : "out"] = value;
      index += 1;
    } else throw new Error("invalid_cli_arguments");
  }
  if (options.help) return options;
  if (!options.plan) throw new Error("invalid_cli_arguments");
  if (options.out && path.resolve(options.out) === path.resolve(options.plan)) throw new Error("output_must_not_overwrite_plan");
  return options;
}

function compact(result) {
  return {
    ok: result.ok,
    outcome: result.outcome,
    reason: result.reason,
    track_id: result.summary?.trackId ?? result.trackId ?? null,
    version: result.version ?? result.currentVersion ?? result.expectedVersion ?? null,
    applied: result.applied,
    verification: result.verification
      ? Object.fromEntries(["track", "revision", "toc", "occurrences"].map((key) => [key, result.verification[key]?.state ?? "unknown"]))
      : undefined,
  };
}

export async function runCli(argv = process.argv.slice(2), {
  requestFn = apiRequest,
  stdout = (text) => process.stdout.write(`${text}\n`),
  stderr = (text) => process.stderr.write(`${text}\n`),
} = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    const reason = error?.message === "unsupported_operation" ? "unsupported_operation" : "invalid_cli_arguments";
    stderr(JSON.stringify({ ok: false, outcome: "rejected", reason }));
    return 2;
  }
  if (options.help) {
    stdout(usage());
    return 0;
  }

  let plan;
  try {
    plan = JSON.parse(fs.readFileSync(options.plan, "utf8"));
  } catch {
    stderr(JSON.stringify({ ok: false, outcome: "rejected", reason: "plan_read_failed" }));
    return 2;
  }
  let outputFd = null;
  if (options.out) {
    try {
      outputFd = fs.openSync(options.out, "wx");
    } catch {
      stderr(JSON.stringify({ ok: false, outcome: "rejected", reason: "out_path_unavailable" }));
      return 2;
    }
  }
  const result = await addTrackContent({ plan, apply: options.apply, requestFn });
  if (outputFd !== null) {
    try {
      fs.writeFileSync(outputFd, `${JSON.stringify(result, null, 2)}\n`, "utf8");
      fs.closeSync(outputFd);
    } catch {
      try { fs.closeSync(outputFd); } catch { /* descriptor may already be closed */ }
      stdout(JSON.stringify(compact(result)));
      stderr(JSON.stringify({ ok: false, outcome: "local_output_failed", reason: "out_write_failed" }));
      return 2;
    }
  }
  stdout(JSON.stringify(compact(result)));
  return result.ok ? 0 : 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await runCli();
}
