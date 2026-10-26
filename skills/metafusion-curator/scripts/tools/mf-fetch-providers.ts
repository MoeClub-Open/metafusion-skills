// mf-fetch-providers.ts - 编目外链提供方只读连接器（read-only catalog provider connectors）
//
// 定位：mf-fetch-authoritative.ts 已覆盖 Wikidata / Bangumi / MusicBrainz / UMJ 官方商品页。
// 本模块补齐常见编目外链的其他提供方：Discogs、Open Library、Internet Archive、TMDB、
// AniList、MyAnimeList、ISNI / VIAF / OCLC、NDL Linked Data、VGMdb、iTunes Store、Steam，
// 以及 2026-10-11 新增的五个缺口源：Cover Art Archive（音乐封面）、Kitsu（动画/漫画）、
// VNDB（视觉小说，含版次品番/条码/载体）、OpenBD（日本出版物书目）、Project Gutenberg（公版电子书）。
// 全部只读：不读 MetaFusion 凭据、不写任何线上数据，也不向外部站点携带站内凭据。
//
// 三条硬约定（与 COMMON-BRIEF 的权威来源口径一致，踩过坑才写进代码）：
//   1. 失败必须抛出，不能返回空。found:false 只表示"提供方明确说没有"（HTTP 404、空结果集、
//      archive.org 的空 metadata）；429 / 5xx / 超时 / 网络失败 / 反爬拦截一律抛 ProviderError
//      且 retryable:true。把"未知"当成"不存在"会直接导致漏补或误删外链。
//   2. 403 不等于失效。反爬挑战（Cloudflare "Just a moment"）与网关错误页归为 blocked /
//      unavailable，绝不映射成 found:false。
//   3. 同一主机串行 + 间隔不小于 300ms（paceConfig.minIntervalMs），并对 Retry-After 退避重试；
//      各家限流值见 README-providers.md 的提供方矩阵。
//
// 出参形状（所有 connector 一致，便于上层统一处理）：
//   { provider, found, id, title, titles?, image_url, image_page_url?, dates?, external_ids?,
//     url, sha256, request_url, request_method, human_page?, evidence_reads, raw, notes?, rights_note?, tracks? }
// raw 保留提供方原始响应，便于逐字核对；本模块不替调用方判断"是不是同一个对象"，
// 写入前仍须按 COMMON-BRIEF 第 2 条做三重核对。
//
// 用法：
//   import { fetchDiscogsRelease, searchOpenLibrary, PROVIDER_MATRIX } from "./mf-fetch-providers.ts";
//   const r = await fetchDiscogsRelease("https://www.discogs.com/release/2879-Daft-Punk-Discovery");
// CLI：node mf-fetch-providers.ts <op> <参数>   （op 见文件末尾 PROVIDER_OPS）

import { createHash } from "node:crypto";
import { sourceQualification } from "./mf-source-qualification.ts";

export const USER_AGENT = "MetaFusion-Curator/1.0 ( +https://findverse.cc ; contact: admin@findverse.cc )";

/** 单次请求超时；可用 MF_PROVIDER_TIMEOUT_MS 覆盖。 */
export const TIMEOUT_MS = Number(process.env.MF_PROVIDER_TIMEOUT_MS || 20000);

/** 节流与重试策略。离线单测里把 minIntervalMs 调成 0，保持快速且确定。 */
export const paceConfig = {
  minIntervalMs: 300,    // 同一主机两次请求的最小间隔（COMMON-BRIEF 第 7 条）
  attempts: 2,           // 总尝试次数（含首次）
  backoffBaseMs: 1200,   // 网络 / 5xx 退避基数：backoffBaseMs * attempt
  retryAfterCapMs: 8000, // Retry-After 超过该值就放弃等待并抛 rate_limited
};

const hostState = new Map(); // host -> { chain: Promise, lastAt: number }

/** 清空节流状态（测试或换网络后用）。 */
export function resetPace() { hostState.clear(); }

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 同主机串行执行 + 最小间隔；上一次的失败不会污染下一次的队列。 */
export async function serialize(host, fn) {
  const state = hostState.get(host) || { chain: Promise.resolve(), lastAt: 0 };
  hostState.set(host, state);
  const run = async () => {
    const wait = paceConfig.minIntervalMs - (Date.now() - state.lastAt);
    if (wait > 0) await delay(wait);
    try {
      return await fn();
    } finally {
      state.lastAt = Date.now();
    }
  };
  const result = state.chain.then(run, run);
  state.chain = result.then(() => undefined, () => undefined);
  return result;
}

function redactCredentialText(value) {
  return String(value == null ? "" : value)
    .replace(/([?&](?:api[_-]?key|access[_-]?token|client[_-]?(?:secret|id)|token|key|password|secret|authorization)=)[^&#\s"'<>]*/gi, "$1[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");
}

export class ProviderError extends Error {
  kind: string;
  provider: string;
  status: number | null;
  url: string | null;
  retryable: boolean;
  hint: string | null;
  // kind: bad_input | http（4xx 明确拒绝）| rate_limited | network（传输失败 / 超时 / 5xx，未知可重试）|
  //       parse | blocked | credential_missing | unavailable | unsupported
  constructor(kind: string, provider: string, message: string, info: { status?: number; url?: string; retryable?: boolean; hint?: string; cause?: NodeJS.ErrnoException } = {}) {
    const meta = info || {};
    super(redactCredentialText("[" + provider + "/" + kind + "] " + message));
    this.name = "ProviderError";
    this.kind = kind;
    this.provider = provider;
    this.status = meta.status ?? null;
    this.url = meta.url == null ? null : redactCredentialText(meta.url);
    this.retryable = meta.retryable ?? (kind === "rate_limited" || kind === "network");
    this.hint = meta.hint ?? null;
    if (meta.cause) {
      const cause: NodeJS.ErrnoException = new Error(redactCredentialText(meta.cause.message || String(meta.cause)));
      cause.name = meta.cause.name || "Error";
      if (meta.cause.code) cause.code = meta.cause.code;
      this.cause = cause;
    }
  }
}

/** 把异常压成一行可记录的结构（供 smoke / 日志用，不吞掉原因）。 */
export function describeError(err) {
  if (err instanceof ProviderError) {
    return {
      kind: err.kind, provider: err.provider, status: err.status,
      retryable: err.retryable, message: err.message, hint: err.hint,
    };
  }
  return { kind: "unexpected", provider: null, status: null, retryable: false, message: redactCredentialText(err && err.message ? err.message : err) };
}

/** 提供方网关 / CDN 的错误页特征：出现即说明"这一路不通"，不是"条目不存在"。 */
export function looksLikeGatewayError(text) {
  const head = String(text || "").slice(0, 2000);
  return /no Route matched|Error Code: \d{3}|ErrorCode: \d{3}|^Status: \d{3} /m.test(head);
}

function looksLikeBotChallenge(text) {
  const head = String(text || "").slice(0, 4000);
  return /Just a moment|cf-browser-verification|challenges\.cloudflare\.com|cf-turnstile|Attention Required! \| Cloudflare/i.test(head);
}

function parseRetryAfter(value, nowMs) {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, Math.round(secs * 1000));
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : null;
}

/**
 * 带节流 / 超时 / 退避的一次读取，返回 {status, text, contentType, headers, notFound, url}。
 * 404 与 410 是"正常答案"（notFound:true）；其余失败抛 ProviderError，绝不返回空。
 */
export async function httpRequest(url, opts) {
  const o = opts || {};
  const provider = o.provider ?? "unknown";
  const method = o.method ?? "GET";
  const attempts = o.attempts ?? paceConfig.attempts;
  const timeoutMs = o.timeoutMs ?? TIMEOUT_MS;
  const fetchImpl = o.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new ProviderError("unsupported", provider, "运行时没有可用的 fetch");
  const headers = Object.assign({
    "User-Agent": o.userAgent ?? USER_AGENT,
    Accept: o.accept ?? "application/json",
  }, o.headers || {});
  const host = new URL(url).host;

  return serialize(host, async () => {
    let lastFailure = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let res;
      try {
        res = await fetchImpl(url, {
          method, headers, body: o.body ?? undefined, redirect: "follow",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        lastFailure = new ProviderError("network", provider,
          "网络失败（" + (err && err.name ? err.name : "Error") + ": " + ((err && err.cause && err.cause.code) || (err && err.message) || "unknown") + "）；第 " + attempt + "/" + attempts + " 次",
          { url: url, cause: err, hint: "超时 / 断网属未知状态，不得当作条目不存在" });
        if (attempt < attempts) { await delay(paceConfig.backoffBaseMs * attempt); continue; }
        throw lastFailure;
      }

      let text = "";
      let bytes;
      try {
        bytes = Buffer.from(await res.arrayBuffer());
        text = new TextDecoder().decode(bytes);
      } catch (err) {
        lastFailure = new ProviderError("network", provider, "响应体读取失败：" + (err && err.message ? err.message : String(err)), { url: url, cause: err });
        if (attempt < attempts) { await delay(paceConfig.backoffBaseMs * attempt); continue; }
        throw lastFailure;
      }
      const contentType = res.headers && res.headers.get ? res.headers.get("content-type") || "" : "";
      const retryAfter = res.headers && res.headers.get ? res.headers.get("retry-after") : null;
      const status = res.status;
      const finalUrl = res.url || url;
      const read = {
        url: redactCredentialText(finalUrl),
        request_url: redactCredentialText(url),
        request_method: method,
        url_redacted: redactCredentialText(finalUrl) !== finalUrl || redactCredentialText(url) !== url,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        response_byte_length: bytes.length,
        retrieved_at: new Date().toISOString(),
        ...(o.body == null ? {} : { request_body_sha256: createHash("sha256").update(o.body).digest("hex") }),
      };

      if (status === 404 || status === 410) {
        if (looksLikeGatewayError(text) || looksLikeBotChallenge(text)) {
          throw new ProviderError("unavailable", provider,
            "HTTP " + status + " 返回的是网关 / 反爬页，而不是提供方的「不存在」答复",
            { status: status, url: url, retryable: true, hint: "该提供方当前不可用；按矩阵换读取路径" });
        }
        return { status, text, contentType, headers: res.headers, notFound: true, ...read };
      }

      if (status === 429 || status === 503) {
        const waitMs = parseRetryAfter(retryAfter, Date.now());
        if (attempt < attempts && waitMs !== null && waitMs <= paceConfig.retryAfterCapMs) {
          await delay(Math.max(waitMs, 250));
          continue;
        }
        if (attempt < attempts && waitMs === null) {
          await delay(paceConfig.backoffBaseMs * attempt * 2);
          continue;
        }
        throw new ProviderError("rate_limited", provider,
          "HTTP " + status + " 限流（Retry-After=" + (retryAfter || "无") + "）；已尝试 " + attempt + "/" + attempts + " 次",
          { status: status, url: url, retryable: true, hint: "按矩阵限流值降频后重试；不要据此判定条目失效" });
      }

      if (status === 401) {
        throw new ProviderError("credential_missing", provider, "HTTP 401：需要 API key / access token",
          { status: status, url: url, retryable: false, hint: o.credentialHint ?? "在环境变量里配置该提供方凭据后重试" });
      }

      if (status === 403 || status === 451) {
        const challenge = looksLikeBotChallenge(text);
        throw new ProviderError("blocked", provider,
          challenge ? "HTTP " + status + "：反爬挑战页（不是内容失效）" : "HTTP " + status + "：提供方拒绝当前调用者",
          { status: status, url: url, retryable: false, hint: challenge ? (o.archiveHint ?? "改走 Internet Archive 存档读取") : "确认 UA / 凭据要求，或换提供方" });
      }

      // 5xx 与传输失败同属"未知状态"：归 network（可重试），绝不映射成 found:false。
      if (status >= 500) {
        lastFailure = new ProviderError("network", provider, "HTTP " + status + "（提供方 5xx，状态未知）",
          { status: status, url: url, hint: "退避后重试；5xx 不代表条目不存在" });
        if (attempt < attempts) { await delay(paceConfig.backoffBaseMs * attempt); continue; }
        throw lastFailure;
      }

      // 其余 4xx 是明确的协议级拒绝（可判定），归 http。
      if (!res.ok) {
        throw new ProviderError("http", provider, "HTTP " + status + ": " + String(text).replace(/\s+/g, " ").slice(0, 200),
          { status: status, url: url, retryable: false });
      }

      if (!contentType.includes("html") && looksLikeGatewayError(text)) {
        throw new ProviderError("unavailable", provider,
          "HTTP " + status + " 但响应体是网关错误：" + String(text).replace(/\s+/g, " ").slice(0, 160),
          { status: status, url: url, retryable: true });
      }

      return { status, text, contentType, headers: res.headers, notFound: false, ...read };
    }
    throw lastFailure ?? new ProviderError("network", provider, "未预期的读取失败（状态未知）", { url: url });
  });
}

/** JSON 读取：解析失败抛 parse，不当成"没有数据"。 */
export async function jsonRequest(url, opts) {
  const o = opts || {};
  const res = await httpRequest(url, Object.assign({ accept: "application/json" }, o));
  if (res.notFound) return { ...res, json: null, raw: res.text };
  try {
    return { ...res, json: JSON.parse(res.text), raw: res.text };
  } catch (err) {
    throw new ProviderError("parse", o.provider ?? "unknown",
      "响应不是合法 JSON（content-type=" + (res.contentType || "?") + "）：" + String(res.text).replace(/\s+/g, " ").slice(0, 160),
      { status: res.status, url: res.url, cause: err });
  }
}

/** 统一出参：键齐全，found:false 时其余为 null，上层不必逐家判空。 */
function result(provider, fields) {
  return Object.assign({
    provider: provider,
    source_qualification: sourceQualification(provider),
    found: true,
    id: null,
    title: null,
    titles: null,
    image_url: null,
    image_page_url: null,
    dates: null,
    external_ids: null,
    url: null,
    raw: null,
    notes: null,
    rights_note: null,
  }, fields || {});
}

/** 只将已完成读取的响应作为证据；纯 map/parse 的页面链接不冒充实读。 */
export function attachReadEvidence(output, responses) {
  const reads: Record<string, any>[] = (Array.isArray(responses) ? responses : [responses]).filter(Boolean).map((response) => {
    const keys = ["url", "request_url", "request_method", "url_redacted", "sha256", "response_byte_length", "retrieved_at", "request_body_sha256"];
    return { ...Object.fromEntries(keys.filter((key) => response[key] !== undefined).map((key) => [key, response[key]])), http_status: response.status };
  });
  const primary = reads[0];
  if (!primary?.sha256) throw new Error("来源结果缺少已读取响应的字节摘要");
  const humanPage = output.human_page ?? (output.url && output.url !== primary.url && output.url !== primary.request_url ? output.url : null);
  return { ...output, ...primary, human_page: humanPage, evidence_reads: reads };
}

function readResult(response, provider, fields) {
  return attachReadEvidence(result(provider, fields), response);
}

function clean(value) {
  const s = String(value == null ? "" : value)
    .replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, "\"")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return s || null;
}

function requireObject(value, provider, description) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderError("parse", provider, description + " 响应不是对象", { retryable: false });
  }
  return value;
}

function requireArrayField(value, field, provider, description) {
  const object = requireObject(value, provider, description);
  if (!Array.isArray(object[field])) {
    throw new ProviderError("parse", provider, description + " 缺少数组字段 " + field, { retryable: false });
  }
  return object[field];
}

function hasMeaningfulText(value) {
  if (typeof value === "string" || typeof value === "number") return Boolean(clean(value));
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).some((item) => typeof item === "string" && Boolean(clean(item)));
}

function requireSearchItem(value, provider, description, idKeys, titleKeys) {
  const item = requireObject(value, provider, description + " 候选项");
  const hasId = idKeys.some((key) => item[key] != null && String(item[key]).trim());
  const hasTitle = titleKeys.some((key) => hasMeaningfulText(item[key]));
  if (!hasId || !hasTitle) {
    throw new ProviderError("parse", provider, description + " 候选项缺少标识或题名", { retryable: false });
  }
  return item;
}

const ISO_DATE = /^\d{4}(-\d{2}(-\d{2})?)?$/;
/** 只有确证的 YYYY / YYYY-MM / YYYY-MM-DD 才进 dates；其他形式原样放 raw，不做猜测加工。 */
function isoDate(value) {
  const s = String(value == null ? "" : value).trim();
  return ISO_DATE.test(s) ? s : null;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
/** "Dec 23, 2020" / "23 Dec 2020" 转 "2020-12-23"；解析不了返回 null。 */
export function parseEnglishDate(value) {
  const text = String(value == null ? "" : value).trim();
  if (!text) return null;
  const m = text.match(/^([A-Za-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?,\s*(\d{4})$/)
    || text.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s*(\d{4})$/);
  if (!m) return isoDate(text);
  const monthName = /^[A-Za-z]/.test(m[1]) ? m[1] : m[2];
  const day = Number(/^[A-Za-z]/.test(m[1]) ? m[2] : m[1]);
  const year = Number(m[3]);
  const month = MONTHS[monthName.slice(0, 3).toLowerCase()];
  if (!month || !Number.isFinite(day) || !Number.isFinite(year)) return null;
  return String(year).padStart(4, "0") + "-" + String(month).padStart(2, "0") + "-" + String(day).padStart(2, "0");
}

// ───────────────────────── 提供方能力矩阵 ─────────────────────────
// access 是 verifiedAt 日期的观测快照，不表示之后始终可用；变化时先复核再更新。

export const PROVIDER_MATRIX: Record<string, { label: string; access: string; authority: string; source_qualification?: ReturnType<typeof sourceQualification>; accessObservation?: { status: string; observedAt: string; scope: string }; [key: string]: any }> = {
  discogs: {
    label: "Discogs", access: "anonymous", authority: "official-community",
    baseUrl: "https://api.discogs.com",
    entities: ["release", "master", "artist", "label", "search"],
    rateLimit: "匿名 25 req/min（响应头 x-discogs-ratelimit: 25）",
    note: "匿名可读 database/search、releases/{id}、masters/{id}；写端点与 /oauth/ 身份需 token。图片为社区上传，授权须人工判断。",
    verifiedAt: "2026-10-03",
  },
  openlibrary: {
    label: "Open Library", access: "anonymous", authority: "official",
    baseUrl: "https://openlibrary.org",
    entities: ["search", "work", "edition", "author", "cover"],
    rateLimit: "公开 API，未公布固定额度；按不小于 300ms 串行使用",
    note: "/search.json 与 /books|/works|/authors/<ID>.json 可用；封面走 covers.openlibrary.org/b/id/<cover_id>-{S,M,L}.jpg。/isbn/<isbn>.json 现返回 404 HTML，改用 search?q=isbn:<isbn>。",
    verifiedAt: "2026-10-03",
  },
  internetarchive: {
    label: "Internet Archive", access: "anonymous", authority: "official",
    baseUrl: "https://archive.org",
    entities: ["item metadata", "advancedsearch", "wayback"],
    rateLimit: "未公布；metadata 属高流量端点，保持串行",
    note: "/metadata/<identifier> 对不存在条目返回 HTTP 200 且 body 为空对象 —— 必须按 metadata 是否为空判 not found，不能按 200 判存在。缩略图 /services/img/<identifier> 实测 200 image/jpeg。**2026-10-11 本机复测：archive.org 整站不可达（http=000，连接超时约 21s），nslookup 把它解析到 2a03:2880:f134:83:face:b00c:0:25de —— 那是 Meta 的 face:b00c 虚荣段，说明解析异常，但仅凭这些观测无法确认具体原因**（同机 coverartarchive.org 与 musicbrainz.org 正常解析到 Hetzner 并 200）。因此本机 archive.item / archive.search / archive.wayback 与依赖它做兜底的 vgmdb.archive、以及 coverartarchive 取正文都会失败，且必须归为 network/unavailable，绝不能映射成 found:false。矩阵里 2026-10-03 的 access 快照是当时的观测，换机器或换网络后先复测再用。",
    verifiedAt: "2026-10-03",
  },
  tmdb: {
    label: "TMDB", access: "credential", authority: "official-community",
    baseUrl: "https://api.themoviedb.org/3",
    entities: ["movie", "tv", "person", "search"],
    rateLimit: "key 制，官方未固定额度",
    note: "无 key 实测 HTTP 401（status_code 7）。支持 TMDB_API_KEY（v3 ?api_key=）或 TMDB_ACCESS_TOKEN（v4 Bearer）；两者都缺时抛 credential_missing 而不是返回空。image.tmdb.org 的图片 URL 无需 key。",
    credentialEnv: ["TMDB_API_KEY", "TMDB_ACCESS_TOKEN"],
    verifiedAt: "2026-10-03",
  },
  anilist: {
    label: "AniList", access: "anonymous", authority: "official-community",
    baseUrl: "https://graphql.anilist.co",
    entities: ["anime", "manga", "search"],
    rateLimit: "匿名 30 req/min（x-ratelimit-limit: 30）",
    note: "公开 GraphQL。不存在的 id 返回 HTTP 404 且 body 含 Not Found，可判 found:false。当前 schema 已不可用的字段（实测 400）：Media.synonym（应为 synonyms）、Media.idAbbreviation、Media.year、Page(type:)、MediaTitle.canonical。",
    verifiedAt: "2026-10-03",
  },
  myanimelist: {
    label: "MyAnimeList", access: "credential", authority: "official",
    baseUrl: "https://api.myanimelist.net/v2",
    entities: ["anime", "manga", "search"],
    rateLimit: "按 client id 计量",
    note: "匿名实测 HTTP 403（error: forbidden），OAuth client id 必需（X-MAL-CLIENT-ID）。Jikan（api.jikan.moe）能匿名读，但它是第三方镜像，不满足站内官方原始数据口径，本模块不实现，仅在此记录。",
    credentialEnv: ["MAL_CLIENT_ID"],
    verifiedAt: "2026-10-03",
  },
  isni: {
    label: "ISNI Registry", access: "blocked", authority: "official",
    baseUrl: "https://isni.org",
    entities: ["isni"],
    rateLimit: "n/a",
    note: "最近一次本机观测（日期见 verifiedAt）：isni.org 记录页与 SPARQL 返回 Cloudflare 挑战页（HTTP 403，body 含 Just a moment / challenges.cloudflare.com），换浏览器 UA 同样 403。此状态是观测快照；替代线索为 Wikidata P213/P214 与 Open Library author.remote_ids（须二重核对）。",
    verifiedAt: "2026-10-03",
  },
  viaf: {
    label: "VIAF (OCLC)", access: "unavailable", authority: "official",
    baseUrl: "https://viaf.org",
    entities: ["viaf"],
    rateLimit: "响应头 ratelimit-limit 约 1000/min",
    note: "最近一次本机观测（日期见 verifiedAt）：记录端点 /viaf/<id> 对已知存在号返回网关 404（Error Code: 404）；/viaf/SRU 与 /ws/1.0/... 为 no Route matched；/viaf/search 的 SRW JSON 对 pers.name / cor.name 返回 numberOfRecords:0。此状态是观测快照，不表示端点永久不可用。",
    verifiedAt: "2026-10-03",
  },
  oclc: {
    label: "OCLC / WorldCat", access: "credential", authority: "official",
    baseUrl: "https://api.worldcat.org",
    entities: ["worldcat holdings", "FAST headings"],
    rateLimit: "需 OCLC token",
    note: "api.worldcat.org 未认证请求返回 500 HTML 错误页（重定向到 api.on.worldcat.org/discovery），Read / Search API 均需 client_id + WSKey；FAST Search & Select（fast.oclc.org/searchfast/fastsuggest）当前返回 body 形如 Status: 400 / 404 Reason —— 两条都不可匿名使用。",
    credentialEnv: ["WORLDCLIENTID", "WORLDAUTHTOKEN"],
    verifiedAt: "2026-10-03",
  },
  ndl: {
    label: "NDL Linked Data", access: "anonymous", authority: "official",
    baseUrl: "https://id.ndl.go.jp",
    entities: ["auth/ndlna（人物・団体・統一タイトル・件名）"],
    rateLimit: "未公布；串行使用",
    note: "权威记录 JSON-LD 实测可用：/auth/ndlna/<8 码>.json（label、prefLabel.transcription（ja-Kana）、transcription-l（ja-Latn）、primaryTopic.dateOfBirth / dateOfDeath、exactMatch VIAF URI、inScheme）。书志 LD /bib/<id>.json 与 ndlsht、ncl 当前 404；lod.ndl.go.jp SPARQL 与 www.ndlsearch.ndlsearch.go.jp 在本机 ECONNRESET（NDL Search API 另需申请 key）。",
    verifiedAt: "2026-10-03",
  },
  vgmdb: {
    label: "VGMdb", access: "blocked", authority: "official-community",
    baseUrl: "https://vgmdb.net",
    entities: ["album（页面解析）"],
    rateLimit: "n/a",
    note: "无公开 API（官方 XML API 只对订阅者开放）。站内页面对本机返回 Cloudflare 403 挑战页；图片 CDN medium-media.vgm.io 可匿名 200。页面不含 JSON-LD（实测 0 个 ld+json script、无 microdata itemtype），字段在 table#album_infobit_large 的 label/value 行与 span.albumtitle[lang]，因此实现为 HTML 解析 + Internet Archive id_ 原样存档读取（parseVgmdbAlbumHtml 可离线复用）。",
    verifiedAt: "2026-10-03",
  },
 itunes: {
   label: "iTunes Store", access: "anonymous", authority: "official",
   baseUrl: "https://itunes.apple.com",
   entities: ["search", "album"],
   rateLimit: "约 20 calls/min（Apple Search API 文档口径）；实测连续低量请求未见限流",
   note: "免费 Search API，GET /search（term + media=music&entity=album）与 GET /lookup（id、entity=song 返回 collection + track 曲目）均匿名可用、无需 key。2026-10-08 实测：响应 content-type 为 text/javascript，但 body 是合法 JSON；不存在的 collectionId 与空检索都返回 HTTP 200 + resultCount:0 —— not_found 按 resultCount=0 判定，不能只看 HTTP 状态；jp storefront 检索「まいてつ」只返回模糊匹配的无关专辑、「Maitetsu」0 命中（该作未上架 JPN storefront），检索「AQUAPLUS」命中游戏音乐专辑（collectionId 541874266，10 曲）。2026-10-09 实测：artworkUrl100 改写 60–3000px 可用、超 3000 回退 3000，可换 png/webp（images 给多尺寸候选）；封面 URL 的原图文件名段常常就是发行方编号（如 4538182209493_cov.jpg、4547366532999.jpg），itunesArtworkBarcode 不做硬校验、按 6–14 位数字开头提取为 release_number / barcode_candidate 候选并附 scheme 与 checksum_valid 提示，全部交由 agent 按技能核实确认（数字发行可能用独立编号、沿用实体版条码或没有编号，Apple 响应本身不含 UPC/barcode 字段）。storefront 用 country=<两字母> 覆盖，默认 jp。文档：https://performance-partners.apple.com/search-api 。",
   verifiedAt: "2026-10-08",
 },
  steam: {
    label: "Steam 商店", access: "anonymous", authority: "official",
    baseUrl: "https://store.steampowered.com",
    entities: ["app（appdetails，按 AppID）", "search（storesearch，按名称）"],
    rateLimit: "Steam 商店接口口径：100,000 calls/day 且 200 calls/5 min（约 1 call/1.5s）；本模块同主机 ≥300ms 串行，批量导入时按 200/5min 自行限速",
    note: "Valve 官方商店接口，匿名可读、无需 key。2026-10-08 本机实测：GET /api/appdetails?appids=<id>&l=<lang>&cc=<cc> 返回 {\"<id>\":{success,data}}，AppID 不存在是 HTTP 200 + success:false（不是 404），appids=0 是 HTTP 400 且 body 为 null；不写 cc 时区域与币种按请求来源地解析（本机实测 JPY），可复现的定价必须显式 cc=；发行日期随 l= 本地化（\"2018 年 1 月 25 日\"/\"2018年1月25日\"/\"Jan 25, 2018\"）。GET /api/storesearch/?term=&l=&cc= 返回 {total,items}。steamdb.info 是第三方聚合站、对机读返回 HTTP 403 自有拦截页（无 Cloudflare 挑战特征），只作人工交叉核对，连接器不抓取它，只从它的 /app/<id>/ 链接取 AppID。商店页署名（developers/publishers）与价格由发行商与 Valve 提供，写入目录前仍按字段来源策略逐项核对。",
    verifiedAt: "2026-10-08",
  },
  coverartarchive: {
    label: "Cover Art Archive", access: "anonymous", authority: "official-community",
    baseUrl: "https://coverartarchive.org",
    entities: ["release 封面图组", "release-group 封面图组"],
    rateLimit: "官方未公布固定额度；index.json 与图片正文由 archive.org 托管，批量取图按 archive.org 的礼仪限速，本模块同主机 ≥300ms 串行",
    note: "MusicBrainz 官方封面图存档，按 MBID 取 index.json：GET /release/{mbid} 或 /release-group/{mbid}。2026-10-11 本机实测三条关键事实：① 没有封面时返回 HTTP 404 + HTML「No cover art found for release <mbid>」，这是提供方的明确答复（found:false），不是故障；② release-group 请求会 307 到「CAA 选定的那一个发行版」的 index，因此图属于 index 里 release 字段指向的那个 Release，不是整组通用——写封面必须按 release_of_record 归位，不得沿用上级；③ index.json 与图片正文都在 archive.org 上，而本机 archive.org 出现异常 DNS 解析（疑似 DNS 污染）（解析到 2a03:2880:f134:83:face:b00c:0:25de 这个 Meta 段地址，连接超时 http=000），而 coverartarchive.org 与 musicbrainz.org 正常解析到 Hetzner 并 200——所以本机取不到正文属网络可达性问题，不得据此判定 CAA 失效或该 MBID 无封面。图片由社区上传、逐张授权不同；选图判据是 types 与 front/back（Case Front 是正面再摄＝与 Front 重复，Back/Case Back 才是不同画面）。图片尺寸需自己打开确认，index.json 不提供像素。",
    verifiedAt: "2026-10-11",
  },
  kitsu: {
    label: "Kitsu", access: "anonymous", authority: "official-community",
    baseUrl: "https://kitsu.io/api/edge",
    entities: ["anime", "manga", "search"],
    rateLimit: "JSON:API 公开端点，官方未公布固定额度；本模块同主机 ≥300ms 串行",
    note: "JSON:API 形态（data/attributes/relationships/meta/links），匿名可读无需 key。GET /anime/{id}、/manga/{id}，检索 GET /anime?filter[text]=<词>&page[limit]=N；也可用 filter[slug]=<slug> 按 slug 取。2026-10-11 本机实测：不存在的 id 返回 HTTP 404 + {\"errors\":[{\"code\":\"404\",\"title\":\"Record not found\"}]}，可按 found:false 判读；titles 是任意语种键的映射（实测 en / en_jp / ja_jp / zh_cn / ko_kr / pt_br / th_th / it_it），其中 en_jp 是罗马音而不是语种，连接器按 BCP-47 归一并把 en_jp 单列 romaji；posterImage.meta.dimensions 直接给 tiny/small/medium/large 各档宽高（实测 large 550×780、small 284×402），据此判封面尺寸是否够门槛，不要只看 HTTP 200 就选图；coverImage 是宽幅横幅不是海报，不作封面候选。synopsis 末尾常带「(Source: Wikipedia)」「(Source: Crunchyroll)」这类出处标注，那是简介的来源证据：Kitsu 本身是社区聚合站，不能仅凭站点名当权威来源。relationships 默认只给链接，需要 cast/staff/genres 时用 include= 另取。",
    verifiedAt: "2026-10-11",
  },
  vndb: {
    label: "VNDB", access: "anonymous", authority: "official-community",
    baseUrl: "https://api.vndb.org/kana",
    entities: ["vn", "release", "character", "staff", "schema"],
    rateLimit: "官方口径约每分钟 1 次突发、持续 10 秒内不超过 15 次；本模块同主机 ≥300ms 串行，批量时自行降频",
    note: "API v2（Kana）：POST https://api.vndb.org/kana/<vn|release|character|staff|tag|trait|producer>，体为 {\"filters\":[...],\"results\":N,\"fields\":\"...\"}，返回 {more,results}。2026-10-11 本机实测的关键陷阱：① 路径不是 POST /kana（那样返回 HTTP 404 纯文本「Not found.」，容易误判成端点失效），真实端点是 /kana/<type>；② 分页参数是 results 不是 count（用 count 得 HTTP 400「Invalid 'count' member.」）；③ fields 严格校验，写错字段名或嵌套对象不给子字段都会 400 并明确指出是哪个字段（实测 vn 没有 original 字段——用 alttitle/titles；release 的 languages 与 media 必须写成 languages.lang,languages.title 与 media.medium,media.qty）；权威字段名可用 vndb.schema（GET /kana/schema 的 api_fields）查，不必试错。released 用 00 表示未知的月/日（\"2003-05-00\"＝2003 年 5 月、\"2003-00-00\"＝2003 年），连接器按此归一，不当成非法日期。description 是 BBCode（含 [url=...]Wikipedia[/url] 这类标注），既是转写义务也是出处线索。release 的 gtin/catalog/media/producers(developer|publisher)/minage 是社区转录的品番、条码、载体构成与权利方分工候选。image.sexual 与 image.violence 是社区投票数，不是分级结论。",
    verifiedAt: "2026-10-11",
  },
  openbd: {
    label: "OpenBD", access: "anonymous", authority: "official",
    baseUrl: "https://api.openbd.jp/v1",
    entities: ["按 ISBN 取书目记录"],
    rateLimit: "公开 API，官方未公布固定额度；本模块同主机 ≥300ms 串行",
    note: "日本出版物书目 API：GET /v1/get?isbn=<ISBN13>（是查询参数，不是 /get/{isbn}，后者一律 Not Found）。2026-10-11 本机实测：响应顶层是数组，命中为 [{onix,hanmoto,summary}]（注意是 hanmoto 不是 hamoto），查无为 [null] 且 HTTP 200——[null] 只说明 OpenBD 没收录。OpenBD 只收日本出版物，台版/引进版返回 [null] 是收录范围问题，不是站点故障，不得据此判定该书不存在或该站不可用。summary 给 isbn/title/volume/series/publisher/pubdate/cover/author 的规整值，onix 给完整 ONIX 原文（题名在 DescriptiveDetail.TitleDetail.TitleElement.TitleText.content，丛书在 Collection.TitleDetail.TitleElement[].TitleText.content，出版方在 PublishingDetail.Imprint.ImprintName，刊行年月在 PublishingDetail.PublishingDate[].Date，价格在 ProductSupply.SupplyDetail.Price[]）；PublishingDateRole 是 ONIX 代码，连接器不猜其含义、原样给出。summary.title 可能缺副题或标点（实测電撃文庫某卷少一个「.」），题名以版元商品页 h1 为准，OpenBD 只用来复核巻号·丛书·刊行年月。author 是 ONIX 倒装形（实测「師走,トオル」＝姓,名）。summary.cover 常为空串；cover.openbd.jp/<isbn>.jpg 在无封面时返回 404。**两个必须避开的坑**：① 同域名的 /v1/coverage 端点会**忽略 isbn 参数**、直接返回全量收录清单（2026-10-11 实测响应 59MB），任何情况下都不要调它，连接器也不调；② www.openbd.jp（人类页面）本机实测 http=000 连不上，而 api.openbd.jp 正常 200，所以证据 URL 用实际读到的 API 地址，别拼一个打不开的\"书目页\"当来源。",
    verifiedAt: "2026-10-11",
  },
  gutenberg: {
    label: "Project Gutenberg", access: "anonymous", authority: "official",
    baseUrl: "https://www.gutenberg.org",
    entities: ["ebook（RDF 书目记录）", "search"],
    rateLimit: "官方要求低频访问；本模块同主机 ≥300ms 串行",
    note: "取 /cache/epub/{id}/pg{id}.rdf 这份 RDF 而不是页面 HTML：2026-10-11 实测 ebook 1513 的 HTML 里 RDFa content 属性是交叉错位的——property=\"dcterms:issued\" content=\"2025-09-18\"（其实是最后更新日）而 property=\"dcterms:modified\" content=\"1998-11-01\"（其实是发行日），只有可见文本 itemprop=\"datePublished\" 的「Nov 1, 1998」是对的；同一份 RDF 文件里 dcterms:issued 正确给出 1998-11-01。所以日期一律走 RDF。RDF 给 dcterms:title / issued / rights / language(RFC4646) / subject(LCSH) / hasFormat(各格式文件与 extent) 与 pgterms:agent（name 是倒装形「Shakespeare, William」，另有 birthdate/deathdate/alias/webpage）。检索 GET /ebooks/search/?query=<词> 返回 HTML，其中 class=\"link\" href=\"/ebooks/<id>\" 与紧随的 span.subtitle（作者）成对；结果里混着同名异书与不同译本，必须逐个开 RDF 核对署名后再用。dcterms:rights 实测为「Public domain in the USA.」——只覆盖美国，不能据此断言全球公版。gutendex.com 是第三方镜像（实测 301），连接器不用它。",
    verifiedAt: "2026-10-11",
  },
};

for (const [provider, entry] of Object.entries(PROVIDER_MATRIX)) {
  entry.source_qualification = sourceQualification(provider);
  if (["openlibrary", "myanimelist"].includes(provider)) entry.authority = "community";
  if (provider === "internetarchive") entry.authority = "archive-platform";
  if (provider === "openbd") entry.authority = "bibliographic-aggregator";
  if (provider === "gutenberg") entry.authority = "own-digital-edition-publisher";
  entry.accessObservation = {
    status: entry.access,
    observedAt: entry.verifiedAt,
    scope: "snapshot",
  };
}

export function providerAccess(provider) {
  const entry = PROVIDER_MATRIX[provider];
  if (!entry) throw new ProviderError("bad_input", provider, "未知提供方：" + provider + "（可用：" + Object.keys(PROVIDER_MATRIX).join(", ") + "）");
  return entry;
}

function needCredential(provider, envNames, purpose) {
  for (const name of envNames) {
    const value = process.env[name];
    if (value && String(value).trim()) return String(value).trim();
  }
  throwCredentialMissing(provider, envNames, purpose);
}

function throwCredentialMissing(provider, envNames, purpose) {
  throw new ProviderError("credential_missing", provider,
    purpose + " 需要凭据，但环境变量 " + envNames.join(" 或 ") + " 都没配置",
    {
      retryable: false,
      hint: "申请凭据后写入环境变量 " + envNames[0] + "（不要提交进仓库、不要打进日志）；缺凭据是跳过，不是提供方没有该条目",
    });
}

// ───────────────────────── 1. Discogs ─────────────────────────

/** 接受 2879 / https://www.discogs.com/release/2879-Daft-Punk-Discovery / https://api.discogs.com/releases/2879 */
export function normalizeDiscogsId(input, kind) {
  const kindName = kind || "release";
  const text = String(input == null ? "" : input).trim();
  if (/^\d{1,12}$/.test(text)) return text;
  const m = text.match(new RegExp("discogs\\.com/" + kindName + "(?:s)?/(\\d+)", "i"));
  if (m) return m[1];
  throw new ProviderError("bad_input", "discogs", "无法从 " + text.slice(0, 80) + " 解析 Discogs " + kindName + " id（需要纯数字或 /" + kindName + "/<数字> 链接）");
}

function discogsImages(data) {
  const primary = (data.images || []).find((i) => i.type === "primary") || (data.images || [])[0];
  const url = (primary && (primary.uri || primary.resource_url)) || data.cover_image || data.thumbnail_url || null;
  return { image_url: url, image_page_url: data.uri || null };
}

export function mapDiscogsRelease(data, kind) {
  const kindName = kind || "release";
  requireObject(data, "discogs", kindName);
  if (data.id == null || !String(data.id).trim() || !clean(data.title)) {
    throw new ProviderError("parse", "discogs", kindName + " 响应缺少 id 或 title", { retryable: false });
  }
  const barcode = (data.identifiers || []).find((i) => i.type === "Barcode");
  const label0 = (data.labels || [])[0] || null;
  const artists = (data.artists || []).map((a) => a.name).filter(Boolean);
  const images = discogsImages(data);
  return result("discogs", {
    id: String(data.id == null ? "" : data.id),
    title: clean(data.title),
    titles: { release: clean(data.title), artists: artists.length ? artists : null, artists_sort: clean(data.artists_sort) },
    image_url: images.image_url,
    image_page_url: images.image_page_url,
    dates: {
      year: data.year != null ? String(data.year) : null,
      release: isoDate(data.released),
      released_formatted: clean(data.released_formatted) || clean(data.released),
    },
    external_ids: {
      discogs: String(data.id),
      master: data.master_id != null ? String(data.master_id) : null,
      barcode: barcode ? clean(barcode.value) : null,
      catalog_number: label0 ? clean(label0.catno) : null,
      label: label0 && label0.name ? clean(label0.name) : null,
    },
    url: data.uri || ("https://www.discogs.com/" + kindName + "/" + data.id),
    tracks: (data.tracklist || [])
      .filter((t) => (t.type_ || "track") === "track")
      .map((t) => ({
        position: clean(t.position),
        title: clean(t.title),
        duration: clean(t.duration),
        performers: (t.extraartists || []).map((e) => clean(e.name) + (e.role ? " (" + clean(e.role) + ")" : "")).filter((s) => s.trim()),
      })),
    notes: [
      data.country ? "国=" + clean(data.country) : null,
      (data.formats || []).length ? "形式=" + data.formats.map(clean).join(",") : null,
      data.status ? "状态=" + clean(data.status) : null,
      data.data_quality ? "数据质量=" + clean(data.data_quality) : null,
    ].filter(Boolean).join("；") || null,
    rights_note: "Discogs 图片由社区上传，不等于官方封面图；写入 pictures[] 前须逐条判断来源与授权。",
    raw: data,
  });
}

export async function fetchDiscogsRelease(idOrUrl, opts) {
  const id = normalizeDiscogsId(idOrUrl, "release");
  const url = "https://api.discogs.com/releases/" + id;
  const res = await jsonRequest(url, Object.assign({ provider: "discogs" }, opts));
  if (res.notFound) return readResult(res, "discogs", { found: false, id: id, url: url, raw: res.raw, notes: "Discogs 返回 404（该 release 不存在或已删除）" });
  return attachReadEvidence(mapDiscogsRelease(res.json, "release"), res);
}

export async function fetchDiscogsMaster(idOrUrl, opts) {
  const id = normalizeDiscogsId(idOrUrl, "master");
  const url = "https://api.discogs.com/masters/" + id;
  const res = await jsonRequest(url, Object.assign({ provider: "discogs" }, opts));
  if (res.notFound) return readResult(res, "discogs", { found: false, id: id, url: url, raw: res.raw, notes: "Discogs master 404" });
  const mapped = mapDiscogsRelease(res.json, "master");
  mapped.external_ids = Object.assign({}, mapped.external_ids, { master: id });
  mapped.notes = "master 记录（版本列表在 " + ((res.json && res.json.versions_url) ? res.json.versions_url : "缺") + "）；" + (mapped.notes || "");
  return attachReadEvidence(mapped, res);
}

/** 社区库检索：只返回候选，身份判定留给调用方（同名不同物在 Discogs 极常见）。 */
export async function searchDiscogs(query, opts) {
  const o = opts || {};
  const q = String(query == null ? "" : query).trim();
  if (!q) throw new ProviderError("bad_input", "discogs", "检索词不能为空");
  const params = new URLSearchParams({
    q: q,
    type: o.type || "release",
    per_page: String(Math.min(50, Math.max(1, o.perPage || 5))),
  });
  if (o.year) params.set("year", String(o.year));
  if (o.label) params.set("label", o.label);
  if (o.catno) params.set("catno", o.catno);
  if (o.format) params.set("format", o.format);
  const url = "https://api.discogs.com/database/search?" + params.toString();
  const res = await jsonRequest(url, Object.assign({ provider: "discogs" }, o));
  const records = requireArrayField(res.json, "results", "discogs", "database/search");
  const hits = records.map((r) => requireSearchItem(r, "discogs", "database/search", ["id"], ["title"])).map((r) => ({
    id: String(r.id == null ? "" : r.id),
    type: r.type || null,
    title: clean(r.title),
    year: r.year ? String(r.year) : null,
    country: clean(r.country),
    label: (r.label || []).length ? clean(r.label[0]) : null,
    catalog_number: clean(r.catno),
    barcode: (r.barcode || []).length ? clean(r.barcode[0]) : null,
    formats: Array.isArray(r.formats) ? r.formats.map(clean).filter(Boolean) : null,
    master: r.master_id != null ? String(r.master_id) : null,
    image_url: r.cover_image || r.thumb || null,
    url: r.uri || r.resource_url || null,
  }));
  return readResult(res, "discogs", {
    found: hits.length > 0,
    id: hits[0] ? hits[0].id : null,
    title: hits[0] ? hits[0].title : null,
    image_url: hits[0] ? hits[0].image_url : null,
    dates: hits[0] && hits[0].year ? { year: hits[0].year } : null,
    url: hits[0] ? hits[0].url : null,
    notes: "候选 " + hits.length + " 条（total=" + (res.json && res.json.pagination ? res.json.pagination.items : "?") + "）；题名 + 年份 + 品番三重核对前不得写入",
    raw: { pagination: res.json ? res.json.pagination : null, hits: hits },
  });
}

// ───────────────────────── 2. Open Library ─────────────────────────

/** 接受 OL2665823M / /books/OL2665823M / https://openlibrary.org/books/OL2665823M */
export function normalizeOpenLibraryId(input, kind) {
  const kindName = kind || "book";
  const suffix = ({ book: "M", edition: "M", work: "W", author: "A" })[kindName] || "M";
  const text = String(input == null ? "" : input).trim().toUpperCase();
  const m = text.match(/OL(\d+)/);
  if (!m) throw new ProviderError("bad_input", "openlibrary", "无法解析 OpenLibrary id：" + text.slice(0, 60));
  const id = "OL" + m[1] + suffix;
  if (!/^OL\d+[MWA]$/.test(id)) throw new ProviderError("bad_input", "openlibrary", "OpenLibrary " + kindName + " id 形状非法：" + id);
  return id;
}

export function openLibraryCoverUrl(coverId, size) {
  const id = Number(String(coverId == null ? "" : coverId).replace(/[^0-9]/g, ""));
  if (!id || id <= 0) throw new ProviderError("bad_input", "openlibrary", "封面 id 非法：" + String(coverId));
  const s = String(size || "L").toUpperCase().replace(/[^SML]/g, "") || "L";
  return "https://covers.openlibrary.org/b/id/" + id + "-" + s + ".jpg";
}

function olKeyToId(key) {
  const parts = String(key || "").split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

export function mapOpenLibraryBook(data, kindLabel) {
  requireObject(data, "openlibrary", "edition/work");
  if (!clean(data.key) || !clean(data.title)) {
    throw new ProviderError("parse", "openlibrary", "edition/work 响应缺少 key 或 title", { retryable: false });
  }
  const cover = Array.isArray(data.covers) ? data.covers.find((c) => Number(c) > 0) : null;
  const key = clean(data.key) || "";
  const olid = olKeyToId(key);
  const isbn13 = Array.isArray(data.isbn_13) ? data.isbn_13.map(clean).filter(Boolean) : [];
  const isbn10 = Array.isArray(data.isbn_10) ? data.isbn_10.map(clean).filter(Boolean) : [];
  return result("openlibrary", {
    id: olid,
    title: clean(data.title),
    titles: { title: clean(data.title), subtitle: clean(data.subtitle), alternative_titles: data.alternative_titles || null },
    image_url: cover ? openLibraryCoverUrl(cover, "L") : null,
    image_page_url: key ? "https://openlibrary.org" + key : null,
    dates: {
      publish: clean(data.publish_date),
      first_publish_year: data.first_publish_year != null ? String(data.first_publish_year) : null,
      created: data.created ? data.created.value || null : null,
      modified: data.last_modified ? data.last_modified.value || null : null,
    },
    external_ids: {
      openlibrary: olid,
      isbn: isbn13.concat(isbn10).slice(0, 6),
      lccn: (data.lccn || []).length ? clean((data.lccn || [])[0]) : null,
      oclc: data.oclc ? String(data.oclc) : (data.oclc_number ? String(data.oclc_number) : null),
      viaf: data.remote_ids && data.remote_ids.viaf ? String(data.remote_ids.viaf) : null,
      isni: data.remote_ids && data.remote_ids.isni ? String(data.remote_ids.isni) : null,
      wikidata: data.remote_ids && data.remote_ids.wikidata ? String(data.remote_ids.wikidata) : null,
    },
    url: "https://openlibrary.org" + key,
    notes: [
      kindLabel ? "记录类型=" + kindLabel : null,
      (data.publishers || []).length ? "出版社=" + data.publishers.map(clean).join(",") : null,
      data.number_of_pages != null ? "页数=" + data.number_of_pages : null,
      Array.isArray(data.authors) && data.authors.length ? "作者键=" + data.authors.map((a) => a && a.key).filter(Boolean).join(",") : null,
    ].filter(Boolean).join("；") || null,
    raw: data,
  });
}

export async function lookupOpenLibraryEdition(olidOrUrl, opts) {
  const olid = normalizeOpenLibraryId(olidOrUrl, "book");
  const url = "https://openlibrary.org/books/" + olid + ".json";
  const res = await jsonRequest(url, Object.assign({ provider: "openlibrary" }, opts));
  if (res.notFound) return readResult(res, "openlibrary", { found: false, id: olid, url: url, raw: res.raw, notes: "OpenLibrary edition 404" });
  return attachReadEvidence(mapOpenLibraryBook(res.json, "edition"), res);
}

export async function lookupOpenLibraryWork(olidOrUrl, opts) {
  const olid = normalizeOpenLibraryId(olidOrUrl, "work");
  const url = "https://openlibrary.org/works/" + olid + ".json";
  const res = await jsonRequest(url, Object.assign({ provider: "openlibrary" }, opts));
  if (res.notFound) return readResult(res, "openlibrary", { found: false, id: olid, url: url, raw: res.raw, notes: "OpenLibrary work 404" });
  const data = requireObject(res.json, "openlibrary", "work");
  if (!clean(data.key) || !clean(data.title)) throw new ProviderError("parse", "openlibrary", "work 响应缺少 key 或 title", { retryable: false });
  const cover = Array.isArray(data.covers) ? data.covers.find((c) => Number(c) > 0) : null;
  return readResult(res, "openlibrary", {
    id: olid,
    title: clean(data.title),
    titles: { title: clean(data.title), subtitle: clean(data.subtitle) },
    image_url: cover ? openLibraryCoverUrl(cover, "L") : null,
    dates: { first_publish_year: clean(data.first_publish_date) },
    external_ids: { openlibrary: olid },
    url: "https://openlibrary.org/works/" + olid,
    notes: "subjects=" + (data.subjects || []).slice(0, 5).map(clean).join(",") + (data.edition_count != null ? "；edition_count=" + data.edition_count : ""),
    raw: data,
  });
}

/** author 记录带 remote_ids（viaf / isni / wikidata / lc_naf）—— isni.org 被拦时的合法线索来源之一。 */
export async function lookupOpenLibraryAuthor(olidOrUrl, opts) {
  const olid = normalizeOpenLibraryId(olidOrUrl, "author");
  const url = "https://openlibrary.org/authors/" + olid + ".json";
  const res = await jsonRequest(url, Object.assign({ provider: "openlibrary" }, opts));
  if (res.notFound) return readResult(res, "openlibrary", { found: false, id: olid, url: url, raw: res.raw, notes: "OpenLibrary author 404" });
  const data = requireObject(res.json, "openlibrary", "author");
  if (!clean(data.key) || !(clean(data.name) || clean(data.personal_name))) {
    throw new ProviderError("parse", "openlibrary", "author 响应缺少 key 或 name", { retryable: false });
  }
  const remote = data.remote_ids || {};
  return readResult(res, "openlibrary", {
    id: olid,
    title: clean(data.name) || clean(data.personal_name),
    titles: { name: clean(data.name), personal_name: clean(data.personal_name), alternate_names: data.alternate_names || null },
    dates: {
      birth: clean(data.birth_date), death: clean(data.death_date),
      created: data.created ? data.created.value || null : null,
      modified: data.last_modified ? data.last_modified.value || null : null,
    },
    external_ids: {
      openlibrary: olid,
      viaf: remote.viaf ? String(remote.viaf) : null,
      isni: remote.isni ? String(remote.isni) : null,
      wikidata: remote.wikidata ? String(remote.wikidata) : null,
      lc_naf: remote.lc_naf ? String(remote.lc_naf) : null,
    },
    url: "https://openlibrary.org/authors/" + olid,
    notes: remote.isni
      ? "ISNI / VIAF 是 OpenLibrary 登记的第三方标识，须与 Wikidata P213 / P214 或官方记录二重核对后才可写入"
      : "该 author 未登记 ISNI / VIAF",
    raw: data,
  });
}

/** 列出某个 work 的 editions：找「哪个版本有封面 / 有 ISBN」时用；只读，不改写任何数据。 */
export async function listOpenLibraryEditions(olidOrUrl, opts) {
  const o = opts || {};
  const olid = normalizeOpenLibraryId(olidOrUrl, "work");
  const url = "https://openlibrary.org/works/" + olid + "/editions.json?limit=" + String(Math.min(100, Math.max(1, o.limit || 20)));
  const res = await jsonRequest(url, Object.assign({ provider: "openlibrary" }, o));
  if (res.notFound) return readResult(res, "openlibrary", { found: false, id: olid, url: url, raw: res.raw, notes: "OpenLibrary work 不存在（editions 404）" });
  const rawEntries = requireArrayField(res.json, "entries", "openlibrary", "work editions");
  const entries = rawEntries.map((e) => requireSearchItem(e, "openlibrary", "work editions", ["key"], ["title"])).map((e) => ({
    id: olKeyToId(e.key),
    key: clean(e.key),
    title: clean(e.title),
    subtitle: clean(e.subtitle),
    publish_date: clean(e.publish_date),
    languages: Array.isArray(e.languages) ? e.languages.map((l) => (l && l.key ? String(l.key).split("/").pop() : null)).filter(Boolean) : null,
    cover_id: Array.isArray(e.covers) && e.covers.length ? String(e.covers.find((c) => Number(c) > 0) || e.covers[0]) : null,
    image_url: Array.isArray(e.covers) && e.covers.some((c) => Number(c) > 0) ? openLibraryCoverUrl(e.covers.find((c) => Number(c) > 0), "L") : null,
    isbn_13: Array.isArray(e.isbn_13) ? e.isbn_13.map(clean).filter(Boolean) : null,
    isbn_10: Array.isArray(e.isbn_10) ? e.isbn_10.map(clean).filter(Boolean) : null,
    physical_pages: e.number_of_pages != null ? String(e.number_of_pages) : null,
  }));
  return readResult(res, "openlibrary", {
    found: entries.length > 0,
    id: olid,
    title: entries.length ? entries[0].title : null,
    image_url: (entries.find((e) => e.image_url) || {}).image_url || null,
    url: "https://openlibrary.org/works/" + olid + "/editions",
    notes: "版本 " + entries.length + " 条；有封面 " + entries.filter((e) => e.image_url).length + " 条；取封面须再核版本",
    raw: { entries: entries },
  });
}

/** work 级检索；cover_i 可直接拼封面 URL。 */
export async function searchOpenLibrary(query, opts) {
  const o = opts || {};
  const q = String(query == null ? "" : query).trim();
  if (!q) throw new ProviderError("bad_input", "openlibrary", "检索词不能为空");
  const params = new URLSearchParams({
    q: q,
    limit: String(Math.min(50, Math.max(1, o.limit || 5))),
    fields: o.fields || "key,title,author_name,first_publish_year,cover_i,isbn,publish_date,publisher_name,language",
  });
  const url = "https://openlibrary.org/search.json?" + params.toString();
  const res = await jsonRequest(url, Object.assign({ provider: "openlibrary" }, o));
  const response = requireObject(res.json, "openlibrary", "search");
  const rawDocs = requireArrayField(response, "docs", "openlibrary", "search");
  if (!Number.isInteger(response.numFound) || response.numFound < 0) {
    throw new ProviderError("parse", "openlibrary", "search 响应缺少有效 numFound", { retryable: false });
  }
  const docs = rawDocs.map((d) => requireSearchItem(d, "openlibrary", "search", ["key"], ["title"])).map((d) => ({
    id: olKeyToId(d.key),
    key: clean(d.key),
    title: clean(d.title),
    authors: Array.isArray(d.author_name) ? d.author_name.map(clean).filter(Boolean) : null,
    first_publish_year: d.first_publish_year != null ? String(d.first_publish_year) : null,
    publish_date: Array.isArray(d.publish_date) ? d.publish_date.map(clean).filter(Boolean).slice(0, 3) : clean(d.publish_date),
    cover_id: d.cover_i != null ? String(d.cover_i) : null,
    image_url: d.cover_i != null ? openLibraryCoverUrl(d.cover_i, "L") : null,
    isbn: Array.isArray(d.isbn) ? d.isbn.slice(0, 4) : null,
    languages: Array.isArray(d.language) ? d.language : null,
  }));
  return readResult(res, "openlibrary", {
    found: docs.length > 0,
    id: docs[0] ? docs[0].id : null,
    title: docs[0] ? docs[0].title : null,
    image_url: docs[0] ? docs[0].image_url : null,
    dates: docs[0] && docs[0].first_publish_year ? { first_publish_year: docs[0].first_publish_year } : null,
    url: docs[0] && docs[0].key ? "https://openlibrary.org" + docs[0].key : null,
    notes: "命中 " + docs.length + " 条（numFound=" + (res.json ? res.json.numFound : "?") + "）；结果集含同名与译本，须逐字核题",
    raw: { numFound: res.json ? res.json.numFound : null, docs: docs },
  });
}

/** ISBN 查记录：/isbn/<isbn>.json 已不可用（实测 404 HTML），走 search?q=isbn: 。 */
export async function lookupOpenLibraryByIsbn(isbn, opts) {
  const raw = String(isbn == null ? "" : isbn).trim();
  const cleanIsbn = raw.replace(/[^0-9Xx]/g, "").toUpperCase();
  if (!/^(97[89]\d{10}|\d{9}[\dX])$/.test(cleanIsbn)) {
    throw new ProviderError("bad_input", "openlibrary", "ISBN 形状非法：" + raw.slice(0, 30));
  }
  const url = "https://openlibrary.org/search.json?q=isbn%3A" + cleanIsbn + "&limit=5&fields=key,title,cover_i,publish_date,first_publish_year,isbn";
  const res = await jsonRequest(url, Object.assign({ provider: "openlibrary" }, opts));
  const response = requireObject(res.json, "openlibrary", "ISBN search");
  const docs = requireArrayField(response, "docs", "openlibrary", "ISBN search");
  if (!Number.isInteger(response.numFound) || response.numFound < 0) {
    throw new ProviderError("parse", "openlibrary", "ISBN search 响应缺少有效 numFound", { retryable: false });
  }
  if (!docs.length) {
    return readResult(res, "openlibrary", { found: false, id: null, url: "https://openlibrary.org/isbn/" + cleanIsbn, raw: res.json, notes: "OpenLibrary 无该 ISBN 记录（isbn=" + cleanIsbn + "）" });
  }
  const hit = requireSearchItem(docs[0], "openlibrary", "ISBN search", ["key"], ["title"]);
  return readResult(res, "openlibrary", {
    id: olKeyToId(hit.key),
    title: clean(hit.title),
    image_url: hit.cover_i != null ? openLibraryCoverUrl(hit.cover_i, "L") : null,
    dates: {
      publish: Array.isArray(hit.publish_date) ? clean(hit.publish_date[0]) : clean(hit.publish_date),
      first_publish_year: hit.first_publish_year != null ? String(hit.first_publish_year) : null,
    },
    external_ids: { isbn: [cleanIsbn], openlibrary: olKeyToId(hit.key) },
    url: "https://openlibrary.org" + hit.key,
    notes: "ISBN 命中 " + docs.length + " 条记录，取第一条" + (docs.length > 1 ? "（多版本须人工确认）" : ""),
    raw: { isbn: cleanIsbn, docs: docs },
  });
}

// ───────────────────────── 3. Internet Archive ─────────────────────────

/** 接受 identifier 或 https://archive.org/details/<identifier> 链接。 */
export function normalizeArchiveIdentifier(input) {
  const text = String(input == null ? "" : input).trim();
  const m = text.match(/archive\.org\/(?:details|metadata)\/([^/?#]+)/i);
  const id = m ? m[1] : text;
  if (!/^[A-Za-z0-9][A-Za-z0-9._\-]{1,199}$/.test(id)) {
    throw new ProviderError("bad_input", "internetarchive", "identifier 非法：" + text.slice(0, 60) + "（只允许字母数字与 . _ -，且不能以分隔符开头）");
  }
  return id;
}

export function mapArchiveMetadata(data, identifier) {
  requireObject(data, "internetarchive", "metadata");
  const metadata = data && data.metadata;
  // 关键口径：观测到不存在的 item 返回 HTTP 200 且 body 为 {} 或 metadata:{}。
  if (!Object.keys(data).length || (metadata && typeof metadata === "object" && !Array.isArray(metadata) && !Object.keys(metadata).length)) {
    return result("internetarchive", {
      found: false, id: identifier,
      url: "https://archive.org/details/" + identifier,
      raw: data, notes: "archive.org /metadata 返回空 metadata（HTTP 200 不代表条目存在）",
    });
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new ProviderError("parse", "internetarchive", "metadata 响应缺少对象字段 metadata", { retryable: false });
  }
  if (metadata.identifier == null || !String(metadata.identifier).trim()) {
    throw new ProviderError("parse", "internetarchive", "metadata 记录缺少 identifier", { retryable: false });
  }
  if (String(metadata.identifier) !== String(identifier)) {
    throw new ProviderError("parse", "internetarchive", "metadata identifier 与请求条目标识不一致", { retryable: false });
  }
  const files = Array.isArray(data.files) ? data.files : [];
  const hasImage = files.some((f) => /\.(jpg|jpeg|png)$/i.test(f.name || "") || /(^|\/)(thumb)\.jpg$/i.test(f.name || ""));
  const title = Array.isArray(metadata.title) ? metadata.title[0] : metadata.title;
  const creator = Array.isArray(metadata.creator) ? metadata.creator.map(clean).filter(Boolean)
    : (metadata.creator ? [clean(metadata.creator)] : null);
  const epochDay = (value) => {
    if (value == null || value === "") return null;
    const asNumber = Number(value);
    if (Number.isFinite(asNumber) && asNumber > 0) {
      const d = new Date(asNumber * 1000);
      if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    }
    return isoDate(String(value)) ? String(value).slice(0, 10) : null;
  };
  return result("internetarchive", {
    id: identifier,
    title: clean(title),
    titles: { title: clean(title), creator: creator, description: clean(metadata.description) ? String(clean(metadata.description)).slice(0, 400) : null },
    image_url: hasImage ? "https://archive.org/services/img/" + identifier : null,
    image_page_url: "https://archive.org/details/" + identifier,
    dates: {
      release: isoDate(metadata.date) || clean(metadata.date),
      original_date: isoDate(metadata.originaldate) || clean(metadata.originaldate),
      year: metadata.year != null ? String(metadata.year) : null,
      public_date: epochDay(metadata.publicdate),
      added: epochDay(metadata.addeddate),
      item_last_updated: epochDay(data.item_last_updated),
    },
    external_ids: {
      identifier: identifier,
      mediatype: metadata.mediatype ? String(metadata.mediatype) : null,
      collection: Array.isArray(metadata.collection) ? metadata.collection.map(String) : (metadata.collection ? [String(metadata.collection)] : null),
      uploader: metadata.uploader ? String(metadata.uploader) : null,
      isrc: metadata.isrc ? String(metadata.isrc) : null,
    },
    url: "https://archive.org/details/" + identifier,
    notes: "mediatype=" + (metadata.mediatype || "?") + "；文件数=" + (data.files_count != null ? data.files_count : files.length) + "；上传件=" + (metadata.uploader || "?") + " —— 用户上传件不等于官方来源，只有官方元数据可作证据",
    raw: { metadata: metadata, files: files.slice(0, 40), files_count: data.files_count, item_size: data.item_size, server: data.server, dir: data.dir },
  });
}

export async function fetchArchiveItem(identifier, opts) {
  const id = normalizeArchiveIdentifier(identifier);
  const url = "https://archive.org/metadata/" + encodeURIComponent(id);
  const res = await jsonRequest(url, Object.assign({ provider: "internetarchive" }, opts));
  if (res.notFound) return readResult(res, "internetarchive", { found: false, id: id, url: url, raw: res.raw, notes: "archive.org /metadata 返回 404" });
  return attachReadEvidence(mapArchiveMetadata(res.json, id), res);
}

/** advancedsearch：只用于发现候选，不代替逐字核对。 */
export async function searchArchive(query, opts) {
  const o = opts || {};
  const q = String(query == null ? "" : query).trim();
  if (!q) throw new ProviderError("bad_input", "internetarchive", "检索词不能为空");
  const params = new URLSearchParams();
  params.set("q", q);
  for (const f of String(o.fields || "identifier,title,mediatype,creator,date,year").split(",")) params.append("fl[]", f.trim());
  params.set("rows", String(Math.min(100, Math.max(1, o.rows || 5))));
  params.set("page", String(Math.max(1, o.page || 1)));
  params.set("sort", o.sort || "metadata.titleSort asc");
  params.set("output", "json");
  const url = "https://archive.org/advancedsearch.php?" + params.toString();
  const res = await jsonRequest(url, Object.assign({ provider: "internetarchive" }, o));
  const root = requireObject(res.json, "internetarchive", "advancedsearch");
  const response = requireObject(root.response, "internetarchive", "advancedsearch.response");
  const rawDocs = requireArrayField(response, "docs", "internetarchive", "advancedsearch.response");
  if (!Number.isInteger(response.numFound) || response.numFound < 0) {
    throw new ProviderError("parse", "internetarchive", "advancedsearch.response 缺少有效 numFound", { retryable: false });
  }
  const docs = rawDocs.map((d) => {
    const doc = requireObject(d, "internetarchive", "advancedsearch 候选项");
    if (doc.identifier == null || !String(doc.identifier).trim()) {
      throw new ProviderError("parse", "internetarchive", "advancedsearch 候选项缺少 identifier", { retryable: false });
    }
    return {
    identifier: d.identifier ? String(d.identifier) : null,
    title: Array.isArray(d.title) ? clean(d.title[0]) : clean(d.title),
    mediatype: d.mediatype ? String(Array.isArray(d.mediatype) ? d.mediatype[0] : d.mediatype) : null,
    creator: d.creator ? (Array.isArray(d.creator) ? d.creator.map(clean).filter(Boolean) : [clean(d.creator)]) : null,
    date: clean(d.date),
    url: "https://archive.org/details/" + d.identifier,
    };
  });
  return readResult(res, "internetarchive", {
    found: docs.length > 0,
    id: docs[0] ? docs[0].identifier : null,
    title: docs[0] ? docs[0].title : null,
    url: docs[0] ? docs[0].url : null,
    dates: docs[0] && docs[0].date ? { release: isoDate(docs[0].date) || docs[0].date } : null,
    notes: "命中 " + (response.numFound != null ? response.numFound : "?") + " 条，本页 " + docs.length + " 条",
    raw: { numFound: response.numFound, docs: docs },
  });
}

/** Wayback 可用性：用于 VGMdb 这类被反爬拦但确有存档的站。 */
export async function waybackSnapshot(archivedUrl, opts) {
  const o = opts || {};
  const target = String(archivedUrl == null ? "" : archivedUrl).trim();
  if (!/^https?:\/\//i.test(target)) throw new ProviderError("bad_input", "internetarchive", "需要完整 URL：" + target.slice(0, 80));
  const params = new URLSearchParams({ url: target });
  if (o.timestamp) params.set("timestamp", String(o.timestamp));
  const res = await jsonRequest("https://archive.org/wayback/available?" + params.toString(), Object.assign({ provider: "internetarchive" }, o));
  const root = requireObject(res.json, "internetarchive", "Wayback availability");
  const snapshots = requireObject(root.archived_snapshots, "internetarchive", "Wayback archived_snapshots");
  const snap = snapshots.closest || null;
  if (snap != null) requireObject(snap, "internetarchive", "Wayback closest snapshot");
  if (snap && (typeof snap.available !== "boolean" || snap.status == null || !snap.url)) {
    throw new ProviderError("parse", "internetarchive", "Wayback closest snapshot 缺少 available/status/url", { retryable: false });
  }
  const usable = Boolean(snap && snap.available && String(snap.status) === "200");
  return readResult(res, "internetarchive", {
    found: usable,
    id: null,
    title: null,
    url: usable ? snap.url : null,
    snapshot_url: usable ? snap.url : null,
    dates: snap && snap.timestamp ? { snapshot: clean(snap.timestamp) } : null,
    notes: usable ? "最近存档 " + snap.timestamp + "（status=" + snap.status + "）" : "该 URL 没有 status=200 的可用存档",
    raw: res.json,
  });
}

// ───────────────────────── 4. TMDB（需 key，缺 key 时优雅降级） ─────────────────────────

export function tmdbCredential(options) {
  const o = options || {};
  const explicit = Object.prototype.hasOwnProperty.call(o, "apiKey") || Object.prototype.hasOwnProperty.call(o, "accessToken");
  const v3 = String(explicit ? (o.apiKey || "") : (process.env.TMDB_API_KEY || "")).trim();
  const v4 = String(explicit ? (o.accessToken || "") : (process.env.TMDB_ACCESS_TOKEN || "")).trim();
  return { v3: v3 || null, v4: v4 || null };
}

export function tmdbImageUrl(posterPath, size) {
  const p = String(posterPath == null ? "" : posterPath).trim();
  if (!p) return null;
  if (!p.startsWith("/")) throw new ProviderError("bad_input", "tmdb", "TMDB path 应以 / 开头：" + p.slice(0, 40));
  return "https://image.tmdb.org/t/p/" + (size || "w500") + p;
}

export function mapTmdbMedia(data, type) {
  requireObject(data, "tmdb", "media");
  const kindName = type || "movie";
  const isPerson = kindName === "person";
  const title = isPerson ? clean(data.name) : (clean(data.title) || clean(data.name));
  if (data.id == null || !String(data.id).trim() || !title) {
    throw new ProviderError("parse", "tmdb", "media 响应缺少 id 或 title/name", { retryable: false });
  }
  const path = isPerson ? data.profile_path : (data.poster_path || data.backdrop_path);
  return result("tmdb", {
    id: String(data.id == null ? "" : data.id),
    title: title,
    titles: {
      title: title,
      original: isPerson ? null : clean(data.original_title || data.original_name),
      alternatives: isPerson ? null : (data.alternative_titles || null),
    },
    image_url: tmdbImageUrl(path, "w500"),
    image_page_url: data.homepage ? clean(data.homepage) : null,
    dates: {
      release: isPerson ? null : isoDate(data.release_date || data.first_air_date),
      birth: isPerson ? isoDate(data.birthday) : null,
      death: isPerson ? isoDate(data.deathday) : null,
    },
    external_ids: {
      tmdb: String(data.id),
      imdb: data.imdb_id ? String(data.imdb_id) : null,
      homepage: data.homepage ? String(data.homepage) : null,
    },
    url: "https://www.themoviedb.org/" + (isPerson ? "person" : kindName) + "/" + data.id,
    notes: [
      isPerson ? null : "原语=" + (data.original_language || "?"),
      data.runtime ? "时长=" + data.runtime + "min" : null,
      !isPerson && data.number_of_episodes != null ? "集数=" + data.number_of_episodes : null,
      clean(data.tagline) ? "tagline=" + clean(data.tagline) : null,
    ].filter(Boolean).join("；") || null,
    rights_note: "TMDB 素材按其条款使用（须署名 TMDB）；站内图片应取版权方官方页，TMDB 图只作线索。",
    raw: data,
  });
}

function tmdbRequestConfig(providerOpts) {
  const o = providerOpts || {};
  const { v3, v4 } = tmdbCredential(o);
  if (!v3 && !v4) {
    const envNames = ["TMDB_API_KEY", "TMDB_ACCESS_TOKEN"];
    const purpose = o.purpose || "TMDB 读取";
    if (Object.prototype.hasOwnProperty.call(o, "apiKey") || Object.prototype.hasOwnProperty.call(o, "accessToken")) {
      throwCredentialMissing("tmdb", envNames, purpose);
    }
    needCredential("tmdb", envNames, purpose);
  }
  const params = new URLSearchParams(o.params || {});
  if (v3) params.set("api_key", v3);
  const headers = v4 ? { Authorization: "Bearer " + v4 } : undefined;
  return { params: params, headers: headers };
}

function tmdbCredentialOverrides(options) {
  const source = options || {};
  const overrides: Record<string, any> = {};
  for (const key of ["apiKey", "accessToken"]) {
    if (Object.prototype.hasOwnProperty.call(source, key)) overrides[key] = source[key];
  }
  return overrides;
}

/** TMDB 读取：无凭据时抛 credential_missing，调用方应记「跳过（缺凭据）」而不是「无数据」。 */
export async function fetchTmdbMedia(id, opts) {
  const o = opts || {};
  const type = o.type || "movie";
  if (!["movie", "tv", "person"].includes(type)) throw new ProviderError("bad_input", "tmdb", "type 只能是 movie / tv / person，收到 " + type);
  const normId = String(id == null ? "" : id).trim();
  if (!/^\d{1,12}$/.test(normId)) throw new ProviderError("bad_input", "tmdb", "TMDB id 需为数字：" + normId.slice(0, 40));
  const cfg = tmdbRequestConfig(Object.assign({
    purpose: "TMDB " + type + "/" + normId + " 读取",
    params: Object.assign({ language: o.language || "ja-JP" }, o.appendToResponse ? { append_to_response: o.appendToResponse } : {}),
  }, tmdbCredentialOverrides(o)));
  const url = "https://api.themoviedb.org/3/" + type + "/" + normId + "?" + cfg.params.toString();
  const res = await jsonRequest(url, Object.assign({ provider: "tmdb", headers: cfg.headers, credentialHint: "在环境变量 TMDB_API_KEY（v3）或 TMDB_ACCESS_TOKEN（v4）里配置" }, o));
  if (res.notFound) {
    return readResult(res, "tmdb", { found: false, id: normId, url: "https://www.themoviedb.org/" + type + "/" + normId, raw: res.raw, notes: "TMDB " + type + " " + normId + " 不存在（404）" });
  }
  return attachReadEvidence(mapTmdbMedia(res.json, type), res);
}

export async function searchTmdb(query, opts) {
  const o = opts || {};
  const q = String(query == null ? "" : query).trim();
  if (!q) throw new ProviderError("bad_input", "tmdb", "检索词不能为空");
  const type = o.type || "movie";
  if (!["movie", "tv", "person", "multi"].includes(type)) throw new ProviderError("bad_input", "tmdb", "type 非法：" + type);
  const base: Record<string, string> = { query: q, include_adult: String(Boolean(o.includeAdult)), language: o.language || "ja-JP" };
  if (o.year) base.year = String(o.year);
  if (o.firstAirDateYear) base.first_air_date_year = String(o.firstAirDateYear);
  const cfg = tmdbRequestConfig(Object.assign({ purpose: "TMDB " + type + " 检索", params: base }, tmdbCredentialOverrides(o)));
  const url = "https://api.themoviedb.org/3/search/" + type + "?" + cfg.params.toString();
  const res = await jsonRequest(url, Object.assign({ provider: "tmdb", headers: cfg.headers, credentialHint: "配置 TMDB_API_KEY 或 TMDB_ACCESS_TOKEN" }, o));
  const root = requireObject(res.json, "tmdb", "search");
  const rawHits = requireArrayField(root, "results", "tmdb", "search");
  if (!Number.isInteger(root.total_results) || root.total_results < 0) {
    throw new ProviderError("parse", "tmdb", "search 响应缺少有效 total_results", { retryable: false });
  }
  const hits = rawHits.map((r) => requireSearchItem(r, "tmdb", "search", ["id"], ["title", "name"]))
    .slice(0, Math.max(1, o.limit || 5)).map((r) => ({
    id: String(r.id),
    media_type: r.media_type || type,
    title: clean(r.title || r.name),
    original: clean(r.original_title || r.original_name),
    image_url: tmdbImageUrl(r.poster_path || r.profile_path, "w342"),
    dates: { release: isoDate(r.release_date || r.first_air_date) },
    url: "https://www.themoviedb.org/" + (r.media_type || type) + "/" + r.id,
  }));
  return readResult(res, "tmdb", {
    found: hits.length > 0,
    id: hits[0] ? hits[0].id : null,
    title: hits[0] ? hits[0].title : null,
    image_url: hits[0] ? hits[0].image_url : null,
    dates: hits[0] ? hits[0].dates : null,
    url: hits[0] ? hits[0].url : null,
    notes: "候选 " + hits.length + " 条（page=" + (res.json ? res.json.page : "?") + "/" + (res.json ? res.json.total_pages : "?") + "，total=" + (res.json ? res.json.total_results : "?") + "）",
    raw: { page: res.json ? res.json.page : null, total_results: res.json ? res.json.total_results : null, hits: hits },
  });
}

// ───────────────────────── 5. AniList（公开 GraphQL） ─────────────────────────

const ANILIST_MEDIA_QUERY = "query($id:Int,$type:MediaType){Media(id:$id,type:$type){id type title{romaji english native} genres coverImage{large medium color} bannerImage startDate{year month day} endDate{year month day} synonyms episodes format status season description siteUrl studios{edges{node{name}}}}}";
const ANILIST_SEARCH_QUERY = "query($s:String!,$p:Int,$l:Int,$type:MediaType){Page(page:$p,perPage:$l){pageInfo{total perPage hasNextPage} media(search:$s,type:$type){id type title{romaji english native} genres coverImage{large} startDate{year month day} format status season siteUrl}}}";

/** 接受数字 ID 或 AniList 页面 URL；URL 中的媒介类型优先。 */
export function normalizeAniListId(input, defaultType) {
  const text = String(input == null ? "" : input).trim();
  const m = text.match(/anilist\.co\/(anime|manga)\/(\d+)/i);
  if (m) return { id: Number(m[2]), type: m[1].toUpperCase() };
  if (/^\d{1,12}$/.test(text)) return { id: Number(text), type: (defaultType || "ANIME").toUpperCase() };
  throw new ProviderError("bad_input", "anilist", "无法解析 AniList id：" + text.slice(0, 60));
}

function formatDatePart(d) {
  if (!d || d.year == null) return null;
  const y = String(d.year).padStart(4, "0");
  if (d.month == null) return y;
  const mo = String(d.month).padStart(2, "0");
  if (d.day == null) return y + "-" + mo;
  return y + "-" + mo + "-" + String(d.day).padStart(2, "0");
}

/** GraphQL 层的错误也要区分「条目不存在」与「服务异常」。 */
function anilistGuard(res, idLabel?: string) {
  const root = requireObject(res.json, "anilist", "GraphQL");
  if (Object.prototype.hasOwnProperty.call(root, "errors") && !Array.isArray(root.errors)) {
    throw new ProviderError("parse", "anilist", "GraphQL errors 字段不是数组", { status: res.status, retryable: false });
  }
  const errors = root.errors;
  if (!errors || !errors.length) return;
  const first = requireObject(errors[0], "anilist", "GraphQL errors[0]");
  if (!clean(first.message)) throw new ProviderError("parse", "anilist", "GraphQL error 缺少 message", { status: res.status, retryable: false });
  const message = String(first.message || "");
  if (res.status === 404 || /Not Found/i.test(message)) return; // 交由调用方按 data:null 判 found:false
  throw new ProviderError(first.status === 429 ? "rate_limited" : "parse", "anilist",
    "GraphQL 错误（" + message.slice(0, 160) + "）" + (idLabel || ""),
    { status: res.status, retryable: first.status === 429 || (first.status >= 500) });
}

export function mapAniListMedia(data) {
  requireObject(data, "anilist", "Media");
  if (data.id == null || !String(data.id).trim() || !(clean(data.title && data.title.romaji) || clean(data.title && data.title.english) || clean(data.title && data.title.native))) {
    throw new ProviderError("parse", "anilist", "Media 响应缺少 id 或可用题名", { retryable: false });
  }
  return result("anilist", {
    id: String(data.id),
    title: clean(data.title && data.title.romaji) || clean(data.title && data.title.english) || clean(data.title && data.title.native),
    titles: {
      romaji: clean(data.title && data.title.romaji),
      english: clean(data.title && data.title.english),
      native: clean(data.title && data.title.native),
      synonyms: data.synonyms || null,
    },
    image_url: (data.coverImage && (data.coverImage.large || data.coverImage.medium)) || null,
    image_page_url: data.bannerImage || null,
    dates: { start: formatDatePart(data.startDate), end: formatDatePart(data.endDate), season: clean(data.season) },
    external_ids: { anilist: String(data.id) },
    genres: data.genres || null,
    url: data.siteUrl || ("https://anilist.co/" + (data.type === "MANGA" ? "manga/" : "anime/") + data.id),
    notes: [
      data.format ? "形式=" + clean(data.format) : null,
      data.status ? "状态=" + clean(data.status) : null,
      data.episodes != null ? "集数=" + data.episodes : null,
      data.studios && data.studios.edges && data.studios.edges.length ? "制作=" + data.studios.edges.map((e) => clean(e.node && e.node.name)).filter(Boolean).join(",") : null,
    ].filter(Boolean).join("；") || null,
    rights_note: "AniList 封面为社区 / CMS 抓取图；站内图片应取版权方官方页，AniList 值只作核对线索。",
    raw: data,
  });
}

async function anilistGql(query, variables, opts) {
  const o = opts || {};
  return jsonRequest("https://graphql.anilist.co", Object.assign({
    provider: "anilist",
    method: "POST",
    accept: "application/json",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: query, variables: variables }),
    archiveHint: "AniList 公开可用；持续 429 时降到 30 req/min 以下再重试",
  }, o));
}

export async function fetchAniListMedia(idOrUrl, opts) {
  const o = opts || {};
  const parsed = (idOrUrl && typeof idOrUrl === "object" && idOrUrl.id)
    ? { id: Number(idOrUrl.id), type: String(idOrUrl.type || o.type || "ANIME").toUpperCase() }
    : normalizeAniListId(idOrUrl, o.type);
  const type = parsed.type;
  const res = await anilistGql(ANILIST_MEDIA_QUERY, { id: parsed.id, type: type }, o);
  const pageUrl = "https://anilist.co/" + type.toLowerCase() + "/" + parsed.id;
  if (res.notFound) {
    return readResult(res, "anilist", { found: false, id: String(parsed.id), url: pageUrl, raw: res.raw, notes: "AniList " + type + " " + parsed.id + " 不存在（404 Not Found）" });
  }
  anilistGuard(res, "（id=" + parsed.id + "）");
  const root = requireObject(res.json, "anilist", "GraphQL");
  const data = requireObject(root.data, "anilist", "GraphQL data");
  if (!Object.prototype.hasOwnProperty.call(data, "Media")) {
    throw new ProviderError("parse", "anilist", "GraphQL data 缺少 Media 字段", { status: res.status, retryable: false });
  }
  const media = data.Media;
  if (!media) {
    return readResult(res, "anilist", { found: false, id: String(parsed.id), url: pageUrl, raw: res.json, notes: "AniList 返回 data.Media=null（该 id 在 type=" + type + " 下无条目；先换 type 复查，再判无此线索）" });
  }
  requireObject(media, "anilist", "GraphQL data.Media");
  return attachReadEvidence(mapAniListMedia(media), res);
}

export async function searchAniList(query, opts) {
  const o = opts || {};
  const s = String(query == null ? "" : query).trim();
  if (!s) throw new ProviderError("bad_input", "anilist", "检索词不能为空");
  const res = await anilistGql(ANILIST_SEARCH_QUERY, {
    s: s, p: Math.max(1, o.page || 1), l: Math.min(50, Math.max(1, o.perPage || 5)), type: (o.type || "ANIME").toUpperCase(),
  }, o);
  anilistGuard(res);
  const root = requireObject(res.json, "anilist", "GraphQL");
  const data = requireObject(root.data, "anilist", "GraphQL data");
  const page = requireObject(data.Page, "anilist", "GraphQL data.Page");
  const pageInfo = requireObject(page.pageInfo, "anilist", "GraphQL Page.pageInfo");
  if (!Number.isInteger(pageInfo.total) || pageInfo.total < 0) {
    throw new ProviderError("parse", "anilist", "GraphQL Page.pageInfo 缺少有效 total", { status: res.status, retryable: false });
  }
  const media = requireArrayField(page, "media", "anilist", "GraphQL Page");
  const hits = media.map((m) => requireSearchItem(m, "anilist", "GraphQL search", ["id"], ["title"]))
    .map((m) => ({
    id: String(m.id),
    title: clean(m.title && m.title.romaji) || clean(m.title && m.title.native),
    native: clean(m.title && m.title.native),
    image_url: (m.coverImage && m.coverImage.large) || null,
    dates: { start: formatDatePart(m.startDate), season: clean(m.season) },
    genres: m.genres || null,
    format: clean(m.format), status: clean(m.status), url: m.siteUrl || null,
  }));
  return readResult(res, "anilist", {
    found: hits.length > 0,
    id: hits[0] ? hits[0].id : null,
    title: hits[0] ? hits[0].title : null,
    image_url: hits[0] ? hits[0].image_url : null,
    dates: hits[0] ? hits[0].dates : null,
    url: hits[0] ? hits[0].url : null,
    notes: "候选 " + hits.length + " 条（total=" + (page && page.pageInfo ? page.pageInfo.total : "?") + "）；AniList 罗马字与别名混用，须与官方页核对",
    raw: { pageInfo: page ? page.pageInfo : null, hits: hits },
  });
}

// ───────────────────────── 6. MyAnimeList（需 client id） ─────────────────────────

export function normalizeMalId(input, type) {
  const text = String(input == null ? "" : input).trim();
  const m = text.match(/myanimelist\.net\/(anime|manga)\/(\d+)/i);
  if (m) return { id: m[2], type: m[1] };
  if (/^\d{1,12}$/.test(text)) return { id: text, type: type || "anime" };
  throw new ProviderError("bad_input", "myanimelist", "无法解析 MAL id：" + text.slice(0, 60));
}

const MAL_FIELDS = "id,title,main_picture,alternative_titles,start_date,end_date,media_type,status,rank,popularity,num_episodes,mean,genres,synopsis";

function malClientId(options, purpose) {
  const o = options || {};
  if (Object.prototype.hasOwnProperty.call(o, "clientId")) {
    const value = String(o.clientId || "").trim();
    if (value) return value;
    throwCredentialMissing("myanimelist", ["MAL_CLIENT_ID"], purpose);
  }
  return needCredential("myanimelist", ["MAL_CLIENT_ID"], purpose);
}

export function mapMalAnime(data) {
  requireObject(data, "myanimelist", "anime/manga");
  if (data.id == null || !String(data.id).trim() || !clean(data.title)) {
    throw new ProviderError("parse", "myanimelist", "anime/manga 响应缺少 id 或 title", { retryable: false });
  }
  return result("myanimelist", {
    id: String(data.id),
    title: clean(data.title),
    titles: {
      title: clean(data.title),
      english: clean(data.alternative_titles && data.alternative_titles.english),
      ja: clean(data.alternative_titles && data.alternative_titles.ja),
    },
    image_url: (data.main_picture && (data.main_picture.large || data.main_picture.medium)) || null,
    dates: { start: isoDate(data.start_date) || clean(data.start_date), end: isoDate(data.end_date) || clean(data.end_date) },
    external_ids: { myanimelist: String(data.id) },
    url: "https://myanimelist.net/anime/" + data.id,
    notes: [
      data.media_type ? "媒体=" + clean(data.media_type) : null,
      data.status ? "状态=" + clean(data.status) : null,
      data.num_episodes != null ? "集数=" + data.num_episodes : null,
    ].filter(Boolean).join("；") || null,
    rights_note: "MAL 图片也是第三方转载；封面应以版权方官方页为准。",
    raw: data,
  });
}

/** 匿名访问 api.myanimelist.net 实测 403 forbidden：必须有 OAuth client id。 */
export async function fetchMyAnimeList(idOrUrl, opts) {
  const o = opts || {};
  const parsed = normalizeMalId(idOrUrl, o.type);
  const clientId = malClientId(o, "MyAnimeList " + parsed.type + "/" + parsed.id + " 读取");
  const url = "https://api.myanimelist.net/v2/" + parsed.type + "/" + parsed.id + "?fields=" + (o.fields || MAL_FIELDS);
  const res = await jsonRequest(url, Object.assign({ provider: "myanimelist", headers: { "X-MAL-CLIENT-ID": clientId } }, o));
  if (res.notFound) {
    return readResult(res, "myanimelist", { found: false, id: parsed.id, url: "https://myanimelist.net/" + parsed.type + "/" + parsed.id, raw: res.raw, notes: "MyAnimeList " + parsed.type + " " + parsed.id + " 不存在（404）" });
  }
  return attachReadEvidence(mapMalAnime(res.json), res);
}

export async function searchMyAnimeList(query, opts) {
  const o = opts || {};
  const q = String(query == null ? "" : query).trim();
  if (!q) throw new ProviderError("bad_input", "myanimelist", "检索词不能为空");
  const clientId = malClientId(o, "MyAnimeList 检索");
  const type = o.type || "anime";
  const params = new URLSearchParams({
    q: q,
    limit: String(Math.min(100, Math.max(1, o.limit || 5))),
    fields: o.fields || ("id,title,main_picture,alternative_titles,start_date,end_date,media_type,num_episodes,mean"),
  });
  const res = await jsonRequest("https://api.myanimelist.net/v2/" + type + "?" + params.toString(),
    Object.assign({ provider: "myanimelist", headers: { "X-MAL-CLIENT-ID": clientId } }, o));
  const data = requireArrayField(res.json, "data", "myanimelist", "search");
  const hits = data.map((n) => {
    const row = requireObject(n, "myanimelist", "search 候选项");
    const node = requireSearchItem(row.node, "myanimelist", "search", ["id"], ["title"]);
    return {
    id: String(node.id),
    title: clean(node.title),
    image_url: (node.main_picture && (node.main_picture.large || node.main_picture.medium)) || null,
    dates: { start: isoDate(node.start_date) || clean(node.start_date) },
    media_type: clean(node.media_type),
    url: "https://myanimelist.net/" + type + "/" + node.id,
    };
  });
  return readResult(res, "myanimelist", {
    found: hits.length > 0,
    id: hits[0] ? hits[0].id : null,
    title: hits[0] ? hits[0].title : null,
    image_url: hits[0] ? hits[0].image_url : null,
    dates: hits[0] ? hits[0].dates : null,
    url: hits[0] ? hits[0].url : null,
    notes: "候选 " + hits.length + " 条",
    raw: { hits: hits },
  });
}

// ───────────────────────── 7. ISNI / VIAF / OCLC ─────────────────────────

/** ISNI：16 位数字含 ISO 7064 MOD 11-2 校验位（可为 X）。接受带空格、连字符与 ISNI 包装。 */
export function normalizeIsni(input) {
  const raw = String(input == null ? "" : input).trim();
  const unwrapped = raw.match(/<ISNI[^>]*>([^<]+)<\/ISNI>/i) ? raw.match(/<ISNI[^>]*>([^<]+)<\/ISNI>/i)[1] : raw;
  const digits = String(unwrapped).replace(/[\s\-]/g, "").toUpperCase();
  if (!/^(\d{15}[0-9X])$/.test(digits)) {
    throw new ProviderError("bad_input", "isni", "ISNI 形状非法：" + raw.slice(0, 40) + "（应为 16 位，最后可含校验位 X）");
  }
  return digits;
}

/** 校验位检查：错一位的 ISNI 会把外链指向别人，必须在联网前先本地拦下。 */
export function isValidIsni(input) {
  let value;
  try { value = normalizeIsni(input); } catch { return false; }
  let total = 0;
  for (const ch of value.slice(0, 15)) total = ((total + Number(ch)) * 2) % 11;
  const check = (12 - total) % 11;
  return value[15] === (check === 10 ? "X" : String(check));
}

/** 从 Wikidata EntityData JSON 取 ISNI(P213) / VIAF(P214) —— isni.org 被拦时的官方登记路径。 */
export function isniFromWikidataClaims(entityData, qid) {
  const entities = entityData && entityData.entities ? entityData.entities : null;
  const entity = entities ? entities[qid || Object.keys(entities)[0]] : entityData;
  if (!entity) throw new ProviderError("bad_input", "isni", "缺少 Wikidata entity（传 Special:EntityData/Qxxx.json 解析后的对象）");
  const claimValues = (pid) => {
    const seen = [];
    for (const c of (entity.claims && entity.claims[pid] ? entity.claims[pid] : [])) {
      const v = c && c.mainsnak && c.mainsnak.datavalue ? c.mainsnak.datavalue.value : null;
      if (typeof v !== "string" || !v.trim()) continue;
      const value = v.trim();
      if (!seen.includes(value)) seen.push(value);
    }
    return seen;
  };
  const isni = claimValues("P213");
  const viaf = claimValues("P214");
  return {
    qid: entity.id || qid || null,
    isni: isni.length ? isni.map(normalizeIsni) : [],
    viaf: Array.from(new Set(viaf.map((v) => v.replace(/^https?:\/\/viaf\.org\/viaf\//i, "").replace(/[\s\-]/g, "")).filter((v) => /^\d+$/.test(v)))),
    note: "取自 Wikidata 声明；维基值须经官方页二重核对后才可作为写入证据",
  };
}

/** ISNI 登记机构读取：访问状态按当次 HTTP 响应分类；只有匹配到 RDF 记录结构后才返回 found。 */
export async function fetchIsniRecord(isni, opts) {
  const value = normalizeIsni(isni);
  const url = "https://isni.org/isni/" + value;
  const res = await httpRequest(url, Object.assign({
      provider: "isni", accept: "application/rdf+xml",
      archiveHint: "isni.org 被反爬拦：ISNI / VIAF 改从 Wikidata P213 / P214 取（mf-fetch-authoritative 的 fetchWikidataEntity），或用 isniFromWikidataClaims 抽取；OpenLibrary author.remote_ids 只作线索",
    }, opts));
  if (res.notFound) {
    return readResult(res, "isni", { found: false, id: value, url: url, raw: res.text.slice(0, 4000), notes: "ISNI 登记机构明确返回 HTTP " + res.status });
  }
  if (looksLikeBotChallenge(res.text)) {
    throw new ProviderError("blocked", "isni", "HTTP " + res.status + " 返回反爬挑战页，不是 ISNI 记录", {
      status: res.status, url: url, retryable: false,
      hint: "改从 Wikidata P213 / P214 取线索，或用 OpenLibrary author.remote_ids 二重核对",
    });
  }
  if (/html/i.test(res.contentType) || /<!doctype\s+html|<html\b/i.test(res.text)) {
    throw new ProviderError("parse", "isni", "ISNI 端点返回 HTML 页面而不是 RDF/XML 记录", {
      status: res.status, url: url, retryable: false,
    });
  }
  if (!/<(?:[\w.-]+:)?RDF\b/i.test(res.text) || !/<\/(?:[\w.-]+:)?RDF\s*>/i.test(res.text)) {
    throw new ProviderError("parse", "isni", "ISNI 响应缺少 RDF 根元素", { status: res.status, url: url, retryable: false });
  }
  const descriptionRe = /<((?:[\w.-]+:)?Description)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
  let description;
  let recordBody = null;
  while ((description = descriptionRe.exec(res.text))) {
    const about = description[2].match(/(?:^|\s)(?:[\w.-]+:)?about\s*=\s*(["'])(.*?)\1/i);
    if (!about) continue;
    const match = about[2].match(/^https?:\/\/isni\.org\/isni\/(\d{16})\/?$/i);
    if (match && match[1] === value) {
      recordBody = description[3];
      break;
    }
  }
  if (recordBody == null) {
    throw new ProviderError("parse", "isni", "RDF/XML 未包含与请求 ISNI 匹配的记录标识", { status: res.status, url: url, retryable: false });
  }
  const labelMatch = recordBody.match(/<((?:[\w.-]+:)?label)\b[^>]*>([\s\S]*?)<\/\1\s*>/i);
  const label = labelMatch ? clean(labelMatch[2]) : null;
  if (!label) {
    throw new ProviderError("parse", "isni", "记录缺少有效 label", { status: res.status, url: url, retryable: false });
  }
  return readResult(res, "isni", {
    id: value,
    title: label,
    external_ids: { isni: value },
    url: url,
    notes: "content-type=" + (res.contentType || "?") + "；ISNI 记录本体",
    raw: res.text.slice(0, 4000),
  });
}

/** VIAF 记录：只解析带匹配 viafID 和 mainHeadings.data 的 JSON 记录；网关错误不作 not-found。 */
export async function fetchViafRecord(viafId, opts) {
  const id = String(viafId == null ? "" : viafId).trim().replace(/^https?:\/\/viaf\.org\/viaf\//i, "").replace(/[^\d]/g, "");
  if (!id) throw new ProviderError("bad_input", "viaf", "VIAF id 非法：" + String(viafId).slice(0, 40));
  const url = "https://viaf.org/viaf/" + id;
  let res;
  try {
    res = await jsonRequest(url, Object.assign({ provider: "viaf", accept: "application/json", attempts: 1 }, opts));
  } catch (err) {
    if (err instanceof ProviderError && (err.kind === "unavailable" || err.kind === "blocked")) {
      throw new ProviderError("unavailable", "viaf",
        "VIAF 记录端点当前返回网关或访问拦截响应，不能据此判定记录不存在",
        { status: err.status, url: url, retryable: err.retryable, hint: "改用 NDL exactMatch、OpenLibrary author.remote_ids.viaf 或 Wikidata P214 作线索；访问状态见 providerAccess 快照" });
    }
    throw err;
  }
  if (res.notFound) {
    return readResult(res, "viaf", { found: false, id: id, url: url, raw: res.raw, notes: "VIAF 明确返回 HTTP " + res.status });
  }
  const record = requireObject(res.json, "viaf", "record");
  if (String(record.viafID == null ? "" : record.viafID) !== id || !record.mainHeadings || !Array.isArray(record.mainHeadings.data)) {
    throw new ProviderError("parse", "viaf", "JSON 响应不符合 VIAF record 形状（需匹配 viafID 与 mainHeadings.data 数组）", {
      status: res.status, url: url, retryable: false,
    });
  }
  const heading = record.mainHeadings.data
    .map((item) => item && typeof item === "object" && !Array.isArray(item) ? clean(item.text) : null)
    .find(Boolean);
  if (!heading) {
    throw new ProviderError("parse", "viaf", "VIAF record 缺少有效 main heading", { status: res.status, url: url, retryable: false });
  }
  return readResult(res, "viaf", {
    id: id,
    title: heading,
    external_ids: { viaf: id },
    url: url,
    notes: "VIAF 主标题；仍需与其他权威记录交叉核对",
    raw: record,
  });
}

/** OCLC：WorldCat Read / Search API 需 client_id + WSKey；FAST 端点当前返回 Status: 4xx。 */
export async function fetchOclcFastHeading(query, opts) {
  const o = opts || {};
  const q = String(query == null ? "" : query).trim();
  if (!q) throw new ProviderError("bad_input", "oclc", "检索词不能为空");
  const params = new URLSearchParams({
    query: q, queryIndex: o.queryIndex || "fastrname", queryReturn: o.queryReturn || "fastrname,idroot",
    database: "fast", suggest: o.suggest || "auto", maxRecords: String(Math.min(20, o.maxRecords || 5)),
  });
  let bodyText;
  let bodyUrl = "https://fast.oclc.org/searchfast/fastsuggest";
  try {
    const res = await httpRequest("https://fast.oclc.org/searchfast/fastsuggest?" + params.toString(), Object.assign({ provider: "oclc" }, o));
    bodyText = res.text;
    bodyUrl = res.url || bodyUrl;
  } catch (err) {
    // 通用网关检测会先把 "Status: 4xx Reason" 归为 unavailable；这里换成指向 FAST 的说明。
    if (err instanceof ProviderError && err.kind === "unavailable") {
      throw new ProviderError("unavailable", "oclc",
        "FAST 端点返回网关错误体（fast.oclc.org/searchfast/fastsuggest 接口已变更或需凭据）：" + err.message,
        { status: err.status, url: err.url, retryable: false, hint: "需要 OCLC 凭据的 WorldCat Read API 见矩阵；主题词表可改用 Wikidata / LC / NDL 件名" });
    }
    throw err;
  }
  if (/^Status:\s*\d{3}/m.test(bodyText)) {
    throw new ProviderError("unavailable", "oclc",
      "FAST 端点返回「" + bodyText.replace(/\s+/g, " ").slice(0, 80) + "」（接口已变更或需凭据）",
      { url: bodyUrl, retryable: false, hint: "需要 OCLC 凭据的 WorldCat Read API 见矩阵；主题词表可改用 Wikidata / LC / NDL 件名" });
  }
  throw new ProviderError("parse", "oclc", "FAST 返回 HTTP 200，但当前没有可核的成功响应解析形状，不能据此声称检索命中", {
    status: 200, url: bodyUrl, retryable: false,
    hint: "保留响应供人工核对；确认 FAST 成功格式后再增加解析器",
  });
}

// ───────────────────────── 8. NDL Linked Data ─────────────────────────

/** NDLNA 权威记录号：通常 8 位数字（允许 6-10 位历史值）。接受 id.ndl.go.jp 链接。 */
export function normalizeNdlAuthorityId(input) {
  const text = String(input == null ? "" : input).trim();
  const m = text.match(/id\.ndl\.go\.jp\/auth\/(?:ndlna|entity)\/(\d{7,10})/i);
  const id = m ? m[1] : text.replace(/[^\d]/g, "");
  if (!/^\d{7,10}$/.test(id)) {
    throw new ProviderError("bad_input", "ndl", "NDL 权威记录号非法：" + text.slice(0, 50) + "（需要 7-10 位数字，NDLNA 实际为 8 位）");
  }
  return id;
}

const JA_RE = /[\u3040-\u30ff\u4e00-\u9fff]/;
const KANA_RE = /[\u3040-\u30ff]/;

export function mapNdlAuthority(data, id) {
  requireObject(data, "ndl", "authority");
  const topic = data.primaryTopic || {};
  if (!(clean(data.label) || clean(data.prefLabel && data.prefLabel.literalForm) || clean(topic.name))) {
    throw new ProviderError("parse", "ndl", "authority 响应缺少 label / prefLabel.literalForm / primaryTopic.name", { retryable: false });
  }
  const typeUri = topic.type && topic.type.uri ? topic.type.uri : null;
  const schemeUri = data.inScheme && data.inScheme.uri ? data.inScheme.uri : null;
  const labelForms = (v) => (Array.isArray(v) ? v.map((x) => x && x["@value"]).filter(Boolean) : (v ? [String(v)] : []));
  const transcriptionL = labelForms(data.prefLabel && data.prefLabel["transcription-l"]);
  const viafList = [].concat(data.exactMatch || [])
    .map((m) => (typeof m === "string" ? m : (m && m.uri) || null))
    .filter((u) => u && /viaf\.org/i.test(u))
    .map((u) => {
      const direct = u.match(/viaf\.org\/viaf\/(\d+)/i);
      if (direct) return direct[1];
      const sourceId = u.match(/viaf\/sourceID\/[^#]+/i);
      return sourceId ? sourceId[0] : u;
    });
  return result("ndl", {
    id: id,
    title: clean(data.label) || clean(data.prefLabel && data.prefLabel.literalForm) || clean(topic.name),
    titles: {
      label: clean(data.label),
      literalForm: clean(data.prefLabel && data.prefLabel.literalForm),
      kana: clean(data.prefLabel && data.prefLabel.transcription) || transcriptionL.find((v) => KANA_RE.test(v)) || null,
      romaji: transcriptionL.find((v) => !JA_RE.test(v)) || null,
      name: clean(topic.name),
    },
    dates: {
      birth: clean(topic.dateOfBirth), death: clean(topic.dateOfDeath),
      created: clean(data.created), modified: clean(data.modified),
    },
    external_ids: {
      ndlna: id,
      uri: data.uri || ("http://id.ndl.go.jp/auth/ndlna/" + id),
      viaf: viafList.length ? viafList : null,
    },
    url: "https://id.ndl.go.jp/auth/ndlna/" + id,
    notes: [
      typeUri ? "type=" + typeUri.split("/").pop() : null,
      schemeUri ? "inScheme=" + schemeUri.split("#").pop() : null,
      Array.isArray(data.source) && data.source.length ? "出典=" + data.source.slice(0, 3).map(clean).join(" / ") : null,
    ].filter(Boolean).join("；") || null,
    raw: data,
  });
}

export async function fetchNdlAuthority(idOrUrl, opts) {
  const id = normalizeNdlAuthorityId(idOrUrl);
  const url = "https://id.ndl.go.jp/auth/ndlna/" + id + ".json";
  const res = await jsonRequest(url, Object.assign({ provider: "ndl" }, opts));
  if (res.notFound) {
    return readResult(res, "ndl", { found: false, id: id, url: url, raw: res.raw, notes: "NDL 权威记录 " + id + " 不存在（404；书志 LD / ndlsht / ncl 当前也可能 404，见矩阵）" });
  }
  return attachReadEvidence(mapNdlAuthority(res.json, id), res);
}

// ───────────────────────── 9. VGMdb（无 API：HTML 解析 + 存档读取） ─────────────────────────

export function normalizeVgmdbAlbumId(input) {
  const text = String(input == null ? "" : input).trim();
  const m = text.match(/vgmdb\.net\/album\/(\d+)/i);
  const id = m ? m[1] : text.replace(/[^\d]/g, "");
  if (!/^\d{1,12}$/.test(id)) throw new ProviderError("bad_input", "vgmdb", "VGMdb album id 非法：" + text.slice(0, 50));
  return id;
}

function vgmdbRowPairs(tableHtml) {
  const rows = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = rowRe.exec(tableHtml))) {
    const cells = [];
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let c;
    while ((c = cellRe.exec(m[1]))) cells.push(c[1]);
    if (cells.length < 2) continue;
    const key = clean(cells[0]);
    const value = clean(cells[1]);
    if (key) rows.push([key, value]);
  }
  return rows;
}

/**
 * VGMdb 专辑页解析。页面**没有 JSON-LD**（实测 0 个 ld+json script、无 microdata itemtype），
 * 字段在 table#album_infobit_large 的 label/value 行、span.albumtitle[lang]、
 * span#tracklist 区的 tr.rolebit 行与 div#notes 里。纯函数，可对 Internet Archive
 * 存档 HTML 离线复用（也是本模块唯一能离线验证的 VGMdb 路径）。
 */
export function parseVgmdbAlbumHtml(html, info) {
  const meta = info || {};
  const text = String(html == null ? "" : html);
  if (!text.trim()) throw new ProviderError("parse", "vgmdb", "空 HTML");
  if (looksLikeBotChallenge(text) && !/og:image/i.test(text)) {
    throw new ProviderError("blocked", "vgmdb", "收到反爬挑战页而不是专辑页", { retryable: false, hint: "用 fetchVgmdbAlbumViaArchive 走 Internet Archive 存档" });
  }
  const pageTitle = (text.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  const ogImage = (text.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i) || [])[1] || null;
  const canonical = (text.match(/<link\s+href="([^"]+)"\s+rel="canonical"/i) || [])[1]
    || (text.match(/<meta\s+property="og:url"\s+content="([^"]+)"/i) || [])[1] || null;
  const idFromPage = canonical && canonical.match(/vgmdb\.net\/album\/(\d+)/i) ? canonical.match(/vgmdb\.net\/album\/(\d+)/i)[1] : null;

  const titles: Record<string, any> = {};
  const spanRe = /<span class="albumtitle" lang="([^"]+)"[^>]*>([\s\S]*?)<\/span>/gi;
  let s;
  while ((s = spanRe.exec(text))) {
    const value = clean(s[2]);
    if (value) titles[s[1]] = value;
  }

  const infoMap: Record<string, any> = {};
  const tableRe = /<table id="album_infobit_large"[^>]*>([\s\S]*?)<\/table>/gi;
  let t;
  while ((t = tableRe.exec(text))) {
    for (const pair of vgmdbRowPairs(t[1])) if (!(pair[0] in infoMap)) infoMap[pair[0]] = pair[1];
  }

  const tracks = [];
  const start = text.indexOf('id="tracklist"');
  if (start >= 0) {
    const region = text.slice(start, start + 120000);
    const chunkRe = /<b>\s*Disc\s+(\d+)\s*<\/b>|<tr class="rolebit">([\s\S]*?)<\/tr>/gi;
    let disc = "1";
    let c;
    while ((c = chunkRe.exec(region))) {
      if (c[1]) { disc = c[1]; continue; }
      const row = c[2];
      const cells = [];
      const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      let cell;
      while ((cell = cellRe.exec(row))) cells.push(clean(cell[1]));
      const position = cells.length ? cells[0] : null;
      const title = cells.length > 1 ? cells[1] : null;
      const duration = cells.length > 2 ? cells[cells.length - 1] : null;
      if (title) tracks.push({ disc: disc, position: position, title: title, duration: duration && /[:\d]/.test(duration) ? duration : null });
    }
  }

  const notes = clean((text.match(/<div[^>]*id="notes"[^>]*>([\s\S]*?)<\/div>/i) || [])[1]);
  const title = titles.en || Object.keys(titles).map((k) => titles[k])[0]
    || (clean(pageTitle) ? String(clean(pageTitle)).replace(/\s*-\s*VGMdb$/i, "") : null)
    || infoMap.Title || null;
  if (!title || (!Object.keys(titles).length && !Object.keys(infoMap).length)) {
    throw new ProviderError("parse", "vgmdb", "响应缺少 VGMdb 专辑题名或字段结构（可能是搜索 / 登录页）", { retryable: false });
  }
  const id = meta.albumId ? String(meta.albumId) : idFromPage;
  if (meta.albumId && idFromPage && String(meta.albumId) !== String(idFromPage)) {
    throw new ProviderError("parse", "vgmdb", "页面 canonical album id 与请求 id 不一致", { retryable: false });
  }
  const catalog = infoMap["Catalog Number"] && infoMap["Catalog Number"] !== "N/A" ? infoMap["Catalog Number"] : null;
  return result("vgmdb", {
    id: id,
    title: title,
    titles: Object.keys(titles).length ? titles : null,
    image_url: ogImage,
    image_page_url: canonical || null,
    dates: {
      release: parseEnglishDate(infoMap["Release Date"]),
      release_raw: clean(infoMap["Release Date"]),
      copyright: parseEnglishDate(infoMap["Copyright Date"]) || clean(infoMap["Copyright Date"]),
    },
    external_ids: { vgmdb: id ? String(id) : null, catalog_number: catalog },
    url: canonical || (id ? "https://vgmdb.net/album/" + id : null),
    notes: [
      infoMap["Publish Format"] ? "发行形式=" + infoMap["Publish Format"] : null,
      infoMap["Media Format"] ? "媒体=" + infoMap["Media Format"] : null,
      infoMap["Classification"] ? "分类=" + infoMap["Classification"] : null,
      infoMap["Release Price"] ? "价格=" + infoMap["Release Price"] : null,
      infoMap.Publisher ? "出版=" + infoMap.Publisher : null,
      infoMap["Exclusive Retailer"] ? "独家零售=" + infoMap["Exclusive Retailer"] : null,
      tracks.length ? "曲目=" + tracks.length : null,
      meta.sourceUrl ? "来源页=" + meta.sourceUrl : null,
    ].filter(Boolean).join("；") || null,
    rights_note: "VGMdb 为社区数据库；封面与曲目须与版权方官方页或实体扫描核对后才可作为站内写入证据。",
    tracks: tracks,
    raw: { page_title: clean(pageTitle), info: infoMap, notes: notes, tracks_found: tracks.length, bytes: text.length },
  });
}

/** 直连读取：vgmdb.net 对本机返回 Cloudflare 403（httpRequest 归为 blocked）。 */
export async function fetchVgmdbAlbum(idOrUrl, opts) {
  const id = normalizeVgmdbAlbumId(idOrUrl);
  const url = "https://vgmdb.net/album/" + id;
  const res = await httpRequest(url, Object.assign({
      provider: "vgmdb", accept: "text/html",
      archiveHint: "直连被反爬拦：改用 fetchVgmdbAlbumViaArchive 走 Internet Archive id_ 存档读取",
    }, opts));
  return attachReadEvidence(parseVgmdbAlbumHtml(res.text, { albumId: id, sourceUrl: url }), res);
}

/** 经 Internet Archive 存档读取原样正文（id_ 修饰符），并保留「经存档」标注。 */
export async function fetchVgmdbAlbumViaArchive(idOrUrl, opts) {
  const o = opts || {};
  const id = normalizeVgmdbAlbumId(idOrUrl);
  const originalUrl = "https://vgmdb.net/album/" + id;
  const availability = await waybackSnapshot(originalUrl, o);
  if (!availability.found) {
    throw new ProviderError("unavailable", "vgmdb", "没有可用的 Internet Archive 存档：" + originalUrl,
      { retryable: false, hint: availability.notes || "wayback available 未返回 status=200 的快照" });
  }
  let snapshotUrl = String(availability.snapshot_url).replace(/^http:/i, "https:");
  if (!/\/web\/\d{8,14}id_\//i.test(snapshotUrl)) {
    snapshotUrl = snapshotUrl.replace(/(\/web\/\d{8,14})\/(https?:\/\/.*)$/i, "$1id_/$2");
  }
  if (snapshotUrl === String(availability.snapshot_url).replace(/^http:/i, "https:") && !/id_\//.test(snapshotUrl)) {
    throw new ProviderError("parse", "internetarchive", "无法从快照 URL 拼出 id_ 原样正文：" + snapshotUrl, { retryable: false });
  }
  const res = await httpRequest(snapshotUrl, Object.assign({
    provider: "internetarchive", accept: "text/html", timeoutMs: Math.max(TIMEOUT_MS, 30000),
  }, o));
  const parsed = parseVgmdbAlbumHtml(res.text, { albumId: id, sourceUrl: originalUrl });
  parsed.notes = (parsed.notes ? parsed.notes + "；" : "")
    + "经 Internet Archive 存档读取（快照 " + (availability.dates && availability.dates.snapshot ? availability.dates.snapshot : "?") + "）；证据 URL 用本次读取的存档地址 "
    + res.url + "，原始页面只在 human_page 与 citation 记录；图片仍逐张读取和核对归属";
  parsed.raw = Object.assign({}, parsed.raw, {
    snapshot_url: res.url, snapshot_timestamp: availability.dates ? availability.dates.snapshot : null, original_url: originalUrl,
  });
  return attachReadEvidence(parsed, res);
}

// ───────────────────────── 12. iTunes Store ─────────────────────────
// 免费 Search API（无需 key）：/search 检索 album 候选，/lookup 按 collectionId 取专辑与曲目（entity=song）。
// 2026-10-08 实测：content-type 为 text/javascript 但 body 是合法 JSON；不存在的 id 与空结果都是
// HTTP 200 + resultCount:0，因此 not_found 只按 resultCount/results 判，不按 HTTP 状态判。

const ITUNES_DEFAULT_STOREFRONT = "jp";

/** itunes 单参数末尾可选 `country=xx` 覆盖 storefront；返回 { value, storefront }，未写时 storefront 为 null。 */
export function splitItunesStorefrontArg(raw) {
  const text = String(raw == null ? "" : raw).trim();
  const m = text.match(/(?:^|\s)country=(\S*)\s*$/i);
  if (!m) return { value: text, storefront: null };
  const code = String(m[1] || "").toLowerCase();
  if (!/^[a-z]{2}$/.test(code)) {
    throw new ProviderError("bad_input", "itunes",
      "country= 需要两字母 storefront 代码（如 jp / us），实际：" + String(m[1] || "").slice(0, 20));
  }
  return { value: text.slice(0, m.index).trim(), storefront: code };
}

/** 参数后缀优先，其次 opts.storefront，最后默认 jp。 */
function itunesStorefront(argValue, optValue) {
  const chosen = argValue || (optValue == null ? "" : String(optValue).trim().toLowerCase()) || ITUNES_DEFAULT_STOREFRONT;
  if (!/^[a-z]{2}$/.test(chosen)) {
    throw new ProviderError("bad_input", "itunes", "storefront 需要两字母代码（如 jp / us），实际：" + String(chosen).slice(0, 20));
  }
  return chosen;
}

/** 接受纯数字 collectionId（1–12 位）或 music.apple.com/.../album/.../<数字> 链接（含 ?i= 曲目参数）。 */
export function normalizeItunesCollectionId(input) {
  const text = String(input == null ? "" : input).trim();
  if (/^\d{1,12}$/.test(text)) return text;
  const m = text.match(/music\.apple\.com\/(?:[a-z]{2}\/)?album\/(?:[^/?#]*\/)?(\d{1,12})/i);
  if (m) return m[1];
  throw new ProviderError("bad_input", "itunes",
    "无法解析 iTunes collectionId：" + text.slice(0, 80) + "（需要 1–12 位数字或 music.apple.com/.../album/<数字 ID> 链接）");
}

/** mzstatic 封面 URL 形状：base 末段是原图文件名，再跟 <WxH>bb<ext> 尺寸段。 */
const MZSTATIC_ARTWORK_RE = /^(https?:\/\/[^?#]+?)\/(\d+)x(\d+)bb(\.[A-Za-z]+)$/;
const ITUNES_ARTWORK_MIN = 60;
const ITUNES_ARTWORK_MAX = 3000;

/** 实测 2026-10-09：mzstatic 只认到 3000px，更大尺寸回退到 3000（同一字节数）。 */
export const ITUNES_ARTWORK_SIZES = [60, 100, 170, 300, 600, 1200, 3000];

function itunesArtworkPx(size) {
  return Math.min(ITUNES_ARTWORK_MAX, Math.max(ITUNES_ARTWORK_MIN, Number(size) || 600));
}

/**
 * artworkUrl100 → 指定尺寸。实测 2026-10-09：改写 <WxH>bb<ext> 得 200；60–3000px 可用，
 * 超过 3000 回退到 3000（同一字节数）；ext 可换 png/webp（实测 600x600bb.png / .webp 返回对应 content-type）。
 * 形状不识别时原样返回。
 */
export function itunesArtworkUrl(url, size, ext?: string) {
  const raw = String(url == null ? "" : url).trim();
  if (!raw) return null;
  const m = raw.match(MZSTATIC_ARTWORK_RE);
  if (!m) return raw;
  const px = itunesArtworkPx(size);
  const suffix = ext ? "." + String(ext).replace(/^\./, "") : m[4];
  return m[1] + "/" + px + "x" + px + "bb" + suffix;
}

/** 同一张封面按尺寸列表产出 URL 映射（默认 ITUNES_ARTWORK_SIZES）；非 mzstatic 形状返回 null。 */
export function itunesArtworkSizes(url, sizes?: number[]) {
  const raw = String(url == null ? "" : url).trim();
  if (!raw || !MZSTATIC_ARTWORK_RE.test(raw)) return null;
  const list = Array.isArray(sizes) && sizes.length ? sizes : ITUNES_ARTWORK_SIZES;
  const out: Record<string, any> = {};
  for (const s of list) out[String(itunesArtworkPx(s))] = itunesArtworkUrl(raw, s);
  return out;
}

/** GTIN（EAN-8 / UPC-A / EAN-13 / GTIN-14）校验位：从右往左权重 3,1,3,1…。只作提示，不用来过滤。 */
function gtinCheckDigitValid(digits) {
  if (!/^\d+$/.test(digits)) return false;
  const rev = digits.split("").reverse();
  let sum = 0;
  for (let i = 1; i < rev.length; i += 1) sum += Number(rev[i]) * (i % 2 === 1 ? 3 : 1);
  return (10 - (sum % 10)) % 10 === Number(rev[0]);
}

const GTIN_SCHEMES = { 8: "ean-8", 12: "upc-a", 13: "ean-13", 14: "gtin-14" };

/** 取 mzstatic 封面 URL 的"原图文件名"段（去掉末尾 <WxH>bb<ext> 尺寸段）。 */
function itunesArtworkFileName(url) {
  let pathname;
  try { pathname = new URL(String(url == null ? "" : url).trim()).pathname; } catch { return null; }
  const segs = pathname.split("/").filter(Boolean);
  if (!segs.length) return null;
  const last = segs[segs.length - 1];
  if (/^\d+x\d+bb(\.[A-Za-z]+)?$/.test(last) && segs.length >= 2) return segs[segs.length - 2];
  return last;
}

/**
 * 从封面 URL 文件名段提取"发行编号候选"。Apple 的 artworkUrl 原图文件名常常就是发行方编号
 * （如 4538182209493_cov.jpg / 4547366532999.jpg），但也可能是内部命名（dj.lxhnqrgt.jpg）或艺人图；
 * 且数字发行可能用独立编号、沿用实体版条码或没有编号。这里**不做硬校验**：只要文件名以一段
 * 6–14 位数字开头、后接分隔符或结尾就原样给出候选，并附带 GTIN 标准名（位数匹配时）与校验位是否
 * 通过作为提示，全部交人工核对。识别不出数字编号段时返回 null。
 */
export function itunesArtworkBarcode(url) {
  const name = itunesArtworkFileName(url);
  if (!name) return null;
  const stem = name.split(".")[0];
  const m = stem.match(/^(\d{6,14})(?:[._-]|$)/);
  if (!m) return null;
  const code = m[1];
  return {
    value: code,
    source: "apple_artwork_filename",
    scheme: GTIN_SCHEMES[code.length] || null,
    checksum_valid: gtinCheckDigitValid(code),
  };
}

/** 封面块：image_url(600) + 多尺寸 images + 文件名提取的编号候选（release_number，可能为 null）。 */
function itunesArtworkBlock(artworkUrl) {
  const barcode = itunesArtworkBarcode(artworkUrl);
  return {
    image_url: itunesArtworkUrl(artworkUrl, 600),
    images: itunesArtworkSizes(artworkUrl),
    release_number: barcode ? Object.assign({}, barcode, { kind: "candidate" }) : null,
  };
}

/** "2021-10-18T07:00:00Z" → "2021-10-18"；其他形态退回 isoDate（只产出能确证的日期）。 */
function itunesReleaseDate(value) {
  const s = String(value == null ? "" : value).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})T/);
  return m ? m[1] : isoDate(s);
}

/** search 候选项保留的原始字段子集（便于逐字核对，同时避免整条响应膨胀）。 */
const ITUNES_COLLECTION_KEYS = [
  "wrapperType", "collectionType", "artistId", "collectionId", "artistName", "collectionName",
  "collectionCensoredName", "artistViewUrl", "collectionViewUrl", "artworkUrl60", "artworkUrl100",
  "collectionPrice", "collectionExplicitness", "trackCount", "copyright", "country", "currency",
  "releaseDate", "primaryGenreName",
];

function itunesItemSlice(item, keys) {
  const out: Record<string, any> = {};
  for (const key of keys) if (item[key] !== undefined && item[key] !== null) out[key] = item[key];
  return out;
}

function mapItunesSearchHit(r, storefront) {
  const artwork = itunesArtworkBlock(r.artworkUrl100);
  return {
    id: String(r.collectionId),
    title: clean(r.collectionName),
    artist: clean(r.artistName),
    artist_id: r.artistId != null ? String(r.artistId) : null,
    release_date: itunesReleaseDate(r.releaseDate),
    release_date_raw: clean(r.releaseDate),
    track_count: Number.isFinite(r.trackCount) ? Number(r.trackCount) : null,
    country: clean(r.country),
    storefront: storefront,
    url: clean(r.collectionViewUrl),
    image_url: artwork.image_url,
    images: artwork.images,
    release_number: artwork.release_number,
    explicitness: clean(r.collectionExplicitness),
    raw: itunesItemSlice(r, ITUNES_COLLECTION_KEYS),
  };
}

/** album 候选检索；单参数支持末尾 `country=xx`（默认 jp，本仓库以日系音乐为主）。 */
export async function searchItunes(query, opts) {
  const o = opts || {};
  const parsed = splitItunesStorefrontArg(query);
  if (!parsed.value) throw new ProviderError("bad_input", "itunes", "检索词不能为空");
  const storefront = itunesStorefront(parsed.storefront, o.storefront);
  const params = new URLSearchParams({
    term: parsed.value,
    media: "music",
    entity: "album",
    country: storefront,
    limit: String(Math.min(200, Math.max(1, o.limit || 5))),
  });
  const url = "https://itunes.apple.com/search?" + params.toString();
  const res = await jsonRequest(url, Object.assign({ provider: "itunes" }, o));
  const response = requireObject(res.json, "itunes", "search");
  const rawResults = requireArrayField(response, "results", "itunes", "search");
  if (!Number.isInteger(response.resultCount) || response.resultCount < 0) {
    throw new ProviderError("parse", "itunes", "search 响应缺少有效 resultCount", { retryable: false });
  }
  const hits = rawResults
    .map((r) => requireSearchItem(r, "itunes", "search", ["collectionId"], ["collectionName"]))
    .map((r) => mapItunesSearchHit(r, storefront));
  return readResult(res, "itunes", {
    found: hits.length > 0,
    id: hits[0] ? hits[0].id : null,
    title: hits[0] ? hits[0].title : null,
    image_url: hits[0] ? hits[0].image_url : null,
    images: hits[0] ? hits[0].images : null,
    release_number: hits[0] ? hits[0].release_number : null,
    dates: hits[0] && hits[0].release_date ? { release: hits[0].release_date } : null,
    url: hits[0] ? hits[0].url : null,
    notes: hits.length
      ? "候选 " + hits.length + " 条（resultCount=" + response.resultCount + "，storefront=" + storefront + "）；检索结果是候选，写入前须核对题名与艺人"
      : "iTunes search 无命中（resultCount=0，storefront=" + storefront + "）：该商店下没有匹配的 album 候选",
    raw: { resultCount: response.resultCount, storefront: storefront, hits: hits },
  });
}

/** 单张专辑 + 曲目列表（lookup?id=<collectionId>&entity=song）；不存在 id 返回 found:false，不抛错。 */
export async function lookupItunesAlbum(idOrUrl, opts) {
  const o = opts || {};
  const parsed = splitItunesStorefrontArg(idOrUrl);
  const id = normalizeItunesCollectionId(parsed.value);
  const storefront = itunesStorefront(parsed.storefront, o.storefront);
  const params = new URLSearchParams({ id: id, entity: "song", country: storefront });
  const url = "https://itunes.apple.com/lookup?" + params.toString();
  const res = await jsonRequest(url, Object.assign({ provider: "itunes" }, o));
  const response = requireObject(res.json, "itunes", "lookup");
  const rawResults = requireArrayField(response, "results", "itunes", "lookup");
  if (!Number.isInteger(response.resultCount) || response.resultCount < 0) {
    throw new ProviderError("parse", "itunes", "lookup 响应缺少有效 resultCount", { retryable: false });
  }
  const collection = rawResults.find((r) => r && r.wrapperType === "collection");
  if (!collection) {
    return readResult(res, "itunes", {
      found: false,
      id: id,
      url: url,
      raw: response,
      notes: response.resultCount === 0
        ? "iTunes lookup 空结果（resultCount=0）：collectionId=" + id + " 在 storefront=" + storefront + " 不存在或未上架"
        : "iTunes lookup 返回 " + response.resultCount + " 条结果但没有 collection（该数字更像 trackId）：id=" + id + "，请换专辑数字 ID 重试",
    });
  }
  requireSearchItem(collection, "itunes", "lookup", ["collectionId"], ["collectionName"]);
  const tracks = rawResults
    .filter((t) => t && t.wrapperType === "track")
    .map((t) => ({
      track_id: t.trackId != null ? String(t.trackId) : null,
      disc_number: Number.isFinite(t.discNumber) ? Number(t.discNumber) : null,
      disc_count: Number.isFinite(t.discCount) ? Number(t.discCount) : null,
      track_number: Number.isFinite(t.trackNumber) ? Number(t.trackNumber) : null,
      title: clean(t.trackName),
      artist: clean(t.artistName),
      duration_ms: Number.isFinite(t.trackTimeMillis) ? Number(t.trackTimeMillis) : null,
      duration_seconds: Number.isFinite(t.trackTimeMillis) ? Math.round(Number(t.trackTimeMillis) / 100) / 10 : null,
      has_preview: Boolean(t.previewUrl),
      preview_url: clean(t.previewUrl),
      explicitness: clean(t.trackExplicitness),
      url: clean(t.trackViewUrl),
    }));
  const trackCount = Number.isFinite(collection.trackCount) ? Number(collection.trackCount) : null;
  const genre = clean(collection.primaryGenreName);
  const copyright = clean(collection.copyright);
  const artwork = itunesArtworkBlock(collection.artworkUrl100);
  return readResult(res, "itunes", {
    id: String(collection.collectionId),
    title: clean(collection.collectionName),
    titles: {
      collection: clean(collection.collectionName),
      censored: clean(collection.collectionCensoredName),
      artist: clean(collection.artistName),
    },
    image_url: artwork.image_url,
    images: artwork.images,
    release_number: artwork.release_number,
    image_page_url: clean(collection.collectionViewUrl),
    dates: {
      release: itunesReleaseDate(collection.releaseDate),
      release_raw: clean(collection.releaseDate),
    },
    external_ids: {
      itunes: String(collection.collectionId),
      artist_id: collection.artistId != null ? String(collection.artistId) : null,
      upc: collection.upc != null && String(collection.upc).trim() ? String(collection.upc) : null,
      barcode_candidate: artwork.release_number ? artwork.release_number.value : null,
    },
    url: clean(collection.collectionViewUrl),
    tracks: tracks,
    notes: [
      "曲目 " + tracks.length + " 条（trackCount=" + (trackCount == null ? "?" : trackCount) + "）",
      "storefront=" + storefront,
      trackCount != null && trackCount !== tracks.length ? "lookup 返回的曲目数与 trackCount 不一致，入库前须核对" : null,
      genre ? "分类=" + genre : null,
      copyright ? "版权=" + copyright : null,
      artwork.release_number
        ? "封面文件名含编号候选 " + artwork.release_number.value
          + "（" + (artwork.release_number.scheme || "非标准 GTIN 位数")
          + "，校验位" + (artwork.release_number.checksum_valid ? "通过" : "不通过")
          + "；来源=封面文件名，未做硬校验，可能为数字发行独立编号、实体版条码或其他规则，须由 agent 按技能核实确认）"
        : "封面文件名未含可识别编号（Apple Search API 响应不含 UPC/barcode 字段）",
    ].filter(Boolean).join("；"),
    rights_note: "封面 URL 为 Apple mzstatic 托管图（artworkUrl100 改写，实测 60–3000px 可用、超 3000 回退 3000，可换 png/webp；images 给多尺寸候选）；release_number 从封面文件名提取、非 Apple 字段，写入 pictures[] 与 identifiers 前仍按字段来源策略核实。",
    raw: response,
  });
}

// ───────────────────────── 13. Steam 商店 ─────────────────────────
// 官方商店接口，无需 key：/api/appdetails 按 AppID 取应用资料，/api/storesearch 按名称检索候选。
// 2026-10-08 本机实测（踩过的坑都写在这里）：
//   1. AppID 不存在不是 404：HTTP 200 + {"<id>":{"success":false}}；appids=0 是 HTTP 400 且 body 为 null，
//      所以 0 / 非数字先用 normalizeSteamAppId 挡掉，found 只按 success / items 判。
//   2. 不写 cc 时区域与币种按请求来源地解析（本机实测得到 JPY）；要可复现的定价必须显式 cc=，
//      默认 us 与本仓库既有游戏数字发行的定价记录口径一致（Celeste / Hades / ELDEN RING 均为 USD/US 区）。
//   3. 发行日期随 l= 本地化："2018 年 1 月 25 日" / "2018年1月25日" / "Jan 25, 2018"；
//      CJK 形态 parseEnglishDate 解析不了，走 parseSteamLocalDate。
//   4. steamdb.info 是第三方聚合站，对机读返回 HTTP 403 自有拦截页（非 Cloudflare 挑战页）；
//      它只作人工交叉核对，本模块不抓它的页面，只从 /app/<id>/ 链接里取 AppID。

const STEAM_STORE = "https://store.steampowered.com";
const STEAM_DEFAULT_CC = "us";
const STEAM_DEFAULT_LANG = "english";
const STEAM_MAX_LANGS = 4;
const STEAM_LANG_CODE = /^[a-z][a-z0-9]{1,11}$/;
const STEAM_CC_CODE = /^[a-z]{2}$/;

/** 接受 504230 / store.steampowered.com/app/504230/Celeste/ / steamdb.info/app/504230/；只取 AppID，不读页面内容。 */
export function normalizeSteamAppId(input) {
  const text = String(input == null ? "" : input).trim();
  if (/^\d{1,12}$/.test(text)) {
    if (Number(text) < 1) throw new ProviderError("bad_input", "steam", "Steam AppID 必须是正整数，实际：" + text);
    return String(Number(text));
  }
  const m = text.match(/(?:store\.steampowered\.com|steamdb\.info)\/app\/(\d{1,12})(?:\/|$|\?|#)/i);
  if (m) {
    if (Number(m[1]) < 1) throw new ProviderError("bad_input", "steam", "Steam AppID 必须是正整数，实际：" + m[1]);
    return String(Number(m[1]));
  }
  throw new ProviderError("bad_input", "steam",
    "无法解析 Steam AppID：" + text.slice(0, 80) + "（需要 1–12 位数字、store.steampowered.com/app/<id> 或 steamdb.info/app/<id> 链接）");
}

/** steam 单参数末尾可选 `lang=` / `langs=` / `cc=`（可叠加、任意顺序；后写的覆盖先写的，langs 优先于 lang）。 */
export function splitSteamArgOptions(raw) {
  let text = String(raw == null ? "" : raw).trim();
  const parsed = { lang: null, langs: null, cc: null };
  for (;;) {
    const m = text.match(/(?:^|\s)(lang|langs|cc)=(\S*)\s*$/i);
    if (!m) break;
    const key = m[1].toLowerCase();
    const value = String(m[2] || "");
    if (key === "cc") {
      const code = value.toLowerCase();
      if (!STEAM_CC_CODE.test(code)) {
        throw new ProviderError("bad_input", "steam",
          "cc= 需要两字母国家/地区代码（us / cn / jp …），实际：" + String(value).slice(0, 20));
      }
      parsed.cc = code;
    } else {
      const codes = value.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean);
      if (!codes.length || codes.some((code) => !STEAM_LANG_CODE.test(code))) {
        throw new ProviderError("bad_input", "steam",
          key + "= 需要 Steam 语言代码（english / japanese / schinese …，langs= 可用逗号分隔），实际：" + String(value).slice(0, 40));
      }
      if (key === "lang") parsed.lang = codes[0];
      else parsed.langs = codes;
    }
    text = text.slice(0, m.index).trim();
  }
  return { value: text, lang: parsed.lang, langs: parsed.langs, cc: parsed.cc };
}

/** 请求语种列表：参数后缀 > opts > 默认 english；一次最多 4 个，去重。 */
function steamLangs(parsed, opts) {
  const o = opts || {};
  const optLangs = Array.isArray(o.langs) ? o.langs : (o.langs ? String(o.langs).split(",") : null);
  const chosen = (parsed.langs && parsed.langs.length ? parsed.langs : null)
    || (parsed.lang ? [parsed.lang] : null)
    || optLangs
    || (o.lang ? [String(o.lang)] : null)
    || [STEAM_DEFAULT_LANG];
  const codes: string[] = [...new Set<string>(chosen.map((value) => String(value).trim().toLowerCase()).filter(Boolean))];
  for (const code of codes) {
    if (!STEAM_LANG_CODE.test(code)) {
      throw new ProviderError("bad_input", "steam",
        "lang= 需要 Steam 语言代码（english / japanese / schinese …），实际：" + String(code).slice(0, 20));
    }
  }
  if (codes.length > STEAM_MAX_LANGS) {
    throw new ProviderError("bad_input", "steam",
      "一次最多取 " + STEAM_MAX_LANGS + " 个语种，实际 " + codes.length + " 个（拆成多次调用，避免放大请求量）");
  }
  return codes;
}

/** 区域码：参数后缀 > opts > 默认 us（不带 cc 时 Steam 按请求来源地解析，结果不可复现）。 */
function steamCc(parsed, opts) {
  const o = opts || {};
  const chosen = parsed.cc || (o.cc == null ? "" : String(o.cc).trim().toLowerCase()) || STEAM_DEFAULT_CC;
  if (!STEAM_CC_CODE.test(chosen)) {
    throw new ProviderError("bad_input", "steam", "cc= 需要两字母国家/地区代码（us / cn / jp …），实际：" + String(chosen).slice(0, 20));
  }
  return chosen;
}

/** Steam 发行日期：英文月名交给 parseEnglishDate；中/日「2020 年 2 月 14 日」「2018年1月25日」单独归一。
 *  解析不了（"Coming soon" / "2024 年 2 月" 这类）返回 null，原文留在 raw，不猜。 */
export function parseSteamLocalDate(value) {
  const text = String(value == null ? "" : value).trim();
  if (!text) return null;
  const cjk = text.match(/^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日$/);
  if (cjk) {
    const month = Number(cjk[2]);
    const day = Number(cjk[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return cjk[1] + "-" + String(month).padStart(2, "0") + "-" + String(day).padStart(2, "0");
  }
  return parseEnglishDate(text);
}

/** appdetails 的 raw 子集：保留可逐字核对的字段，省掉 detailed_description / about_the_game 等长 HTML。 */
const STEAM_APP_KEYS = [
  "type", "name", "steam_appid", "required_age", "is_free", "short_description", "supported_languages",
  "header_image", "capsule_image", "capsule_imagev5", "background", "website", "developers", "publishers",
  "price_overview", "packages", "package_groups", "platforms", "metacritic", "categories", "genres",
  "screenshots", "movies", "recommendations", "achievements", "release_date", "support_info",
  "content_descriptors", "controller_support", "dlc", "legal_notice", "library_assets",
];

export function steamStoreUrl(id) {
  return STEAM_STORE + "/app/" + String(id) + "/";
}

function steamDescriptionList(value) {
  if (!Array.isArray(value)) return null;
  return value.map((entry) => clean(entry && entry.description)).filter(Boolean);
}

/** price_overview 以「分」为单位；标价取未折扣的 initial，折扣价另存 final。 */
function steamPriceFields(data, cc) {
  const price = data.price_overview;
  if (price && Number.isFinite(price.initial)) {
    return {
      currency: clean(price.currency),
      amount: Math.round(price.initial) / 100,
      amount_formatted: clean(price.initial_formatted),
      discount_percent: Number.isFinite(price.discount_percent) ? Number(price.discount_percent) : null,
      final_amount: Number.isFinite(price.final) ? Math.round(price.final) / 100 : null,
      final_formatted: clean(price.final_formatted),
      region: cc,
      basis: "price_overview.initial（未折扣标价）",
    };
  }
  if (data.is_free === true) {
    return { currency: null, amount: 0, amount_formatted: null, discount_percent: 0, final_amount: 0, final_formatted: null, region: cc, basis: "is_free" };
  }
  return null;
}

/** 按 AppID 取应用资料；多语种串行请求（同主机节流），单语种无资料只记 notes，不伪造字段、不整体失败。 */
export async function fetchSteamApp(idOrUrl, opts) {
  const o = opts || {};
  const parsed = splitSteamArgOptions(idOrUrl);
  const id = normalizeSteamAppId(parsed.value);
  const langs = steamLangs(parsed, o);
  const cc = steamCc(parsed, o);

  const reads = [];
  const locales: Record<string, any> = {};
  const success: Record<string, any> = {};
  const withoutData = [];
  for (const lang of langs) {
    const params = new URLSearchParams({ appids: id, l: lang, cc: cc });
    const url = STEAM_STORE + "/api/appdetails?" + params.toString();
    const res = await jsonRequest(url, Object.assign({ provider: "steam" }, o));
    reads.push({ ...res, language: lang });
    if (res.notFound) {
      success[lang] = null;
      withoutData.push(lang);
      continue;
    }
    const payload = requireObject(res.json, "steam", "appdetails");
    const entry = payload[id];
    if (entry === undefined) {
      throw new ProviderError("parse", "steam",
        "appdetails 响应缺少 appid=" + id + " 的条目（顶层键：" + Object.keys(payload).join(",") + "）",
        { retryable: false, url: url });
    }
    if (entry && entry.success === true) {
      locales[lang] = requireObject(entry.data, "steam", "appdetails data");
      success[lang] = true;
    } else {
      success[lang] = false;
      withoutData.push(lang);
    }
  }

  const okLangs = langs.filter((lang) => locales[lang]);
  reads.sort((a, b) => Number(Boolean(locales[b.language])) - Number(Boolean(locales[a.language])));
  if (!okLangs.length) {
    return readResult(reads, "steam", {
      found: false,
      id: id,
      url: steamStoreUrl(id),
      notes: "Steam appdetails 对 AppID " + id + " 返回 success:false（langs=" + langs.join(",") + "，cc=" + cc + "）："
        + "该 AppID 不存在、未在 cc 区域上架，或所选语种没有资料；这是 cc 区域的答案，不代表该作品在其他区域或平台的收录情况",
      raw: { appid: id, cc: cc, requested_langs: langs, success: success },
    });
  }

  const primary = locales[okLangs[0]];
  const titles: Record<string, any> = {};
  const releaseByLang: Record<string, any> = {};
  for (const lang of okLangs) {
    const data = locales[lang];
    const name = clean(data.name);
    if (name) titles[lang] = name;
    const release = data.release_date || {};
    releaseByLang[lang] = {
      date: clean(release.date),
      coming_soon: release.coming_soon === true,
      normalized: parseSteamLocalDate(release.date),
    };
  }
  const primaryRelease = primary.release_date || {};
  const primaryDate = clean(primaryRelease.date);
  const normalizedDate = parseSteamLocalDate(primaryDate);
  const price = steamPriceFields(primary, cc);
  const websites = clean(primary.website);
  const rawLocales: Record<string, any> = {};
  for (const lang of okLangs) {
    const slice: Record<string, any> = {};
    for (const key of STEAM_APP_KEYS) if (locales[lang][key] !== undefined && locales[lang][key] !== null) slice[key] = locales[lang][key];
    rawLocales[lang] = slice;
  }

  const notes = [
    "cc=" + cc + "（定价与区域按该地区返回；不写 cc 时 Steam 按请求来源地解析，结果不可复现）",
    "请求语种：" + langs.join(",") + (withoutData.length ? "（success:false 或无资料：" + withoutData.join(",") + "）" : ""),
    primaryDate ? "发行日期原文「" + primaryDate + "」→ " + (normalizedDate || "无法归一，原文见 raw") : "本次响应没有 release_date.date",
    primaryRelease.coming_soon === true ? "coming_soon=true：尚未发售，不能按已发售日期写 edition_date" : null,
    price
      ? "定价取 price_overview.initial（未折扣标价，region=" + cc + (price.discount_percent ? "，当前折扣 " + price.discount_percent + "%" : "") + "）；Steam 区域定价与折扣随活动变化，写入前复核"
      : (primary.is_free === true
        ? "该应用 is_free=true：无标价"
        : "本次响应没有 price_overview：可能未在 cc=" + cc + " 区域销售或无价格信息，不能当作免费，也不能据此判定该地区未上架"),
    "developers/publishers 是商店页署名，不是完整权利链；建 agent 与署名关系前另行核对",
    "titles 是各语种的商店题名（译文可能非官方正式题名），写入 translations 前按命名与来源策略核对",
  ].filter(Boolean).join("；");

  return readResult(reads, "steam", {
    id: id,
    title: clean(primary.name),
    titles: Object.keys(titles).length ? titles : null,
    image_url: clean(primary.header_image),
    image_page_url: steamStoreUrl(id),
    dates: {
      release: normalizedDate,
      release_raw: primaryDate,
      coming_soon: primaryRelease.coming_soon === true,
      by_lang: releaseByLang,
    },
    external_ids: { steam: id },
    url: steamStoreUrl(id),
    type: clean(primary.type),
    developers: Array.isArray(primary.developers) ? primary.developers.map(clean).filter(Boolean) : [],
    publishers: Array.isArray(primary.publishers) ? primary.publishers.map(clean).filter(Boolean) : [],
    genres: steamDescriptionList(primary.genres),
    categories: steamDescriptionList(primary.categories),
    platforms: primary.platforms || null,
    languages: clean(primary.supported_languages),
    website: websites,
    price: price,
    coming_soon: primaryRelease.coming_soon === true,
    notes: notes,
    rights_note: "cover/截图 URL 由 Steam CDN（steamstatic）托管、图片内容由发行商提供；header_image 是商店横幅，不自动等于发行版封面，写入 pictures[] 前按字段来源策略核对具体版次与权利。",
    raw: { appid: id, cc: cc, requested_langs: langs, success: success, locales: rawLocales },
  });
}

/** 商店检索（名称 → AppID 候选）。total=0 是明确的无命中，不是失败。 */
export async function searchSteam(query, opts) {
  const o = opts || {};
  const parsed = splitSteamArgOptions(query);
  if (!parsed.value) throw new ProviderError("bad_input", "steam", "检索词不能为空");
  const lang = (parsed.langs && parsed.langs.length ? parsed.langs[0] : null)
    || parsed.lang
    || (o.lang == null ? "" : String(o.lang).trim().toLowerCase())
    || STEAM_DEFAULT_LANG;
  if (!STEAM_LANG_CODE.test(lang)) {
    throw new ProviderError("bad_input", "steam", "lang= 需要 Steam 语言代码（english / japanese / schinese …），实际：" + String(lang).slice(0, 20));
  }
  const cc = steamCc(parsed, o);
  const params = new URLSearchParams({ term: parsed.value, l: lang, cc: cc });
  const url = STEAM_STORE + "/api/storesearch/?" + params.toString();
  const res = await jsonRequest(url, Object.assign({ provider: "steam" }, o));
  if (res.notFound) {
    return readResult(res, "steam", {
      found: false,
      url: url,
      notes: "Steam storesearch 返回 404/410：该读取路径当前没有答案，不等于没有匹配作品",
      raw: { url: url, raw: String(res.raw || "").slice(0, 400) },
    });
  }
  const response = requireObject(res.json, "steam", "storesearch");
  const rawItems = requireArrayField(response, "items", "steam", "storesearch");
  const total = Number.isInteger(response.total) ? response.total : null;
  const hits = rawItems.map((entry) => {
    const item = requireSearchItem(entry, "steam", "storesearch", ["id"], ["name"]);
    const price = item.price && Number.isFinite(item.price.initial)
      ? {
        currency: clean(item.price.currency),
        amount: Math.round(item.price.initial) / 100,
        final_amount: Number.isFinite(item.price.final) ? Math.round(item.price.final) / 100 : null,
        region: cc,
      }
      : null;
    return {
      id: String(item.id),
      type: clean(item.type),
      name: clean(item.name),
      url: steamStoreUrl(item.id),
      image_url: clean(item.tiny_image),
      price: price,
      platforms: item.platforms || null,
      metascore: clean(item.metascore),
      raw: item,
    };
  });
  return readResult(res, "steam", {
    found: hits.length > 0,
    id: hits[0] ? hits[0].id : null,
    title: hits[0] ? hits[0].name : null,
    image_url: hits[0] ? hits[0].image_url : null,
    url: hits[0] ? hits[0].url : null,
    notes: hits.length
      ? "候选 " + hits.length + " 条（total=" + (total == null ? "?" : total) + "，lang=" + lang + "，cc=" + cc + "）；检索结果是候选，写入前核对 AppID、类型（app / 原声 / DLC）与题名"
      : "Steam storesearch 无命中（total=" + (total == null ? "?" : total) + "，lang=" + lang + "，cc=" + cc + "）：该地区与语种下没有匹配候选；换 lang=schinese / japanese 或换检索词再试",
    raw: { total: total, cc: cc, lang: lang, hits: hits },
  });
}

// ───────────────────────── ISBN（OpenBD 等书目源共用） ─────────────────────────

const ISBN_10_SHAPE = /^\d{9}[\dX]$/;
const ISBN_13_SHAPE = /^(?:978|979)\d{10}$/;
// 前后都要非字母数字边界：否则 13 位非 978/979 开头的数字串会被 \d{9}[\dX] 截前 10 位当成 ISBN-10。
const ISBN_TOKEN = /(?:^|[^0-9A-Z])((?:978|979)\d{10}|\d{9}[\dX])(?![0-9A-Z])/;

/**
 * 规整 ISBN：去空格与连字符、末位 x 大写；也接受把 ISBN 包在链接或「ISBN:」前缀里的写法。
 * 只校验**形状**，不拿校验位当拒绝理由——站内确实存在校验位写错的 ISBN（那是待整改的数据问题），
 * 拒绝会让这类记录连「取回来源核对」都做不到。校验位结论由 isbnCheckDigit 单独作为提示给出。
 */
export function normalizeIsbn(input, provider) {
  const p = provider || "openbd";
  const raw = String(input == null ? "" : input).trim();
  if (!raw) throw new ProviderError("bad_input", p, "ISBN 不能为空");
  const compact = raw.replace(/[\s-]/g, "").toUpperCase();
  let value = null;
  if (ISBN_13_SHAPE.test(compact) || ISBN_10_SHAPE.test(compact)) value = compact;
  else {
    const m = compact.match(ISBN_TOKEN);
    if (m) value = m[1];
  }
  if (!value) {
    throw new ProviderError("bad_input", p,
      "无法解析 ISBN：" + raw.slice(0, 60)
      + "（需要 ISBN-13：978/979 开头共 13 位；或 ISBN-10：9 位数字 + 校验位，末位可为 X）");
  }
  return value;
}

/**
 * ISBN 校验位：ISBN-13 与 EAN-13 同算法（复用 gtinCheckDigitValid，不另写第二份），
 * ISBN-10 是 mod-11 加权和、末位可为 X（=10）。形状不合返回 valid:null，不猜。
 */
export function isbnCheckDigit(input) {
  const digits = String(input == null ? "" : input).trim().toUpperCase().replace(/[\s-]/g, "");
  if (ISBN_13_SHAPE.test(digits)) return { scheme: "isbn-13", valid: gtinCheckDigitValid(digits) };
  if (ISBN_10_SHAPE.test(digits)) {
    let sum = 0;
    for (let i = 0; i < 10; i += 1) {
      const c = digits[i];
      sum += (c === "X" ? 10 : Number(c)) * (10 - i);
    }
    return { scheme: "isbn-10", valid: sum % 11 === 0 };
  }
  return { scheme: null, valid: null };
}

// ───────────────────────── Cover Art Archive ─────────────────────────

const CAA_BASE = "https://coverartarchive.org";
const MBID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CAA_KINDS = ["release", "release-group"];

/**
 * 解析 MBID 与层级。层级必须明确：release 与 release-group 的 MBID 不可互换，
 * 而站内 musicbrainz 码的 url_pattern 是 release-group 形态，混层会生成错链接。
 * 链接里的层级与请求的操作冲突时抛 bad_input，不猜。
 */
export function normalizeCoverArtRef(input, requestedKind) {
  const raw = String(input == null ? "" : input).trim();
  if (!raw) throw new ProviderError("bad_input", "coverartarchive", "缺少 MBID 或 Cover Art Archive / MusicBrainz 链接");
  const fromUrl = raw.match(/(?:coverartarchive\.org|musicbrainz\.org)\/(release-group|release)\/([0-9A-Fa-f-]{36})/i);
  const urlKind = fromUrl ? fromUrl[1].toLowerCase() : null;
  const wanted = CAA_KINDS.includes(requestedKind) ? requestedKind : null;
  const id = String(fromUrl ? fromUrl[2] : raw).trim().toLowerCase();
  if (!MBID_SHAPE.test(id)) {
    throw new ProviderError("bad_input", "coverartarchive",
      "MBID 需要标准 36 位 UUID 形态，实际：" + raw.slice(0, 60));
  }
  if (urlKind && wanted && urlKind !== wanted) {
    throw new ProviderError("bad_input", "coverartarchive",
      "链接里的层级是 " + urlKind + "，但请求的操作是 caa." + wanted + "；两者不一致，请核对这个 MBID 属于哪一层");
  }
  const kind = urlKind || wanted;
  if (!kind) {
    throw new ProviderError("bad_input", "coverartarchive",
      "必须指明层级：用 caa.release 或 caa.release-group，或给一条含 /release/ 或 /release-group/ 的链接");
  }
  return { kind: kind, id: id };
}

export function coverArtPageUrl(kind, id) {
  return CAA_BASE + "/" + kind + "/" + String(id).toLowerCase();
}

/** index.json 的 release 字段：release-group 请求时它指向 CAA 选定的那一个发行版。 */
function caaReleaseOfRecord(data) {
  const rel = data && typeof data.release === "string" ? data.release.trim() : null;
  if (!rel) return null;
  const m = rel.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return { url: rel, mbid: m ? m[1].toLowerCase() : null };
}

function caaImageBlock(entry) {
  const item = requireObject(entry, "coverartarchive", "CAA images 项");
  const thumbs = item.thumbnails && typeof item.thumbnails === "object" ? item.thumbnails : {};
  return {
    id: item.id == null ? null : String(item.id),
    types: Array.isArray(item.types) ? item.types.map(clean).filter(Boolean) : [],
    front: item.front === true,
    back: item.back === true,
    approved: item.approved === true,
    edit: Number.isFinite(Number(item.edit)) && item.edit != null ? Number(item.edit) : null,
    comment: clean(item.comment),
    image_url: clean(item.image),
    thumbnails: {
      small: clean(thumbs.small), 250: clean(thumbs["250"]),
      500: clean(thumbs["500"]), 1200: clean(thumbs["1200"]), large: clean(thumbs.large),
    },
  };
}

/**
 * 按 MBID 取封面图组。CAA 的 404 是「这一层没有封面图」的明确答复（body 是 HTML
 * 「No cover art found for ...」），按 found:false 判读；index.json 与图片正文都在
 * archive.org 上，取不到属网络问题，由 httpRequest 归为 network/unavailable，不映射成 found:false。
 */
export async function fetchCoverArtArchive(idOrUrl, opts) {
  const o = opts || {};
  const ref = normalizeCoverArtRef(idOrUrl, o.kind);
  const url = coverArtPageUrl(ref.kind, ref.id);
  const res = await httpRequest(url, Object.assign({ provider: "coverartarchive", accept: "application/json" }, o));

  if (res.notFound) {
    const body = String(res.text || "").replace(/\s+/g, " ").trim();
    const explicit = /No cover art found/i.test(body);
    if (!explicit) {
      throw new ProviderError("unavailable", "coverartarchive",
        "HTTP " + res.status + " 但响应不是 CAA 的「无封面」答复：" + body.slice(0, 160),
        { status: res.status, url: url, retryable: true, hint: "404 只有在 body 明写 No cover art found 时才是提供方的答复" });
    }
    return readResult(res, "coverartarchive", {
      found: false,
      id: ref.id,
      url: url,
      notes: "Cover Art Archive 明确答复：" + ref.kind + " " + ref.id + " 没有封面图（HTTP " + res.status + "）。"
        + "这只说明 CAA 没收录，不代表该发行版没有封面——厂牌官方商品页、商店页与 MusicBrainz 之外的渠道仍可能有图。",
      raw: { kind: ref.kind, mbid: ref.id, status: res.status, body: body.slice(0, 300) },
    });
  }

  let data;
  try {
    data = JSON.parse(res.text);
  } catch (err) {
    throw new ProviderError("parse", "coverartarchive",
      "index.json 不是合法 JSON（content-type=" + (res.contentType || "?") + "）：" + String(res.text).replace(/\s+/g, " ").slice(0, 160),
      { status: res.status, url: url, cause: err });
  }
  const images = requireArrayField(data, "images", "coverartarchive", "CAA index");
  const mapped = images.map(caaImageBlock);
  const record = caaReleaseOfRecord(data);
  const fronts = mapped.filter((i) => i.front);
  const backs = mapped.filter((i) => i.back);

  const notes = [
    "层级=" + ref.kind + "，共 " + mapped.length + " 张（front " + fronts.length + " / back " + backs.length + "）",
    ref.kind === "release-group" && record
      ? "这是 release-group 请求，CAA 307 到了它选定的发行版：" + (record.mbid || record.url)
        + "。图属于**那个 Release**，不是整组通用；写 Release 封面按 release_of_record 归位，不得沿用上级实体"
      : null,
    record && record.mbid && record.mbid !== ref.id
      ? "index 里的 release（" + record.mbid + "）与请求的 MBID（" + ref.id + "）不同，以上面那条为准"
      : null,
    "选图判据是 types 与 front/back：Case Front 是正面再摄＝与 Front 重复画面，Back / Case Back 才是另一面；"
      + "只查 HTTP 200 + image/* 就选图是本工具链明确禁止的做法（2026-09-25 封面复审教训）",
    "index.json 不提供像素尺寸，判定尺寸门槛必须真的打开图片",
  ].filter(Boolean).join("；");

  return readResult(res, "coverartarchive", {
    id: ref.id,
    title: null,
    image_url: fronts.length ? fronts[0].image_url : null,
    image_page_url: url,
    url: url,
    kind: ref.kind,
    mbid: ref.id,
    release_of_record: record,
    images: mapped,
    front_count: fronts.length,
    back_count: backs.length,
    notes: notes,
    rights_note: "CAA 的图由社区上传，逐张授权与来源不同；写入 pictures[] 前必须逐张核对授权与「这张图是不是这个版次自己的图」，不能整组照搬。",
    raw: { kind: ref.kind, mbid: ref.id, release: record ? record.url : null, images: mapped },
  });
}

// ───────────────────────── Kitsu ─────────────────────────

const KITSU_BASE = "https://kitsu.io/api/edge";
const KITSU_KINDS = ["anime", "manga"];

/** Kitsu 的 titles 键是任意语种（en / en_jp / ja_jp / zh_cn / ko_kr …）；en_jp 是罗马音而不是语种。 */
function kitsuLocaleKey(key) {
  const k = String(key == null ? "" : key).trim().toLowerCase();
  if (!k || k === "en_jp" || k === "en-jp") return null;
  const parts = k.replace(/_/g, "-").split("-");
  if (parts.length < 2) return parts[0];
  return parts[0] + "-" + parts.slice(1).map((p) => p.toUpperCase()).join("-");
}

function kitsuImageBlock(img) {
  if (!img || typeof img !== "object") return null;
  const dims = img.meta && img.meta.dimensions && typeof img.meta.dimensions === "object" ? img.meta.dimensions : {};
  const sizes: Record<string, any> = {};
  for (const key of ["tiny", "small", "medium", "large", "original"]) {
    const url = clean(img[key]);
    if (!url) continue;
    const d = dims[key] && typeof dims[key] === "object" ? dims[key] : null;
    sizes[key] = {
      url: url,
      width: d && Number.isFinite(d.width) ? d.width : null,
      height: d && Number.isFinite(d.height) ? d.height : null,
      short_edge: d && Number.isFinite(d.width) && Number.isFinite(d.height) ? Math.min(d.width, d.height) : null,
    };
  }
  return Object.keys(sizes).length ? sizes : null;
}

/**
 * 解析 Kitsu 标识：裸数字 id，或 kitsu.io/anime/<id|slug>、kitsu.io/manga/<id|slug> 链接。
 * 层级冲突（链接写 manga、操作是 kitsu.anime）抛 bad_input，不猜。
 */
export function normalizeKitsuRef(input, requestedKind) {
  const raw = String(input == null ? "" : input).trim();
  if (!raw) throw new ProviderError("bad_input", "kitsu", "缺少 Kitsu id 或链接");
  const m = raw.match(/kitsu\.(?:io|app)\/(anime|manga)\/([^/?#\s]+)/i);
  const urlKind = m ? m[1].toLowerCase() : null;
  const wanted = KITSU_KINDS.includes(requestedKind) ? requestedKind : null;
  if (urlKind && wanted && urlKind !== wanted) {
    throw new ProviderError("bad_input", "kitsu",
      "链接里的层级是 " + urlKind + "，但请求的操作是 kitsu." + wanted + "；两者不一致");
  }
  const kind = urlKind || wanted;
  if (!kind) {
    throw new ProviderError("bad_input", "kitsu", "必须指明层级：用 kitsu.anime 或 kitsu.manga，或给一条含 /anime/ 或 /manga/ 的链接");
  }
  const token = (m ? m[2] : raw).trim();
  if (/^\d{1,12}$/.test(token)) {
    if (Number(token) < 1) throw new ProviderError("bad_input", "kitsu", "Kitsu id 必须是正整数，实际：" + token);
    return { kind: kind, id: String(Number(token)), slug: null };
  }
  if (/^[a-z0-9][a-z0-9-]{0,120}$/i.test(token) && !/^https?:/i.test(token)) {
    return { kind: kind, id: null, slug: token.toLowerCase() };
  }
  throw new ProviderError("bad_input", "kitsu",
    "无法解析 Kitsu 标识：" + raw.slice(0, 80) + "（需要数字 id、slug，或 kitsu.io/<anime|manga>/<id|slug> 链接）");
}

export function kitsuPageUrl(kind, idOrSlug) {
  return "https://kitsu.io/" + kind + "/" + String(idOrSlug);
}

/** JSON:API 的 404 必须带 errors[].code=404 才算「提供方明确说没有」；否则按未知处理。 */
function kitsuNotFoundCode(res) {
  let codes = [];
  try {
    const body = JSON.parse(res.text);
    if (body && Array.isArray(body.errors)) codes = body.errors.map((e) => String((e && e.code) || "")).filter(Boolean);
  } catch {
    return null;
  }
  return codes.length ? codes.join(",") : null;
}

function requireKitsuEntry(value, kind, expectedId?: string, expectedSlug?: string) {
  const entry = requireObject(value, "kitsu", kind + " 条目");
  if (entry.type !== kind || !/^[1-9]\d{0,11}$/.test(String(entry.id ?? ""))) {
    throw new ProviderError("parse", "kitsu", "条目的 type 或 id 与请求层级不符", { retryable: false });
  }
  const attrs = requireObject(entry.attributes, "kitsu", kind + " attributes");
  if ((expectedId && String(entry.id) !== expectedId) || (expectedSlug && attrs.slug !== expectedSlug)) {
    throw new ProviderError("parse", "kitsu", "条目的身份标识与请求不一致", { retryable: false });
  }
  return entry;
}

function mapKitsuAttributes(attrs, kind, id) {
  const a = requireObject(attrs, "kitsu", kind + " attributes");
  const rawTitles = a.titles && typeof a.titles === "object" ? a.titles : {};
  const titles: Record<string, any> = {};
  for (const [key, value] of Object.entries(rawTitles)) {
    const locale = kitsuLocaleKey(key);
    const text = clean(value);
    if (locale && text) titles[locale] = text;
  }
  const poster = kitsuImageBlock(a.posterImage);
  const cover = kitsuImageBlock(a.coverImage);
  const slug = clean(a.slug);
  return {
    id: String(id),
    slug: slug,
    title: clean(a.canonicalTitle),
    titles: Object.keys(titles).length ? titles : null,
    romaji: clean(rawTitles.en_jp || rawTitles["en-jp"]),
    aliases: Array.isArray(a.abbreviatedTitles) ? a.abbreviatedTitles.map(clean).filter(Boolean) : [],
    synopsis: clean(a.synopsis),
    dates: {
      start: isoDate(a.startDate), start_raw: clean(a.startDate),
      end: isoDate(a.endDate), end_raw: clean(a.endDate),
      next_release: clean(a.nextRelease),
    },
    subtype: clean(a.subtype),
    status: clean(a.status),
    episode_count: Number.isFinite(a.episodeCount) ? a.episodeCount : null,
    episode_length: Number.isFinite(a.episodeLength) ? a.episodeLength : null,
    total_length: Number.isFinite(a.totalLength) ? a.totalLength : null,
    chapter_count: Number.isFinite(a.chapterCount) ? a.chapterCount : null,
    volume_count: Number.isFinite(a.volumeCount) ? a.volumeCount : null,
    age_rating: clean(a.ageRating),
    age_rating_guide: clean(a.ageRatingGuide),
    nsfw: a.nsfw === true,
    average_rating: Number.isFinite(Number(a.averageRating)) && a.averageRating != null ? Number(a.averageRating) : null,
    popularity_rank: Number.isFinite(a.popularityRank) ? a.popularityRank : null,
    youtube_video_id: clean(a.youtubeVideoId),
    poster: poster,
    cover_banner: cover,
    url: kitsuPageUrl(kind, slug || id),
  };
}

function kitsuResultNotes(mapped, kind) {
  const sourceHint = (mapped.synopsis || "").match(/\(Source:\s*([^)]{1,60})\)\s*$/i);
  return [
    "Kitsu 是社区聚合站，命中不等于权威：kind=" + kind + "、层级与身份锚点写入前仍须逐项核对",
    sourceHint
      ? "synopsis 末尾自带出处标注「Source: " + sourceHint[1].trim() + "」——那是简介的真实来源，按来源策略去核那一手页面，不要把 Kitsu 当出处"
      : "synopsis 没有 (Source: …) 标注，出处不明，写入 summary 前必须另找一手来源",
    "poster.meta.dimensions 给了各档宽高（见 poster.*.short_edge），按站内封面尺寸门槛判可用性；coverImage 是宽幅横幅不是海报，不作封面候选",
    mapped.titles ? "titles 已按 BCP-47 归一（Kitsu 的 ja_jp/zh_cn → ja-JP/zh-CN）；en_jp 是罗马音，单列在 romaji，不要当译名写入" : null,
    "relationships（cast/staff/genres/episodes）默认只给链接，需要时用 include= 另取，本连接器不自动展开",
  ].filter(Boolean).join("；");
}

/** 按 id 或 slug 取单条 anime/manga。 */
export async function fetchKitsuMedia(idOrUrl, opts) {
  const o = opts || {};
  const ref = normalizeKitsuRef(idOrUrl, o.kind);
  let url;
  let bySlug = false;
  if (ref.id) {
    url = KITSU_BASE + "/" + ref.kind + "/" + ref.id;
  } else {
    bySlug = true;
    url = KITSU_BASE + "/" + ref.kind + "?" + new URLSearchParams({ "filter[slug]": ref.slug, "page[limit]": "2" }).toString();
  }
  const res = await httpRequest(url, Object.assign({ provider: "kitsu", accept: "application/vnd.api+json" }, o));

  if (res.notFound) {
    if (bySlug) {
      throw new ProviderError("unavailable", "kitsu", "slug 检索端点返回 HTTP " + res.status + "，不能据此判定条目不存在",
        { status: res.status, url: url, retryable: true });
    }
    const code = kitsuNotFoundCode(res);
    if (code === null || !/(^|,)404(,|$)/.test(code)) {
      throw new ProviderError("unavailable", "kitsu",
        "HTTP " + res.status + " 但响应不是 JSON:API 的 404 错误体（errors[].code=" + (code || "无") + "）",
        { status: res.status, url: url, retryable: true, hint: "只有 code=404 的 JSON:API 错误体才是「记录不存在」的明确答复" });
    }
    return readResult(res, "kitsu", {
      found: false,
      id: ref.id || ref.slug,
      kind: ref.kind,
      url: kitsuPageUrl(ref.kind, ref.id || ref.slug),
      api_url: url,
      notes: "Kitsu 明确答复：" + ref.kind + " " + (ref.id || ref.slug) + " 不存在（HTTP 404 / errors.code=404）。"
        + "这只说明 Kitsu 没收录，不代表作品不存在——按来源策略换 Bangumi / AniList / 官方页核。"
        + "注意 anime 与 manga 是两套独立编号，同一数字在两层指不同条目：换层重试前先用 kitsu.search 确认。",
      raw: { kind: ref.kind, id: ref.id, slug: ref.slug, status: res.status, body: String(res.text || "").slice(0, 400) },
    });
  }

  let data;
  try {
    data = JSON.parse(res.text);
  } catch (err) {
    throw new ProviderError("parse", "kitsu", "响应不是合法 JSON：" + String(res.text).replace(/\s+/g, " ").slice(0, 160),
      { status: res.status, url: url, cause: err });
  }

  let entry = null;
  if (bySlug) {
    const hits = requireArrayField(data, "data", "kitsu", "slug 检索");
    if (hits.length > 1) {
      throw new ProviderError("parse", "kitsu", "slug=" + ref.slug + " 命中多条记录；请用 kitsu.search 确认数字 id", { retryable: false });
    }
    entry = hits.length ? requireObject(hits[0], "kitsu", "slug 条目") : null;
  } else {
    entry = requireObject(data, "kitsu", "详情").data;
    requireObject(entry, "kitsu", "详情 data");
  }
  if (!entry) {
    return readResult(res, "kitsu", {
      found: false,
      id: ref.id || ref.slug,
      kind: ref.kind,
      url: kitsuPageUrl(ref.kind, ref.slug),
      api_url: url,
      notes: "Kitsu 对 " + ref.kind + " slug=" + ref.slug + " 返回空结果集：该层级下没有这个 slug。"
        + "anime 与 manga 是两套独立 slug 空间，换层重试前先用 kitsu.search 确认。",
      raw: { kind: ref.kind, slug: ref.slug, status: res.status, body: String(res.text || "").slice(0, 400) },
    });
  }
  entry = requireKitsuEntry(entry, ref.kind, ref.id, ref.slug);
  const mapped = mapKitsuAttributes(entry.attributes, ref.kind, entry.id);

  return readResult(res, "kitsu", Object.assign({}, mapped, {
    kind: ref.kind,
    external_ids: { kitsu: mapped.id },
    image_url: mapped.poster && mapped.poster.large ? mapped.poster.large.url
      : (mapped.poster && mapped.poster.original ? mapped.poster.original.url : null),
    image_page_url: mapped.url,
    notes: kitsuResultNotes(mapped, ref.kind),
    rights_note: "图片托管在 media.kitsu.app，版权归原权利方；Kitsu 是社区聚合站，海报不等于官方发行版封面，写 pictures[] 前按字段来源策略核对具体版次。",
    raw: entry,
  }));
}

/** Kitsu 全文检索。meta.count=0 或 data 为空数组是明确的无命中。 */
export async function searchKitsu(query, opts) {
  const o = opts || {};
  const raw = String(query == null ? "" : query).trim();
  if (!raw) throw new ProviderError("bad_input", "kitsu", "检索词不能为空");
  const kind = KITSU_KINDS.includes(o.kind) ? o.kind : "anime";
  const limit = Number.isFinite(Number(o.limit)) && Number(o.limit) > 0 ? Math.min(20, Math.floor(Number(o.limit))) : 5;
  const url = KITSU_BASE + "/" + kind + "?" + new URLSearchParams({ "filter[text]": raw, "page[limit]": String(limit) }).toString();
  const res = await httpRequest(url, Object.assign({ provider: "kitsu", accept: "application/vnd.api+json" }, o));
  if (res.notFound) {
    throw new ProviderError("unavailable", "kitsu", "检索端点返回 HTTP " + res.status + "，不能据此判定无匹配条目",
      { status: res.status, url: url, retryable: true });
  }
  let data;
  try {
    data = JSON.parse(res.text);
  } catch (err) {
    throw new ProviderError("parse", "kitsu", "检索响应不是合法 JSON：" + String(res.text).replace(/\s+/g, " ").slice(0, 160),
      { status: res.status, url: url, cause: err });
  }
  const rows = requireArrayField(data, "data", "kitsu", "检索");
  const total = data.meta && Number.isFinite(data.meta.count) ? data.meta.count : null;
  const hits = rows.map((row) => {
    const item = requireKitsuEntry(row, kind);
    requireSearchItem(item, "kitsu", "检索", ["id"], ["attributes"]);
    const attrs = item.attributes || {};
    return {
      id: String(item.id),
      kind: kind,
      slug: clean(attrs.slug),
      title: clean(attrs.canonicalTitle),
      titles_zh: clean(attrs.titles && attrs.titles.zh_cn),
      titles_ja: clean(attrs.titles && attrs.titles.ja_jp),
      romaji: clean(attrs.titles && attrs.titles.en_jp),
      subtype: clean(attrs.subtype),
      status: clean(attrs.status),
      start_date: isoDate(attrs.startDate),
      episode_count: Number.isFinite(attrs.episodeCount) ? attrs.episodeCount : null,
      nsfw: attrs.nsfw === true,
      url: kitsuPageUrl(kind, clean(attrs.slug) || item.id),
      raw: attrs,
    };
  });
  return readResult(res, "kitsu", {
    found: hits.length > 0,
    id: hits[0] ? hits[0].id : null,
    title: hits[0] ? hits[0].title : null,
    image_url: null,
    url: hits[0] ? hits[0].url : url,
    kind: kind,
    notes: hits.length
      ? "候选 " + hits.length + " 条（meta.count=" + (total == null ? "?" : total) + "，kind=" + kind + "，limit=" + limit + "）；检索结果是候选，写入前用 kitsu.anime/kitsu.manga 取全字段并核对身份锚点"
      : "Kitsu 检索无命中（meta.count=" + (total == null ? "?" : total) + "，kind=" + kind + "）：换个检索词，或用 kitsu.manga 试另一层级；无命中不代表作品不存在",
    rights_note: "检索结果只含题名与日期等索引字段，不含图片授权信息。",
    raw: { kind: kind, query: raw, count: total, hits: hits },
  });
}

// ───────────────────────── VNDB ─────────────────────────

const VNDB_API = "https://api.vndb.org/kana";
const VNDB_PREFIX = { vn: "v", release: "r", character: "c", staff: "s", producer: "p" };

/**
 * 权威字段清单（2026-10-11 用 GET /kana/schema 的 api_fields 逐个核过）。
 * VNDB 严格校验 fields：写错字段名、或嵌套对象不给子字段，都会 HTTP 400 并指名是哪个字段。
 * 已知易错点：vn **没有** original（用 alttitle / titles）；release 的 languages 与 media
 * 必须写成 languages.lang,languages.title,mtl 与 media.medium,media.qty；staff **没有** birthday。
 */
export const VNDB_FIELDS = {
  vn: "title,alttitle,aliases,titles.lang,titles.latin,titles.main,titles.official,titles.title,"
    + "released,olang,languages,platforms,description,length,length_minutes,rating,popularity,votecount,"
    + "image.id,image.url,image.thumbnail,image.sexual,image.violence,image.dims,"
    + "developers.id,developers.name,developers.original,"
    + "extlinks.id,extlinks.label,extlinks.name,extlinks.url",
  release: "title,alttitle,released,minage,gtin,catalog,media.medium,media.qty,platforms,"
    + "languages.lang,languages.title,languages.mtl,"
    + "producers.id,producers.name,producers.developer,producers.publisher,"
    + "vns.id,vns.title,vns.rtype,official,patch,notes,"
    + "extlinks.id,extlinks.label,extlinks.name,extlinks.url",
  character: "name,original,aliases,gender,sex,birthday,blood_type,description,"
    + "image.id,image.url,image.sexual,image.violence,image.dims,"
    // vns.release 是嵌套对象（schema: {_inherit:"/release"}），不给子字段会 HTTP 400；
    // 这里只要「出现在哪些作品」，用 vns.id + vns.title 就够，不展开 release。
    + "vns.id,vns.title,vns.role,vns.spoiler",
  staff: "name,original,aliases.name,aliases.latin,aliases.aid,aliases.ismain,gender,description,"
    + "extlinks.id,extlinks.name,extlinks.url",
};

/** 解析 VNDB 标识：v17 / 17 / https://vndb.org/v17；层级与操作不符时抛 bad_input。 */
export function normalizeVndbId(input, kind) {
  const p = "vndb";
  const prefix = VNDB_PREFIX[kind];
  if (!prefix) throw new ProviderError("bad_input", p, "未知的 VNDB 层级：" + kind);
  const raw = String(input == null ? "" : input).trim();
  if (!raw) throw new ProviderError("bad_input", p, "缺少 VNDB " + kind + " id");
  const fromUrl = raw.match(/vndb\.org\/([vrcsp])(\d{1,8})(?:[/?#]|$)/i);
  if (fromUrl) {
    if (fromUrl[1].toLowerCase() !== prefix) {
      throw new ProviderError("bad_input", p,
        "链接里的层级是 " + fromUrl[1].toLowerCase() + "，但本操作要的是 " + prefix + "（" + kind + "）；层级不可互换");
    }
    return prefix + String(Number(fromUrl[2]));
  }
  if (/^\d{1,8}$/.test(raw)) return prefix + String(Number(raw));
  if (new RegExp("^" + prefix + "\\d{1,8}$", "i").test(raw)) return prefix + String(Number(raw.slice(1)));
  throw new ProviderError("bad_input", p,
    "无法解析 VNDB " + kind + " id：" + raw.slice(0, 60) + "（需要 " + prefix + " 后跟数字、裸数字，或 vndb.org/" + prefix + "<数字> 链接）");
}

export function vndbPageUrl(kind, id) {
  return "https://vndb.org/" + String(id);
}

/**
 * released 用 00 表示未知的月/日：「2003-05-00」＝2003 年 5 月、「2003-00-00」＝2003 年。
 * 直接丢给 isoDate 会把 00 当成合法月日，所以先按 VNDB 口径降级到能确证的精度。
 */
export function vndbReleased(value) {
  const s = String(value == null ? "" : value).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return isoDate(s);
  if (m[2] === "00") return m[3] === "00" ? m[1] : null;
  if (m[3] === "00") return m[1] + "-" + m[2];
  return s;
}

/** description 是 BBCode：机械去标签给出纯文本，原文一律保留在 raw 里。 */
export function vndbStripBbcode(value) {
  const s = String(value == null ? "" : value);
  if (!s.trim()) return null;
  const out = s
    .replace(/\[url=[^\]]*\]([\s\S]*?)\[\/url\]/gi, "$1")
    .replace(/\[(?:url|spoiler|quote|code|raw|b|i|u|s)(?:=[^\]]*)?\]/gi, "")
    .replace(/\[\/(?:url|spoiler|quote|code|raw|b|i|u|s)\]/gi, "")
    // 只清"长得像标签"的残留（纯字母标签名，可带 =参数）；不能按"方括号里 ≤40 字"一刀切——
    // 那会把 [From Wikipedia] 这类**出处证据**一起吃掉，而它恰恰是最该留下的东西。
    .replace(/\[[a-z]{1,12}(?:=[^\]]*)?\]/gi, "")
    .replace(/\[\/[a-z]{1,12}\]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return out || null;
}

async function vndbPost(endpoint, payload, o) {
  const url = VNDB_API + "/" + endpoint;
  // Content-Type 必须留住：Object.assign 里 o 在后会整体替换 headers，所以合并完再放回。
  const headers = Object.assign({ "Content-Type": "application/json" }, o.headers || {});
  let res;
  try {
    res = await httpRequest(url, Object.assign({
      provider: "vndb",
      method: "POST",
      body: JSON.stringify(payload),
      accept: "application/json",
    }, o, { headers: headers }));
  } catch (err) {
    // 400 是 API 在指名字段/过滤器不合法：转成 bad_input 并给出可执行的下一步，别让人继续试错。
    if (err instanceof ProviderError && err.kind === "http" && err.status === 400) {
      throw new ProviderError("bad_input", "vndb",
        "VNDB API 拒绝请求：" + err.message.replace(/^\[vndb\/http\]\s*/, ""),
        {
          status: 400, url: url, retryable: false,
          hint: "字段名或 filters 形状不合法。嵌套对象必须显式给子字段（titles.lang,titles.title / media.medium,media.qty / languages.lang）。"
            + "权威字段名用 vndb.schema 查；分页参数是 results 不是 count。",
        });
    }
    throw err;
  }
  if (res.notFound) {
    throw new ProviderError("unavailable", "vndb", "API 端点返回 HTTP " + res.status + "，不能据此判定空结果集",
      { status: res.status, url: url, retryable: true });
  }
  let data;
  try {
    data = JSON.parse(res.text);
  } catch (err) {
    throw new ProviderError("parse", "vndb", "响应不是合法 JSON：" + String(res.text).replace(/\s+/g, " ").slice(0, 160),
      { status: res.status, url: url, cause: err });
  }
  return { ...res, data };
}

function vndbResultSet(res, endpoint) {
  const rows = requireArrayField(res.data, "results", "vndb", endpoint);
  if (typeof res.data.more !== "boolean") {
    throw new ProviderError("parse", "vndb", endpoint + " 响应缺少 boolean more", { retryable: false });
  }
  return { rows: rows, more: res.data.more };
}

function requireVndbSingle(rows, endpoint, expectedId) {
  const row = requireObject(rows[0], "vndb", endpoint);
  if (rows.length !== 1 || row.id !== expectedId) {
    throw new ProviderError("parse", "vndb", endpoint + " 条目的身份标识与请求不一致", { retryable: false });
  }
  return row;
}

function vndbExtlinks(row) {
  if (!Array.isArray(row.extlinks)) return null;
  const out = row.extlinks.map((e) => ({
    name: clean(e && e.name), label: clean(e && e.label), url: clean(e && e.url),
  })).filter((e) => e.url);
  return out.length ? out : null;
}

/** VN 条目：题名/别名/多语题名/发行日/平台/开发方/评分与封面（含社区性暴力投票数）。 */
export async function fetchVndbVn(idOrUrl, opts) {
  const o = opts || {};
  const id = normalizeVndbId(idOrUrl, "vn");
  const res = await vndbPost("vn", { filters: ["id", "=", id], results: 1, fields: VNDB_FIELDS.vn }, o);
  const { rows } = vndbResultSet(res, "vn");
  const url = vndbPageUrl("vn", id);
  if (!rows.length) {
    return readResult(res, "vndb", {
      found: false, id: id, url: url,
      notes: "VNDB 对 " + id + " 返回空结果集：该条目不存在或已被撤回。这只说明 VNDB 没有，不代表作品不存在。",
      raw: { id: id, status: res.status, results: rows },
    });
  }
  const row = requireVndbSingle(rows, "vn", id);
  const titlesByLang: Record<string, any> = {};
  const titleList = Array.isArray(row.titles) ? row.titles.map((t) => {
    const lang = clean(t && t.lang);
    const title = clean(t && t.title);
    if (lang && title) titlesByLang[lang] = { title: title, latin: clean(t.latin), main: t.main === true, official: t.official === true };
    return { lang: lang, title: title, latin: clean(t && t.latin), main: t && t.main === true, official: t && t.official === true };
  }) : [];
  const image = row.image && typeof row.image === "object" ? row.image : null;
  const released = vndbReleased(row.released);
  const developers = Array.isArray(row.developers)
    ? row.developers.map((d) => ({ id: clean(d && d.id), name: clean(d && d.name), original: clean(d && d.original) })).filter((d) => d.name)
    : [];

  return readResult(res, "vndb", {
    id: id,
    title: clean(row.title),
    titles: Object.keys(titlesByLang).length ? titlesByLang : null,
    image_url: clean(image && image.url),
    image_page_url: url,
    dates: { release: released, release_raw: clean(row.released) },
    external_ids: { vndb: id },
    url: url,
    alttitle: clean(row.alttitle),
    aliases: Array.isArray(row.aliases) ? row.aliases.map(clean).filter(Boolean) : [],
    title_variants: titleList,
    description: clean(row.description),
    description_text: vndbStripBbcode(row.description),
    languages: Array.isArray(row.languages) ? row.languages.map(clean).filter(Boolean) : [],
    original_language: clean(row.olang),
    platforms: Array.isArray(row.platforms) ? row.platforms.map(clean).filter(Boolean) : [],
    length: Number.isFinite(row.length) ? row.length : null,
    length_minutes: Number.isFinite(row.length_minutes) ? row.length_minutes : null,
    rating: Number.isFinite(row.rating) ? row.rating : null,
    popularity: Number.isFinite(row.popularity) ? row.popularity : null,
    votecount: Number.isFinite(row.votecount) ? row.votecount : null,
    developers: developers,
    extlinks: vndbExtlinks(row),
    image_meta: image ? {
      id: clean(image.id), thumbnail: clean(image.thumbnail),
      dims: image.dims || null,
      sexual_votes: Number.isFinite(image.sexual) ? image.sexual : null,
      violence_votes: Number.isFinite(image.violence) ? image.violence : null,
    } : null,
    notes: [
      "released 原文「" + (clean(row.released) || "无") + "」→ " + (released || "无法确证，精度见原文")
      + "（VNDB 用 00 表示未知的月/日）",
      "description 是 BBCode，且常带 [url=…Wikipedia[/url]] 这类出处标注：那既是转写义务，也是简介的真实来源线索，按来源策略去核那一手页面",
      "image.sexual / image.violence 是社区投票数，不是分级结论；dims 是像素宽高，可据此判封面尺寸门槛",
      "本操作只给 VN 层；版次（品番/条码/载体/权利方分工）要用 vndb.releases 另取",
    ].join("；"),
    rights_note: "VNDB 图片由社区上传，逐张授权不同；写入 pictures[] 前逐张核对，不能只看 HTTP 200。",
    raw: row,
  });
}

/**
 * 某 VN 下的版次列表。这里是 VNDB 最值钱的部分：gtin（条码）、catalog（品番）、
 * media（载体与枚数）、producers 的 developer/publisher 分工、minage（分级）都是社区转录字段。
 */
export async function fetchVndbReleases(vnIdOrUrl, opts) {
  const o = opts || {};
  const vnId = normalizeVndbId(vnIdOrUrl, "vn");
  const res = await vndbPost("release", {
    filters: ["vn", "=", ["id", "=", vnId]],
    results: Number.isFinite(Number(o.limit)) && Number(o.limit) > 0 ? Math.min(50, Math.floor(Number(o.limit))) : 25,
    fields: VNDB_FIELDS.release,
  }, o);
  const { rows, more } = vndbResultSet(res, "release");
  if (!rows.length) {
    return readResult(res, "vndb", {
      found: false, id: vnId, url: vndbPageUrl("vn", vnId),
      notes: "VNDB 对 " + vnId + " 返回空版次集：该 VN 没有登记任何 release。不能据此断定它没有发行版——官方商品页仍可能刊出。",
      raw: { vn: vnId, status: res.status, results: rows },
    });
  }
  const releases = rows.map((entry) => {
    const row = requireObject(entry, "vndb", "release");
    if (!/^r[1-9]\d{0,7}$/.test(String(row.id ?? "")) || !Array.isArray(row.vns) || !row.vns.some(vn => vn && vn.id === vnId)) {
      throw new ProviderError("parse", "vndb", "release 的标识或所属 VN 与请求不一致", { retryable: false });
    }
    const gtin = clean(row.gtin);
    return {
      id: clean(row.id),
      title: clean(row.title),
      alttitle: clean(row.alttitle),
      released: vndbReleased(row.released),
      released_raw: clean(row.released),
      minage: Number.isFinite(row.minage) ? row.minage : null,
      gtin: gtin,
      gtin_scheme: gtin ? (GTIN_SCHEMES[gtin.length] || null) : null,
      gtin_checksum_valid: gtin ? gtinCheckDigitValid(gtin) : null,
      catalog_number: clean(row.catalog),
      media: Array.isArray(row.media)
        ? row.media.map((m) => ({ medium: clean(m && m.medium), qty: Number.isFinite(m && m.qty) ? m.qty : null })).filter((m) => m.medium)
        : [],
      platforms: Array.isArray(row.platforms) ? row.platforms.map(clean).filter(Boolean) : [],
      languages: Array.isArray(row.languages)
        ? row.languages.map((l) => ({ lang: clean(l && l.lang), title: clean(l && l.title), machine_translation: l && l.mtl === true }))
        : [],
      producers: Array.isArray(row.producers)
        ? row.producers.map((p) => ({ id: clean(p && p.id), name: clean(p && p.name), developer: p && p.developer === true, publisher: p && p.publisher === true })).filter((p) => p.name)
        : [],
      official: row.official === true,
      patch: row.patch === true,
      notes: clean(row.notes),
      extlinks: vndbExtlinks(row),
      url: row.id ? vndbPageUrl("release", row.id) : null,
      raw: row,
    };
  });
  return readResult(res, "vndb", {
    found: true,
    id: vnId,
    title: null,
    url: vndbPageUrl("vn", vnId),
    releases: releases,
    release_count: releases.length,
    notes: [
      "VN " + vnId + " 下 " + releases.length + " 个版次" + (more ? "（more=true，还有更多，用 limit 提高上限或分页）" : ""),
      "gtin 是条码、catalog 是品番、media 是载体与枚数：这三项是建 Release / Medium 的社区候选，身份判断需核原始出处；gtin_checksum_valid 只是校验位提示，不是存在性证明",
      "producers 里 publisher=true 才是发行方、developer=true 是开发方，二者常是同一家也可能不同；建 agent 与署名关系前按来源策略核对权利链",
      "minage 是 VNDB 的年龄分级数字，不等于站内 content_rating 词表；映射前查 definitions",
      "官方/同人（official）与补丁（patch）会影响它算不算一个独立版次，写入前判断",
    ].join("；"),
    rights_note: "版次字段由 VNDB 社区维护、多来自官方页转录；写入前与厂牌官方商品页对一次，冲突时以权利方页面为准。",
    raw: { vn: vnId, more: more, results: releases.map((r) => r.raw) },
  });
}

/** 角色条目。 */
export async function fetchVndbCharacter(idOrUrl, opts) {
  const o = opts || {};
  const id = normalizeVndbId(idOrUrl, "character");
  const res = await vndbPost("character", { filters: ["id", "=", id], results: 1, fields: VNDB_FIELDS.character }, o);
  const { rows } = vndbResultSet(res, "character");
  const url = vndbPageUrl("character", id);
  if (!rows.length) {
    return readResult(res, "vndb", {
      found: false, id: id, url: url,
      notes: "VNDB 对角色 " + id + " 返回空结果集：该条目不存在。",
      raw: { id: id, status: res.status, results: rows },
    });
  }
  const row = requireVndbSingle(rows, "character", id);
  const image = row.image && typeof row.image === "object" ? row.image : null;
  return readResult(res, "vndb", {
    id: id,
    title: clean(row.name),
    image_url: clean(image && image.url),
    image_page_url: url,
    external_ids: { vndb_character: id },
    url: url,
    original_name: clean(row.original),
    aliases: Array.isArray(row.aliases) ? row.aliases.map(clean).filter(Boolean) : [],
    gender: clean(row.gender),
    sex: clean(row.sex),
    birthday: clean(row.birthday),
    blood_type: clean(row.blood_type),
    description: clean(row.description),
    description_text: vndbStripBbcode(row.description),
    appears_in: Array.isArray(row.vns)
      ? row.vns.map((v) => ({
        id: clean(v && v.id),
        title: clean(v && v.title),
        role: clean(v && v.role),
        spoiler: Number.isFinite(v && v.spoiler) ? v.spoiler : null,
      }))
      : [],
    image_meta: image ? {
      id: clean(image.id),
      dims: image.dims || null,
      sexual_votes: Number.isFinite(image.sexual) ? image.sexual : null,
      violence_votes: Number.isFinite(image.violence) ? image.violence : null,
    } : null,
    notes: "角色名 VNDB 用 name（多为拉丁转写）+ original（原文）两栏；写站内 agent 时按语种键归位，别把转写当原文。gender 是身份表述、sex 是生理表述，VNDB 两者分列，不要混填。appears_in 里的 spoiler 是剧透等级，公开简介不要引用高剧透条目。",
    rights_note: "角色图由社区上传，逐张授权不同；配角立绘常低于站内尺寸门槛，dims 是像素宽高，先量再写。",
    raw: row,
  });
}

/** 制作人员条目。注意 staff 没有 birthday 字段（schema 核过）。 */
export async function fetchVndbStaff(idOrUrl, opts) {
  const o = opts || {};
  const id = normalizeVndbId(idOrUrl, "staff");
  const res = await vndbPost("staff", { filters: ["id", "=", id], results: 1, fields: VNDB_FIELDS.staff }, o);
  const { rows } = vndbResultSet(res, "staff");
  const url = vndbPageUrl("staff", id);
  if (!rows.length) {
    return readResult(res, "vndb", {
      found: false, id: id, url: url,
      notes: "VNDB 对职员 " + id + " 返回空结果集：该条目不存在。",
      raw: { id: id, status: res.status, results: rows },
    });
  }
  const row = requireVndbSingle(rows, "staff", id);
  const aliases = Array.isArray(row.aliases)
    ? row.aliases.map((a) => ({ aid: clean(a && a.aid), name: clean(a && a.name), latin: clean(a && a.latin), is_main: a && a.ismain === true }))
    : [];
  return readResult(res, "vndb", {
    id: id,
    title: clean(row.name),
    external_ids: { vndb_staff: id },
    url: url,
    original_name: clean(row.original),
    aliases: aliases,
    gender: clean(row.gender),
    description: clean(row.description),
    description_text: vndbStripBbcode(row.description),
    extlinks: vndbExtlinks(row),
    notes: "name 是拉丁转写、original 是原文；aliases 里 ismain=true 的那条才是主名。VNDB 的 staff 没有生日字段，别把别处看到的生日当成 VNDB 佐证。",
    raw: row,
  });
}

/** 权威字段名与枚举：给 fields/filters 报错时查，不必试错。参数被忽略但不能为空。 */
export async function fetchVndbSchema(_arg, opts) {
  const o = opts || {};
  const url = VNDB_API + "/schema";
  const res = await httpRequest(url, Object.assign({ provider: "vndb", accept: "application/json" }, o));
  if (res.notFound) {
    throw new ProviderError("unavailable", "vndb", "schema 端点返回 HTTP " + res.status,
      { status: res.status, url: url, retryable: true });
  }
  let data;
  try {
    data = JSON.parse(res.text);
  } catch (err) {
    throw new ProviderError("parse", "vndb", "schema 响应不是合法 JSON：" + String(res.text).replace(/\s+/g, " ").slice(0, 160),
      { status: res.status, url: url, cause: err });
  }
  const body = requireObject(data, "vndb", "schema");
  const apiFields = requireObject(body.api_fields, "vndb", "schema.api_fields");
  const endpoints = Object.keys(apiFields).sort();
  const fields: Record<string, any> = {};
  for (const ep of endpoints) {
    fields[ep] = Object.keys(apiFields[ep] || {}).sort();
  }
  return readResult(res, "vndb", {
    found: true,
    id: null,
    title: null,
    url: url,
    endpoints: endpoints,
    fields: fields,
    enums: body.enums && typeof body.enums === "object" ? Object.keys(body.enums).sort() : [],
    extlinks: body.extlinks && typeof body.extlinks === "object" ? Object.keys(body.extlinks).sort() : [],
    notes: "这是 VNDB API v2 的权威字段清单：fields 里嵌套对象（值为 object）必须显式给子字段，否则 HTTP 400。"
      + "分页参数是 results 不是 count。本连接器实际使用的字段见 VNDB_FIELDS。",
    raw: body,
  });
}

// ───────────────────────── OpenBD ─────────────────────────

const OPENBD_BASE = "https://api.openbd.jp/v1";

/** "201612" → "2016-12"，"20161210" → "2016-12-10"，"2016" → "2016"；其余不猜。 */
export function openbdPubdate(value) {
  const s = String(value == null ? "" : value).trim();
  if (/^\d{8}$/.test(s)) return s.slice(0, 4) + "-" + s.slice(4, 6) + "-" + s.slice(6, 8);
  if (/^\d{6}$/.test(s)) return s.slice(0, 4) + "-" + s.slice(4, 6);
  if (/^\d{4}$/.test(s)) return s;
  return isoDate(s);
}

function openbdOnixPaths(onix) {
  const o = onix && typeof onix === "object" ? onix : {};
  const desc = o.DescriptiveDetail && typeof o.DescriptiveDetail === "object" ? o.DescriptiveDetail : {};
  const titleElement = desc.TitleDetail && desc.TitleDetail.TitleElement ? desc.TitleDetail.TitleElement : null;
  const titleText = titleElement && titleElement.TitleText ? titleElement.TitleText : null;
  const contributors = Array.isArray(desc.Contributor) ? desc.Contributor : [];
  const collection = desc.Collection && desc.Collection.TitleDetail && Array.isArray(desc.Collection.TitleDetail.TitleElement)
    ? desc.Collection.TitleDetail.TitleElement : [];
  const pub = o.PublishingDetail && typeof o.PublishingDetail === "object" ? o.PublishingDetail : {};
  const supply = o.ProductSupply && o.ProductSupply.SupplyDetail ? o.ProductSupply.SupplyDetail : {};
  const prices = Array.isArray(supply.Price) ? supply.Price : [];
  return {
    record_reference: clean(o.RecordReference),
    notification_type: clean(o.NotificationType),
    title_text: clean(titleText && titleText.content),
    title_collationkey: clean(titleText && titleText.collationkey),
    subtitle: clean(desc.TitleDetail && desc.TitleDetail.TitleElement && desc.TitleDetail.TitleElement.Subtitle
      ? desc.TitleDetail.TitleElement.Subtitle.content : null),
    contributors: contributors.map((c) => ({
      sequence: clean(c && c.SequenceNumber),
      roles: Array.isArray(c && c.ContributorRole) ? c.ContributorRole.map(clean).filter(Boolean) : [],
      name: clean(c && c.PersonName && c.PersonName.content),
      name_collationkey: clean(c && c.PersonName && c.PersonName.collationkey),
      inverted: clean(c && c.PersonNameInverted && c.PersonNameInverted.content),
    })).filter((c) => c.name || c.inverted),
    collection: collection.map((el) => ({
      part_number: clean(el && el.PartNumber),
      title: clean(el && el.TitleText && el.TitleText.content),
      level: clean(el && el.TitleElementLevel),
    })).filter((c) => c.title),
    imprint: clean(pub.Imprint && pub.Imprint.ImprintName),
    publisher: clean(pub.Publisher && (Array.isArray(pub.Publisher) ? null : pub.Publisher.PublisherName)),
    publishing_dates: Array.isArray(pub.PublishingDate)
      ? pub.PublishingDate.map((d) => ({ role: clean(d && d.PublishingDateRole), date: clean(d && d.Date), normalized: openbdPubdate(d && d.Date) }))
      : [],
    availability: clean(supply.ProductAvailability),
    prices: prices.map((p) => ({
      type: clean(p && p.PriceType), currency: clean(p && p.CurrencyCode),
      amount: clean(p && p.PriceAmount),
    })),
  };
}

function isbnIdentity(value) {
  const compact = String(value ?? "").replace(/[\s-]/g, "").toUpperCase();
  if (ISBN_13_SHAPE.test(compact)) return compact;
  if (!ISBN_10_SHAPE.test(compact)) return null;
  const base = "978" + compact.slice(0, 9);
  const sum = Array.from(base).reduce((total, digit, index) => total + Number(digit) * (index % 2 ? 3 : 1), 0);
  return base + String((10 - sum % 10) % 10);
}

function requireOpenbdIdentity(record, expectedIsbn) {
  const anchors = [];
  if (record.summary && record.summary.isbn != null) anchors.push(record.summary.isbn);
  const onix = record.onix && typeof record.onix === "object" ? record.onix : {};
  if (isbnIdentity(onix.RecordReference)) anchors.push(onix.RecordReference);
  if (Array.isArray(onix.ProductIdentifier)) {
    for (const identifier of onix.ProductIdentifier) {
      if (identifier && ["02", "03", "15"].includes(String(identifier.ProductIDType))) anchors.push(identifier.IDValue);
    }
  }
  const expected = isbnIdentity(expectedIsbn);
  if (!anchors.length || anchors.some(value => isbnIdentity(value) !== expected)) {
    throw new ProviderError("parse", "openbd", "书目记录的 ISBN 缺失或与请求不一致", { retryable: false });
  }
}

/**
 * 按 ISBN 取 OpenBD 书目记录。查无是 HTTP 200 + [null]；HTTP 404 说明**路径**不对
 * （端点是查询参数 ?isbn=，不是 /get/{isbn}），绝不能映射成 found:false。
 */
export async function lookupOpenbdByIsbn(isbnOrUrl, opts) {
  const o = opts || {};
  const isbn = normalizeIsbn(isbnOrUrl, "openbd");
  const url = OPENBD_BASE + "/get?" + new URLSearchParams({ isbn: isbn }).toString();
  const res = await httpRequest(url, Object.assign({ provider: "openbd", accept: "application/json" }, o));

  if (res.notFound) {
    throw new ProviderError("unavailable", "openbd",
      "HTTP " + res.status + "：OpenBD 的查询端点是 /v1/get?isbn=<ISBN>，路径形态不对时才会 404",
      { status: res.status, url: url, retryable: false, hint: "查无此书是 HTTP 200 + [null]，不是 404；不要把 404 当成「这本书不存在」" });
  }

  let rows;
  try {
    rows = JSON.parse(res.text);
  } catch (err) {
    throw new ProviderError("parse", "openbd", "响应不是合法 JSON：" + String(res.text).replace(/\s+/g, " ").slice(0, 160),
      { status: res.status, url: url, cause: err });
  }
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new ProviderError("parse", "openbd", "单 ISBN 响应必须是 [记录] 或 [null]，且恰有一项",
      { status: res.status, url: url });
  }
  const checksum = isbnCheckDigit(isbn);

  if (rows[0] === null) {
    return readResult(res, "openbd", {
      found: false,
      id: isbn,
      url: url,
      external_ids: { openbd: isbn },
      notes: "OpenBD 对 ISBN " + isbn + " 返回 [null]：没有收录。"
        + (checksum.valid === false ? "另外该 ISBN 校验位不通过（" + checksum.scheme + "），先确认这串数字是不是写错了。" : "")
        + "OpenBD 只收日本出版物——台版、繁中版、简体引进版返回 [null] 是收录范围问题，不是站点故障，"
        + "更不能据此判定该书不存在；繁中版走台灣角川官方商店，简体版另找版元页。",
      raw: { isbn: isbn, status: res.status, body: rows, checksum: checksum },
    });
  }

  const record = requireObject(rows[0], "openbd", "记录");
  requireOpenbdIdentity(record, isbn);
  const summary = record.summary && typeof record.summary === "object" ? record.summary : {};
  const onix = openbdOnixPaths(record.onix);
  const hanmoto = record.hanmoto && typeof record.hanmoto === "object" ? record.hanmoto : null;
  const pubdates = onix.publishing_dates.filter((d) => d.normalized);
  const cover = clean(summary.cover);
  // summary.volume 是 ONIX 的 Collection PartNumber，也就是**丛书序号**而不是巻号：
  // 实测 9784048923514 的 volume=3159（電撃文庫第 3159 号），真正的巻号 10 只在题名
  // 「僕と彼女のゲーム戦争. 10」里。叫 volume 会让代理把丛书序号当巻号写进站内。
  const collectionPartNumber = clean(summary.volume);
  const series = clean(summary.series);

  return readResult(res, "openbd", {
    id: isbn,
    title: clean(summary.title) || onix.title_text,
    image_url: cover,
    // OpenBD 没有可核读的人类页面：www.openbd.jp 本机实测 http=000，/v1/coverage 又会忽略 isbn
    // 参数返回全量清单（实测 59MB）。证据 URL 就用实际读到的这个 API 地址。
    image_page_url: null,
    dates: {
      publish: openbdPubdate(summary.pubdate) || (pubdates[0] ? pubdates[0].normalized : null),
      publish_raw: clean(summary.pubdate),
      candidates: pubdates,
    },
    external_ids: { openbd: isbn },
    url: url,
    isbn: isbn,
    isbn_checksum: checksum,
    collection_part_number: collectionPartNumber,
    series: series,
    publisher: clean(summary.publisher) || onix.imprint,
    imprint: onix.imprint,
    authors: Array.isArray(summary.author) ? summary.author.map(clean).filter(Boolean)
      : (clean(summary.author) ? [clean(summary.author)] : onix.contributors.map((c) => c.name).filter(Boolean)),
    onix: onix,
    hanmoto: hanmoto,
    prices: onix.prices,
    notes: [
      "summary 是 OpenBD 规整后的值，onix 是完整原文；两者不一致时以 onix 逐字核对，别只信 summary",
      "summary.title 可能缺副题或标点（实测電撃文庫某卷少一个「.」）：题名以版元商品页 h1 为准，OpenBD 只用来复核巻号·丛书·刊行年月",
      collectionPartNumber
        ? "collection_part_number=" + collectionPartNumber + " 是**丛书序号**（ONIX Collection PartNumber，本次丛书＝"
          + (series || "未给") + "），不是巻号；巻号只出现在题名文字里（本例「. 10」），要写 volume 字段请从版元商品页逐字确认，不要把丛书序号当巻号"
        : null,
      "author 是 ONIX 倒装形（实测「師走,トオル」＝姓,名），写站内 agent 前按语种与姓名顺序核对",
      pubdates.length
        ? "PublishingDate 的 role 是 ONIX 代码（本次：" + pubdates.map((d) => d.role).join(",") + "），连接器不猜代码含义，原样给出；判定 edition_date 前先确认用的是哪个 role"
        : "本次响应没有可归一的 PublishingDate",
      cover ? "summary.cover 有值" : "summary.cover 为空（cover.openbd.jp/<isbn>.jpg 在无封面时 404）：OpenBD 没有封面不代表该版次没有封面，去版元商品页找",
      checksum.valid === false ? "ISBN 校验位不通过（" + checksum.scheme + "）：先核对这串数字，不要照写进站内" : null,
    ].filter(Boolean).join("；"),
    rights_note: "OpenBD 是书目登记数据（题名/丛书/刊行年月/价格），不含图片授权；封面另按来源策略核。",
    raw: record,
  });
}

// ───────────────────────── Project Gutenberg ─────────────────────────

const GUTENBERG_BASE = "https://www.gutenberg.org";

/** 解析 ebook id：1513 / ebooks/1513 / https://www.gutenberg.org/ebooks/1513 / …/ebooks/1513.html.images */
export function normalizeGutenbergId(input) {
  const raw = String(input == null ? "" : input).trim();
  if (!raw) throw new ProviderError("bad_input", "gutenberg", "缺少 ebook id 或链接");
  const m = raw.match(/gutenberg\.org\/(?:ebooks|files|cache\/epub)\/(\d{1,7})(?:[./?#]|$)/i) || raw.match(/^ebooks\/(\d{1,7})$/i);
  const id = m ? m[1] : (/^\d{1,7}$/.test(raw) ? raw : null);
  if (!id) {
    throw new ProviderError("bad_input", "gutenberg",
      "无法解析 Gutenberg ebook id：" + raw.slice(0, 80) + "（需要纯数字 id，或 gutenberg.org/ebooks/<id> 链接）");
  }
  if (Number(id) < 1) throw new ProviderError("bad_input", "gutenberg", "ebook id 必须是正整数，实际：" + id);
  return String(Number(id));
}

export function gutenbergRdfUrl(id) {
  return GUTENBERG_BASE + "/cache/epub/" + id + "/pg" + id + ".rdf";
}

export function gutenbergPageUrl(id) {
  return GUTENBERG_BASE + "/ebooks/" + id;
}

/** XML 实体还原，但不像 clean() 那样吞掉标签与换行结构。 */
function xmlText(value) {
  const s = String(value == null ? "" : value)
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&")
    .trim();
  return s || null;
}

function rdfBlocks(text, tag) {
  const out = [];
  const re = new RegExp("<" + tag + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + tag + ">", "g");
  let m = re.exec(String(text || ""));
  while (m) { out.push(m[1]); m = re.exec(String(text || "")); }
  return out;
}

function rdfValue(block, tag) {
  const m = String(block || "").match(new RegExp("<" + tag + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + tag + ">"));
  return m ? xmlText(m[1]) : null;
}

function rdfResourceAttr(block, tag) {
  const m = String(block || "").match(new RegExp("<" + tag + "(?:\\s[^>]*?)?rdf:resource=\"([^\"]+)\""));
  return m ? m[1] : null;
}

function parseGutenbergAgent(block) {
  const about = (String(block).match(/<pgterms:agent\s+rdf:about="([^"]+)"/) || [])[1] || null;
  const aliases = [];
  const re = /<pgterms:alias>([\s\S]*?)<\/pgterms:alias>/g;
  let m = re.exec(String(block));
  while (m) { const v = xmlText(m[1]); if (v) aliases.push(v); m = re.exec(String(block)); }
  return {
    name: rdfValue(block, "pgterms:name"),
    birthdate: rdfValue(block, "pgterms:birthdate"),
    deathdate: rdfValue(block, "pgterms:deathdate"),
    aliases: aliases,
    webpage: rdfResourceAttr(block, "pgterms:webpage"),
    agent_url: about ? GUTENBERG_BASE + "/" + String(about).replace(/^\/+/, "") : null,
  };
}

/**
 * 解析 pg{id}.rdf。日期一律取 RDF 的 dcterms:issued：同一本书的 HTML 页面里
 * RDFa content 属性是交叉错位的（实测 1513：property="dcterms:issued" content="2025-09-18"
 * 其实是最后更新日，property="dcterms:modified" content="1998-11-01" 才是发行日）。
 */
export function parseGutenbergRdf(text, expectedId) {
  const body = String(text == null ? "" : text);
  if (!/<pgterms:ebook/i.test(body)) {
    throw new ProviderError("parse", "gutenberg",
      "响应不是 Gutenberg 的 ebook RDF（缺 pgterms:ebook 根元素）：" + body.replace(/\s+/g, " ").slice(0, 160),
      { retryable: false });
  }
  const about = (body.match(/<pgterms:ebook\b[^>]*\brdf:about=["']([^"']+)["']/i) || [])[1] || null;
  const fromAbout = about ? String(about).match(/^(?:https?:\/\/www\.gutenberg\.org\/)?ebooks\/([1-9]\d*)$/) : null;
  if (!fromAbout) {
    throw new ProviderError("parse", "gutenberg", "RDF 缺少可识别的 ebook rdf:about 身份标识", { retryable: false });
  }
  const id = fromAbout[1];
  if (expectedId && id && String(id) !== String(expectedId)) {
    throw new ProviderError("parse", "gutenberg",
      "RDF 里的 ebook id（" + id + "）与请求的（" + expectedId + "）不一致，拒绝按错身份写入", { retryable: false });
  }

  const languages = rdfBlocks(body, "dcterms:language")
    .map((b) => rdfValue(b, "rdf:value")).filter(Boolean);
  const subjects = rdfBlocks(body, "dcterms:subject").map((b) => {
    const member = rdfResourceAttr(b, "dcam:memberOf");
    return {
      scheme: member ? String(member).split("/").pop() : null,
      value: rdfValue(b, "rdf:value"),
    };
  }).filter((s) => s.value);
  const bookshelves = rdfBlocks(body, "pgterms:bookshelf")
    .map((b) => rdfValue(b, "rdf:value")).filter(Boolean);
  const formats = rdfBlocks(body, "dcterms:hasFormat").map((b) => {
    const file = (String(b).match(/<pgterms:file\s+rdf:about="([^"]+)"/) || [])[1] || null;
    const extent = rdfValue(b, "dcterms:extent");
    const mime = rdfValue(b, "rdf:value");
    return { url: file, extent: extent && /^\d+$/.test(extent) ? Number(extent) : (extent || null), format: mime };
  }).filter((f) => f.url);

  return {
    id: id,
    title: rdfValue(body, "dcterms:title"),
    issued: rdfValue(body, "dcterms:issued"),
    rights: rdfValue(body, "dcterms:rights"),
    publisher: rdfValue(body, "dcterms:publisher"),
    license: rdfResourceAttr(body, "dcterms:license"),
    languages: languages,
    subjects: subjects,
    bookshelves: bookshelves,
    creators: rdfBlocks(body, "dcterms:creator").map(parseGutenbergAgent).filter((a) => a.name),
    contributors: rdfBlocks(body, "dcterms:contributor").map(parseGutenbergAgent).filter((a) => a.name),
    formats: formats,
  };
}

/** 按 ebook id 取书目。日期取 RDF（页面 HTML 的 RDFa content 属性交叉错位）。 */
export async function fetchGutenbergEbook(idOrUrl, opts) {
  const o = opts || {};
  const id = normalizeGutenbergId(idOrUrl);
  const url = gutenbergRdfUrl(id);
  const res = await httpRequest(url, Object.assign({
    provider: "gutenberg", accept: "application/rdf+xml, application/xml;q=0.9, */*;q=0.8",
  }, o));
  const page = gutenbergPageUrl(id);
  if (res.notFound) {
    return readResult(res, "gutenberg", {
      found: false, id: id, url: page,
      notes: "Gutenberg 对 ebook " + id + " 返回 HTTP " + res.status + "：该编号没有电子书（编号被撤回或不存在）。"
        + "这只说明 Gutenberg 没有，不代表作品本身不存在。",
      raw: { id: id, status: res.status, body: String(res.text || "").slice(0, 300) },
    });
  }
  const record = parseGutenbergRdf(res.text, id);
  const issued = isoDate(record.issued);
  const rdfCovers = record.formats.filter((format) => /^image\//i.test(format.format || "")
    && /^https?:\/\//i.test(format.url || ""));
  const coverSmall = rdfCovers.find((format) => /\.cover\.small\./i.test(format.url))?.url || null;
  const coverMedium = rdfCovers.find((format) => /\.cover\.medium\./i.test(format.url))?.url || null;

  return readResult(res, "gutenberg", {
    id: id,
    title: record.title,
    image_url: coverMedium || coverSmall || null,
    image_page_url: page,
    dates: { release: issued, release_raw: record.issued },
    external_ids: { gutenberg: id },
    url: page,
    rdf_url: url,
    languages: record.languages,
    publisher: record.publisher,
    creators: record.creators,
    contributors: record.contributors,
    subjects: record.subjects,
    bookshelves: record.bookshelves,
    formats: record.formats,
    rights: record.rights,
    license_url: record.license && !/^https?:/i.test(record.license)
      ? GUTENBERG_BASE + "/" + String(record.license).replace(/^\/+/, "")
      : (record.license || null),
    cover_candidates: { small: coverSmall, medium: coverMedium, rdf_formats: rdfCovers },
    notes: [
      "发行日取 RDF 的 dcterms:issued（" + (record.issued || "缺") + " → " + (issued || "无法归一") + "）。"
        + "不要读页面 HTML 的 RDFa content 属性：实测 ebook 1513 的 property=\"dcterms:issued\" content 是最后更新日、"
        + "property=\"dcterms:modified\" content 才是发行日，两者交叉错位；页面可见文本 itemprop=\"datePublished\" 才对",
      "creator 的 pgterms:name 是倒装形（「Shakespeare, William」＝姓, 名），aliases 是历史拼写变体；建 agent 时按语种与姓名顺序核对",
      "这个 ebook 是 Gutenberg 自己的数字版次：可建 Release，publisher 记 Project Gutenberg，但原作的 Work 层身份要另找一手来源",
      record.rights ? "dcterms:rights 原文「" + record.rights + "」" : "本次 RDF 没有 dcterms:rights",
      "subjects/bookshelves 是 LCSH 主题与书架分类，只作 tag 候选，不是站内受控词表",
      rdfCovers.length ? "封面候选仅取本次 RDF hasFormat 明示的图片 URL；图片正文、内容与版次归属仍需核对" : "本次 RDF hasFormat 未声明封面图片；不按 ebook 编号拼图",
    ].filter(Boolean).join("；"),
    rights_note: "Gutenberg 的 rights 实测是「Public domain in the USA.」——只覆盖美国公版，不能据此断言全球公版或该版本可自由分发；封面缩略图由 Gutenberg 生成，写 pictures[] 前确认它确实是这个版次的图。",
    raw: record,
  });
}

/** 解析 /ebooks/search/ 的 HTML：li.booklink 里 href + span.title + span.subtitle（作者）+ span.extra（下载量）。 */
export function parseGutenbergSearchHtml(html) {
  const out = [];
  const source = String(html == null ? "" : html).split(/<li class="booklink">/i).slice(1);
  for (const block of source) {
    const href = (block.match(/href="\/ebooks\/(\d{1,7})"/) || [])[1];
    if (!href) continue;
    const id = String(Number(href));
    const thumb = (block.match(/<img class="cover-thumb" src="([^"]+)"/) || [])[1];
    out.push({
      id: id,
      title: xmlText((block.match(/<span class="title">([\s\S]*?)<\/span>/) || [])[1]),
      author: xmlText((block.match(/<span class="subtitle">([\s\S]*?)<\/span>/) || [])[1]),
      extra: xmlText((block.match(/<span class="extra">([\s\S]*?)<\/span>/) || [])[1]),
      cover_thumb: thumb ? GUTENBERG_BASE + String(thumb).replace(/^\/+/, "/") : null,
      url: gutenbergPageUrl(id),
    });
  }
  return out;
}

/** Gutenberg 检索。结果是候选：同名异书与不同译本混在一起，必须逐条开 RDF 核对署名。 */
export async function searchGutenberg(query, opts) {
  const o = opts || {};
  const raw = String(query == null ? "" : query).trim();
  if (!raw) throw new ProviderError("bad_input", "gutenberg", "检索词不能为空");
  const url = GUTENBERG_BASE + "/ebooks/search/?" + new URLSearchParams({ query: raw }).toString();
  const res = await httpRequest(url, Object.assign({ provider: "gutenberg", accept: "text/html" }, o));
  if (res.notFound) {
    throw new ProviderError("unavailable", "gutenberg", "检索端点返回 HTTP " + res.status + "，不能据此判定无匹配书目",
      { status: res.status, url: url, retryable: true });
  }
  const hits = parseGutenbergSearchHtml(res.text);
  const total = (res.text.match(/<meta\s+name="totalResults"\s+content="(\d+)"/i) || [])[1];
  if (total === undefined || (Number(total) > 0 && !hits.length) || hits.some(hit => !hit.title)) {
    throw new ProviderError("parse", "gutenberg", "检索页缺少可识别的结果计数或书目结构", { retryable: false });
  }
  return readResult(res, "gutenberg", {
    found: hits.length > 0,
    id: hits[0] ? hits[0].id : null,
    title: hits[0] ? hits[0].title : null,
    url: hits[0] ? hits[0].url : url,
    hits: hits,
    notes: hits.length
      ? "候选 " + hits.length + " 条（按 Gutenberg 的排序，通常是下载量）。"
        + "结果里混着同名异书、不同译本与不同编者的版本，subtitle 是署名线索但不足为凭："
        + "必须逐条用 gutenberg.ebook 取 RDF 核对 creator 与 issued 后再用"
      : "Gutenberg 检索无命中：换检索词（试原文题名或作者姓），无命中不代表该书不存在",
    rights_note: "检索页只给缩略图，不含授权信息。",
    raw: { query: raw, url: url, hits: hits },
  });
}

// ───────────────────────── 汇总入口（CLI 与 smoke 共用） ─────────────────────────

export const PROVIDER_OPS = {
  "discogs.release": { provider: "discogs", label: "Discogs release（数字或 /release/<id> 链接）", run: (arg, o) => fetchDiscogsRelease(arg, o) },
  "discogs.master": { provider: "discogs", label: "Discogs master", run: (arg, o) => fetchDiscogsMaster(arg, o) },
  "discogs.search": { provider: "discogs", label: "Discogs 检索", run: (arg, o) => searchDiscogs(arg, o) },
  "openlibrary.edition": { provider: "openlibrary", label: "OpenLibrary edition", run: (arg, o) => lookupOpenLibraryEdition(arg, o) },
  "openlibrary.work": { provider: "openlibrary", label: "OpenLibrary work", run: (arg, o) => lookupOpenLibraryWork(arg, o) },
  "openlibrary.author": { provider: "openlibrary", label: "OpenLibrary author（含 ISNI / VIAF 线索）", run: (arg, o) => lookupOpenLibraryAuthor(arg, o) },
  "openlibrary.search": { provider: "openlibrary", label: "OpenLibrary 检索", run: (arg, o) => searchOpenLibrary(arg, o) },
  "openlibrary.editions": { provider: "openlibrary", label: "OpenLibrary work 版本列表", run: (arg, o) => listOpenLibraryEditions(arg, o) },
  "openlibrary.isbn": { provider: "openlibrary", label: "OpenLibrary 按 ISBN", run: (arg, o) => lookupOpenLibraryByIsbn(arg, o) },
  "archive.item": { provider: "internetarchive", label: "archive.org 条目元数据", run: (arg, o) => fetchArchiveItem(arg, o) },
  "archive.search": { provider: "internetarchive", label: "archive.org advancedsearch", run: (arg, o) => searchArchive(arg, o) },
  "archive.wayback": { provider: "internetarchive", label: "Wayback 可用性", run: (arg, o) => waybackSnapshot(arg, o) },
  "tmdb.movie": { provider: "tmdb", label: "TMDB movie（需 key）", run: (arg, o) => fetchTmdbMedia(arg, Object.assign({ type: "movie" }, o)) },
  "tmdb.tv": { provider: "tmdb", label: "TMDB tv（需 key）", run: (arg, o) => fetchTmdbMedia(arg, Object.assign({ type: "tv" }, o)) },
  "tmdb.search": { provider: "tmdb", label: "TMDB 检索（需 key）", run: (arg, o) => searchTmdb(arg, o) },
  "anilist.media": { provider: "anilist", label: "AniList media", run: (arg, o) => fetchAniListMedia(arg, o) },
  "anilist.search": { provider: "anilist", label: "AniList 检索", run: (arg, o) => searchAniList(arg, o) },
  "mal.anime": { provider: "myanimelist", label: "MyAnimeList anime（需 client id）", run: (arg, o) => fetchMyAnimeList(arg, o) },
  "mal.search": { provider: "myanimelist", label: "MyAnimeList 检索（需 client id）", run: (arg, o) => searchMyAnimeList(arg, o) },
  "isni.record": { provider: "isni", label: "ISNI 记录（访问状态见日期快照）", run: (arg, o) => fetchIsniRecord(arg, o) },
  "viaf.record": { provider: "viaf", label: "VIAF 记录（访问状态见日期快照）", run: (arg, o) => fetchViafRecord(arg, o) },
  "oclc.fast": { provider: "oclc", label: "OCLC FAST（需凭据 / 已变更）", run: (arg, o) => fetchOclcFastHeading(arg, o) },
  "ndl.authority": { provider: "ndl", label: "NDL Linked Data 权威记录", run: (arg, o) => fetchNdlAuthority(arg, o) },
  "vgmdb.album": { provider: "vgmdb", label: "VGMdb 专辑（直连；被拦时抛 blocked）", run: (arg, o) => fetchVgmdbAlbum(arg, o) },
  "vgmdb.archive": { provider: "vgmdb", label: "VGMdb 专辑（经 Internet Archive 存档）", run: (arg, o) => fetchVgmdbAlbumViaArchive(arg, o) },
  "itunes.search": { provider: "itunes", label: "iTunes Store 专辑检索（可带 country=xx，默认 jp）", run: (arg, o) => searchItunes(arg, o) },
  "itunes.album": { provider: "itunes", label: "iTunes Store 专辑 + 曲目（数字 collectionId 或专辑链接）", run: (arg, o) => lookupItunesAlbum(arg, o) },
  "steam.app": { provider: "steam", label: "Steam 应用资料（AppID 或商店/steamdb 链接；可带 langs=/cc=）", run: (arg, o) => fetchSteamApp(arg, o) },
  "steam.search": { provider: "steam", label: "Steam 商店检索（可带 lang=/cc=）", run: (arg, o) => searchSteam(arg, o) },
  "caa.release": { provider: "coverartarchive", label: "Cover Art Archive 发行版封面图组（release MBID 或链接）", run: (arg, o) => fetchCoverArtArchive(arg, Object.assign({ kind: "release" }, o)) },
  "caa.release-group": { provider: "coverartarchive", label: "Cover Art Archive 发行组封面图组（release-group MBID 或链接；图属选定发行版）", run: (arg, o) => fetchCoverArtArchive(arg, Object.assign({ kind: "release-group" }, o)) },
  "kitsu.anime": { provider: "kitsu", label: "Kitsu 动画条目（数字 id / slug / kitsu.io/anime/… 链接）", run: (arg, o) => fetchKitsuMedia(arg, Object.assign({ kind: "anime" }, o)) },
  "kitsu.manga": { provider: "kitsu", label: "Kitsu 漫画条目（数字 id / slug / kitsu.io/manga/… 链接）", run: (arg, o) => fetchKitsuMedia(arg, Object.assign({ kind: "manga" }, o)) },
  "kitsu.search": { provider: "kitsu", label: "Kitsu 检索（默认 anime；kind=manga 换层级）", run: (arg, o) => searchKitsu(arg, o) },
  "vndb.vn": { provider: "vndb", label: "VNDB 作品条目（v<数字> / 裸数字 / vndb.org/v<数字> 链接）", run: (arg, o) => fetchVndbVn(arg, o) },
  "vndb.releases": { provider: "vndb", label: "VNDB 某作品下的版次（品番 / 条码 / 载体枚数 / 发行方与开发方分工）", run: (arg, o) => fetchVndbReleases(arg, o) },
  "vndb.character": { provider: "vndb", label: "VNDB 角色条目（c<数字>）", run: (arg, o) => fetchVndbCharacter(arg, o) },
  "vndb.staff": { provider: "vndb", label: "VNDB 职员条目（s<数字>）", run: (arg, o) => fetchVndbStaff(arg, o) },
  "vndb.schema": { provider: "vndb", label: "VNDB API 权威字段名与枚举（fields/filters 报错时查这个，不用试错）", run: (arg, o) => fetchVndbSchema(arg, o) },
  "openbd.isbn": { provider: "openbd", label: "OpenBD 日本出版物书目（ISBN-13 / ISBN-10）", run: (arg, o) => lookupOpenbdByIsbn(arg, o) },
  "gutenberg.ebook": { provider: "gutenberg", label: "Project Gutenberg 电子书书目（数字 id 或 /ebooks/<id> 链接，读 RDF）", run: (arg, o) => fetchGutenbergEbook(arg, o) },
  "gutenberg.search": { provider: "gutenberg", label: "Project Gutenberg 检索（候选须逐条核对署名）", run: (arg, o) => searchGutenberg(arg, o) },
};

/** CLI / smoke 统一分发：未知 op 抛 bad_input，不静默返回空。 */
export async function runProviderOp(op, arg, opts: Record<string, any> = {}) {
  const entry = PROVIDER_OPS[op];
  if (!entry) throw new ProviderError("bad_input", op, "未知操作：" + op + "（可用：" + Object.keys(PROVIDER_OPS).join(", ") + "）");
  if (!String(arg == null ? "" : arg).trim()) throw new ProviderError("bad_input", entry.provider, "操作 " + op + " 缺少参数");
  return entry.run(arg, opts || {});
}

if (process.argv[1] && String(process.argv[1]).endsWith("mf-fetch-providers.ts")) {
  const op = process.argv[2];
  const arg = process.argv.slice(3).join(" ");
  if (!op) {
    console.log("用法：node mf-fetch-providers.ts <op> <参数>\n可用 op：");
    for (const [key, entry] of Object.entries(PROVIDER_OPS)) console.log("  " + key.padEnd(20) + entry.label);
    process.exit(0);
  }
  try {
    const out = await runProviderOp(op, arg);
    const slim = Object.assign({}, out);
    if (typeof slim.raw === "string") slim.raw = slim.raw.slice(0, 600);
    console.log(JSON.stringify(slim, null, 2));
  } catch (err) {
    console.error("抓取失败:", JSON.stringify(describeError(err), null, 2));
    process.exit(1);
  }
}
