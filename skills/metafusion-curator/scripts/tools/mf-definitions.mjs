#!/usr/bin/env node

import fs from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { request as apiRequest } from "../metafusion-api.mjs";

const ADMIN_PATH = "/api/admin/catalog-definitions";
const PUBLIC_PATH = "/api/catalog/definitions";
const OPENAPI_PATH = "/api/openapi.json";
const IMPACT_PATH = `${ADMIN_PATH}/impact`;
const NAME_LOCALES = ["zh-CN", "zh-TW", "en-US"];
const JA_LOCALES = ["ja", "ja-JP"];
const TERM_PLAN_KEYS = new Set(["expected_etag", "vocabulary", "term_code", "term", "edit_note", "sources"]);
const FIELD_PLAN_KEYS = new Set(["action", "expected_etag", "field_code", "field", "edit_note", "sources"]);
const SOURCE_KEYS = new Set(["kind", "citation", "url"]);
const TERM_KEYS = new Set(["names", "enabled"]);
const FIELD_KEYS = new Set([
  "names", "type", "applicable_kinds", "fields", "items", "enabled", "required", "searchable", "comparable",
  "min", "max", "unit", "vocabulary", "kinds", "anchor_key", "range_start", "semantics", "hidden",
]);
const SAFE_FIELD_TYPES = new Set(["group", "list", "number", "text", "boolean", "date", "url", "multilingual"]);
const FIELD_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const RESERVED_FIELD_CODES = new Set([
  "id", "kind", "version", "status", "created_by", "work_id", "parent_id", "release_id", "medium_id",
  "content_unit_id", "contents", "subjects", "redirect_id",
]);
const ENTITY_KINDS = new Set(["agent", "collection", "work", "content_unit", "expression", "release", "medium", "track"]);
const DEFINITION_MAPS = ["fields", "vocabularies", "relations", "templates", "schemes", "structure"];

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function cloneJson(value) {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("non_json_value");
  return JSON.parse(encoded);
}

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

function validHttpUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function validLocale(locale) {
  if (typeof locale !== "string" || !locale.trim()) return false;
  try {
    return Intl.getCanonicalLocales(locale).length === 1;
  } catch {
    return false;
  }
}

function validateNames(names) {
  if (!isRecord(names) || Object.keys(names).length === 0) return "invalid_names";
  if (Object.entries(names).some(([locale, value]) => !validLocale(locale) || typeof value !== "string" || !value.trim())) {
    return "invalid_names";
  }
  return null;
}

function hasFourLocales(names) {
  return NAME_LOCALES.every((locale) => typeof names?.[locale] === "string" && names[locale].trim())
    && JA_LOCALES.some((locale) => typeof names?.[locale] === "string" && names[locale].trim());
}

function isJsonSafe(value, ancestors = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;
  if (Array.isArray(value)) {
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string" || (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key)))) return false;
    for (let index = 0; index < value.length; index += 1) {
      if (!has(value, index)) return false;
    }
    ancestors.add(value);
    const safe = value.every((item) => isJsonSafe(item, ancestors));
    ancestors.delete(value);
    return safe;
  }
  if (!isRecord(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) return false;
  ancestors.add(value);
  const safe = keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return Boolean(descriptor?.enumerable && has(descriptor, "value") && isJsonSafe(descriptor.value, ancestors));
  });
  ancestors.delete(value);
  return safe;
}

function validateFieldNode(field, { depth = 0, top = false } = {}) {
  if (depth > 4) return "field_nesting_limit";
  if (!isRecord(field) || Object.keys(field).some((key) => !FIELD_KEYS.has(key))) return "invalid_field_shape";
  if (!has(field, "type") || !SAFE_FIELD_TYPES.has(field.type)) return "unsupported_field_type";
  if (!has(field, "names") || validateNames(field.names) || !hasFourLocales(field.names)) return "four_locale_names_required";
  if (typeof field.enabled !== "boolean") return "invalid_field_enabled";
  for (const key of ["required", "searchable", "comparable", "hidden"]) {
    if (has(field, key) && typeof field[key] !== "boolean") return "invalid_field_boolean";
  }
  if (top && (!Array.isArray(field.applicable_kinds) || field.applicable_kinds.length === 0)) return "top_applicable_kinds_required";
  if (has(field, "applicable_kinds")) {
    if (!Array.isArray(field.applicable_kinds)
      || field.applicable_kinds.some((kind) => typeof kind !== "string" || !ENTITY_KINDS.has(kind))
      || new Set(field.applicable_kinds).size !== field.applicable_kinds.length) return "invalid_applicable_kinds";
  }
  if (has(field, "min") && (field.type !== "number" || typeof field.min !== "number" || !Number.isFinite(field.min))) return "invalid_field_min";
  if (has(field, "max") && (field.type !== "number" || typeof field.max !== "number" || !Number.isFinite(field.max))) return "invalid_field_max";
  if (has(field, "min") && has(field, "max") && field.min > field.max) return "invalid_field_range";
  if (has(field, "unit") && field.unit !== null
    && (field.type !== "number" || validateNames(field.unit) || !hasFourLocales(field.unit))) return "invalid_field_unit";
  if (has(field, "vocabulary") || has(field, "kinds")) return "unsupported_field_property";
  if (field.type !== "list" && has(field, "items")) return "non_list_items_not_supported";
  if (field.type === "list" && has(field, "fields")) return "list_fields_not_supported";
  if (has(field, "anchor_key") && (field.type !== "group" || typeof field.anchor_key !== "string" || !FIELD_CODE.test(field.anchor_key))) {
    return "invalid_field_anchor_key";
  }
  if (has(field, "range_start") && (field.type !== "number" || typeof field.range_start !== "string" || !FIELD_CODE.test(field.range_start))) {
    return "invalid_field_range_start";
  }
  if (has(field, "semantics") && !["content", "locating"].includes(field.semantics)) return "invalid_field_semantics";

  if (field.type === "group") {
    if (!isRecord(field.fields) || Object.keys(field.fields).length === 0) return "group_fields_required";
    for (const [code, child] of Object.entries(field.fields)) {
      if (!FIELD_CODE.test(code) || RESERVED_FIELD_CODES.has(code)) return "invalid_nested_field_code";
      const childError = validateFieldNode(child, { depth: depth + 1 });
      if (childError) return childError;
    }
    if (has(field, "anchor_key") && !has(field.fields, field.anchor_key)) return "unknown_field_anchor_key";
    for (const [code, child] of Object.entries(field.fields)) {
      if (has(child, "range_start")) {
        const start = field.fields[child.range_start];
        if (!start || start.type !== "number" || child.range_start === code || has(start, "range_start")) return "invalid_field_range_start";
      }
    }
  } else if (field.type === "list") {
    if (!has(field, "items")) return "list_items_required";
    const itemError = validateFieldNode(field.items, { depth: depth + 1 });
    if (itemError) return itemError;
  } else if (has(field, "fields")) return "non_group_fields_not_supported";
  return null;
}

function validateSources(sources) {
  if (!Array.isArray(sources) || sources.length === 0) return "evidence_required";
  for (const source of sources) {
    if (!isRecord(source) || Object.keys(source).some((key) => !SOURCE_KEYS.has(key))) return "invalid_source";
    if (!["url", "publication"].includes(source.kind) || typeof source.citation !== "string" || !source.citation.trim()) {
      return "invalid_source";
    }
    if ((source.kind === "url" && !validHttpUrl(source.url)) || (source.url !== undefined && !validHttpUrl(source.url))) {
      return "invalid_source";
    }
  }
  return null;
}

export function validatePlan(plan) {
  if (!isRecord(plan)) return "invalid_plan";
  if (has(plan, "action")) {
    if (plan.action !== "field.create" || Object.keys(plan).some((key) => !FIELD_PLAN_KEYS.has(key))) return "invalid_plan";
    if (typeof plan.expected_etag !== "string" || !plan.expected_etag.trim()) return "expected_etag_required";
    if (typeof plan.field_code !== "string" || !FIELD_CODE.test(plan.field_code) || RESERVED_FIELD_CODES.has(plan.field_code)) return "invalid_field_code";
    if (typeof plan.edit_note !== "string" || !plan.edit_note.trim()) return "edit_note_required";
    const sourceError = validateSources(plan.sources);
    if (sourceError) return sourceError;
    if (!isJsonSafe(plan.field) || !isJsonSafe(plan.sources)) return "invalid_json_value";
    return validateFieldNode(plan.field, { top: true });
  }
  if (Object.keys(plan).some((key) => !TERM_PLAN_KEYS.has(key))) return "invalid_plan";
  if (typeof plan.expected_etag !== "string" || !plan.expected_etag.trim()) return "expected_etag_required";
  if (typeof plan.vocabulary !== "string" || !plan.vocabulary.trim()) return "vocabulary_required";
  if (typeof plan.term_code !== "string" || !plan.term_code.trim()) return "term_code_required";
  if (!isRecord(plan.term) || Object.keys(plan.term).length === 0 || Object.keys(plan.term).some((key) => !TERM_KEYS.has(key))) {
    return "invalid_term_patch";
  }
  if (has(plan.term, "names")) {
    const namesError = validateNames(plan.term.names);
    if (namesError) return namesError;
  }
  if (has(plan.term, "enabled") && typeof plan.term.enabled !== "boolean") return "invalid_enabled";
  if (typeof plan.edit_note !== "string" || !plan.edit_note.trim()) return "edit_note_required";
  const sourceError = validateSources(plan.sources);
  if (sourceError) return sourceError;
  try {
    cloneJson(plan.term);
    cloneJson(plan.sources);
  } catch {
    return "invalid_json_value";
  }
  return null;
}

function safeStatus(response) {
  return Number.isInteger(response?.status) ? response.status : 0;
}

async function call(requestFn, pathname, options = {}) {
  try {
    const response = await requestFn(pathname, options);
    return { status: safeStatus(response), body: response?.body, response };
  } catch {
    return { status: 0, body: null, response: null };
  }
}

function configDocument(body) {
  if (!isRecord(body)
    || typeof body.etag !== "string"
    || !body.etag.trim()
    || typeof body.updated_at !== "string"
    || !body.updated_at.trim()
    || !isRecord(body.document)) return null;
  if (DEFINITION_MAPS.some((key) => !isRecord(body.document[key]))) return null;
  return body;
}

function documentFrom(body) {
  if (!isRecord(body)) return null;
  const document = body.document;
  if (!isRecord(document) || DEFINITION_MAPS.some((key) => !isRecord(document[key]))) return null;
  return document;
}

function summarizeDefinitions(body, vocabularyFilter) {
  const document = documentFrom(body);
  if (!document) return { ok: false, outcome: "unknown", reason: "definitions_shape_incomplete" };
  const vocabularies = document.vocabularies;
  if (vocabularyFilter && !has(vocabularies, vocabularyFilter)) {
    return { ok: false, outcome: "rejected", reason: "unknown_vocabulary", etag: body.etag ?? null };
  }
  const codes = vocabularyFilter ? [vocabularyFilter] : Object.keys(vocabularies).sort();
  const items = codes.map((code) => {
    const vocabulary = vocabularies[code];
    if (!isRecord(vocabulary) || !isRecord(vocabulary.terms)) {
      return { code, valid: false, reason: "vocabulary_shape_incomplete" };
    }
    return {
      code,
      names: isRecord(vocabulary.names) ? cloneJson(vocabulary.names) : {},
      term_count: Object.keys(vocabulary.terms).length,
      terms: Object.keys(vocabulary.terms).sort().map((termCode) => ({
        code: termCode,
        ...(isRecord(vocabulary.terms[termCode]) ? cloneJson(vocabulary.terms[termCode]) : { invalid: true }),
      })),
    };
  });
  if (items.some((item) => item.valid === false)) return { ok: false, outcome: "unknown", reason: "vocabulary_shape_incomplete", items };
  return { ok: true, outcome: "read", mode: body.kinds ? "public" : "admin", etag: body.etag ?? null, items };
}

export async function readDefinitions({ public: publicRead = false, requestFn = apiRequest } = {}) {
  const pathname = publicRead ? PUBLIC_PATH : ADMIN_PATH;
  const result = await call(requestFn, pathname, { method: "GET" });
  if (result.status !== 200) {
    return { ok: false, outcome: result.status === 0 || result.status >= 500 ? "unknown" : "failed", reason: "definitions_read_failed", http_status: result.status };
  }
  const body = publicRead ? result.body : configDocument(result.body);
  if (!body || !documentFrom(body)) {
    return { ok: false, outcome: "unknown", reason: publicRead ? "published_definitions_shape_incomplete" : "admin_definitions_shape_incomplete", http_status: result.status };
  }
  return { ok: true, outcome: "read", mode: publicRead ? "public" : "admin", definitions: cloneJson(body) };
}

function refName(schema) {
  if (!isRecord(schema) || typeof schema.$ref !== "string") return null;
  const match = schema.$ref.match(/^#\/components\/schemas\/([^/]+)$/);
  return match?.[1] ?? null;
}

function operation(paths, path, method) {
  const pathItem = paths?.[path];
  const found = pathItem?.[method];
  return isRecord(found) ? found : null;
}

function responseSchemaName(op) {
  return refName(op?.responses?.["200"]?.content?.["application/json"]?.schema);
}

function requestSchemaName(op) {
  return refName(op?.requestBody?.content?.["application/json"]?.schema);
}

function checkOpenApi(body) {
  if (!isRecord(body) || !isRecord(body.paths) || !isRecord(body.components?.schemas)) return { ok: false, reason: "openapi_shape_unknown" };
  const checks = [
    ["admin_get", operation(body.paths, "/admin/catalog-definitions", "get"), null, "DefinitionConfig"],
    ["impact_post", operation(body.paths, "/admin/catalog-definitions/impact", "post"), "DefinitionImpactRequest", "DefinitionImpact"],
    ["admin_put", operation(body.paths, "/admin/catalog-definitions", "put"), "DefinitionSave", "DefinitionConfig"],
  ];
  const mismatches = [];
  for (const [name, op, requestName, responseName] of checks) {
    if (!op || (requestName && requestSchemaName(op) !== requestName) || responseSchemaName(op) !== responseName) {
      mismatches.push(name);
    }
  }
  return mismatches.length ? { ok: false, reason: "openapi_contract_changed", mismatches } : { ok: true };
}

async function preflightOpenApi(requestFn) {
  const result = await call(requestFn, OPENAPI_PATH, { method: "GET" });
  if (result.status !== 200) {
    return { ok: false, outcome: "unknown", reason: "openapi_unavailable", http_status: result.status };
  }
  const check = checkOpenApi(result.body);
  if (!check.ok) return { ...check, outcome: "unknown" };
  return { ok: true, outcome: "preflight" };
}

function validImpact(body) {
  if (!isRecord(body)) return { ok: false, reason: "impact_shape_incomplete" };
  if (body.partial === true || body.degraded === true) return { ok: false, reason: "impact_degraded" };
  const allowed = new Set(["issues", "dangling_references"]);
  if (Object.keys(body).some((key) => !allowed.has(key))
    || !Array.isArray(body.issues)
    || body.issues.some((issue) => typeof issue !== "string")
    || !Array.isArray(body.dangling_references)
    || body.dangling_references.some((item) => !isRecord(item))) {
    return { ok: false, reason: "impact_shape_incomplete" };
  }
  return { ok: true, value: body };
}

function findTarget(document, vocabulary, termCode) {
  const vocabularies = document?.vocabularies;
  if (!isRecord(vocabularies) || !has(vocabularies, vocabulary)) return { reason: "unknown_vocabulary" };
  const vocab = vocabularies[vocabulary];
  if (!isRecord(vocab) || !isRecord(vocab.terms)) return { reason: "vocabulary_shape_incomplete" };
  return { vocabulary: vocab, terms: vocab.terms, exists: has(vocab.terms, termCode) };
}

function applyTermPatch(currentDocument, plan) {
  const document = cloneJson(currentDocument);
  const target = findTarget(document, plan.vocabulary, plan.term_code);
  if (target.reason) return { error: target.reason };
  const previous = target.exists ? target.terms[plan.term_code] : null;
  if (target.exists && !isRecord(previous)) return { error: "term_shape_incomplete" };
  if (!target.exists && (!has(plan.term, "names") || !has(plan.term, "enabled"))) return { error: "new_term_requires_names_and_enabled" };

  const next = target.exists ? cloneJson(previous) : {};
  if (has(plan.term, "names")) {
    const names = { ...(isRecord(next.names) ? cloneJson(next.names) : {}), ...cloneJson(plan.term.names) };
    const missing = NAME_LOCALES.filter((locale) => typeof names[locale] !== "string" || !names[locale].trim());
    if ((typeof names.ja !== "string" || !names.ja.trim()) && (typeof names["ja-JP"] !== "string" || !names["ja-JP"].trim())) {
      missing.push("ja-JP");
    }
    if (missing.length) return { error: "four_locale_names_required", missing };
    next.names = names;
  }
  if (has(plan.term, "enabled")) next.enabled = plan.term.enabled;

  Object.defineProperty(target.terms, plan.term_code, {
    value: next, enumerable: true, writable: true, configurable: true,
  });
  return { document, previous: previous === null ? null : cloneJson(previous), next: cloneJson(next), created: !target.exists };
}

function onlyAddedField(before, after, fieldCode, field) {
  if (!isRecord(before?.fields) || !isRecord(after?.fields) || has(before.fields, fieldCode)) return false;
  if (Object.keys(after.fields).length !== Object.keys(before.fields).length + 1 || !has(after.fields, fieldCode)) return false;
  if (!same(after.fields[fieldCode], field)) return false;
  const restored = cloneJson(after);
  delete restored.fields[fieldCode];
  return same(restored, before);
}

function normalizeFieldForWire(field) {
  const normalized = cloneJson(field);
  if (!has(normalized, "unit")) normalized.unit = null;
  for (const key of ["required", "searchable", "comparable"]) {
    if (!has(normalized, key)) normalized[key] = false;
  }
  if (normalized.hidden === false) delete normalized.hidden;
  if (Array.isArray(normalized.applicable_kinds) && normalized.applicable_kinds.length === 0) {
    delete normalized.applicable_kinds;
  }
  if (normalized.type === "group") {
    normalized.fields = Object.fromEntries(Object.entries(normalized.fields).map(([code, child]) => [code, normalizeFieldForWire(child)]));
  }
  if (normalized.type === "list") normalized.items = normalizeFieldForWire(normalized.items);
  return normalized;
}

function applyFieldCreate(currentDocument, plan) {
  if (has(currentDocument.fields, plan.field_code)) return { error: "field_already_exists" };
  const document = cloneJson(currentDocument);
  const normalizedField = normalizeFieldForWire(plan.field);
  Object.defineProperty(document.fields, plan.field_code, {
    value: normalizedField, enumerable: true, writable: true, configurable: true,
  });
  if (!onlyAddedField(currentDocument, document, plan.field_code, normalizedField)) return { error: "definition_patch_not_local" };
  return {
    document,
    previous: null,
    next: cloneJson(normalizedField),
    created: true,
    changes: [{
      field: `fields.${plan.field_code}`,
      before: null,
      after: cloneJson(normalizedField),
      before_present: false,
      after_present: true,
    }],
  };
}

function termDiff(before, after) {
  const changes = [];
  if (before === null) return [{ field: "term", before: null, after: cloneJson(after), before_present: false, after_present: true }];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const beforePresent = has(before, key);
    const afterPresent = has(after, key);
    if (beforePresent === afterPresent && same(before[key], after[key])) continue;
    changes.push({
      field: `term.${key}`,
      before: beforePresent ? cloneJson(before[key]) : null,
      after: afterPresent ? cloneJson(after[key]) : null,
      before_present: beforePresent,
      after_present: afterPresent,
    });
  }
  return changes;
}

function baseResult(plan, additions = {}) {
  const identity = plan?.action === "field.create"
    ? { action: plan.action, field_code: plan.field_code }
    : { vocabulary: plan?.vocabulary, term_code: plan?.term_code };
  return {
    ok: false,
    outcome: "rejected",
    applied: false,
    ...identity,
    ...additions,
  };
}

function getExpectedEtagResult(plan, config) {
  if (config.etag === plan.expected_etag) return null;
  return baseResult(plan, {
    outcome: "version_conflict",
    reason: "expected_etag_mismatch",
    expected_etag: plan.expected_etag,
    current_etag: config.etag,
  });
}

async function runDefinitionMutation(plan, { apply = false, requestFn = apiRequest } = {}, mode) {
  const invalid = validatePlan(plan);
  if (invalid) return baseResult(plan ?? {}, { reason: invalid });
  if ((mode === "field" && plan.action !== "field.create") || (mode === "term" && has(plan, "action"))) {
    return baseResult(plan, { reason: "invalid_plan" });
  }

  const openapi = await preflightOpenApi(requestFn);
  if (!openapi.ok) return baseResult(plan, { outcome: openapi.outcome, reason: openapi.reason, openapi });

  const current = await call(requestFn, ADMIN_PATH, { method: "GET" });
  const config = current.status === 200 ? configDocument(current.body) : null;
  if (!config) {
    return baseResult(plan, {
      outcome: current.status === 0 || current.status >= 500 || current.status === 200 ? "unknown" : "failed",
      reason: current.status === 200 ? "admin_definitions_shape_incomplete" : "admin_definitions_read_failed",
      http_status: current.status,
    });
  }
  const etagFailure = getExpectedEtagResult(plan, config);
  if (etagFailure) return etagFailure;

  const proposed = mode === "field" ? applyFieldCreate(config.document, plan) : applyTermPatch(config.document, plan);
  if (proposed.error) return baseResult(plan, { reason: proposed.error, missing: proposed.missing });
  const changes = mode === "field" ? proposed.changes : termDiff(proposed.previous, proposed.next);
  if (mode === "field" && (!onlyAddedField(config.document, proposed.document, plan.field_code, proposed.next) || changes.length !== 1)) {
    return baseResult(plan, { reason: "definition_patch_not_local" });
  }
  const common = {
    expected_etag: plan.expected_etag,
    current_etag: config.etag,
    before: proposed.previous,
    after: proposed.next,
    changes,
    created: proposed.created,
    evidence_submission: {
      state: "not_sent",
      note: plan.edit_note,
      sources: cloneJson(plan.sources),
      limitation: "来源格式已校验；工具未核实来源内容，也不能从定义回读证明来源事实。",
    },
  };

  if (changes.length === 0) {
    return {
      ...baseResult(plan, common),
      ok: true,
      outcome: "noop",
      reason: "term_unchanged",
    };
  }

  const impactResponse = await call(requestFn, IMPACT_PATH, {
    method: "POST",
    body: { document: cloneJson(proposed.document) },
  });
  if (impactResponse.status !== 200) {
    return baseResult(plan, {
      ...common,
      outcome: "unknown",
      reason: "impact_check_failed",
      http_status: impactResponse.status,
    });
  }
  const impact = validImpact(impactResponse.body);
  if (!impact.ok) {
    return baseResult(plan, { ...common, outcome: "unknown", reason: impact.reason });
  }
  if (impact.value.issues.length > 0) {
    return baseResult(plan, { ...common, outcome: "rejected", reason: "impact_issues", impact: impact.value });
  }

  const preview = {
    ...baseResult(plan, {
      ...common,
      outcome: apply ? "pending_write" : "preview",
      impact: cloneJson(impact.value),
      warnings: impact.value.dangling_references,
      request: {
        method: "PUT",
        path: ADMIN_PATH,
        body: {
          document: cloneJson(proposed.document),
          expected_etag: plan.expected_etag,
          edit_note: plan.edit_note,
          sources: cloneJson(plan.sources),
        },
      },
    }),
    ok: true,
  };
  if (!apply) return { ...preview, applied: false };

  if (mode === "field" && !onlyAddedField(config.document, preview.request.body.document, plan.field_code, proposed.next)) {
    return baseResult(plan, { ...common, reason: "definition_patch_not_local" });
  }
  const write = await call(requestFn, ADMIN_PATH, { method: "PUT", body: preview.request.body });
  const attemptedEvidence = {
    ...preview.evidence_submission,
    state: "attempted",
    acceptance: "not_confirmed",
    persistence: "not_independently_verified",
    limitation: "已尝试发送来源载荷；当前响应尚未证明服务端接受或持久化来源。",
  };
  if (write.status === 409) {
    const conflictRead = await call(requestFn, ADMIN_PATH, { method: "GET" });
    const conflictConfig = conflictRead.status === 200 ? configDocument(conflictRead.body) : null;
    return {
      ...preview,
      ok: false,
      outcome: "version_conflict",
      reason: "version_conflict",
      applied: false,
      write_status: 409,
      readback: {
        state: conflictConfig ? "current_etag_read" : "unknown",
        http_status: conflictRead.status,
        etag: conflictConfig?.etag ?? null,
      },
      evidence_submission: { ...attemptedEvidence, acceptance: "rejected" },
    };
  }

  if (write.status >= 400 && write.status < 500) {
    return {
      ...preview,
      ok: false,
      outcome: "failed",
      reason: "write_rejected",
      applied: false,
      write_status: write.status,
      readback: { state: "not_requested", reason: "explicit_rejection" },
      evidence_submission: { ...attemptedEvidence, acceptance: "rejected" },
    };
  }

  const writeConfig = write.status >= 200 && write.status < 300 ? configDocument(write.body) : null;
  const writeDocumentMatches = Boolean(writeConfig && same(writeConfig.document, proposed.document));
  const writeEtagAdvanced = Boolean(writeConfig && writeConfig.etag !== config.etag);
  const acceptedPayload = Boolean(writeConfig && writeDocumentMatches && writeEtagAdvanced);
  const evidenceAfterWrite = acceptedPayload
    ? {
      ...attemptedEvidence,
      state: "accepted_payload",
      acceptance: "accepted",
      limitation: "PUT 响应接受了载荷；definitions 回读不暴露来源修订记录，故不宣称来源持久化或事实核验。",
    }
    : attemptedEvidence;

  const readbackResponse = await call(requestFn, ADMIN_PATH, { method: "GET" });
  const readback = readbackResponse.status === 200 ? configDocument(readbackResponse.body) : null;
  const writeAccepted = write.status >= 200 && write.status < 300;
  if (!readback) {
    return {
      ...preview,
      ok: false,
      outcome: writeAccepted && !acceptedPayload ? "partial" : "unknown",
      reason: "write_readback_unavailable",
      applied: null,
      write_status: write.status,
      write_response: {
        shape_valid: Boolean(writeConfig),
        document_matches: writeDocumentMatches,
        etag: writeConfig?.etag ?? null,
        etag_advanced: writeEtagAdvanced,
      },
      readback: { state: "unknown", http_status: readbackResponse.status },
      evidence_submission: evidenceAfterWrite,
    };
  }

  const documentMatches = same(readback.document, proposed.document);
  const termTarget = mode === "term" ? findTarget(readback.document, plan.vocabulary, plan.term_code) : null;
  const targetMatches = mode === "field"
    ? has(readback.document.fields, plan.field_code) && same(readback.document.fields[plan.field_code], proposed.next)
    : !termTarget.reason && termTarget.exists && same(termTarget.terms[plan.term_code], proposed.next);
  const etagAdvanced = readback.etag !== config.etag;
  const readbackEtagMatchesResponse = Boolean(writeConfig && readback.etag === writeConfig.etag);
  const fullMatch = writeAccepted
    && acceptedPayload
    && documentMatches
    && targetMatches
    && etagAdvanced
    && readbackEtagMatchesResponse;
  const outcome = fullMatch ? "verified" : writeAccepted ? "partial" : "unknown";
  return {
    ...preview,
    ok: fullMatch,
    outcome,
    reason: fullMatch ? undefined : writeAccepted ? "write_readback_mismatch" : "write_result_unknown",
    applied: fullMatch ? true : null,
    write_status: write.status,
    write_response: {
      shape_valid: Boolean(writeConfig),
      document_matches: writeDocumentMatches,
      etag: writeConfig?.etag ?? null,
      etag_advanced: writeEtagAdvanced,
    },
    readback: {
      state: fullMatch
        ? "verified"
        : documentMatches && targetMatches && !readbackEtagMatchesResponse
          ? "observed_unconfirmed"
          : "mismatch",
      http_status: readbackResponse.status,
      etag: readback.etag,
      etag_advanced: etagAdvanced,
      etag_matches_write_response: readbackEtagMatchesResponse,
      document_matches: documentMatches,
      ...(mode === "field" ? { field_matches: targetMatches } : { term_matches: targetMatches }),
      unchanged_document_fields_preserved: documentMatches,
    },
    evidence_submission: evidenceAfterWrite,
  };
}

export async function upsertTerm(plan, options = {}) {
  return runDefinitionMutation(plan, options, "term");
}

export async function createField(plan, options = {}) {
  return runDefinitionMutation(plan, options, "field");
}

export function usage() {
  return [
    "用法:",
    "  node mf-definitions.mjs help",
    "  node mf-definitions.mjs list [--public] [--vocabulary <code>] [--out <json> ]",
    "  node mf-definitions.mjs read [--public] [--out <json>]",
    "  node mf-definitions.mjs plan <plan.json> [--apply] [--out <result.json>]",
    "",
    "list/read 默认读取管理端 DefinitionConfig；--public 读取公开投影，不能用作写入源。",
    "plan 默认只预览；--apply 单次 PUT，并要求 --out 以独占方式预留结果文件。",
    "兼容旧计划（不含 action）: expected_etag, vocabulary, term_code, term:{names?,enabled?}, edit_note, sources。",
    "新词项必须同时提供完整 names 与 enabled；既有词项的 names 按 locale 合并，未提交的 term 字段保留。",
    "受控字段新增计划: action=field.create, expected_etag, field_code, field, edit_note, sources；已有字段同码会拒绝。",
    "字段仅接受 group/list/number/text/boolean/date/url/multilingual 递归子集；四语 names 与顶层有效 applicable_kinds 必须齐全。",
    "group 必须有子字段；list 必须有受支持的 items Field 且不能带 fields；非 list 不能带 items。",
    "field.create 只生成新增单字段的完整 DefinitionSave；不接受任意 definitions 文档替换。最终校验以服务端 impact 为准。",
    "名称需含 zh-CN/zh-TW/en-US 与 ja 或 ja-JP。sources 只接受 url/publication；格式不证明来源事实。",
    "默认仅预览；--apply 单次 PUT 并写后完整文档等价回读，冲突或结果不明不重放。",
  ].join("\n");
}

function takeValue(args, index, option) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`missing_${option}`);
  return value;
}

export function parseArgs(args) {
  if (!Array.isArray(args) || args.length === 0 || args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    return { command: "help" };
  }
  const [command, ...rest] = args;
  if (!["list", "read", "plan"].includes(command)) throw new Error("invalid_cli_arguments");
  const options = { command, public: false, vocabulary: null, planPath: null, out: null, apply: false };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--public" && command !== "plan") options.public = true;
    else if (arg === "--apply" && command === "plan") options.apply = true;
    else if (arg === "--vocabulary" && command === "list") {
      options.vocabulary = takeValue(rest, index, arg);
      index += 1;
    } else if (arg === "--out") {
      options.out = takeValue(rest, index, arg);
      index += 1;
    } else if (command === "plan" && !arg.startsWith("--") && options.planPath === null) {
      options.planPath = arg;
    } else throw new Error("invalid_cli_arguments");
  }
  if (command === "plan" && !options.planPath) throw new Error("plan_file_required");
  if (command === "plan" && options.apply && !options.out) throw new Error("apply_requires_out");
  if (options.out && command === "plan" && resolve(options.out) === resolve(options.planPath)) throw new Error("output_must_not_overwrite_plan");
  return options;
}

function reserveOutput(path) {
  if (!path) return null;
  const fd = fs.openSync(path, "wx");
  fs.writeSync(fd, "{\"ok\":false,\"outcome\":\"running\"}\n");
  fs.fsyncSync(fd);
  return fd;
}

function writeReserved(fd, value) {
  if (fd === null) return;
  fs.ftruncateSync(fd, 0);
  fs.writeSync(fd, `${JSON.stringify(value, null, 2)}\n`, 0, "utf8");
  fs.fsyncSync(fd);
}

export async function runCli(args = process.argv.slice(2), {
  requestFn = apiRequest,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  let outputFd = null;
  try {
    const options = parseArgs(args);
    if (options.command === "help") {
      stdout.write(`${usage()}\n`);
      return { ok: true, outcome: "help" };
    }
    let plan = null;
    if (options.command === "plan") {
      plan = JSON.parse(fs.readFileSync(options.planPath, "utf8"));
      const invalid = validatePlan(plan);
      if (invalid) throw new Error(invalid);
    }
    outputFd = reserveOutput(options.out);

    let result;
    if (options.command === "read") {
      result = await readDefinitions({ public: options.public, requestFn });
    } else if (options.command === "list") {
      const read = await readDefinitions({ public: options.public, requestFn });
      result = read.ok ? summarizeDefinitions(read.definitions, options.vocabulary) : read;
    } else {
      const mutation = plan.action === "field.create" ? createField : upsertTerm;
      result = await mutation(plan, { apply: options.apply, requestFn });
    }
    writeReserved(outputFd, result);
    if (outputFd !== null) {
      fs.closeSync(outputFd);
      outputFd = null;
    }
    stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exitCode = 1;
    return result;
  } catch (error) {
    const result = { ok: false, outcome: "rejected", reason: error instanceof SyntaxError ? "invalid_json" : String(error?.message || "cli_error") };
    try {
      writeReserved(outputFd, result);
    } catch {
      // The reserved file remains as a visible indication that result writing failed.
    }
    if (outputFd !== null) {
      try { fs.closeSync(outputFd); } catch { /* keep original CLI failure */ }
      outputFd = null;
    }
    stderr.write(`${JSON.stringify(result)}\n`);
    process.exitCode = 1;
    return result;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await runCli();
}
