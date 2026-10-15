import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createField, parseArgs, readDefinitions, runCli, upsertTerm, validatePlan } from "./mf-definitions.mjs";

const TOOL_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "mf-definitions.mjs");
const FIELD_TEMPLATE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "templates", "list-price-field.json");
const LOCALES = {
  "zh-CN": "主角色",
  "zh-TW": "主角色",
  "en-US": "Primary role",
  "ja-JP": "主役",
  "fr-FR": "Rôle principal",
};

const clone = (value) => JSON.parse(JSON.stringify(value));

function goFieldRoundTrip(field) {
  const serialized = clone(field);
  if (!Object.hasOwn(serialized, "unit")) serialized.unit = null;
  for (const key of ["required", "enabled", "searchable", "comparable"]) {
    if (!Object.hasOwn(serialized, key)) serialized[key] = false;
  }
  if (serialized.hidden === false) delete serialized.hidden;
  if (Array.isArray(serialized.applicable_kinds) && serialized.applicable_kinds.length === 0) delete serialized.applicable_kinds;
  if (serialized.type === "group" && serialized.fields) {
    for (const code of Object.keys(serialized.fields)) serialized.fields[code] = goFieldRoundTrip(serialized.fields[code]);
    if (Object.keys(serialized.fields).length === 0) delete serialized.fields;
  }
  if (serialized.type === "list" && serialized.items) serialized.items = goFieldRoundTrip(serialized.items);
  return serialized;
}

function goDefinitionRoundTrip(document) {
  const serialized = clone(document);
  for (const code of Object.keys(serialized.fields)) serialized.fields[code] = goFieldRoundTrip(serialized.fields[code]);
  return serialized;
}

function documentFixture() {
  return {
    fields: {},
    vocabularies: {
      release_role: {
        names: { "zh-CN": "发行对象角色", "zh-TW": "發行對象角色", "en-US": "Release subject role", "ja-JP": "収録対象の役割" },
        terms: {
          primary: {
            names: { "zh-CN": "主要", "zh-TW": "主要", "en-US": "Primary", "ja-JP": "主" },
            enabled: true,
            is_bonus: false,
            curator_extension: { retained: true },
          },
          secondary: {
            names: { "zh-CN": "次要", "zh-TW": "次要", "en-US": "Secondary", "ja-JP": "副" },
            enabled: false,
          },
        },
        curator_vocab_extension: "keep-vocabulary-extension",
      },
      other_vocabulary: {
        names: {},
        terms: { preserved: { enabled: true } },
      },
    },
    relations: {},
    templates: {},
    schemes: {},
    structure: {},
    curator_document_extension: { retained: "verbatim" },
  };
}

function plan(overrides = {}) {
  return {
    expected_etag: "etag-current",
    vocabulary: "release_role",
    term_code: "primary",
    term: { names: { "en-US": "Lead role" }, enabled: true },
    edit_note: "按已核对的发布资料完善角色名称",
    sources: [{ kind: "publication", citation: "发布资料列明该角色名称" }],
    ...overrides,
  };
}

function fieldPlan(overrides = {}) {
  const fieldNames = { "zh-CN": "发行定价", "zh-TW": "發行定價", "en-US": "List price", "ja-JP": "希望小売価格" };
  const recordNames = { "zh-CN": "价格记录", "zh-TW": "價格記錄", "en-US": "Price record", "ja-JP": "価格記録" };
  const child = (names, type, extra = {}) => ({ names, type, enabled: true, required: false, ...extra });
  return {
    action: "field.create",
    expected_etag: "etag-current",
    field_code: "list_price",
    field: {
      names: fieldNames,
      type: "list",
      unit: null,
      applicable_kinds: ["release"],
      enabled: true,
      required: false,
      searchable: false,
      comparable: false,
      items: {
        names: recordNames,
        type: "group",
        unit: null,
        enabled: true,
        required: false,
        searchable: false,
        comparable: false,
        fields: {
          amount: child({ "zh-CN": "金额", "zh-TW": "金額", "en-US": "Amount", "ja-JP": "金額" }, "number", { unit: null, min: 0, required: true, searchable: false, comparable: false }),
          currency: child({ "zh-CN": "币种代码（ISO 4217）", "zh-TW": "幣別代碼（ISO 4217）", "en-US": "Currency code (ISO 4217)", "ja-JP": "通貨コード（ISO 4217）" }, "text", { unit: null, required: true, searchable: false, comparable: false }),
          tax_included: child({ "zh-CN": "含税", "zh-TW": "含稅", "en-US": "Tax included", "ja-JP": "税込" }, "boolean", { unit: null, searchable: false, comparable: false }),
        },
      },
    },
    edit_note: "新增发行层级的公开标价字段定义；不据此补录任何发行实体价格。",
    sources: [{
      kind: "url",
      citation: "Bushiroad Music 官方页面按版本明示金额（日元、含税）；此来源仅支持发行定价字段语义，不表示自动补录该页面或任何具体实体价格。",
      url: "https://bushiroad-music.com/musics/brmm-11077/",
    }],
    ...overrides,
  };
}

function openApiFixture() {
  const response = (schema) => ({ content: { "application/json": { schema: { $ref: `#/components/schemas/${schema}` } } } });
  return {
    paths: {
      "/admin/catalog-definitions": {
        get: { responses: { "200": response("DefinitionConfig") } },
        put: { requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/DefinitionSave" } } } }, responses: { "200": response("DefinitionConfig") } },
      },
      "/admin/catalog-definitions/impact": {
        post: { requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/DefinitionImpactRequest" } } } }, responses: { "200": response("DefinitionImpact") } },
      },
    },
    components: { schemas: {} },
  };
}

function fixture({
  document: documentOverride,
  impactBody = { issues: [], dangling_references: [] },
  impactStatus = 200,
  impactThrows = false,
  etag = "etag-current",
  openapi = openApiFixture(),
  openapiStatus = 200,
  putMode = "commit",
  readbackStatus = 200,
} = {}) {
  const document = clone(documentOverride ?? documentFixture());
  let current = { etag, document: clone(document), updated_at: "2026-01-01T00:00:00Z" };
  const calls = [];
  let putCount = 0;
  let impactCount = 0;
  const requestFn = async (pathname, options = {}) => {
    calls.push({ pathname, options: clone(options) });
    if (pathname === "/api/openapi.json") return { status: openapiStatus, body: clone(openapi) };
    if (pathname === "/api/admin/catalog-definitions" && options.method === "GET") {
      if (readbackStatus !== 200 && putCount > 0) return { status: readbackStatus, body: { error: "readback_failed" } };
      return { status: 200, body: clone(current) };
    }
    if (pathname === "/api/catalog/definitions") {
      return { status: 200, body: { ...clone(current), kinds: {}, relationship_rules: [] } };
    }
    if (pathname === "/api/admin/catalog-definitions/impact" && options.method === "POST") {
      impactCount += 1;
      if (impactThrows) throw new Error("offline mock transport error");
      return { status: impactStatus, body: clone(impactBody) };
    }
    if (pathname === "/api/admin/catalog-definitions" && options.method === "PUT") {
      putCount += 1;
      if (putMode === "conflict") return { status: 409, body: { error: "version_conflict" } };
      if (putMode === "forbidden") return { status: 403, body: { error: "forbidden" } };
      if (putMode === "throw-after-commit" || putMode === "500-after-commit") {
        current = { etag: "etag-next", document: goDefinitionRoundTrip(options.body.document), updated_at: "2026-01-02T00:00:00Z" };
        if (putMode === "throw-after-commit") throw new Error("mock connection lost after commit");
        return { status: 500, body: { error: "internal_error" } };
      }
      if (putMode === "empty-response-commit") {
        current = { etag: "etag-next", document: goDefinitionRoundTrip(options.body.document), updated_at: "2026-01-02T00:00:00Z" };
        return { status: 200, body: {} };
      }
      if (putMode === "readback-etag-mismatch") {
        current = { etag: "etag-next", document: goDefinitionRoundTrip(options.body.document), updated_at: "2026-01-02T00:00:00Z" };
        return { status: 200, body: { ...clone(current), etag: "etag-response" } };
      }
      if (putMode === "mismatch") {
        current = { etag: "etag-next", document: clone(document), updated_at: "2026-01-02T00:00:00Z" };
        return { status: 200, body: clone(current) };
      }
      current = { etag: "etag-next", document: goDefinitionRoundTrip(options.body.document), updated_at: "2026-01-02T00:00:00Z" };
      return { status: 200, body: clone(current) };
    }
    return { status: 404, body: { error: "not_found" } };
  };
  return {
    requestFn,
    calls,
    get current() { return clone(current); },
    get putCount() { return putCount; },
    get impactCount() { return impactCount; },
  };
}

test("validates narrow plan shape, four required locales, and url/publication evidence only", () => {
  assert.equal(validatePlan(plan()), null);
  assert.equal(validatePlan(plan({ unexpected: true })), "invalid_plan");
  assert.equal(validatePlan(plan({ term: { names: LOCALES, description: "forbidden" } })), "invalid_term_patch");
  assert.equal(validatePlan(plan({ sources: [{ kind: "self", citation: "internal" }] })), "invalid_source");
  assert.equal(validatePlan(plan({ sources: [{ kind: "url", citation: "citation", url: "javascript:alert(1)" }] })), "invalid_source");
  assert.equal(validatePlan(plan({ sources: [{ kind: "url", citation: "citation", url: "https://source.example/item", metadata: {} }] })), "invalid_source");
  assert.equal(validatePlan(plan({ term: { names: { "xx_!": "bad" } } })), "invalid_names");
});

test("validates field.create as a JSON-safe recursive field whitelist with four locales", () => {
  assert.equal(validatePlan(fieldPlan()), null);
  assert.equal(validatePlan(fieldPlan({ field_code: "ReleasePrice" })), "invalid_field_code");
  assert.equal(validatePlan(fieldPlan({ field: { ...fieldPlan().field, applicable_kinds: [] } })), "top_applicable_kinds_required");
  assert.equal(validatePlan(fieldPlan({ field: { ...fieldPlan().field, type: "entity" } })), "unsupported_field_type");
  const noItems = fieldPlan();
  delete noItems.field.items;
  assert.equal(validatePlan(noItems), "list_items_required");
  assert.equal(validatePlan(fieldPlan({ field: { ...fieldPlan().field, fields: {} } })), "list_fields_not_supported");
  assert.equal(validatePlan(fieldPlan({ field: { ...fieldPlan().field, items: { ...fieldPlan().field.items, type: "entity" } } })), "unsupported_field_type");
  assert.equal(validatePlan(fieldPlan({ field: { ...fieldPlan().field, type: "group" } })), "non_list_items_not_supported");
  assert.equal(validatePlan(fieldPlan({ field: { ...fieldPlan().field, items: { ...fieldPlan().field.items, fields: {} } } })), "group_fields_required");

  const missingLocale = fieldPlan();
  delete missingLocale.field.items.fields.currency.names["ja-JP"];
  assert.equal(validatePlan(missingLocale), "four_locale_names_required");

  const unknownProperty = fieldPlan();
  unknownProperty.field.items.fields.amount.server_magic = true;
  assert.equal(validatePlan(unknownProperty), "invalid_field_shape");

  const tooDeep = fieldPlan();
  let node = tooDeep.field.items;
  for (let index = 0; index < 5; index += 1) {
    const nested = { names: { "zh-CN": "组", "zh-TW": "組", "en-US": "Group", "ja-JP": "グループ" }, type: "group", enabled: true, fields: {} };
    node.fields = { nested_group: nested };
    node = nested;
  }
  assert.equal(validatePlan(tooDeep), "field_nesting_limit");

  const nonJson = fieldPlan();
  nonJson.field.items.fields.amount.min = Number.POSITIVE_INFINITY;
  assert.equal(validatePlan(nonJson), "invalid_json_value");
});

test("reusable list-price template is a locale-complete field plan without live etag or entity prices", () => {
  const template = JSON.parse(fs.readFileSync(FIELD_TEMPLATE_PATH, "utf8"));
  assert.equal(validatePlan(template), null);
  assert.equal(template.expected_etag, "<current-etag>");
  assert.equal(template.field.type, "list");
  assert.equal(template.field.items.type, "group");
  assert.deepEqual(template.field.items.names, { "zh-CN": "价格记录", "zh-TW": "價格記錄", "en-US": "Price record", "ja-JP": "価格記録" });
  assert.deepEqual(template.field.applicable_kinds, ["release"]);
  assert.equal(template.field.items.fields.amount.enabled, true);
  assert.equal(template.field.items.fields.currency.enabled, true);
  assert.equal(template.field.items.fields.tax_included.required, false);
  assert.equal(Object.hasOwn(template.field.items.fields.tax_included, "default"), false);
  assert.equal(Object.hasOwn(template, "entity"), false);
  assert.equal(Object.hasOwn(template, "price"), false);
});

test("normalizes only the new field to Go Field JSON defaults and preserves old fields verbatim", async () => {
  const baseline = documentFixture();
  baseline.fields.preexisting_note = {
    names: { "zh-CN": "旧备注", "zh-TW": "舊備註", "en-US": "Existing note", "ja-JP": "既存のメモ" },
    type: "text",
    applicable_kinds: ["release"],
    unit: null,
    required: false,
    enabled: true,
    searchable: false,
    comparable: false,
  };
  const mock = fixture({ document: baseline });
  const requestPlan = fieldPlan();
  requestPlan.field.hidden = false;
  delete requestPlan.field.searchable;
  delete requestPlan.field.comparable;
  requestPlan.field.items.fields.currency.applicable_kinds = [];
  delete requestPlan.field.items.fields.currency.searchable;
  delete requestPlan.field.items.fields.currency.comparable;
  const result = await createField(requestPlan, { apply: true, requestFn: mock.requestFn });

  assert.equal(result.outcome, "verified");
  assert.deepEqual(result.changes[0].after, result.after);
  assert.deepEqual(result.request.body.document.fields.list_price, result.after);
  assert.equal(result.after.unit, null);
  assert.equal(result.after.required, false);
  assert.equal(result.after.searchable, false);
  assert.equal(result.after.comparable, false);
  assert.equal(Object.hasOwn(result.after, "hidden"), false);
  assert.equal(result.after.items.unit, null);
  assert.equal(result.after.items.fields.currency.unit, null, "null unit is valid on text fields too");
  assert.equal(result.after.items.fields.currency.searchable, false);
  assert.equal(result.after.items.fields.currency.comparable, false);
  assert.equal(Object.hasOwn(result.after.items.fields.currency, "applicable_kinds"), false);
  assert.equal(result.after.items.fields.tax_included.unit, null);
  assert.deepEqual(result.request.body.document.fields.preexisting_note, baseline.fields.preexisting_note);
  assert.deepEqual(mock.current.document.fields.preexisting_note, baseline.fields.preexisting_note);
  assert.equal(result.readback.document_matches, true);
});

test("field.create defaults to preview, records one-field diff, and leaves other definitions intact", async () => {
  const mock = fixture();
  const before = mock.current.document;
  const result = await createField(fieldPlan(), { requestFn: mock.requestFn });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "preview");
  assert.equal(result.applied, false);
  assert.equal(result.created, true);
  assert.deepEqual(result.changes.map((change) => change.field), ["fields.list_price"]);
  assert.equal(result.request.body.expected_etag, "etag-current");
  assert.equal(result.after.unit, null);
  assert.equal(result.after.items.fields.amount.unit, null);
  assert.equal(result.request.body.document.fields.list_price.items.fields.tax_included.required, false);
  assert.equal(Object.hasOwn(result.request.body.document.fields.list_price.items.fields.tax_included, "default"), false);
  assert.equal(mock.putCount, 0);
  assert.equal(mock.impactCount, 1);
  assert.deepEqual(mock.current.document, before);
  assert.deepEqual(result.request.body.document.vocabularies, before.vocabularies);
  assert.deepEqual(result.request.body.document.relations, before.relations);
});

test("field.create applies one new field and verifies the complete definitions document on readback", async () => {
  const baseline = documentFixture();
  baseline.fields.preexisting_note = {
    names: { "zh-CN": "旧备注", "zh-TW": "舊備註", "en-US": "Existing note", "ja-JP": "既存のメモ" },
    type: "text",
    applicable_kinds: ["release"],
    unit: null,
    required: false,
    enabled: true,
    searchable: false,
    comparable: false,
  };
  const mock = fixture({ document: baseline });
  const before = mock.current.document;
  const result = await createField(fieldPlan(), { apply: true, requestFn: mock.requestFn });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "verified");
  assert.equal(result.applied, true);
  assert.equal(result.readback.document_matches, true);
  assert.equal(result.readback.field_matches, true);
  assert.equal(Object.hasOwn(result.readback, "term_matches"), false);
  assert.deepEqual(result.changes[0].after, result.after);
  assert.deepEqual(result.request.body.document.fields.list_price, result.after);
  assert.equal(result.readback.unchanged_document_fields_preserved, true);
  assert.equal(mock.putCount, 1);
  const put = mock.calls.find((call) => call.options.method === "PUT");
  assert.equal(put.options.body.expected_etag, "etag-current");
  assert.deepEqual(put.options.body.document.vocabularies, before.vocabularies);
  assert.deepEqual(put.options.body.document.relations, before.relations);
  assert.deepEqual(put.options.body.document.fields.preexisting_note, before.fields.preexisting_note);
  assert.deepEqual(mock.current.document.fields.preexisting_note, before.fields.preexisting_note);
  assert.deepEqual(Object.keys(mock.current.document.fields).sort(), ["list_price", "preexisting_note"].sort());
});

test("field.create refuses an existing code, stale etag, and impact issues before PUT", async () => {
  const existingDocument = documentFixture();
  existingDocument.fields.list_price = { type: "text" };
  const existing = fixture({ document: existingDocument });
  const duplicate = await createField(fieldPlan(), { apply: true, requestFn: existing.requestFn });
  assert.equal(duplicate.reason, "field_already_exists");
  assert.equal(existing.impactCount, 0);
  assert.equal(existing.putCount, 0);

  const stale = fixture();
  const staleResult = await createField(fieldPlan({ expected_etag: "etag-old" }), { apply: true, requestFn: stale.requestFn });
  assert.equal(staleResult.outcome, "version_conflict");
  assert.equal(stale.impactCount, 0);
  assert.equal(stale.putCount, 0);

  const impacted = fixture({ impactBody: { issues: ["invalid_field"], dangling_references: [] } });
  const impactResult = await createField(fieldPlan(), { apply: true, requestFn: impacted.requestFn });
  assert.equal(impactResult.reason, "impact_issues");
  assert.equal(impacted.putCount, 0);
});

test("field.create never replays a PUT whose result is unknown", async () => {
  for (const putMode of ["throw-after-commit", "500-after-commit"]) {
    const mock = fixture({ putMode });
    const result = await createField(fieldPlan(), { apply: true, requestFn: mock.requestFn });
    assert.equal(result.outcome, "unknown");
    assert.equal(result.ok, false);
    assert.equal(mock.putCount, 1);
    assert.equal(mock.calls.filter((call) => call.options.method === "PUT").length, 1);
    assert.deepEqual(mock.current.document.fields.list_price, result.after);
    assert.equal(result.readback.document_matches, true);
    assert.equal(result.readback.field_matches, true);
  }
});

test("preview preflights live OpenAPI and impact, merges names, and preserves other term/document fields", async () => {
  const mock = fixture({ impactBody: { issues: [], dangling_references: [{ scope: "entity", entity_id: "stale-ref" }] } });
  const result = await upsertTerm(plan(), { requestFn: mock.requestFn });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "preview");
  assert.equal(result.applied, false);
  assert.deepEqual(result.warnings, [{ scope: "entity", entity_id: "stale-ref" }]);
  assert.equal(mock.putCount, 0);
  assert.equal(mock.impactCount, 1);
  assert.deepEqual(result.after.names, { ...mock.current.document.vocabularies.release_role.terms.primary.names, "en-US": "Lead role" });
  assert.equal(result.after.is_bonus, false);
  assert.deepEqual(result.after.curator_extension, { retained: true });
  assert.deepEqual(result.request.body.document.vocabularies.other_vocabulary, mock.current.document.vocabularies.other_vocabulary);
  assert.deepEqual(result.request.body.document.curator_document_extension, { retained: "verbatim" });
  assert.equal(result.request.body.expected_etag, "etag-current");
  assert.equal(mock.calls.filter((call) => call.pathname === "/api/openapi.json").length, 1);
});

test("upserts an absent term only when both names and enabled are explicit", async () => {
  const mock = fixture();
  const absent = plan({ term_code: "release_role_new", term: { names: LOCALES, enabled: false } });
  const result = await upsertTerm(absent, { requestFn: mock.requestFn });
  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.deepEqual(result.after, { names: LOCALES, enabled: false });

  const missingNames = await upsertTerm(plan({ term_code: "new_role", term: { enabled: true } }), { requestFn: mock.requestFn });
  assert.equal(missingNames.reason, "new_term_requires_names_and_enabled");
  assert.equal(mock.impactCount, 1, "invalid new-term plan performs no additional impact request");
  assert.equal(mock.putCount, 0);
});

test("stale plan etag stops before impact or PUT", async () => {
  const mock = fixture();
  const result = await upsertTerm(plan({ expected_etag: "etag-old" }), { apply: true, requestFn: mock.requestFn });
  assert.equal(result.outcome, "version_conflict");
  assert.equal(mock.impactCount, 0);
  assert.equal(mock.putCount, 0);
});

test("unchanged term is a no-op without impact or PUT", async () => {
  const mock = fixture();
  const result = await upsertTerm(plan({ term: { enabled: true } }), { apply: true, requestFn: mock.requestFn });
  assert.equal(result.outcome, "noop");
  assert.equal(result.ok, true);
  assert.equal(mock.impactCount, 0);
  assert.equal(mock.putCount, 0);
});

test("impact issues block writes while real dangling-reference warnings do not", async () => {
  const blocked = fixture({ impactBody: { issues: ["invalid_vocabulary_term"], dangling_references: [] } });
  const rejected = await upsertTerm(plan(), { apply: true, requestFn: blocked.requestFn });
  assert.equal(rejected.reason, "impact_issues");
  assert.equal(blocked.putCount, 0);

  const warningOnly = fixture({ impactBody: { issues: [], dangling_references: [{ scope: "relation", entity_id: "old-row" }] } });
  const applied = await upsertTerm(plan(), { apply: true, requestFn: warningOnly.requestFn });
  assert.equal(applied.outcome, "verified");
  assert.equal(applied.ok, true);
  assert.equal(applied.warnings.length, 1);
});

test("incomplete, degraded, or failed impact responses are unknown and never PUT", async () => {
  const cases = [
    fixture({ impactBody: { issues: [] } }),
    fixture({ impactBody: { issues: [], dangling_references: [], degraded: true } }),
    fixture({ impactBody: { issues: [], dangling_references: [] }, impactStatus: 503 }),
    fixture({ impactThrows: true }),
  ];
  for (const mock of cases) {
    const result = await upsertTerm(plan(), { apply: true, requestFn: mock.requestFn });
    assert.equal(result.outcome, "unknown");
    assert.equal(mock.putCount, 0);
  }
  assert.equal(cases[3].impactCount, 1, "POST impact is attempted once even after a transport failure");
});

test("OpenAPI changes or unknown declarations block the update", async () => {
  const changed = openApiFixture();
  changed.paths["/admin/catalog-definitions/impact"].post.responses["200"].content["application/json"].schema.$ref = "#/components/schemas/OtherImpact";
  const mock = fixture({ openapi: changed });
  const result = await upsertTerm(plan(), { apply: true, requestFn: mock.requestFn });
  assert.equal(result.outcome, "unknown");
  assert.equal(result.reason, "openapi_contract_changed");
  assert.equal(mock.calls.some((call) => call.pathname === "/api/admin/catalog-definitions"), false);
  assert.equal(mock.putCount, 0);
});

test("apply sends one guarded whole-document PUT and verifies full document, term, and new etag", async () => {
  const mock = fixture();
  const result = await upsertTerm(plan(), { apply: true, requestFn: mock.requestFn });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "verified");
  assert.equal(result.applied, true);
  assert.equal(result.readback.etag, "etag-next");
  assert.equal(result.readback.document_matches, true);
  assert.equal(result.readback.unchanged_document_fields_preserved, true);
  assert.equal(mock.putCount, 1);
  const putCall = mock.calls.find((call) => call.options.method === "PUT");
  assert.equal(putCall.options.body.expected_etag, "etag-current");
  assert.deepEqual(Object.keys(putCall.options.body).sort(), ["document", "edit_note", "expected_etag", "sources"]);
  assert.equal(result.evidence_submission.state, "accepted_payload");
  assert.equal(result.evidence_submission.acceptance, "accepted");
  assert.equal(result.evidence_submission.persistence, "not_independently_verified");
  assert.match(result.evidence_submission.limitation, /不暴露来源修订记录/);
});

test("409 is reported without retry; uncertain write responses are never retried", async () => {
  const conflict = fixture({ putMode: "conflict" });
  const conflictResult = await upsertTerm(plan(), { apply: true, requestFn: conflict.requestFn });
  assert.equal(conflictResult.outcome, "version_conflict");
  assert.equal(conflict.putCount, 1);
  assert.equal(conflictResult.readback.state, "current_etag_read");
  assert.equal(conflictResult.readback.etag, "etag-current");
  assert.equal(conflictResult.evidence_submission.acceptance, "rejected");

  for (const putMode of ["throw-after-commit", "500-after-commit"]) {
    const mock = fixture({ putMode });
    const result = await upsertTerm(plan(), { apply: true, requestFn: mock.requestFn });
    assert.equal(result.outcome, "unknown");
    assert.equal(result.ok, false);
    assert.equal(mock.putCount, 1);
    assert.equal(result.readback.document_matches, true);
    assert.equal(result.readback.state, "observed_unconfirmed");
    assert.equal(result.evidence_submission.state, "attempted");
    assert.equal(result.evidence_submission.acceptance, "not_confirmed");
  }
});

test("HTTP 200 with an empty or inconsistent DefinitionConfig body cannot verify from GET alone", async () => {
  const emptyResponse = fixture({ putMode: "empty-response-commit" });
  const emptyResult = await upsertTerm(plan(), { apply: true, requestFn: emptyResponse.requestFn });
  assert.equal(emptyResult.outcome, "partial");
  assert.equal(emptyResult.ok, false);
  assert.equal(emptyResult.readback.document_matches, true);
  assert.equal(emptyResult.write_response.shape_valid, false);
  assert.equal(emptyResult.evidence_submission.state, "attempted");
  assert.equal(emptyResult.evidence_submission.acceptance, "not_confirmed");

  const etagMismatch = fixture({ putMode: "readback-etag-mismatch" });
  const etagResult = await upsertTerm(plan(), { apply: true, requestFn: etagMismatch.requestFn });
  assert.equal(etagResult.outcome, "partial");
  assert.equal(etagResult.write_response.shape_valid, true);
  assert.equal(etagResult.readback.document_matches, true);
  assert.equal(etagResult.readback.etag_matches_write_response, false);
});

test("explicit 4xx rejection is failed; it does not claim payload acceptance or retry", async () => {
  const forbidden = fixture({ putMode: "forbidden" });
  const result = await upsertTerm(plan(), { apply: true, requestFn: forbidden.requestFn });
  assert.equal(result.outcome, "failed");
  assert.equal(result.write_status, 403);
  assert.equal(result.applied, false);
  assert.equal(result.evidence_submission.state, "attempted");
  assert.equal(result.evidence_submission.acceptance, "rejected");
  assert.equal(forbidden.putCount, 1);
  assert.equal(forbidden.calls.filter((call) => call.options.method === "PUT").length, 1);
});

test("successful PUT with incomplete or mismatched readback is partial/unknown, never successful", async () => {
  const mismatch = fixture({ putMode: "mismatch" });
  const mismatchResult = await upsertTerm(plan(), { apply: true, requestFn: mismatch.requestFn });
  assert.equal(mismatchResult.outcome, "partial");
  assert.equal(mismatchResult.ok, false);

  const unavailable = fixture({ readbackStatus: 503 });
  const unavailableResult = await upsertTerm(plan(), { apply: true, requestFn: unavailable.requestFn });
  assert.equal(unavailableResult.outcome, "unknown");
  assert.equal(unavailableResult.applied, null);
});

test("admin and public reads use distinct endpoints and preserve their response distinction", async () => {
  const mock = fixture();
  const admin = await readDefinitions({ requestFn: mock.requestFn });
  const published = await readDefinitions({ public: true, requestFn: mock.requestFn });
  assert.equal(admin.mode, "admin");
  assert.equal(admin.definitions.etag, "etag-current");
  assert.equal(published.mode, "public");
  assert.ok(published.definitions.kinds);
  assert.ok(mock.calls.some((call) => call.pathname === "/api/admin/catalog-definitions"));
  assert.ok(mock.calls.some((call) => call.pathname === "/api/catalog/definitions"));
});

test("CLI help does not read credentials or make requests", () => {
  const result = spawnSync(process.execPath, [TOOL_PATH, "help"], {
    encoding: "utf8",
    env: { ...process.env, MF_BASE: "", MF_PAT: "", MF_CREDENTIALS: path.join(os.tmpdir(), "missing-mf-credentials.json") },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /DefinitionConfig/);
  assert.match(result.stdout, /field\.create/);
  assert.match(result.stdout, /--apply/);
});

test("CLI requires an output reservation for apply and never overwrites a plan", () => {
  assert.throws(() => parseArgs(["plan", "plan.json", "--apply"]), /apply_requires_out/);
  assert.throws(() => parseArgs(["plan", "plan.json", "--out", "plan.json"]), /output_must_not_overwrite_plan/);
  assert.equal(parseArgs(["read", "--public"]).public, true);
});

test("CLI dispatches field.create plans to a default preview without PUT", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mf-definitions-field-cli-test-"));
  const planPath = path.join(directory, "field-plan.json");
  fs.writeFileSync(planPath, JSON.stringify(fieldPlan()), "utf8");
  const mock = fixture();
  const stdout = { value: "", write(text) { this.value += text; } };
  const stderr = { value: "", write(text) { this.value += text; } };
  const oldExitCode = process.exitCode;
  try {
    const result = await runCli(["plan", planPath], { requestFn: mock.requestFn, stdout, stderr });
    assert.equal(result.action, "field.create");
    assert.equal(result.outcome, "preview");
    assert.equal(mock.putCount, 0);
  } finally {
    process.exitCode = oldExitCode;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI reserves --out with exclusive creation before the first request", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mf-definitions-test-"));
  const planPath = path.join(directory, "plan.json");
  const outPath = path.join(directory, "result.json");
  fs.writeFileSync(planPath, JSON.stringify(plan()), "utf8");
  const mock = fixture();
  let checkedReservation = false;
  const requestFn = async (pathname, options) => {
    if (!checkedReservation) {
      assert.equal(fs.existsSync(outPath), true);
      assert.match(fs.readFileSync(outPath, "utf8"), /"outcome":"running"/);
      checkedReservation = true;
    }
    return mock.requestFn(pathname, options);
  };
  const stdout = { value: "", write(text) { this.value += text; } };
  const stderr = { value: "", write(text) { this.value += text; } };
  const oldExitCode = process.exitCode;
  try {
    const result = await runCli(["plan", planPath, "--apply", "--out", outPath], { requestFn, stdout, stderr });
    assert.equal(result.outcome, "verified");
    assert.equal(JSON.parse(fs.readFileSync(outPath, "utf8")).outcome, "verified");
    assert.equal(fs.readFileSync(planPath, "utf8"), JSON.stringify(plan()));
  } finally {
    process.exitCode = oldExitCode;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
