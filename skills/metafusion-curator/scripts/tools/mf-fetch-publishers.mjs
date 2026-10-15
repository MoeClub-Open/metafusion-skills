// mf-fetch-publishers.mjs - 唱片厂牌商品页只读连接器
//   universal-music.co.jp  口径参考 mf-fetch-authoritative.mjs 的 umj_product（不改动该文件）
//   ponycanyon.co.jp       jacket 图统一补 ?size=3&order=1
//   canime.jp              品番 → URL：字母前缀 + 数字左补 0 到 9 位（即“去横杠中间补 0000”，如 PCCG-2541 → PCCG000002541）
//   sonymusic.co.jp        /artist/{slug}/discography/{CATALOG}/（整页为 SPA 壳，SSR 仅 meta 层；正文尽力抽取）
//   bushiroad-music.com    /musics/{catalog-slug}/（品番和 URL slug 仅按页面内容回核）
//   bang-dream.com         /discographies/{numeric-id}/（数字为站内页面 ID，仅接受完整 URL）
// 只读取源：不读 MetaFusion 凭据、不写目录库。统一签名 fetchXxx(urlOrCode) ->
//   { publisher, product_url, title, catalog_number?, release_date?, price?, image_urls[], tracklist?, raw }
// 错误分类（语义参照 mf-fetch-providers.mjs 的 ProviderError，独立实现）：
//   bad_input / network（含超时、5xx、传输失败；retryable）/ http（其余 4xx）/
//   blocked（401/403/反爬挑战页）/ notfound（确认的 404/410 或“壳页伪 200”）/ rate_limited（429/503 退避耗尽）/ parse

export const PUBLISHERS = ['universal_music', 'pony_canyon', 'canime', 'sony_music', 'bushiroad_music', 'bang_dream'];

const OFFICIAL_HOSTS = {
  universal_music: ['universal-music.co.jp'],
  pony_canyon: ['ponycanyon.co.jp'],
  canime: ['canime.jp'],
  sony_music: ['sonymusic.co.jp'],
  bushiroad_music: ['bushiroad-music.com'],
  bang_dream: ['bang-dream.com'],
};

function checkedOfficialUrl(publisher, value, kind = 'bad_input') {
  let u;
  try { u = new URL(value); } catch {
    throw new PublisherError(kind, publisher, '不是有效的 HTTPS 商品页 URL');
  }
  const hostAllowed = (OFFICIAL_HOSTS[publisher] ?? []).some((host) => u.hostname.toLowerCase() === host || u.hostname.toLowerCase().endsWith('.' + host));
  if (u.protocol !== 'https:' || u.username || u.password || !hostAllowed) {
    const destination = u.origin + u.pathname;
    throw new PublisherError(kind, publisher, '拒绝非本站 HTTPS 目标或含凭据的 URL：' + destination, { url: destination, retryable: false, hint: kind === 'blocked' ? '最终跳转离开了允许的官方域名' : undefined });
  }
  return u.href;
}

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export class PublisherError extends Error {
  constructor(kind, publisher, message, meta = {}) {
    super(message);
    this.name = 'PublisherError';
    this.kind = kind;            // bad_input | network | http | blocked | notfound | rate_limited | parse
    this.publisher = publisher;
    this.status = meta.status ?? null;
    this.url = meta.url ?? null;
    this.retryable = meta.retryable ?? (kind === 'network' || kind === 'rate_limited');
    if (meta.hint) this.hint = meta.hint;
  }
}

export function toPublisherError(err) {
  if (err instanceof PublisherError) {
    return { kind: err.kind, publisher: err.publisher, status: err.status, url: err.url, retryable: err.retryable, message: err.message, hint: err.hint ?? null };
  }
  return { kind: 'unexpected', publisher: null, status: null, url: null, retryable: false, message: String(err?.message ?? err) };
}

const DEFAULT_PACE = { attempts: 2, timeoutMs: 20000, backoffBaseMs: 1200, retryAfterCapMs: 8000 };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function parseRetryAfter(value) {
  if (!value) return null;
  const secs = Number.parseInt(String(value), 10);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(String(value));
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

function looksLikeGatewayError(text) {
  return /no Route matched|Error Code: \d{3}|ErrorCode: \d{3}|^Status: \d{3} /im.test(String(text ?? '').slice(0, 2000));
}

function looksLikeBotChallenge(text) {
  return /(captcha|access[ -]?denied|attention required|verify you are human|jschl|cf-challenge|Just a moment|cf-browser-verification|challenges\.cloudflare\.com|cf-turnstile|Attention Required! \| Cloudflare|challenge-platform)/i.test(String(text ?? '').slice(0, 4000));
}

/** 统一抓取本站文本资源：固定无凭据请求头、超时、退避与最终域名校验。 */
async function fetchOfficialBody(publisher, url, opts = {}, accept = 'text/html,application/xhtml+xml') {
  const pace = { ...DEFAULT_PACE, ...opts.pace };
  const fetchImpl = opts.fetchFn ?? opts.fetchImpl ?? globalThis.fetch;
  const sleep = opts.delay ?? delay;
  if (typeof fetchImpl !== 'function') throw new PublisherError('bad_input', publisher, '运行时没有可用的 fetch');
  url = checkedOfficialUrl(publisher, url);
  let lastFailure = null;
  for (let attempt = 1; attempt <= pace.attempts; attempt++) {
    let res;
    let requestUrl = url;
    try {
      for (let redirects = 0; ; redirects++) {
        res = await fetchImpl(requestUrl, {
          // 不接受调用方传入任意 headers，避免 MetaFusion Authorization/Cookie 等凭据外泄。
          headers: { 'User-Agent': BROWSER_UA, Accept: accept, 'Accept-Language': 'ja,en-US;q=0.8' },
          // 手动逐跳跟随，先校验目标官方域名，再发出下一次请求。
          redirect: 'manual',
          signal: globalThis.AbortSignal?.timeout ? globalThis.AbortSignal.timeout(pace.timeoutMs) : undefined,
        });
        if (![301, 302, 303, 307, 308].includes(res.status)) break;
        const location = res.headers?.get?.('location');
        if (!location) throw new PublisherError('http', publisher, '官方站点返回了没有 Location 的 HTTP ' + res.status, { status: res.status, url: requestUrl, retryable: false });
        if (redirects >= 5) throw new PublisherError('blocked', publisher, '官方商品页重定向超过 5 次', { status: res.status, url: requestUrl, retryable: false });
        requestUrl = checkedOfficialUrl(publisher, new URL(location, requestUrl).href, 'blocked');
      }
    } catch (err) {
      if (err instanceof PublisherError) throw err;
      lastFailure = new PublisherError('network', publisher, '传输失败（第 ' + attempt + '/' + pace.attempts + ' 次）：' + (err?.name ?? '') + ' ' + String(err?.message ?? err).slice(0, 160), { url });
      if (attempt < pace.attempts) { await sleep(pace.backoffBaseMs * attempt); continue; }
      throw lastFailure;
    }
    const status = res.status;
    const finalUrl = checkedOfficialUrl(publisher, res.url || requestUrl, 'blocked');
    const body = await res.text().catch((err) => {
      throw new PublisherError('network', publisher, '响应体读取失败：' + String(err?.message ?? err).slice(0, 160), { url });
    });
    if (status === 404 || status === 410) {
      if (looksLikeBotChallenge(body)) {
        throw new PublisherError('blocked', publisher, 'HTTP ' + status + ' 响应是反爬挑战页，不作为商品不存在证据：' + finalUrl, { status, url: finalUrl, retryable: false, hint: '需通过站点允许的读取路径；未判定商品是否存在' });
      }
      if (looksLikeGatewayError(body)) {
        throw new PublisherError('network', publisher, 'HTTP ' + status + ' 响应是网关/路由错误，状态未知：' + body.replace(/\s+/g, ' ').slice(0, 160), { status, url: finalUrl, retryable: true, hint: '网关错误不能作为商品不存在证据；稍后重试或换官方读取路径' });
      }
      throw new PublisherError('notfound', publisher, 'HTTP ' + status + '：商品页不存在 ' + url, { status, url, retryable: false });
    }
    if (status === 401 || status === 403) {
      throw new PublisherError('blocked', publisher, 'HTTP ' + status + '：疑似反爬拦截或权限拒绝 ' + url, { status, url, retryable: false, hint: '换已许可的读取路径或走 Internet Archive 快照，不要判定商品不存在' });
    }
    if (status === 429 || status === 503) {
      const waitMs = parseRetryAfter(res.headers?.get?.('retry-after'));
      if (attempt < pace.attempts && waitMs !== null && waitMs <= pace.retryAfterCapMs) { await sleep(waitMs); continue; }
      if (attempt < pace.attempts) { await sleep(pace.backoffBaseMs * attempt * 2); continue; }
      throw new PublisherError('rate_limited', publisher, 'HTTP ' + status + ' 限流；已尝试 ' + attempt + '/' + pace.attempts + ' 次', { status, url, retryable: true, hint: '降频重试；不得据此判定商品失效' });
    }
    if (status >= 500) {
      lastFailure = new PublisherError('network', publisher, 'HTTP ' + status + '（厂牌站 5xx，状态未知）', { status, url });
      if (attempt < pace.attempts) { await sleep(pace.backoffBaseMs * attempt); continue; }
      throw lastFailure;
    }
    if (status >= 400) {
      if (looksLikeBotChallenge(body)) {
        throw new PublisherError('blocked', publisher, 'HTTP ' + status + '：收到反爬挑战页 ' + url, { status, url, retryable: false, hint: '改走 Internet Archive 存档读取' });
      }
      throw new PublisherError('http', publisher, 'HTTP ' + status + ': ' + body.replace(/\s+/g, ' ').slice(0, 200), { status, url, retryable: false });
    }
    if (looksLikeBotChallenge(body)) {
      throw new PublisherError('blocked', publisher, 'HTTP 200 响应呈现反爬挑战页，不能按商品页处理：' + finalUrl, { status, url: finalUrl, retryable: false, hint: '页面需要人工/站点挑战验证；未据此判断商品存在或不存在' });
    }
    return { body, finalUrl, status, headers: res.headers };
  }
  throw lastFailure ?? new PublisherError('network', publisher, '未预期的读取失败（状态未知）', { url });
}

/** HTML 抓取入口：fetchFn（旧名 fetchImpl）/delay 供离线测试注入。 */
export async function fetchHtml(publisher, url, opts = {}) {
  const result = await fetchOfficialBody(publisher, url, opts);
  return { html: result.body, finalUrl: result.finalUrl, status: result.status };
}

// ---------- HTML 解析小工具（独立实现，不依赖 mf-lib） ----------
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', yen: '¥', hellip: '…', minus: '−' };
export function decodeEntities(value) {
  return String(value).replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const hex = e[1]?.toLowerCase() === 'x';
      const cp = Number.parseInt(e.slice(hex ? 2 : 1), hex ? 16 : 10);
      try { return Number.isFinite(cp) ? String.fromCodePoint(cp) : m; } catch { return m; }
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
export function htmlToText(html) {
  return decodeEntities(String(html)
    .replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|li|h[1-6]|dd|dt|tr|div|section|article|ul|ol|dl)>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}
export function extractMeta(html) {
  const meta = {};
  for (const m of String(html).matchAll(/<meta[^>]+?(?:property|name)="(og:[^"]+|twitter:[^"]+)"[^>]*?(?:content|value)="([^"]*)"/gi)) meta[m[1]] ??= decodeEntities(m[2]);
  for (const m of String(html).matchAll(/<meta[^>]+?(?:content|value)="([^"]*)"[^>]*?(?:property|name)="(og:[^"]+|twitter:[^"]+)"[^>]*?>/gi)) meta[m[2]] ??= decodeEntities(m[1]);
  return meta;
}
export function pageTitle(html) {
  const m = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1].replace(/<[^>]+>/g, '').trim()) : null;
}
function firstLine(text, pattern) { return text.match(pattern)?.[1]?.trim() || null; }
export function findReleaseDate(text) {
  const raw = firstLine(text, /発売日[^\d]{0,24}(\d{4}[年.\/\-]\d{1,2}[月.\/\-]\d{1,2}日?)/)
    || firstLine(text, /発売日\s*[：:]?\s*(\d{4}[\/.\-]\d{1,2}[\/.\-]\d{1,2})/)
    // Pony Canyon 等站点的“2010.9.3 発売”形状：日期在前、発売在后。
    || firstLine(text, /(\d{4}[年.\/\-]\d{1,2}[月.\/\-]\d{1,2}日?)\s*発売/);
  if (!raw) return null;
  const digits = raw.replace(/[年月]/g, '-').replace(/日$/, '').split(/[-./]/).map((p) => p.padStart(2, '0'));
  return digits.length === 3 ? digits.join('-') : raw;
}
export function findPrice(text) {
  const priceRe = /([¥￥][\s\d,]{2,12}(?:円)?(?:[ \t]*[（(][^）)]{1,10}[）)])?)|(\d{1,3}(?:[,\d]{1,9})\s*円(?:[ \t]*[（(][^）)]{1,10}[）)])?)/;
  const pick = (pool) => {
    const pm = pool.match(priceRe);
    if (!pm) return null;
    const v = (pm[1] || pm[2]).replace(/\s+/g, ' ').trim();
    return v.length <= 40 ? v : v.slice(0, 40);
  };
  const near = text.match(/(?:価格|販売価格|税込価格|本体価格)[ \t:：]*([^。\n]{0,32})/);
  // “価格”二字可能只出现在排序菜单/营销文案里：窗口无金额时回退全文首个金额。
  return (near ? pick(near[1]) : null) ?? pick(text);
}
function trackMarkerPos(text) {
  const m = /(?:Track\s*list|トラックリスト)/i.exec(text);
  return m ? m.index : -1;
}
export function findTracklist(text, markers = ['収録曲', 'トラックリスト', trackMarkerPos]) {
  const idxs = markers.map((f) => (typeof f === 'function' ? f(text) : text.indexOf(f))).filter((i) => i >= 0);
  if (!idxs.length) return null;
  const start = Math.min(...idxs);
  const stops = ['関連商品', '購入', 'BUY', '商品仕様', '特典', '発売日', '備考']
    .map((s) => text.indexOf(s, start + 2)).filter((i) => i > start);
  const end = Math.min(text.length, start + 4000, ...(stops.length ? stops : [text.length]));
  return text.slice(start, end).replace(/\s+/g, ' ').trim() || null;
}
function ldjson(html) {
  for (const m of String(html).matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { return JSON.parse(m[1]); } catch { /* 继续找下一块 */ }
  }
  return null;
}
function uniq(list) { return [...new Set(list.filter(Boolean))]; }

// ---------- 品番 / 站内码 ----------
/** "PCCG-2541" 或 "PCCG2541" → {prefix, digits, suffix, hyphenated}；解析失败返回 null */
export function splitCatalog(code) {
  const s = String(code ?? '').trim().toUpperCase().replace(/[–−]/g, '-');
  const m = s.match(/^([A-Z]{2,6})-?(\d{1,9})([A-Z](?:[A-Z0-9-]*))?$/);
  if (!m) return null;
  return { prefix: m[1], digits: m[2], suffix: m[3] ?? '', hyphenated: m[1] + '-' + m[2] + (m[3] ? '-' + m[3].replace(/^-/, '') : '') };
}
/** 品番 → 站内码：字母 + 数字左补 0 至 9 位（canime / ponycanyon 共用） */
export function padCode(code) {
  const parts = splitCatalog(code);
  if (parts) return parts.prefix + parts.digits.padStart(9, '0');
  return String(code ?? '').trim().toUpperCase().replace(/-/g, '');
}
/** 站内码 → 展示品番：PCCG000002541 → PCCG-2541 */
export function depadCode(code) {
  const m = String(code ?? '').trim().toUpperCase().match(/^([A-Z]{2,6})0*(\d{1,9})$/);
  return m ? m[1] + '-' + m[2] : String(code ?? '').trim().toUpperCase();
}

function requireUrlShape(url, publisher, hostRe, pathRe) {
  let u;
  try { u = new URL(url); } catch { throw new PublisherError('bad_input', publisher, '需要完整商品 URL 或站内码，收到：' + String(url).slice(0, 80)); }
  if (!hostRe.test(u.hostname)) throw new PublisherError('bad_input', publisher, '主机不是 ' + publisher + ' 的商品域：' + u.hostname);
  if (!pathRe.test(u.pathname)) throw new PublisherError('bad_input', publisher, 'URL 不是商品页路径：' + u.pathname);
  return u;
}

// ---------- 1. universal-music.co.jp（口径参考 mf-fetch-authoritative.mjs umj_product） ----------
export async function fetchUniversalMusic(urlOrCode, opts = {}) {
  const publisher = 'universal_music';
  const input = String(urlOrCode ?? '').trim();
  if (!input) throw new PublisherError('bad_input', publisher, '缺少参数：完整 URL 或 <artist-slug>/<CATALOG>');
  let url;
  let codeFromInput = null;
  if (/^https?:\/\//i.test(input)) {
    url = input;
    codeFromInput = requireUrlShape(input, publisher, /(^|\.)universal-music\.co\.jp$/i, /^\/[^/]+\/products\/[^/]+\/?$/i).pathname.split('/').filter(Boolean).at(-1);
  } else {
    const m = input.match(/^([a-z0-9][a-z0-9-]*?)\/([a-z0-9]+(?:-[a-z0-9]+)*)$/i);
    if (!m) throw new PublisherError('bad_input', publisher, '裸品番无法定位艺人页；用 <artist-slug>/<CATALOG>（如 yorushika/upxh-1105）或完整 URL');
    url = 'https://www.universal-music.co.jp/' + m[1].toLowerCase() + '/products/' + m[2].toLowerCase() + '/';
    codeFromInput = m[2];
  }
  const { html, finalUrl, status } = await fetchHtml(publisher, url, opts);
  const text = htmlToText(html);
  const title = pageTitle(html);
  if (!title || !/UNIVERSAL MUSIC JAPAN/i.test(title)) {
    throw new PublisherError('parse', publisher, '响应不是可识别的 Universal Music Japan 页面：' + finalUrl, { status, url });
  }
  const og = extractMeta(html);
  const head = title.replace(/ - UNIVERSAL MUSIC JAPAN\s*$/i, '').trim();
  const sep = head.lastIndexOf(' - ');
  const productTitle = sep >= 0 ? head.slice(0, sep).trim() : head;
  const artist = sep >= 0 ? head.slice(sep + 3).trim() : null;
  const urlCatalog = splitCatalog(codeFromInput ?? finalUrl.split('/').filter(Boolean).at(-1))?.hyphenated ?? String(codeFromInput ?? '').toUpperCase();
  const pageCatalogs = [...text.matchAll(/品\s*番\s*[:：]?\s*([A-Z0-9]+(?:-[A-Z0-9]+)*)/gi)].map((m) => m[1].toUpperCase());
  const catalog = pageCatalogs.includes(urlCatalog) ? urlCatalog : (pageCatalogs[0] ?? urlCatalog);
  const images = uniq([og['og:image'], og['twitter:image'], ...[...html.matchAll(/https:\/\/content-jp\.umgi\.net\/products\/[^"'()\s]+/gi)].map((m) => m[0])]).slice(0, 8);
  return {
    publisher, product_url: og['og:url'] || finalUrl, title: productTitle, artist,
    catalog_number: catalog, release_date: findReleaseDate(text), price: findPrice(text),
    image_urls: images, tracklist: findTracklist(text, ['収録曲', 'トラックリスト', '収録内容']),
    raw: { status, final_url: finalUrl, meta: og, page_title: title, ld: ldjson(html), label: firstLine(text, /レーベル\s*([^\n]+)/), format: firstLine(text, /フォーマット\s*([^\n]+)/), artist_slug: /universal-music\.co\.jp\/([^/]+)\/products/i.exec(finalUrl)?.[1] ?? null },
  };
}

// ---------- 2. ponycanyon.co.jp（jacket 图统一 ?size=3&order=1） ----------
export async function fetchPonyCanyon(urlOrCode, opts = {}) {
  const publisher = 'pony_canyon';
  const input = String(urlOrCode ?? '').trim();
  if (!input) throw new PublisherError('bad_input', publisher, '缺少参数：/music/{站内码} 完整 URL 或品番/站内码');
  let url;
  let code;
  if (/^https?:\/\//i.test(input)) {
    const u = requireUrlShape(input, publisher, /(^|\.)ponycanyon\.co\.jp$/i, /^\/(music|visual)\/[A-Z0-9]+\/?$/i);
    url = u.href; code = u.pathname.split('/').filter(Boolean).at(-1);
  } else if (/^[A-Z]{2,6}-?\d{1,13}$/i.test(input)) {
    code = padCode(input); url = 'https://www.ponycanyon.co.jp/music/' + code;
  } else throw new PublisherError('bad_input', publisher, '无法解析 Pony Canyon 商品标识：' + input.slice(0, 60));
  const { html, finalUrl, status } = await fetchHtml(publisher, url, opts);
  const text = htmlToText(html);
  const og = extractMeta(html);
  const title = (og['og:title'] || pageTitle(html) || '').replace(/\s*[|｜]\s*ポニーキャニオン\s*$/, '').trim();
  if (!title) throw new PublisherError('parse', publisher, '页面没有可识别标题（可能被重定向）：' + finalUrl, { status, url });
  const codeFromUrl = /\/(music|visual)\/([A-Z]{2,6}\d{1,13})/i.exec(finalUrl)?.[2]?.toUpperCase() ?? String(code).toUpperCase();
  const catalog = splitCatalog(text.match(/品番[^\w]{0,8}([A-Z]{2,6}-\d{1,9})/i)?.[1] ?? '')?.hyphenated ?? depadCode(codeFromUrl);
  const normJacket = (u) => (u && /jacket/i.test(String(u)) ? String(u).split(/[?&]size=/)[0] + '?size=3&order=1' : u);
  const bodyImages = uniq([...html.matchAll(/https:\/\/www\.ponycanyon\.co\.jp\/images\/wcms\/accessor\/bin\/jacket\/[A-Z0-9]+\.(?:jpg|png|webp)[^"'()\s]*/gi)].map((m) => normJacket(m[0])));
  const images = uniq([normJacket(og['og:image']), ...bodyImages]).slice(0, 8);
  return {
    publisher, product_url: (og['og:url'] || finalUrl).replace(/\/$/, ''), title,
    catalog_number: catalog, release_date: findReleaseDate(text), price: findPrice(text),
    image_urls: images, tracklist: findTracklist(text),
    raw: { status, final_url: finalUrl, meta: og, page_title: pageTitle(html), site_code: codeFromUrl, description: og['og:description'] ?? null },
  };
}

// ---------- 3. canime.jp（品番去横杠、数字左补 0 至 9 位） ----------
export async function fetchCanime(urlOrCode, opts = {}) {
  const publisher = 'canime';
  const input = String(urlOrCode ?? '').trim();
  if (!input) throw new PublisherError('bad_input', publisher, '缺少参数：完整商品 URL、站内码或品番');
  let url;
  let code;
  if (/^https?:\/\//i.test(input)) {
    const u = requireUrlShape(input, publisher, /^canime\.jp$/i, /^\/product\/[A-Z0-9]+\/?$/i);
    url = u.href; code = u.pathname.split('/').filter(Boolean).at(-1);
  } else if (/^[A-Z]{2,6}\d{9,10}$/i.test(input)) {
    code = input.toUpperCase(); url = 'https://canime.jp/product/' + code + '/';
  } else if (splitCatalog(input)) {
    code = padCode(input); url = 'https://canime.jp/product/' + code + '/';
  } else throw new PublisherError('bad_input', publisher, '无法解析きゃにめ商品标识：' + input.slice(0, 60));
  const { html, finalUrl, status } = await fetchHtml(publisher, url, opts);
  const text = htmlToText(html);
  const og = extractMeta(html);
  const title = (og['og:title'] || pageTitle(html) || '').replace(/\s*[|｜]\s*きゃにめ\s*$/, '').trim();
  if (!title) throw new PublisherError('parse', publisher, '页面没有可识别标题（可能被重定向）：' + finalUrl, { status, url });
  const codeFromUrl = /\/product\/([A-Z0-9]+)\/?$/i.exec(finalUrl)?.[1]?.toUpperCase() ?? String(code).toUpperCase();
  const images = uniq([
    og['og:image'],
    ...[...html.matchAll(/(?:https?:\/\/canime\.jp)?\/upload\/(?:jacket\/[A-Z0-9]+\/org\/[^"'()\s?]+|product\/[A-Z0-9-]+\.(?:jpg|png|webp))/gi)].map((m) => m[0].startsWith('http') ? m[0] : 'https://canime.jp' + m[0]),
  ]).slice(0, 10);
  return {
    publisher, product_url: (og['og:url'] || finalUrl).replace(/\/$/, '') + '/', title,
    catalog_number: depadCode(codeFromUrl), release_date: findReleaseDate(text), price: findPrice(text),
    image_urls: images, tracklist: findTracklist(text),
    raw: { status, final_url: finalUrl, meta: og, page_title: pageTitle(html), site_code: codeFromUrl, description: og['og:description'] ?? null },
  };
}

// ---------- 4. sonymusic.co.jp（/artist/{slug}/discography/{CATALOG}/，SPA 壳页检测） ----------
export async function fetchSonyMusic(urlOrCode, opts = {}) {
  const publisher = 'sony_music';
  const input = String(urlOrCode ?? '').trim();
  if (!input) throw new PublisherError('bad_input', publisher, '缺少参数：完整 URL 或 <artist-slug>/<CATALOG>');
  let url;
  let catalogInput = null;
  if (/^https?:\/\//i.test(input)) {
    const u = requireUrlShape(input, publisher, /(^|\.)sonymusic\.co\.jp$/i, /^\/artist\/[^/]+\/discography\/[^/]+\/?$/i);
    url = u.href; catalogInput = decodeURIComponent(u.pathname.split('/').filter(Boolean).at(-1));
  } else {
    const m = input.match(/^([a-z0-9_-]+|\d+)\/([a-z0-9]+(?:-[a-z0-9]+){1,2}|[a-z0-9]{6,20})$/i);
    if (!m) throw new PublisherError('bad_input', publisher, '裸品番在 Sony Music 站内不唯一定位；用 <artist-slug>/<CATALOG>（如 EiichiOhtaki/SRCL-13100）或完整 URL');
    url = 'https://www.sonymusic.co.jp/artist/' + m[1] + '/discography/' + m[2].toUpperCase();
    catalogInput = m[2].toUpperCase();
  }
  const { html, finalUrl, status } = await fetchHtml(publisher, url, opts);
  const text = htmlToText(html);
  const og = extractMeta(html);
  const title = pageTitle(html);
  // SPA 壳页伪 200：站级通用标题且无商品图 → 该路径下无商品记录
  const ogTitle = og['og:title'] || title || '';
  const genericTitle = /ソニーミュージックオフィシャルサイト\s*$/.test(title || '') && !/\|/.test(ogTitle);
  const faviconOnly = /\/(?:common\/assets\/images\/favicon|favicon)/i.test(og['og:image'] ?? '');
  const looksShell = genericTitle && (faviconOnly || !og['og:image']);
  if (looksShell) throw new PublisherError('notfound', publisher, '返回的是站内壳页/通用页（伪 200），未找到商品记录：' + finalUrl, { status, url, retryable: false });
  // 不存在的品番会被回落到艺人 /discography/ 索引页：最终 URL 已不是详情路径，
  // 此时不得用输入品番拼出假记录。
  if (!/^\/artist\/[^/]+\/discography\/[^/]+\/?$/i.test(new URL(finalUrl).pathname)) {
    throw new PublisherError('notfound', publisher, '最终 URL 已不是商品详情路径（疑似不存在的品番回落到索引页），未找到商品记录：' + finalUrl, { status, url: finalUrl, retryable: false, hint: '核对 artist-slug 与品番组合；结论仅限本次读取' });
  }
  const parts = (og['og:title'] || title || '').split(/\s*[|｜]\s*/);
  const productTitle = parts[0]?.trim() ?? null;
  const artist = parts[1]?.trim() ?? null;
  if (!productTitle) throw new PublisherError('parse', publisher, '页面没有可识别标题：' + finalUrl, { status, url });
  const catalogFromUrl = decodeURIComponent(finalUrl.split('/').filter(Boolean).at(-1) ?? '').toUpperCase();
  const images = uniq([og['og:image'], og['twitter:image'], ...[...html.matchAll(/https:\/\/www\.sonymusic\.co\.jp\/(?:adm_image|imgcdn)\/[^"'()\s]+\.(?:jpg|png|webp)[^"'()\s]*/gi)].map((m) => m[0])]).slice(0, 8);
  return {
    publisher, product_url: og['og:url'] || finalUrl, title: productTitle, artist,
    catalog_number: splitCatalog(catalogFromUrl)?.hyphenated || catalogInput || catalogFromUrl,
    release_date: findReleaseDate(text), price: findPrice(text),
    image_urls: images, tracklist: findTracklist(text),
    raw: { status, final_url: finalUrl, meta: og, page_title: title, artist_slug: /\/artist\/([^/]+)\//.exec(finalUrl)?.[1] ?? null, description: og['og:description'] ?? null, note: 'sonymusic 详情为 SPA，正文 SSR 仅 meta 层；缺失字段以 null 表示' },
  };
}

// ---------- 5. bushiroad-music.com（目录 slug 与品番需由页面正文回核） ----------
function extractCatalogCandidates(text) {
  const markers = [...String(text).matchAll(/品番/gi)];
  for (const marker of markers) {
    const start = marker.index + marker[0].length;
    const rest = String(text).slice(start, start + 1800);
    const stop = /(?:収録内容|収録曲|商品タイプ|ジャケット|発売日|価格|特典|封入|特製アイテム|法人別|店舗別|店頭)/i.exec(rest);
    const section = rest.slice(0, stop?.index ?? 800);
    const found = [];
    const matches = [...section.matchAll(/\b([A-Z]{2,8})-?(\d{3,8})\b|\b(\d{5})\b/gi)];
    let lastEnd = 0;
    for (let i = 0; i < matches.length; i++) {
      const match = matches[i];
      const prefix = section.slice(lastEnd, match.index).split(/\n/).at(-1) ?? '';
      const cleanEdition = (value) => value
        .replace(/^(?:\s*品番\s*[:：]?\s*)/i, '')
        .replace(/^[\s:：・•】］\]]+|[\s:：・•【［\[]+$/g, '').trim();
      let edition = cleanEdition(prefix) || null;
      if (!edition) {
        const suffix = section.slice(match.index + match[0].length, matches[i + 1]?.index ?? section.length).split(/\n/)[0];
        const bracketed = /^\s*[（(【［\[]([^）)】］\]]{1,60})[）)】］\]]/.exec(suffix)?.[1];
        const afterColon = /^\s*[:：]\s*([^\n]{1,60})/.exec(suffix)?.[1];
        edition = cleanEdition(bracketed ?? afterColon ?? '') || null;
      }
      const catalog_number = match[1] ? match[1].toUpperCase() + '-' + match[2] : 'BRMM-' + match[3];
      if (!found.some((item) => item.catalog_number === catalog_number)) found.push({ edition, catalog_number });
      lastEnd = match.index + match[0].length;
    }
    if (found.length) return found;
  }
  return [];
}

function canonicalBushiroadCatalog(value) {
  const match = String(value ?? '').toUpperCase().match(/\bBRMM-?(\d{5})\b/);
  return match ? 'BRMM-' + match[1] : null;
}

function acfText(value) {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(acfText).join('\n');
  return '';
}

function acfExplicitCatalogMatch(item, requestedCatalog) {
  const acf = item?.acf;
  if (!acf || typeof acf !== 'object' || Array.isArray(acf)) return false;
  const pnumber = acfText(acf.d_pnumber).trim();
  const description = htmlToText(acfText(acf.d_description));
  const pnumberCatalogs = [...pnumber.matchAll(/\bBRMM-?(\d{5})\b/gi)].map((m) => 'BRMM-' + m[1]);
  // d_pnumber 本身是官网的品番字段，因此字段值恰为五位数字时可按该字段语义解释；
  // 描述文本则必须出现明确 BRMM 品番，不能仅凭相同数字或相邻编号推断。
  if (/^\d{5}$/.test(pnumber)) pnumberCatalogs.push('BRMM-' + pnumber);
  const descriptionCatalogs = [...description.matchAll(/\bBRMM-?(\d{5})\b/gi)].map((m) => 'BRMM-' + m[1]);
  for (const match of description.matchAll(/品番\s*[:：]?\s*(\d{5})\b/gi)) descriptionCatalogs.push('BRMM-' + match[1]);
  return [...pnumberCatalogs, ...descriptionCatalogs].includes(requestedCatalog);
}

function parseWpHeader(headers, name) {
  const raw = headers?.get?.(name);
  if (raw === null || raw === undefined || !/^\d+$/.test(String(raw).trim())) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function lookupParseError(message, url, hint) {
  return new PublisherError('parse', 'bushiroad_music', message, { url, retryable: false, hint });
}

async function lookupBushiroadCatalog(requestedCatalog, opts = {}) {
  const lookupOpts = opts.catalogLookup ?? {};
  const maxPages = lookupOpts.maxPages ?? 20;
  const maxAllowedPages = 20;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > maxAllowedPages) {
    throw new PublisherError('bad_input', 'bushiroad_music', 'catalogLookup.maxPages 必须是 1 到 20 的整数');
  }
  const perPage = 100;
  const delayMs = lookupOpts.delayMs ?? 250;
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 10000) {
    throw new PublisherError('bad_input', 'bushiroad_music', 'catalogLookup.delayMs 必须是 0 到 10000 的整数');
  }
  const sleep = opts.delay ?? delay;
  const base = new URL('https://bushiroad-music.com/wp-json/wp/v2/musics');
  const matches = new Map();
  let totalItems = null;
  let totalPages = null;
  let firstPageUrl = null;
  let checkedItems = 0;
  const seenIds = new Set();
  const expectedFields = new Set(['id', 'link', 'title', 'acf.d_pnumber', 'acf.d_description']);

  for (let page = 1; ; page++) {
    if (page > maxPages) {
      throw lookupParseError('官方目录分页超过本次扫描上限，无法确认品番唯一性', firstPageUrl ?? base.href,
        `请求 ${requestedCatalog}；已检查 ${page - 1}/${totalPages ?? '未知'} 页、${checkedItems} 条；可通过 opts.catalogLookup.maxPages 调整上限，最多 20 页`);
    }
    if (page > 1 && delayMs > 0) await sleep(delayMs);
    const url = new URL(base.href);
    url.searchParams.set('per_page', String(perPage));
    url.searchParams.set('page', String(page));
    url.searchParams.set('_fields', [...expectedFields].join(','));

    let response;
    try {
      response = await fetchOfficialBody('bushiroad_music', url.href, opts, 'application/json');
    } catch (err) {
      if (err instanceof PublisherError && ['network', 'http', 'blocked', 'rate_limited'].includes(err.kind)) throw err;
      const detail = err instanceof PublisherError ? `${err.kind}: ${err.message}` : String(err?.message ?? err);
      throw lookupParseError('官方目录读取未能完整完成：' + detail, err?.url ?? url.href,
        `请求 ${requestedCatalog}；目录查询失败不是商品不存在证据，未返回替代商品页`);
    }
    if (!firstPageUrl) firstPageUrl = response.finalUrl;

    let rows;
    try { rows = JSON.parse(response.body); } catch {
      throw lookupParseError('官方目录 API 响应不是有效 JSON', response.finalUrl,
        `请求 ${requestedCatalog}；无法确认目录扫描完整性`);
    }
    const reportedTotal = parseWpHeader(response.headers, 'x-wp-total');
    const reportedPages = parseWpHeader(response.headers, 'x-wp-totalpages');
    if (page === 1) {
      if (reportedTotal === null || reportedPages === null || reportedPages !== (reportedTotal === 0 ? 0 : Math.ceil(reportedTotal / perPage))) {
        throw lookupParseError('官方目录 API 缺少有效且一致的分页总量信息', response.finalUrl,
          `请求 ${requestedCatalog}；需要有效的 X-WP-Total 与 X-WP-TotalPages，未据不完整响应判定无匹配`);
      }
      totalItems = reportedTotal;
      totalPages = reportedPages;
      if (totalPages > maxPages) {
        throw lookupParseError('官方目录总页数超过本次扫描上限，无法确认品番唯一性', response.finalUrl,
          `请求 ${requestedCatalog}；目录共 ${totalPages} 页，上限 ${maxPages} 页；未判定为未找到`);
      }
    } else if (reportedTotal !== totalItems || reportedPages !== totalPages) {
      throw lookupParseError('扫描期间官方目录分页总量发生变化', response.finalUrl,
        `请求 ${requestedCatalog}；已检查 ${page - 1}/${totalPages} 页、${checkedItems} 条，无法确认扫描完整性`);
    }
    if (!Array.isArray(rows)) {
      throw lookupParseError('官方目录 API 每页必须返回商品数组', response.finalUrl,
        `请求 ${requestedCatalog}；第 ${page} 页形状无效，无法继续扫描`);
    }
    const expectedLength = page > totalPages ? 0 : Math.min(perPage, Math.max(0, totalItems - (page - 1) * perPage));
    if (rows.length !== expectedLength) {
      throw lookupParseError('官方目录 API 分页条数与总量头不一致', response.finalUrl,
        `请求 ${requestedCatalog}；第 ${page}/${totalPages} 页预期 ${expectedLength} 条、实得 ${rows.length} 条`);
    }
    for (const item of rows) {
      const validAcfValue = (value) => value === null || value === undefined || typeof value === 'string' ||
        typeof value === 'number' || (Array.isArray(value) && value.every((entry) => typeof entry === 'string' || typeof entry === 'number'));
      const acf = item?.acf;
      if (!item || typeof item !== 'object' || Array.isArray(item) || !Number.isSafeInteger(item.id) || item.id <= 0 ||
          typeof item.link !== 'string' || !item.title || typeof item.title !== 'object' || typeof item.title.rendered !== 'string' ||
          !acf || typeof acf !== 'object' || Array.isArray(acf) ||
          !Object.hasOwn(acf, 'd_pnumber') || !Object.hasOwn(acf, 'd_description') ||
          !validAcfValue(acf.d_pnumber) || !validAcfValue(acf.d_description)) {
        throw lookupParseError('官方目录 API 商品记录形状无效', response.finalUrl,
          `请求 ${requestedCatalog}；第 ${page} 页记录缺少有效 id、link、title.rendered 或 ACF 字段`);
      }
      if (seenIds.has(item.id)) {
        throw lookupParseError('官方目录 API 返回了重复商品 ID，分页可能重复或内容不一致', response.finalUrl,
          `请求 ${requestedCatalog}；第 ${page} 页重复 id=${item.id}，无法确认完整扫描`);
      }
      seenIds.add(item.id);
      checkedItems++;
      if (!acfExplicitCatalogMatch(item, requestedCatalog)) continue;
      let canonicalUrl;
      try {
        const parsed = new URL(checkedOfficialUrl('bushiroad_music', item.link, 'blocked'));
        if (!/^\/musics\/[^/]+\/?$/i.test(parsed.pathname)) throw new Error('not a product path');
        canonicalUrl = parsed.origin + parsed.pathname;
      } catch {
        throw lookupParseError('官方目录匹配记录没有合法的商品页 URL', response.finalUrl,
          `请求 ${requestedCatalog}；匹配记录链接不符合官方 /musics/{slug}/ 路径`);
      }
      matches.set(canonicalUrl, { url: canonicalUrl, id: item.id ?? null });
    }
    if (page >= totalPages) break;
  }

  const coverage = { request: requestedCatalog, checked_pages: totalPages, total_pages: totalPages, per_page: perPage, total_items: totalItems, checked_items: checkedItems, source_url: firstPageUrl, complete: true };
  if (matches.size > 1) {
    throw lookupParseError('官方目录中有多个商品记录明确匹配该品番，无法选择唯一商品页', firstPageUrl,
      `请求 ${requestedCatalog}；完整扫描 ${totalPages} 页后匹配到 ${matches.size} 个不同 canonical 商品 URL`);
  }
  if (matches.size === 0) {
    throw new PublisherError('notfound', 'bushiroad_music', `已检查官方商品目录 ${totalPages} 页，未找到明确匹配 ${requestedCatalog} 的商品记录`, {
      url: firstPageUrl, retryable: false,
      hint: '结论仅限本次完整扫描到的官方目录记录，不代表全网发行情况',
    });
  }
  return { ...[...matches.values()][0], coverage };
}

function extractRawTracklist(text) {
  const markers = [...String(text).matchAll(/収録(?:内容|曲)/gi)];
  if (!markers.length) return null;
  const marker = markers.at(-1);
  const rest = String(text).slice(marker.index + marker[0].length);
  const stop = /(?:【|［|\[)\s*[^】］\]]*(?:特典|封入|特製アイテム|法人別|店舗別|店頭|発売日|価格|定価|品番|商品タイプ|ジャケット)[^】］\]]*(?:】|］|\])/i.exec(rest);
  const section = rest.slice(0, stop?.index ?? 10000).trim().replace(/^[】］\]]+\s*/, '').trim();
  return section || null;
}

const PRICE_LABEL_RE = /(?:販売\s*)?(?:税込\s*価格|本体\s*価格|価格|定価)/i;
const PRICE_EXCLUSION_RE = /(?:特典|封入|特製アイテム|法人別|店舗別|店頭|販売店|店舗価格|ショップ価格|取扱店価格|購入特典|送料|手数料)/i;

function priceTokenMatches(value) {
  const tokens = [];
  const re = /[¥￥]\s*([\d,]+)(?:\s*円)?|([\d,]+)\s*円|(?:^\s*|[：:＝=]\s*)([\d,]+)(?![\d,])(?=\s*(?:$|[（(](?:税込|税抜|税別)))/g;
  for (const match of String(value).matchAll(re)) {
    const rawAmount = match[1] ?? match[2] ?? match[3];
    const amount = Number(rawAmount.replace(/,/g, ''));
    if (!Number.isSafeInteger(amount)) continue;
    const token = match[0];
    const amountOffset = token.search(/[\d]/);
    const amountStart = match.index + amountOffset;
    const amountEnd = amountStart + rawAmount.length;
    const tokenEnd = /[¥￥]/.test(token) ? match.index + token.length : amountEnd + (String(value).slice(amountEnd).match(/^\s*円/)?.[0].length ?? 0);
    const tokenText = String(value).slice(match.index, tokenEnd);
    tokens.push({ index: amountStart, rawStart: /[¥￥]/.test(tokenText) ? match.index : amountStart, end: tokenEnd, amount, currency: /[¥￥]|円/.test(tokenText) ? 'JPY' : null });
  }
  return tokens;
}

function priceSourceSegments(text) {
  const lines = String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const segments = [];
  let inPriceBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heading = /^(?:【|［|\[)\s*([^】］\]]+)\s*(?:】|］|\])/.exec(line);
    const isPriceHeading = heading && PRICE_LABEL_RE.test(heading[1]);
    if (heading && !isPriceHeading) inPriceBlock = false;
    if (PRICE_EXCLUSION_RE.test(line)) {
      inPriceBlock = false;
      continue;
    }
    const label = PRICE_LABEL_RE.exec(line);
    if (isPriceHeading || (label && !/販売店|店舗|ショップ/.test(line))) {
      inPriceBlock = true;
      const body = label
        ? line.slice(label.index + label[0].length).replace(/^[】］\]]\s*/, '').trim()
        : line.replace(/^(?:【|［|\[)[^】］\]]+(?:】|］|\])\s*/, '').trim();
      const cleanBody = body.replace(/^(?:(?:税込\s*価格|本体\s*価格|価格|定価)\s*[:：]?\s*)+/i, '').trim();
      if (cleanBody) segments.push({ raw: line, body: cleanBody });
      continue;
    }
    if (inPriceBlock) {
      if (/^(?:発売日|品番|商品タイプ|収録内容|収録曲|アーティスト|関連商品|ジャケット)/i.test(line)) {
        inPriceBlock = false;
        continue;
      }
      if (priceTokenMatches(line).length) segments.push({ raw: line, body: line });
      else if (line) inPriceBlock = false;
    }
  }
  return segments;
}

function normalizeEdition(value) {
  return String(value ?? '').toLocaleLowerCase('ja')
    .replace(/\bBRMM-?\d{5}\b/gi, '')
    .replace(/[\s　:：・•【】［］\[\]()（）]/g, '')
    .trim();
}

function editionBeforePrice(prefix, catalogCandidates) {
  let value = String(prefix ?? '').replace(/[（(][^）)]*(?:税込|税抜|税別)[^）)]*[）)]/g, '');
  const candidate = [...catalogCandidates].reverse().find((item) => item.edition &&
    normalizeEdition(value).endsWith(normalizeEdition(item.edition)));
  if (candidate) return candidate.edition;
  value = value.replace(/^[\s:：=＝・•]+|[\s:：=＝・•]+$/g, '').trim();
  // 金额前的货币符号残留（如“￥7,000”分行形状的 ￥）不是版名。
  if (/^[¥￥]$/.test(value)) return null;
  return value || null;
}

function taxIncludedForPrice(source, start, end, nextStart) {
  const local = source.slice(Math.max(0, start - 18), Math.min(source.length, nextStart ?? end + 28));
  const included = /税込|消費税込/.test(local);
  const excluded = /税抜|税別|税別価格|\+\s*税/.test(local);
  if (included !== excluded) return included;
  if (included && excluded) return null;
  const wholeIncluded = /税込|消費税込/.test(source);
  const wholeExcluded = /税抜|税別|税別価格|\+\s*税/.test(source);
  if (wholeIncluded !== wholeExcluded) return wholeIncluded;
  return null;
}

function extractPriceCandidates(text, catalogCandidates) {
  const candidates = [];
  for (const segment of priceSourceSegments(text)) {
    const { raw, body } = segment;
    const tokens = priceTokenMatches(body);
    const explicitCodes = uniq([...raw.matchAll(/\b([A-Z]{2,8})-?(\d{3,8})\b/gi)].map((m) => m[1].toUpperCase() + '-' + m[2]));
    let cursor = 0;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      const prefix = body.slice(cursor, token.index);
      const edition = editionBeforePrice(prefix, catalogCandidates);
      const normalizedEdition = normalizeEdition(edition);
      const editionMatches = catalogCandidates.filter((item) => item.edition && normalizeEdition(item.edition) === normalizedEdition);
      const directCode = explicitCodes.length === 1 ? explicitCodes[0] : null;
      const editionCode = editionMatches.length === 1 ? editionMatches[0].catalog_number : null;
      const catalog_number = directCode && editionCode && directCode !== editionCode ? null : (directCode ?? editionCode);
      const nextStart = tokens[i + 1]?.index ?? body.length;
      const taxSuffix = body.slice(token.end).match(/^\s*[（(][^）)]*(?:税込|税抜|税別)[^）)]*[）)]/)?.[0] ?? '';
      const amountRaw = body.slice(token.rawStart, token.end) + taxSuffix;
      const rawPrefix = prefix.replace(/[（(][^）)]*(?:税込|税抜|税別)[^）)]*[）)]/g, '').trim();
      const sourceRaw = tokens.length === 1
        ? raw.trim()
        : [rawPrefix, amountRaw.trim()].filter(Boolean).join(' ');
      candidates.push({
        edition: editionMatches.length === 1 ? editionMatches[0].edition : edition,
        catalog_number,
        amount: token.amount,
        currency: token.currency,
        tax_included: taxIncludedForPrice(body, token.index, token.end, nextStart),
        raw: sourceRaw,
        _price_value: amountRaw.trim(),
      });
      cursor = token.end;
    }
  }
  return candidates;
}

function publisherImageCandidates(html, meta, finalUrl) {
  const candidates = [meta['og:image'], meta['twitter:image']];
  for (const match of String(html).matchAll(/\b(?:src|data-src|data-lazy-src)\s*=\s*["']([^"']+)["']/gi)) {
    if (/\.(?:jpe?g|png|webp)(?:[?#]|$)|\/uploads?\//i.test(match[1])) candidates.push(match[1]);
  }
  for (const match of String(html).matchAll(/\bsrcset\s*=\s*["']([^"']+)["']/gi)) {
    for (const candidate of match[1].split(',')) candidates.push(candidate.trim().split(/\s+/)[0]);
  }
  const resolved = [];
  for (const item of candidates) {
    if (!item) continue;
    try {
      const url = new URL(item, finalUrl);
      if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password) resolved.push(url.href);
    } catch { /* 忽略无法解析的图片引用 */ }
  }
  return uniq(resolved).slice(0, 12);
}

function cleanDiscographyTitle(value) {
  const title = String(value ?? '').trim();
  const suffix = /\s*[|｜]\s*ディスコグラフィ(?:ー)?/i.exec(title);
  return (suffix ? title.slice(0, suffix.index) : title).trim() || null;
}

function parseOfficialDiscography(publisher, input, html, finalUrl, status, requestedCatalog = null, catalogLookup = null) {
  const text = htmlToText(html);
  const meta = extractMeta(html);
  const page_title = pageTitle(html);
  const reportedTitle = meta['og:title'] || page_title || '';
  if (/^(?:404(?:\s+ERROR|\s+NOT FOUND)?|NOT FOUND|ページが見つかりません)/i.test(reportedTitle.trim())) {
    throw new PublisherError('notfound', publisher, '官方站点返回了未找到页面：' + finalUrl, { status, url: finalUrl, retryable: false });
  }
  const title = cleanDiscographyTitle(meta['og:title'] || page_title);
  if (!title || /^(?:ブシロードミュージック|BanG Dream!（バンドリ！）公式サイト)$/i.test(title)) {
    throw new PublisherError('parse', publisher, '页面没有可识别的官方唱片标题：' + finalUrl, { status, url: finalUrl, retryable: false });
  }
  const catalog_candidates = extractCatalogCandidates(text);
  if (requestedCatalog && !catalog_candidates.some((candidate) => candidate.catalog_number === requestedCatalog)) {
    throw new PublisherError('parse', publisher, '页面品番与输入品番未能回核：' + requestedCatalog, { status, url: finalUrl, retryable: false, hint: '请使用页面列出的品番或该官方商品页 URL' });
  }
  const release_date = findReleaseDate(text);
  const price_candidates = extractPriceCandidates(text, catalog_candidates);
  if (price_candidates.length === 1 && catalog_candidates.length === 1 && !price_candidates[0].catalog_number && !price_candidates[0].edition) {
    price_candidates[0].catalog_number = catalog_candidates[0].catalog_number;
  }
  let selectedPrices = requestedCatalog
    ? price_candidates.filter((candidate) => candidate.catalog_number === requestedCatalog)
    : [];
  if (!requestedCatalog && price_candidates.length === 1 && catalog_candidates.length === 1 &&
      price_candidates[0].catalog_number === catalog_candidates[0].catalog_number) {
    selectedPrices = price_candidates;
  }
  const price = selectedPrices.length === 1 ? selectedPrices[0]._price_value : null;
  for (const candidate of price_candidates) delete candidate._price_value;
  const tracklist = extractRawTracklist(text);
  const product_url = meta['og:url'] ? checkedOfficialUrl(publisher, meta['og:url'], 'blocked') : finalUrl;
  const field_status = {
    title: 'source_reported_unverified',
    catalog_number: catalog_candidates.length > 1 ? 'multiple_editions_ambiguous' : catalog_candidates.length === 1 ? 'source_reported_unverified' : 'not_found',
    release_date: release_date ? 'source_reported_unverified' : 'not_found',
    price: price ? 'source_reported_unverified' : price_candidates.length ? 'multiple_editions_ambiguous' : 'not_found',
    image_urls: 'candidates_not_assigned_to_editions',
    tracklist: tracklist ? 'raw_source_text_unverified' : 'not_found',
    edition_association: catalog_candidates.length > 1 ? 'ambiguous' : 'not_independently_verified',
  };
  return {
    publisher,
    source_url: finalUrl,
    product_url,
    title,
    catalog_number: catalog_candidates.length === 1 ? catalog_candidates[0].catalog_number : null,
    catalog_candidates,
    requested_catalog_number: requestedCatalog,
    release_date,
    price,
    price_candidates,
    image_urls: publisherImageCandidates(html, meta, finalUrl),
    tracklist,
    field_status,
    raw: { status, final_url: finalUrl, meta, page_title, edition_association: field_status.edition_association,
      ...(catalogLookup ? { catalog_lookup: catalogLookup } : {}),
      note: '保留官网字段原文；图像与曲目未做版次关联或独立核验。' },
  };
}

export async function fetchBushiroadMusic(urlOrCode, opts = {}) {
  const publisher = 'bushiroad_music';
  const input = String(urlOrCode ?? '').trim();
  if (!input) throw new PublisherError('bad_input', publisher, '缺少参数：官方商品 URL 或已核对的 BRMM 品番');
  let url;
  let requestedCatalog = null;
  let explicitUrl = false;
  if (/^https?:\/\//i.test(input)) {
    explicitUrl = true;
    const u = requireUrlShape(input, publisher, /(^|\.)bushiroad-music\.com$/i, /^\/musics\/[^/]+\/?$/i);
    url = u.href;
    const slug = decodeURIComponent(u.pathname.split('/').filter(Boolean).at(-1) ?? '');
    if (/^BRMM-\d{5}$/i.test(slug)) requestedCatalog = slug.toUpperCase();
  } else if (/^BRMM-?\d{5}$/i.test(input)) {
    requestedCatalog = input.toUpperCase().replace(/^(BRMM)(\d)/, '$1-$2');
    url = 'https://bushiroad-music.com/musics/' + requestedCatalog.toLowerCase() + '/';
  } else {
    throw new PublisherError('bad_input', publisher, '只接受完整 Bushiroad Music 商品 URL 或 BRMM-五位数字品番；未确认其他 slug 映射');
  }
  let fetched;
  try {
    fetched = await fetchHtml(publisher, url, opts);
    const { html, finalUrl, status } = fetched;
    if (!/^\/musics\/[^/]+\/?$/i.test(new URL(finalUrl).pathname)) {
      throw new PublisherError('blocked', publisher, '官方页面重定向到非商品路径：' + finalUrl, { status, url: finalUrl, retryable: false });
    }
    return parseOfficialDiscography(publisher, input, html, finalUrl, status, requestedCatalog);
  } catch (err) {
    // HTTP 真 404/410 与可识别的 200 not-found 标题都由 parser 标为 notfound。
    // 仅裸品番可用目录 API 回退；显式 URL 的失败保持原分类。
    if (explicitUrl || !requestedCatalog || !(err instanceof PublisherError) || err.kind !== 'notfound') throw err;
  }
  const located = await lookupBushiroadCatalog(requestedCatalog, opts);
  fetched = await fetchHtml(publisher, located.url, opts);
  const { html, finalUrl, status } = fetched;
  if (!/^\/musics\/[^/]+\/?$/i.test(new URL(finalUrl).pathname)) {
    throw new PublisherError('blocked', publisher, '官方页面重定向到非商品路径：' + finalUrl, { status, url: finalUrl, retryable: false });
  }
  return parseOfficialDiscography(publisher, input, html, finalUrl, status, requestedCatalog, located.coverage);
}

// ---------- 6. bang-dream.com（/discographies/{numeric-id}/；只接受完整 URL） ----------
export async function fetchBangDream(urlOrCode, opts = {}) {
  const publisher = 'bang_dream';
  const input = String(urlOrCode ?? '').trim();
  if (!input) throw new PublisherError('bad_input', publisher, '缺少参数：BanG Dream 官方 /discographies/{id}/ URL');
  const u = requireUrlShape(input, publisher, /(^|\.)bang-dream\.com$/i, /^\/discographies\/\d+\/?$/i);
  const { html, finalUrl, status } = await fetchHtml(publisher, u.href, opts);
  if (!/^\/discographies\/\d+\/?$/i.test(new URL(finalUrl).pathname)) {
    throw new PublisherError('blocked', publisher, '官方页面重定向到非唱片详情路径：' + finalUrl, { status, url: finalUrl, retryable: false });
  }
  return parseOfficialDiscography(publisher, input, html, finalUrl, status);
}

export const DISPATCH = {
  universal_music: fetchUniversalMusic, umj: fetchUniversalMusic, universal: fetchUniversalMusic,
  pony_canyon: fetchPonyCanyon, ponycanyon: fetchPonyCanyon, pony: fetchPonyCanyon,
  canime: fetchCanime, sony_music: fetchSonyMusic, sony: fetchSonyMusic,
  bushiroad_music: fetchBushiroadMusic, bushiroad: fetchBushiroadMusic,
  bang_dream: fetchBangDream, bangdream: fetchBangDream,
};

/** 统一入口：runPublisherOp(publisherKey, urlOrCode, { fetchFn, ...opts })。失败时抛出 PublisherError。 */
export async function runPublisherOp(publisherKey, urlOrCode, opts = {}) {
  const key = String(publisherKey ?? '').trim().toLowerCase();
  const operation = DISPATCH[key];
  if (!operation) throw new PublisherError('bad_input', null, '未知厂牌操作：' + (key || '(空)'));
  return operation(urlOrCode, opts);
}

if (process.argv[1]?.endsWith('mf-fetch-publishers.mjs')) {
  const [, , publisher, arg] = process.argv;
  const fn = DISPATCH[String(publisher ?? '').toLowerCase()];
  if (!fn || !arg) {
    console.log('用法：node mf-fetch-publishers.mjs <umj|pony|canime|sony|bushiroad|bangdream> <url 或已支持品番>');
    console.log('可用：' + Object.keys(DISPATCH).join(', '));
    process.exit(publisher ? 1 : 0);
  }
  try {
    console.log(JSON.stringify(await runPublisherOp(publisher, arg), null, 2));
  } catch (err) {
    console.error(JSON.stringify(toPublisherError(err), null, 2));
    process.exit(1);
  }
}
