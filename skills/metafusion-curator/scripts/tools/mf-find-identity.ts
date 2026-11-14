import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { request as apiRequest } from "../metafusion-api.ts";

const KINDS = new Set([
  "agent",
  "collection",
  "work",
  "content_unit",
  "expression",
  "release",
  "medium",
  "track",
]);
const DEFAULT_LIMIT = 1000;
const CORP_AFFIX_RE =
  /^(?:株式会社|有限会社|合同会社|合資会社|一般社団法人|公益財団法人|\(株\)|\(有\)|㈱|㈲)\s*|\s*(?:株式会社|有限会社|合同会社|合資会社|一般社団法人|公益財団法人|\(株\)|\(有\)|㈱|㈲)$/gu;
const CORP_EN_RE =
  /(?:\s*,\s*|\s+)(?:co\.?,?\s*ltd\.?|inc\.?|corp\.?|corporation|ltd\.?|llc|gmbh)$/iu;
const QUALIFIER_RE =
  /\s*(?:[(]|\[|【)\s*(?:tv\s*anime|tvアニメ|テレビアニメ|アニメ|anime|劇場版|劇場|映画|movie|film|ova|ona|漫画|マンガ|manga|コミック|comic|小説|ライトノベル|novel|light\s*novel|ゲーム|game|シングル|single|アルバム|album|ep|ost|サウンドトラック|soundtrack|cd|bd|dvd|blu-?ray|lp|mv|pv|バンド|band|ユニット|unit|グループ|group|キャラクター|character)\s*(?:[)]|\]|】)$/iu;
const CORE_STRIP_RE =
  /[\x00-\x2F\x3A-\x40\x5B-\x60\x7B-\x7F\u00A0-\u00BF\u2000-\u206F\u2E00-\u2E7F\u3000-\u3004\u3008-\u303A\u303D-\u303F\u30FB\uFE30-\uFE6F\uFF61-\uFF65]+/gu;

function cleanText(value) {
  return String(value ?? "").trim();
}

function normalizeTitle(value) {
  return cleanText(value).replace(/\s+/gu, " ").toLowerCase();
}

function foldFullwidthAscii(value: string) {
  let out = "";
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0xff01 && cp <= 0xff5e) {
      out += String.fromCodePoint(cp - 0xfee0);
    } else if (cp === 0x3000) {
      out += " ";
    } else {
      out += ch;
    }
  }
  return out;
}

export function coreTitle(value: unknown) {
  const folded = cleanText(foldFullwidthAscii(String(value ?? "")))
    .replace(/\s+/gu, " ")
    .toLowerCase();
  if (!folded) return "";
  let cur = folded;
  const noCorp = cur.replace(CORP_AFFIX_RE, "").trim();
  if (noCorp) cur = noCorp;
  const noEnCorp = cur.replace(CORP_EN_RE, "").trim();
  if (noEnCorp) cur = noEnCorp;
  const noQual = cur.replace(QUALIFIER_RE, "").trim();
  if (noQual) cur = noQual;
  const stripped = cur.replace(CORE_STRIP_RE, "");
  return stripped || cur;
}

function coreTrigramSet(value: string) {
  const runes = [..."  " + value + " "];
  const out = new Set<string>();
  for (let i = 0; i + 3 <= runes.length; i += 1) {
    out.add(runes.slice(i, i + 3).join(""));
  }
  return out;
}

function coreTrigramSimilarity(a: string, b: string) {
  const ta = coreTrigramSet(a);
  const tb = coreTrigramSet(b);
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const k of ta) {
    if (tb.has(k)) shared += 1;
  }
  const union = ta.size + tb.size - shared;
  return union > 0 ? shared / union : 0;
}

function hasSimilarCore(queryCore: string, entityCore: string) {
  const qRunes = [...queryCore];
  const eRunes = [...entityCore];
  if (qRunes.length < 2 || eRunes.length < 2) return false;
  if (queryCore === entityCore) return true;
  if (entityCore.includes(queryCore) || queryCore.includes(entityCore)) return true;
  if (qRunes.length < 4 || eRunes.length < 4) return false;
  if (coreTrigramSimilarity(queryCore, entityCore) >= 0.45) return true;
  const [shortRunes, longRunes] =
    qRunes.length <= eRunes.length ? [qRunes, eRunes] : [eRunes, qRunes];
  const shortStr = shortRunes.join("");
  for (let i = 0; i + shortRunes.length <= longRunes.length; i += 1) {
    const slice = longRunes.slice(i, i + shortRunes.length).join("");
    if (coreTrigramSimilarity(shortStr, slice) >= 0.45) return true;
  }
  return false;
}

function isScalar(value) {
  return ["string", "number", "boolean"].includes(typeof value);
}

function safeError(error) {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/mfp_[A-Za-z0-9._~-]+/gu, "[REDACTED]").slice(0, 500);
}

function validateInput({
  kind = "work",
  titles = [],
  externalIds = [],
  attributes = [],
  workId,
  releaseId,
  mediumId,
  limit = DEFAULT_LIMIT,
  approximate = false,
}: Record<string, any>) {
  if (!KINDS.has(kind)) throw new Error("kind 必须是八种实体 kind 之一");
  const normalizedWorkId = cleanText(workId);
  const normalizedReleaseId = cleanText(releaseId),
    normalizedMediumId = cleanText(mediumId);
  if (
    (normalizedReleaseId && kind !== "medium") ||
    (normalizedMediumId && kind !== "track")
  )
    throw new Error("invalid_identity_scope");
  if (workId !== undefined && workId !== null && !normalizedWorkId)
    throw new Error("--work-id 不能为空");
  if (normalizedWorkId && !["expression", "content_unit"].includes(kind))
    throw new Error("--work-id 仅适用于 expression/content_unit");
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
    throw new Error("limit 必须是 1–1000 的整数");

  const titleValues = [...titles].map(cleanText).filter(Boolean);
  const externalValues = [...externalIds].map((item) => ({
    provider: cleanText(item?.kind ?? item?.provider),
    value: cleanText(item?.value),
  }));
  const attributeValues = [...attributes].map((item) => ({
    key: cleanText(item?.key),
    value: cleanText(item?.value),
  }));

  if (externalValues.some((item) => !item.provider || !item.value)) {
    throw new Error("外部标识格式为 provider=value，且两侧都不能为空");
  }
  if (attributeValues.some((item) => !item.key || !item.value)) {
    throw new Error("属性格式为 key=value，且两侧都不能为空");
  }
  if (
    !titleValues.length &&
    !externalValues.length &&
    !attributeValues.length
  ) {
    throw new Error("至少提供一个 --title、--external 或 --attribute 查询条件");
  }

  return {
    kind,
    titles: titleValues,
    externalIds: externalValues,
    attributes: attributeValues,
    workId: normalizedWorkId || null,
    releaseId: normalizedReleaseId || null,
    mediumId: normalizedMediumId || null,
    limit,
    approximate: Boolean(approximate),
  };
}

function entityTitleValues(entity: Record<string, any>) {
  const values = [];
  if (typeof entity.title === "string")
    values.push({ field: "title", value: entity.title });
  if (Array.isArray(entity.aliases)) {
    entity.aliases.forEach((value, index) => {
      if (typeof value === "string")
        values.push({ field: "aliases[" + index + "]", value });
    });
  }
  for (const [locale, translation] of Object.entries<Record<string, any>>(
    entity.translations || {},
  )) {
    if (typeof translation?.title === "string") {
      values.push({
        field: "translations." + locale + ".title",
        value: translation.title,
      });
    }
    if (Array.isArray(translation?.aliases)) {
      translation.aliases.forEach((value, index) => {
        if (typeof value === "string") {
          values.push({
            field: "translations." + locale + ".aliases[" + index + "]",
            value,
          });
        }
      });
    }
    if (Array.isArray(translation?.nonofficial_aliases)) {
      translation.nonofficial_aliases.forEach((value, index) => {
        if (typeof value === "string") {
          values.push({
            field: "translations." + locale + ".nonofficial_aliases[" + index + "]",
            value,
          });
        }
      });
    }
  }
  return values;
}

function addReason(reasons, reason) {
  const key = JSON.stringify(reason);
  if (!reasons.some((item) => JSON.stringify(item) === key))
    reasons.push(reason);
}

function matchReasons(entity, query) {
  const reasons = [];
  const wantedTitles = query.titles.map(normalizeTitle);
  const wantedCores = query.titles.map(coreTitle);
  for (const title of entityTitleValues(entity)) {
    const normalized = normalizeTitle(title.value);
    if (!normalized) continue;
    const entityCore = coreTitle(title.value);
    query.titles.forEach((value, index) => {
      if (normalized === wantedTitles[index]) {
        addReason(reasons, {
          query_mode: "title_normalized_equality",
          query_value: value,
          matched_field: title.field,
          matched_value: title.value,
          match_method: "case_and_whitespace_normalized",
          strength: "weak_title_candidate",
        });
      } else if ([...wantedCores[index]].length >= 2 && entityCore === wantedCores[index]) {
        addReason(reasons, {
          query_mode: "title_core_equality",
          query_value: value,
          matched_field: title.field,
          matched_value: title.value,
          match_method: "core_title_normalized",
          strength: "weak_title_candidate",
        });
      } else if (query.approximate && hasSimilarCore(wantedCores[index], entityCore)) {
        addReason(reasons, {
          query_mode: "title_approximate",
          query_value: value,
          matched_field: title.field,
          matched_value: title.value,
          match_method: "substring_or_trigram",
          strength: "approximate_title_candidate",
        });
      }
    });
  }

  for (const criterion of query.externalIds) {
    const links = Array.isArray(entity.external_links) ? entity.external_links : [];
    const hit = links.find((link) => link.kind === (criterion.kind || criterion.provider) &&
      (link.external_id === criterion.value || link.url === criterion.value));
    if (hit) {
      addReason(reasons, {
        query_mode: "external_id_exact",
        provider: criterion.kind || criterion.provider,
        query_value: criterion.value,
        matched_field: "external_links." + (criterion.kind || criterion.provider),
        matched_value: hit.external_id || hit.url,
        match_method: "exact_value",
        strength: "identifier_candidate",
      });
    }
  }

  for (const criterion of query.attributes) {
    const actual = entity.attributes?.[criterion.key];
    const values = Array.isArray(actual) ? actual : [actual];
    const wantNorm = normalizeTitle(criterion.value);
    for (const value of values) {
      if (
        isScalar(value) &&
        (String(value) === criterion.value || normalizeTitle(String(value)) === wantNorm)
      ) {
        addReason(reasons, {
          query_mode: "attribute_exact",
          attribute: criterion.key,
          query_value: criterion.value,
          matched_field: "attributes." + criterion.key,
          matched_value: value,
          match_method: "exact_value",
          strength: "attribute_candidate",
        });
      }
    }
  }
  return reasons;
}

function coverageIsComplete(coverage) {
  if (!coverage || typeof coverage !== "object" || coverage.complete !== true)
    return false;
  if (!Number.isInteger(coverage.pages) || coverage.pages < 1) return false;
  if (
    !Number.isInteger(coverage.total) ||
    !Number.isInteger(coverage.rawCount) ||
    !Number.isInteger(coverage.uniqueCount)
  )
    return false;
  if (!Array.isArray(coverage.failures) || coverage.failures.length > 0)
    return false;
  if (!Array.isArray(coverage.duplicateIds) || coverage.duplicateIds.length > 0)
    return false;
  if (
    coverage.rawCount !== coverage.total ||
    coverage.uniqueCount !== coverage.total
  )
    return false;
  return true;
}

function candidateEntity(entity) {
  return {
    id: entity.id || null,
    kind: entity.kind || null,
    title: entity.title || "",
    state: entity.state || null,
    work_id: entity.work_id || null,
    content_unit_id: entity.content_unit_id || null,
    release_id: entity.release_id || null,
    medium_id: entity.medium_id || null,
    parent_id: entity.parent_id || null,
    position: entity.position ?? null,
    number: entity.number ?? null,
    attributes:
      entity.attributes && typeof entity.attributes === "object"
        ? entity.attributes
        : {},
    external_links: Array.isArray(entity.external_links) ? entity.external_links : [],
  };
}

function canonicalCandidate(canonical, originals, reasons, assessment = undefined) {
  return {
    canonical_id: canonical.id,
    canonical_verified: true,
    matched_original_ids: originals,
    matched_reasons: reasons,
    entity: candidateEntity(canonical),
    ...(assessment ? { assessment } : {}),
  };
}

function unresolvedCandidate(original, reasons, status, code, assessment = undefined) {
  return {
    canonical_id: null,
    canonical_verified: false,
    matched_original_ids: [original.id],
    matched_reasons: reasons,
    entity: candidateEntity(original),
    canonical_verification: { status, code },
    ...(assessment ? { assessment } : {}),
  };
}

// Full-text discovery supplements exact identity lookup. These results remain
// separate from verified exact candidates and never establish identity.
async function discoverQualifiedTitles(query, requestFn) {
  const items = new Map(), failures = [];
  const baseTitle = (value) => normalizeTitle(value).replace(/\s*[（(][^()（）]+[）)]$/u, "").trim();
  for (const title of query.titles) {
    const params = new URLSearchParams({ kind: query.kind, q: title, limit: "20" });
    if (query.workId) params.set("work_id", query.workId);
    if (query.releaseId) params.set("release_id", query.releaseId);
    if (query.mediumId) params.set("medium_id", query.mediumId);
    try {
      const response = await requestFn(`/api/catalog/entities?${params}`, { tries: 1 });
      if (response.status !== 200 || !Array.isArray(response.body?.items)) {
        failures.push({ title, status: response.status, reason: "title_discovery_unavailable" });
        continue;
      }
      for (const entity of response.body.items) {
        if (!entity?.id || entity.kind !== query.kind) continue;
        const matches = entityTitleValues(entity).filter(({ value }) =>
          normalizeTitle(value) !== normalizeTitle(title) && baseTitle(value) === baseTitle(title));
        if (matches.length) items.set(entity.id, { entity: candidateEntity(entity), matched_titles: matches, match_method: "qualified_title", identity_confirmed: false });
      }
    } catch {
      failures.push({ title, status: 0, reason: "title_discovery_unavailable" });
    }
  }
  return { items: [...items.values()], failures, scope: "first_search_page_per_title", basis: "index_snapshot" };
}

export async function findIdentity({
  kind = "work",
  titles = [],
  externalIds = [],
  attributes = [],
  workId,
  releaseId,
  mediumId,
  limit = DEFAULT_LIMIT,
  variants = false,
  approximate = false,
  includeApproximate = false,
  requestFn = apiRequest,
}: Record<string, any> = {}) {
  const query = validateInput({
    kind,
    titles,
    externalIds,
    attributes,
    workId,
    releaseId,
    mediumId,
    limit,
    approximate: approximate || includeApproximate,
  });
  const queryModes = [];
  if (query.titles.length) {
    queryModes.push({
      mode: "title_normalized_equality",
      values: query.titles,
    });
    queryModes.push({
      mode: "title_core_equality",
      values: query.titles,
    });
    if (query.approximate) {
      queryModes.push({
        mode: "title_approximate",
        values: query.titles,
      });
    }
  }
  if (query.externalIds.length)
    queryModes.push({ mode: "external_id_exact", values: query.externalIds });
  if (query.attributes.length)
    queryModes.push({ mode: "attribute_exact", values: query.attributes });
  const errors = [],
    unknown = [],
    candidates = [];
  let coverage = {
    basis:
      "server-side identity candidates in one PostgreSQL repeatable-read snapshot",
    complete: false,
    pages: 0,
    total: 0,
    rawCount: 0,
    uniqueCount: 0,
    duplicateIds: [],
    failures: [],
  };
  let rows = [];
  try {
    const result = await requestFn("/api/catalog/entities/candidates", {
      method: "POST",
      tries: 1,
      body: {
        kind: query.kind,
        titles: query.titles,
        external_links: (query.externalIds || []).map((c) => ({
          kind: c.provider,
          value: c.value,
        })),
        attributes: query.attributes,
        ...(query.workId ? { work_id: query.workId } : {}),
        ...(query.releaseId ? { release_id: query.releaseId } : {}),
        ...(query.mediumId ? { medium_id: query.mediumId } : {}),
        ...(query.approximate ? { include_approximate: true } : {}),
        limit: query.limit,
      },
    });
    const body = result?.body;
    if (result?.status !== 200) {
      unknown.push({
        stage: "collection",
        reason: "candidate_query_failed",
        status: result?.status ?? 0,
        code: body?.error ?? "request_failed",
      });
    } else if (
      body?.basis !== "postgres_repeatable_read" ||
      !Array.isArray(body.items) ||
      !Number.isInteger(body.total) ||
      body.total < body.items.length ||
      typeof body.complete !== "boolean" ||
      body.items.length > query.limit ||
      (body.complete && body.total !== body.items.length)
    ) {
      unknown.push({
        stage: "collection",
        reason: "candidate_response_unverified",
      });
    } else {
      rows = body.items;
      const ids = rows.map((row) => row?.matched?.id);
      const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
      coverage = {
        ...coverage,
        pages: 1,
        total: body.total,
        rawCount: rows.length,
        uniqueCount: new Set(ids).size,
        duplicateIds,
        complete: body.complete && duplicateIds.length === 0,
        failures: body.complete
          ? []
          : [{ reason: "candidate_limit_exceeded", limit: query.limit }],
      };
      if (!coverageIsComplete(coverage))
        unknown.push({ stage: "collection", reason: "coverage_incomplete" });
    }
  } catch (error) {
    errors.push({
      stage: "collection",
      code: "candidate_query_failed",
      message: safeError(error),
    });
    unknown.push({
      stage: "collection",
      reason: "candidate_query_unverified",
      status: 0,
    });
  }

  const canonicalGroups = new Map();
  for (const row of rows) {
    const original = row?.matched;
    if (
      !original?.id ||
      original.kind !== query.kind ||
      (query.workId && original.work_id !== query.workId) ||
      (query.releaseId && original.release_id !== query.releaseId) ||
      (query.mediumId && original.medium_id !== query.mediumId)
    ) {
      unknown.push({
        stage: "collection",
        reason: "invalid_or_wrong_scope_item",
      });
      continue;
    }
    const reasons = matchReasons(original, query).map((reason) => ({
      ...reason,
      original_id: original.id,
    }));
    if (
      !reasons.length &&
      query.approximate &&
      query.titles.length &&
      Array.isArray(row?.assessment?.matched_fields) &&
      row.assessment.matched_fields.includes("title_similar")
    ) {
      reasons.push({
        query_mode: "title_approximate",
        query_value: query.titles[0],
        matched_field: "title",
        matched_value: original.title || "",
        match_method: "server_word_similarity",
        strength: "approximate_title_candidate",
        original_id: original.id,
      });
    }
    if (!reasons.length) {
      unknown.push({
        stage: "collection",
        reason: "candidate_match_unverified",
        original_id: original.id,
      });
      continue;
    }
    const canonical = row.canonical;
    if (
      !canonical?.id ||
      canonical.kind !== query.kind ||
      ["merged", "deleted"].includes(canonical.state) ||
      (query.workId && canonical.work_id !== query.workId) ||
      (query.releaseId && canonical.release_id !== query.releaseId) ||
      (query.mediumId && canonical.medium_id !== query.mediumId) ||
      row.resolution_error
    ) {
      candidates.push(
        unresolvedCandidate(
          original,
          reasons,
          404,
          "canonical_identity_unverified",
          row.assessment,
        ),
      );
      unknown.push({
        stage: "resolve",
        reason: "canonical_identity_unverified",
        original_id: original.id,
        status: 404,
      });
      continue;
    }
    if (!canonicalGroups.has(canonical.id))
      canonicalGroups.set(canonical.id, {
        canonical,
        originals: [],
        reasons: [],
        assessment: row.assessment,
      });
    const group = canonicalGroups.get(canonical.id);
    if (!group.assessment && row.assessment) group.assessment = row.assessment;
    if (!group.originals.includes(original.id))
      group.originals.push(original.id);
    for (const reason of reasons) addReason(group.reasons, reason);
  }
  for (const group of canonicalGroups.values()) {
    candidates.push(
      canonicalCandidate(
        group.canonical,
        group.originals.sort(),
        group.reasons,
        group.assessment,
      ),
    );
  }
  candidates.sort((left, right) =>
    String(left.canonical_id || left.matched_original_ids[0]).localeCompare(
      String(right.canonical_id || right.matched_original_ids[0]),
    ),
  );
  const complete = coverageIsComplete(coverage) && unknown.length === 0;
  const related = variants ? await discoverQualifiedTitles(query, requestFn) : undefined;
  if (related) related.items = related.items.filter((item) => !candidates.some((candidate) => candidate.canonical_id === item.entity.id));
  const decision =
    candidates.length || related?.items.length || related?.failures.length || !complete || errors.length
      ? "needs_evidence"
      : "no_visible_candidate";
  return {
    kind: query.kind,
    scope: {
      work_id: query.workId,
      ...(query.releaseId ? { release_id: query.releaseId } : {}),
      ...(query.mediumId ? { medium_id: query.mediumId } : {}),
    },
    query_modes: queryModes,
    coverage,
    candidates,
    ...(related ? { title_discovery: related } : {}),
    unknown,
    errors,
    decision,
    identity_confirmed: false,
    decision_note:
      decision === "no_visible_candidate"
        ? "本次可见范围无候选；不证明真实实例中不存在重复实体。"
        : "候选匹配仅用于定位；身份仍需依据内容与来源人工核验。",
  };
}

function parsePair(value, label) {
  const index = value.indexOf("=");
  if (index <= 0 || index === value.length - 1)
    throw new Error(label + " 格式为 key=value，且两侧都不能为空");
  return [value.slice(0, index), value.slice(index + 1)];
}

export function parseArgs(argv) {
  const options: Record<string, any> = {
    kind: "work",
    titles: [],
    externalIds: [],
    attributes: [],
    workId: null,
    limit: DEFAULT_LIMIT,
    out: null,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      index += 1;
      if (index >= argv.length || argv[index].startsWith("--"))
        throw new Error(flag + " 缺少参数");
      return argv[index];
    };
    switch (flag) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--kind":
        options.kind = value();
        break;
      case "--title":
        options.titles.push(value());
        break;
      case "--approximate":
        options.approximate = true;
        break;
      case "--external": {
        const [provider, externalValue] = parsePair(value(), "--external");
        options.externalIds.push({ provider, value: externalValue });
        break;
      }
      case "--attribute": {
        const [key, attributeValue] = parsePair(value(), "--attribute");
        options.attributes.push({ key, value: attributeValue });
        break;
      }
      case "--release-id":
        options.releaseId = value();
        break;
      case "--medium-id":
        options.mediumId = value();
        break;
      case "--work-id":
        options.workId = value();
        break;
      case "--limit": {
        const parsed = Number(value());
        if (!Number.isInteger(parsed)) throw new Error("--limit 必须是整数");
        options.limit = parsed;
        break;
      }
      case "--variants":
        options.variants = true;
        break;
      case "--out":
        options.out = value();
        break;
      default:
        throw new Error("未知参数：" + flag);
    }
  }
  return options;
}

export function usage() {
  return [
    "用法：node mf-find-identity.ts [选项]",
    "  --kind <kind>             实体类型，默认 work",
    "  --title <题名>            可重复；比较基础题名、translations.title 与 aliases",
    "  --approximate             开启近似题名召回（子串与 pg_trgm 相似度，返回 title_similar）",
    "  --variants                补充发现带括号限定的同题名条目；仍需核对身份",
    "  --external <provider=id>  可重复；外部标识精确匹配",
    "  --attribute <key=value>   可重复；attributes 字段精确匹配",
    "  --work-id <id>            限定 expression/content_unit 所属 Work",
    "  --release-id <id>         限定 medium 所属 Release",
    "  --medium-id <id>          限定 track 所属 Medium",
    "  --limit <1-1000>          候选上限，默认 1000；超过上限报告 partial",
    "  --out <file.json>         将完整结果写入 JSON 文件",
    "  --help                    显示帮助，不读取凭据或请求 API",
    "",
    "只读候选查找；不会合并、新建实体或修改题名。候选命中不等于身份确认。",
  ].join("\n");
}

export async function runCli(
  argv = process.argv.slice(2),
  { stdout, stderr, requestFn = apiRequest }: Record<string, any> = {},
) {
  const writeOut =
    stdout || ((text) => process.stdout.write(String(text) + "\n"));
  const writeErr =
    stderr || ((text) => process.stderr.write(String(text) + "\n"));
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    writeErr(safeError(error));
    writeErr(usage());
    return 2;
  }
  if (options.help) {
    writeOut(usage());
    return 0;
  }

  let report;
  try {
    report = await findIdentity({ ...options, requestFn });
  } catch (error) {
    writeErr(safeError(error));
    return 2;
  }
  if (options.out) {
    try {
      await writeFile(
        resolve(process.cwd(), options.out),
        JSON.stringify(report, null, 2) + "\n",
        "utf8",
      );
    } catch (error) {
      writeErr("无法写入 JSON：" + safeError(error));
      return 2;
    }
  }
  writeOut(
    "decision=" +
      report.decision +
      " candidates=" +
      report.candidates.length +
      " unknown=" +
      report.unknown.length +
      " errors=" +
      report.errors.length +
      (options.out ? " json=" + resolve(process.cwd(), options.out) : ""),
  );
  return report.unknown.length ||
    report.errors.length ||
    !coverageIsComplete(report.coverage)
    ? 2
    : 0;
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  runCli()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write("工具执行失败：" + safeError(error) + "\n");
      process.exitCode = 1;
    });
}
