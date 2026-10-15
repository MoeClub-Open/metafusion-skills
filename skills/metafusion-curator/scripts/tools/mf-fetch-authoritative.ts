// mf-fetch-authoritative.ts - 权威数据库与官网一键搜索抓取工具
// 支持 Wikidata Entity & Search API, Wikipedia API, Bangumi API, MusicBrainz API

import { jsonRequest, ProviderError } from "./mf-fetch-providers.ts";
import { extractMeta, fetchHtml, PublisherError } from "./mf-fetch-publishers.ts";
import { sourceQualification } from "./mf-source-qualification.ts";

const TAGS_WHITELIST = new Set([
  "manga", "television_anime", "tv_anime", "anime", "game", "video_game",
  "role_playing", "fantasy", "science_fiction", "comedy", "adventure",
  "school", "novel", "family_love", "anison", "song"
]);

const USER_AGENT = "MetaFusion-Curator/1.0 (https://findverse.cc; contact: admin@findverse.cc)";
const DEFAULT_TIMEOUT_MS = 20000;

export class AuthoritativeError extends Error {
  kind: string;
  source: string;
  status: number | null;
  retryable: boolean;
  constructor(kind: string, source: string, message: string, meta: { status?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = "AuthoritativeError";
    this.kind = kind;
    this.source = source;
    this.status = meta.status ?? null;
    this.retryable = meta.retryable ?? (kind === "network" || kind === "rate_limited");
  }
}

function requireText(value, label, maxLength = 300) {
  const text = String(value ?? "").trim();
  if (!text || text.length > maxLength || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new AuthoritativeError("bad_input", "authoritative", `${label}缺失或格式非法`);
  }
  return text;
}

function requestOptions(source, opts: Record<string, any> = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) {
    throw new AuthoritativeError("bad_input", source, "timeoutMs 必须在 1 至 120000 毫秒之间");
  }
  return { ...opts, provider: source, userAgent: USER_AGENT, timeoutMs, attempts: opts.attempts ?? 2 };
}

function sourceError(source, err) {
  if (err instanceof AuthoritativeError) return err;
  const connectorError = err instanceof ProviderError || err instanceof PublisherError ||
    (err && typeof err === "object" && typeof err.kind === "string" && ("status" in err || "retryable" in err));
  if (connectorError) {
    const safeKinds = new Set(["bad_input", "http", "rate_limited", "network", "parse", "blocked", "credential_missing", "unavailable", "unsupported", "notfound"]);
    const kind = safeKinds.has(err.kind) ? err.kind : "unexpected";
    return new AuthoritativeError(kind, source, "来源请求失败", {
      status: Number.isInteger(err.status) ? err.status : null,
      retryable: Boolean(err.retryable),
    });
  }
  return new AuthoritativeError("unexpected", source, "来源响应处理失败");
}

/**
 * 1. 搜索 Wikidata 实体（返回精确 QID、标签及描述）
 */
export async function searchWikidata(query, lang = "ja", opts: Record<string, any> = {}) {
  const search = requireText(query, "检索词");
  const language = String(lang ?? "ja").trim();
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/i.test(language)) {
    throw new AuthoritativeError("bad_input", "wikidata", "Wikidata language 格式非法");
  }
  const url = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(search)}&language=${encodeURIComponent(language)}&limit=5&format=json`;
  let data;
  try {
    const response = await jsonRequest(url, requestOptions("wikidata", opts));
    if (response.notFound) return [];
    data = response.json;
  } catch (err) {
    throw sourceError("wikidata", err);
  }
  if (!data || !Array.isArray(data.search)) throw new AuthoritativeError("parse", "wikidata", "Wikidata search 响应缺少候选数组", { retryable: false });
  return (data.search || []).map(item => ({
    id: item.id,
    label: item.label,
    description: item.description,
    url: item.concepturi
  }));
}

/**
 * 2. 抓取 Wikidata 实体详情及外部标识 (P856 官网, P2002 Twitter, P345 IMDb)
 */
export async function fetchWikidataEntity(qid, opts: Record<string, any> = {}) {
  const id = requireText(qid, "Wikidata QID", 24).toUpperCase();
  if (!/^Q\d{1,20}$/.test(id)) throw new AuthoritativeError("bad_input", "wikidata", "Wikidata QID 格式非法");
  const url = `https://www.wikidata.org/wiki/Special:EntityData/${id}.json`;
  let data;
  try {
    const response = await jsonRequest(url, requestOptions("wikidata", opts));
    if (response.notFound) throw new AuthoritativeError("notfound", "wikidata", "Wikidata 实体不存在", { status: 404, retryable: false });
    data = response.json;
  } catch (err) {
    throw sourceError("wikidata", err);
  }
  if (!data || typeof data !== "object") throw new AuthoritativeError("parse", "wikidata", "Wikidata entity 响应不是对象", { retryable: false });
  const entity = data.entities?.[id];
  if (!entity) throw new AuthoritativeError("notfound", "wikidata", "Wikidata 响应中没有该实体", { retryable: false });

  const labels = entity.labels || {};
  const descriptions = entity.descriptions || {};
  const claims = entity.claims || {};

  const officialWebsite = claims.P856?.[0]?.mainsnak?.datavalue?.value;
  const twitter = claims.P2002?.[0]?.mainsnak?.datavalue?.value;
  const imdb = claims.P345?.[0]?.mainsnak?.datavalue?.value;

  return {
    qid: id,
    title_ja: labels.ja?.value || labels.en?.value,
    title_zh: labels["zh-cn"]?.value || labels.zh?.value,
    title_en: labels.en?.value,
    desc_ja: descriptions.ja?.value,
    desc_zh: descriptions["zh-cn"]?.value || descriptions.zh?.value,
    desc_en: descriptions.en?.value,
    official_website: officialWebsite,
    twitter_x: twitter,
    imdb
  };
}

/**
 * 3. 搜索与抓取 Bangumi 条目
 */
export async function fetchBangumiSubject(subjectId, opts: Record<string, any> = {}) {
  const id = requireText(subjectId, "Bangumi subject id", 12);
  if (!/^\d{1,12}$/.test(id) || Number(id) < 1) throw new AuthoritativeError("bad_input", "bangumi", "Bangumi subject id 格式非法");
  const url = `https://api.bgm.tv/v0/subjects/${id}`;
  let data;
  try {
    const response = await jsonRequest(url, requestOptions("bangumi", opts));
    if (response.notFound) throw new AuthoritativeError("notfound", "bangumi", "Bangumi subject 不存在", { status: 404, retryable: false });
    data = response.json;
  } catch (err) {
    throw sourceError("bangumi", err);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new AuthoritativeError("parse", "bangumi", "Bangumi subject 响应不是对象", { retryable: false });

  const tags = (data.tags || [])
    .map(t => t.name?.toLowerCase())
    .filter(t => TAGS_WHITELIST.has(t));
  if (data.type === 2 && !tags.includes("anime")) tags.unshift("anime");

  return {
    source: "bangumi",
    id: String(data.id),
    name: data.name,
    name_cn: data.name_cn || data.name,
    date: data.date,
    summary: data.summary,
    platform: data.platform,
    tags,
    raw: data
  };
}

export async function searchBangumiSubjects(keyword, opts: Record<string, any> = {}) {
  const query = requireText(keyword, "Bangumi subject 检索词");
  const url = "https://api.bgm.tv/v0/search/subjects";
  let response;
  try {
    response = await jsonRequest(url, {
      ...requestOptions("bangumi", opts),
      method: "POST",
      headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) },
      body: JSON.stringify({ keyword: query }),
    });
  } catch (err) {
    throw sourceError("bangumi", err);
  }
  if (response.notFound) throw new AuthoritativeError("notfound", "bangumi", "Bangumi subject search endpoint 不存在", { status: 404, retryable: false });
  const payload = response.json;
  if (!payload || !Array.isArray(payload.data)) throw new AuthoritativeError("parse", "bangumi", "Bangumi 搜索响应缺少 data 候选数组", { retryable: false });
  return {
    source: "bangumi",
    query,
    total: Number.isFinite(payload.total) ? payload.total : null,
    limit: Number.isFinite(payload.limit) ? payload.limit : null,
    offset: Number.isFinite(payload.offset) ? payload.offset : null,
    candidates: payload.data,
    raw: payload,
    limitations: ["Bangumi OpenAPI 将该搜索接口标记为实验性，响应契约可能变化"],
  };
}

export const MUSICBRAINZ_PACE = { minIntervalMs: 1000 };
let musicBrainzQueue = Promise.resolve();
let musicBrainzLastRequestAt = 0;

async function musicBrainzJsonRequest(url, opts: Record<string, any> = {}) {
  const run = async () => {
    const waitMs = MUSICBRAINZ_PACE.minIntervalMs - (Date.now() - musicBrainzLastRequestAt);
    if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
    try {
      return await jsonRequest(url, requestOptions("musicbrainz", opts));
    } finally {
      musicBrainzLastRequestAt = Date.now();
    }
  };
  const result = musicBrainzQueue.then(run, run);
  musicBrainzQueue = result.then(() => undefined, () => undefined);
  return result;
}

const MB_INCLUDES = {
  release: new Set(["collections", "labels", "recordings", "release-groups", "media", "artist-credits", "isrcs"]),
  "release-group": new Set(["releases", "artist-credits"]),
  recording: new Set(["releases", "release-groups", "artist-credits", "isrcs"]),
};
const MB_DEFAULT_INCLUDES = {
  release: ["labels", "recordings", "release-groups", "media", "artist-credits"],
  "release-group": ["releases", "artist-credits"],
  recording: ["releases", "release-groups", "artist-credits", "isrcs"],
};

function musicBrainzIncludes(entityType, value) {
  const includes = value == null ? MB_DEFAULT_INCLUDES[entityType] : Array.isArray(value) ? value : String(value).split(/[+,]/);
  const normalized = [...new Set(includes.map(item => String(item).trim().toLowerCase()).filter(Boolean))];
  const allowed = MB_INCLUDES[entityType];
  const invalid = normalized.find(item => !allowed.has(item));
  if (invalid) throw new AuthoritativeError("bad_input", "musicbrainz", `MusicBrainz ${entityType} inc 包含不支持的值`);
  return normalized;
}

function requireMusicBrainzId(value, entityType) {
  const id = requireText(value, `MusicBrainz ${entityType} MBID`, 36).toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
    throw new AuthoritativeError("bad_input", "musicbrainz", `MusicBrainz ${entityType} ID 必须是 UUID`);
  }
  return id;
}

async function fetchMusicBrainzEntity(entityType, idInput, opts: Record<string, any> = {}) {
  const id = requireMusicBrainzId(idInput, entityType);
  const includes = musicBrainzIncludes(entityType, opts.inc);
  const url = new URL(`https://musicbrainz.org/ws/2/${entityType}/${id}`);
  url.searchParams.set("fmt", "json");
  if (includes.length) url.searchParams.set("inc", includes.join("+"));
  let response;
  try {
    response = await musicBrainzJsonRequest(url.href, opts);
  } catch (err) {
    throw sourceError("musicbrainz", err);
  }
  if (response.notFound) throw new AuthoritativeError("notfound", "musicbrainz", `MusicBrainz ${entityType} 不存在`, { status: 404, retryable: false });
  if (!response.json || typeof response.json !== "object" || Array.isArray(response.json)) {
    throw new AuthoritativeError("parse", "musicbrainz", `MusicBrainz ${entityType} 响应不是对象`, { retryable: false });
  }
  return { source: "musicbrainz", entity_type: entityType, id, inc: includes, data: response.json, raw: response.json };
}

export async function fetchMusicBrainzRelease(id, opts: Record<string, any> = {}) {
  return fetchMusicBrainzEntity("release", id, opts);
}

export async function fetchMusicBrainzReleaseGroup(id, opts: Record<string, any> = {}) {
  return fetchMusicBrainzEntity("release-group", id, opts);
}

export async function fetchMusicBrainzRecording(id, opts: Record<string, any> = {}) {
  return fetchMusicBrainzEntity("recording", id, opts);
}

const MUSICBRAINZ_RELEASE_SEARCH_FIELDS = new Set(["release", "barcode", "catno"]);

function requireMusicBrainzBarcode(value) {
  const digits = String(value ?? "").replace(/[\s-]/g, "");
  if (!/^\d{6,14}$/.test(digits)) {
    throw new AuthoritativeError("bad_input", "musicbrainz", "MusicBrainz 条码必须是 6–14 位数字");
  }
  return digits;
}

export async function searchMusicBrainzReleaseByField(value, field, opts: Record<string, any> = {}) {
  if (!MUSICBRAINZ_RELEASE_SEARCH_FIELDS.has(field)) {
    throw new AuthoritativeError("bad_input", "musicbrainz", "MusicBrainz release 检索字段仅支持 release/barcode/catno");
  }
  const search = field === "barcode"
    ? requireMusicBrainzBarcode(value)
    : requireText(value, `MusicBrainz release ${field} 检索词`, 64);
  const url = new URL("https://musicbrainz.org/ws/2/release/");
  url.searchParams.set("query", `${field}:${search}`);
  url.searchParams.set("fmt", "json");
  url.searchParams.set("limit", "10");
  let response;
  try {
    response = await musicBrainzJsonRequest(url.href, opts);
  } catch (err) {
    throw sourceError("musicbrainz", err);
  }
  if (response.notFound) return { source: "musicbrainz", query: search, total: 0, candidates: [], raw: null };
  const payload = response.json;
  if (!payload || !Array.isArray(payload.releases)) throw new AuthoritativeError("parse", "musicbrainz", "MusicBrainz release search 响应缺少 releases 数组", { retryable: false });
  const candidates = payload.releases.map(release => ({
    id: release.id,
    title: release.title,
    date: release.date ?? null,
    country: release.country ?? null,
    status: release.status ?? null,
    artist_credit: release["artist-credit"] ?? null,
    release_group: release["release-group"] ? { id: release["release-group"].id, title: release["release-group"].title } : null,
    raw: release,
  }));
  return { source: "musicbrainz", query: search, field, total: Number.isFinite(payload.count) ? payload.count : candidates.length, candidates, raw: payload };
}

export async function searchMusicBrainzRelease(query, opts: Record<string, any> = {}) {
  return searchMusicBrainzReleaseByField(query, "release", opts);
}

/**
 * 4. 搜索 MusicBrainz 艺人
 */
export async function searchMusicBrainzArtist(name, opts: Record<string, any> = {}) {
  const query = requireText(name, "MusicBrainz 艺人检索词");
  const url = `https://musicbrainz.org/ws/2/artist/?query=${encodeURIComponent(`artist:${query}`)}&fmt=json`;
  let data;
  try {
    const response = await musicBrainzJsonRequest(url, opts);
    if (response.notFound) return [];
    data = response.json;
  } catch (err) {
    throw sourceError("musicbrainz", err);
  }
  if (!data || !Array.isArray(data.artists)) throw new AuthoritativeError("parse", "musicbrainz", "MusicBrainz artist search 响应缺少 artists 数组", { retryable: false });
  return (data.artists || []).slice(0, 5).map(a => ({
    id: a.id,
    name: a.name,
    disambiguation: a.disambiguation,
    type: a.type,
    country: a.country
  }));
}

const HTML_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", yen: "¥"
};

function extractOfficialImageCandidates(html, pageUrl, meta = extractMeta(html)) {
  const found = [];
  const add = value => {
    if (!value) return;
    try {
      const url = new URL(decodeHtml(value.trim()), pageUrl);
      if ((url.protocol === "https:" || url.protocol === "http:") && !found.includes(url.href)) found.push(url.href);
    } catch { /* 页面中的非 URL 图像值忽略 */ }
  };
  add(meta["og:image"]);
  add(meta["twitter:image"]);
  for (const match of String(html).matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const name = /\b(?:property|name)=["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
    const content = /\bcontent=["']([^"']+)["']/i.exec(tag)?.[1];
    if (name === "og:image" || name === "twitter:image") add(content);
  }
  for (const match of String(html).matchAll(/<img\b[^>]*>/gi)) {
    if (found.length >= 8) break;
    const tag = match[0];
    const src = /\b(?:src|data-src)=["']([^"']+)["']/i.exec(tag)?.[1];
    if (!src) continue;
    const hints = `${tag} ${src}`;
    if (/jacket|cover|product|disc|album|(?:^|[\/_-])cd(?:[\/_-]|\.)/i.test(hints)) add(src);
  }
  return found.slice(0, 8);
}

function decodeHtml(value) {
  return String(value).replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === "#") {
      const hex = entity[1]?.toLowerCase() === "x";
      const codepoint = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      try { return Number.isFinite(codepoint) ? String.fromCodePoint(codepoint) : match; }
      catch { return match; }
    }
    return HTML_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function htmlToText(html) {
  return decodeHtml(String(html)
    .replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(?:p|li|h[1-6]|dd|dt|tr|div|article|section|aside|dl|ul|ol)>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function firstMatch(text, pattern) {
  return text.match(pattern)?.[1]?.trim() || null;
}

function extractUmjCanonicalSegments(html) {
  for (const match of String(html).matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    if (!/\brel=["']canonical["']/i.test(tag)) continue;
    const href = /\bhref=["']([^"']+)["']/i.exec(tag)?.[1];
    if (!href) continue;
    let url;
    try { url = new URL(decodeHtml(href.trim())); }
    catch { return null; }
    const host = url.hostname.toLowerCase();
    if (!(host === "universal-music.co.jp" || host.endsWith(".universal-music.co.jp"))) return null;
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length >= 3 && segments[segments.length - 2].toLowerCase() === "products") {
      return { slug: segments[segments.length - 3].toLowerCase(), code: segments[segments.length - 1] };
    }
    return null;
  }
  return null;
}

function extractUmjLdJsonIdentity(html) {
  const codes = new Set();
  const pageUrls = [];
  for (const match of String(html).matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let payload;
    try { payload = JSON.parse(match[1]); }
    catch { continue; }
    const nodes = Array.isArray(payload) ? payload : [...(payload["@graph"] || []), payload];
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      const type = String(node["@type"] || "");
      if (type === "BreadcrumbList" && Array.isArray(node.itemListElement)) {
        for (const item of node.itemListElement) {
          const name = typeof item?.name === "string" ? decodeHtml(item.name).trim() : "";
          if (name) codes.add(name.toUpperCase());
        }
      }
      if (type === "WebPage") {
        if (typeof node.url === "string") pageUrls.push(node.url);
        const name = typeof node.name === "string" ? decodeHtml(node.name).trim() : "";
        const prefix = name.match(/^([A-Z0-9]+(?:-[A-Z0-9]+)*)/i)?.[1];
        if (prefix) codes.add(prefix.toUpperCase());
      }
    }
  }
  return { codes, pageUrls };
}

function umjLdPageUrlMatches(pageUrls, slug, wantedCode) {
  return pageUrls.some(value => {
    let segments;
    try { segments = new URL(String(value)).pathname.split("/").filter(Boolean); }
    catch { return false; }
    return segments.length >= 3
      && segments[segments.length - 3].toLowerCase() === slug
      && segments[segments.length - 2].toLowerCase() === "products"
      && segments[segments.length - 1].toUpperCase() === wantedCode;
  });
}

function extractTracklistExcerpt(text) {
  const markers = ["曲目", "収録曲", "収録楽曲"];
  const positions = markers.map(marker => text.indexOf(marker)).filter(index => index >= 0);
  if (!positions.length) return null;

  const start = Math.min(...positions);
  const stopMarkers = ["別バージョン", "【商品形態】", "発売日", "BUY NOW"];
  const stops = stopMarkers
    .map(marker => text.indexOf(marker, start + 2))
    .filter(index => index > start);
  const end = Math.min(text.length, start + 16000, ...(stops.length ? stops : [text.length]));
  return text.slice(start, end).trim() || null;
}

/**
 * Read a Universal Music Japan product page by its official artist slug and product code.
 * This is source retrieval only: it never reads MetaFusion credentials or writes catalog data.
 */
export async function fetchUniversalMusicJapanProduct(artistSlug, productCode, opts: Record<string, any> = {}) {
  const slug = String(artistSlug || "").trim().toLowerCase();
  const code = String(productCode || "").trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new AuthoritativeError("bad_input", "umj", "艺人 slug 仅允许 ASCII 字母、数字与连字符");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(code)) throw new AuthoritativeError("bad_input", "umj", "品番格式非法");
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = opts.fetchFn ?? opts.fetchImpl ?? globalThis.fetch;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) {
    throw new AuthoritativeError("bad_input", "umj", "timeoutMs 必须在 1 至 120000 毫秒之间");
  }
  if (typeof fetchImpl !== "function") throw new AuthoritativeError("unsupported", "umj", "运行时没有可用的 fetch");

  const url = "https://www.universal-music.co.jp/" + slug + "/products/" + code.toLowerCase() + "/";
  const pace = { ...(opts.pace ?? {}) };
  if (opts.timeoutMs !== undefined) pace.timeoutMs = timeoutMs;
  let fetched;
  try {
    fetched = await fetchHtml("universal_music", url, { ...opts, pace });
  } catch (err) {
    throw sourceError("umj", err);
  }
  const { html, finalUrl, status } = fetched;
  let finalHost;
  try { finalHost = new URL(finalUrl || url).hostname.toLowerCase(); }
  catch { throw new AuthoritativeError("parse", "umj", "Universal Music Japan 响应 URL 非法", { status, retryable: false }); }
  if (!(finalHost === "universal-music.co.jp" || finalHost.endsWith(".universal-music.co.jp"))) {
    throw new AuthoritativeError("parse", "umj", "Universal Music Japan 页面跳转到了非官方域名", { status, retryable: false });
  }
  const pageTitle = decodeHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<[^>]+>/g, "") || "").trim();
  if (!pageTitle || !/UNIVERSAL MUSIC JAPAN/i.test(pageTitle)) {
    throw new AuthoritativeError("parse", "umj", "响应不是可识别的 Universal Music Japan 页面", { retryable: false });
  }

  const text = htmlToText(html);
  const wantedCode = code.toUpperCase();
  const pageCatalogNumbers = [...text.matchAll(/品\s*番\s*([A-Z0-9]+(?:-[A-Z0-9]+)*)/gi)]
    .map(match => match[1].toUpperCase());
  let catalogNumber = pageCatalogNumbers.find(value => value === wantedCode) || null;
  let catalogNumberStatus = "verified_exact";
  if (!catalogNumber && pageCatalogNumbers.length === 0) {
    // 数字发行页（如 UR1AS/UV1AS/UU1AS）商品表无「品番」行：要求 canonical 路径
    // slug+品番与请求完全一致，且 ld+json 面包屑/WebPage 双重确认同一品番。
    const canonical = extractUmjCanonicalSegments(html);
    const ld = extractUmjLdJsonIdentity(html);
    const canonicalMatches = canonical?.slug === slug && canonical.code.toUpperCase() === wantedCode;
    const ldMatches = ld.codes.has(wantedCode) && umjLdPageUrlMatches(ld.pageUrls, slug, wantedCode);
    if (canonicalMatches && ldMatches) {
      catalogNumber = wantedCode;
      catalogNumberStatus = "verified_canonical_ld";
    }
  }
  if (!catalogNumber) {
    throw new AuthoritativeError("identity_mismatch", "umj", "页面未找到与请求完全匹配的品番", { retryable: false });
  }

  const suffix = " - UNIVERSAL MUSIC JAPAN";
  const titleAndArtist = pageTitle.toUpperCase().endsWith(suffix)
    ? pageTitle.slice(0, -suffix.length)
    : pageTitle;
  const artistSeparator = titleAndArtist.lastIndexOf(" - ");
  const productTitle = artistSeparator >= 0 ? titleAndArtist.slice(0, artistSeparator).trim() : titleAndArtist;
  const artist = artistSeparator >= 0 ? titleAndArtist.slice(artistSeparator + 3).trim() : null;

  const format = firstMatch(text, /フォーマット\s*([\s\S]{1,100}?)(?=\s*組み枚数|\s*レーベル|\s*発売元|\s*発売国|\s*商品紹介|$)/);
  const mediaCount = firstMatch(text, /組み枚数\s*(\d+)/);
  const releaseDate = firstMatch(text, /発売日\s*(\d{4}[-.]\d{2}[-.]\d{2})/);
  const label = firstMatch(text, /レーベル\s*([^\n]+)/);
  const tracklistExcerpt = extractTracklistExcerpt(text);
  const pageMeta = extractMeta(html);
  const imageUrls = extractOfficialImageCandidates(html, finalUrl || url, pageMeta);

  return {
    source: "universal_music_japan",
    url,
    final_url: finalUrl || url,
    status,
    page_title: pageTitle,
    product_title: productTitle,
    artist,
    catalog_number: catalogNumber,
    release_date: releaseDate,
    format,
    media_count: mediaCount ? Number(mediaCount) : null,
    label,
    tracklist_excerpt: tracklistExcerpt,
    image_urls: imageUrls,
    field_status: {
      catalog_number: catalogNumberStatus,
      product_title: productTitle ? "page_title" : "missing",
      release_date: releaseDate ? "page_field" : "missing",
      format: format ? "page_field" : "missing",
      media_count: mediaCount ? "page_field" : "missing",
      label: label ? "page_field" : "missing",
      tracklist_excerpt: tracklistExcerpt ? "page_field_excerpt" : "missing",
      image_urls: imageUrls.length ? "official_page_image_candidate" : "missing",
    },
  };
}

export const AUTHORITATIVE_OPS: Record<string, { source: string; label: string; authority: string; access: string; run: (arg: string, opts?: Record<string, any>) => Promise<any>; source_qualification?: ReturnType<typeof sourceQualification> }> = {
  "wikidata.search": { source: "wikidata", label: "Wikidata 实体检索", authority: "社区知识库；声明引用的原始来源须核对", access: "anonymous", run: (arg, opts) => searchWikidata(arg, "ja", opts) },
  "wikidata.entity": { source: "wikidata", label: "Wikidata 实体详情", authority: "社区知识库；声明引用的原始来源须核对", access: "anonymous", run: (arg, opts) => fetchWikidataEntity(arg, opts) },
  "bangumi.subject": { source: "bangumi", label: "Bangumi subject 详情", authority: "社区编目来源", access: "anonymous", run: (arg, opts) => fetchBangumiSubject(arg, opts) },
  "bangumi.search": { source: "bangumi", label: "Bangumi subject 搜索（实验性 POST）", authority: "社区编目来源", access: "anonymous", run: (arg, opts) => searchBangumiSubjects(arg, opts) },
  "musicbrainz.artist.search": { source: "musicbrainz", label: "MusicBrainz 艺人搜索", authority: "社区编目来源", access: "anonymous", run: (arg, opts) => searchMusicBrainzArtist(arg, opts) },
  "musicbrainz.release.search": { source: "musicbrainz", label: "MusicBrainz release 搜索", authority: "社区编目来源", access: "anonymous", run: (arg, opts) => searchMusicBrainzRelease(arg, opts) },
  "musicbrainz.release.barcode": { source: "musicbrainz", label: "MusicBrainz release 条码反查", authority: "社区编目来源", access: "anonymous", run: (arg, opts) => searchMusicBrainzReleaseByField(arg, "barcode", opts) },
  "musicbrainz.release.catno": { source: "musicbrainz", label: "MusicBrainz release 品番反查", authority: "社区编目来源", access: "anonymous", run: (arg, opts) => searchMusicBrainzReleaseByField(arg, "catno", opts) },
  "musicbrainz.release": { source: "musicbrainz", label: "MusicBrainz release 详情（合法 inc）", authority: "社区编目来源", access: "anonymous", run: (arg, opts) => fetchMusicBrainzRelease(arg, opts) },
  "musicbrainz.release-group": { source: "musicbrainz", label: "MusicBrainz release-group 详情（合法 inc）", authority: "社区编目来源", access: "anonymous", run: (arg, opts) => fetchMusicBrainzReleaseGroup(arg, opts) },
  "musicbrainz.recording": { source: "musicbrainz", label: "MusicBrainz recording 详情（合法 inc）", authority: "社区编目来源", access: "anonymous", run: (arg, opts) => fetchMusicBrainzRecording(arg, opts) },
  "umj.product": { source: "umj", label: "Universal Music Japan 官方商品页（严格匹配品番：可见品番或 canonical+结构化数据双重确认）", authority: "版权方官方来源", access: "anonymous", run: (arg, opts) => {
    const parts = String(arg ?? "").split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw new AuthoritativeError("bad_input", "umj", "用法：umj.product <artist-slug/product-code>");
    return fetchUniversalMusicJapanProduct(parts[0], parts[1], opts);
  } },
};

for (const entry of Object.values(AUTHORITATIVE_OPS)) {
  entry.source_qualification = sourceQualification(entry.source);
}

const LEGACY_OPS = {
  wd_search: "wikidata.search",
  wikidata: "wikidata.entity",
  bangumi: "bangumi.subject",
  mb_artist: "musicbrainz.artist.search",
  umj_product: "umj.product",
};

export async function runAuthoritativeOp(op, arg, opts: Record<string, any> = {}) {
  const canonicalOp = LEGACY_OPS[op] ?? op;
  const entry = AUTHORITATIVE_OPS[canonicalOp];
  if (!entry) throw new AuthoritativeError("bad_input", "authoritative", "未知 authoritative 操作");
  if (!String(arg ?? "").trim()) throw new AuthoritativeError("bad_input", entry.source, `操作 ${canonicalOp} 缺少参数`);
  return entry.run(arg, opts);
}

export function describeAuthoritativeError(err) {
  const error = sourceError(err?.source ?? "authoritative", err);
  return { kind: error.kind, source: error.source, status: error.status, retryable: error.retryable, message: error.message };
}

// 旧 CLI 名称和参数形式继续可用；新统一入口调用 runAuthoritativeOp。
if (import.meta.main || process.argv[1]?.endsWith("mf-fetch-authoritative.ts")) {
  const [,, source, ...parts] = process.argv;
  const query = parts.join(" ");
  if (!source || !query) {
    console.log("Usage: bun mf-fetch-authoritative.ts <wd_search|wikidata|bangumi|mb_artist|umj_product|new operation> <query/id>");
    process.exit(0);
  }
  try {
    console.log(JSON.stringify(await runAuthoritativeOp(source, query), null, 2));
  } catch (err) {
    console.error(JSON.stringify(describeAuthoritativeError(err), null, 2));
    process.exit(1);
  }
}
