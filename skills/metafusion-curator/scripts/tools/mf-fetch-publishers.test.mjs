// mf-fetch-publishers.test.mjs - 离线单测（手工最小 fixture + 注入 fetchImpl；不触网）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  fetchUniversalMusic, fetchPonyCanyon, fetchCanime, fetchSonyMusic,
  fetchBushiroadMusic, fetchBangDream, runPublisherOp, DISPATCH, PUBLISHERS,
  PublisherError, padCode, depadCode, splitCatalog, findReleaseDate, findPrice,
} from './mf-fetch-publishers.mjs';

const fakeFetch = (routes) => async (url) => {
  const key = Object.keys(routes).find((k) => url.includes(k));
  if (!key) throw new Error('test: 未注册 URL ' + url);
  const r = routes[key];
  if (r.throw) throw Object.assign(new Error('socket hang up'), { name: 'TypeError' });
  return {
    status: r.status ?? 200,
    url: r.finalUrl ?? url,
    headers: { get: (n) => (n.toLowerCase() === 'retry-after' ? (r.retryAfter ?? null) : null) },
    text: async () => r.html,
  };
};
const noSleep = async () => {};
const html = (title, metas, body) => '<!doctype html><html><head><title>' + title + '</title>' + metas.join('') + '</head><body>' + body + '</body></html>';

// ---- 品番 ⇄ 站内码 ----
test('padCode: 品番去横杠、数字左补 0 至 9 位（中间补 0000 口径）', () => {
  assert.equal(padCode('PCCG-2541'), 'PCCG000002541');
  assert.equal(padCode('BRZP-18835'), 'BRZP000018835');
  assert.equal(padCode('SCCG-198'), 'SCCG000000198');
  assert.equal(padCode('cocc-17061'), 'COCC000017061');
  assert.equal(padCode('PCCG2541'), 'PCCG000002541');
  assert.equal(depadCode('PCCG000002541'), 'PCCG-2541');
  assert.equal(depadCode('BRZP000018835'), 'BRZP-18835');
  assert.deepEqual(splitCatalog('SRCL-13100'), { prefix: 'SRCL', digits: '13100', suffix: '', hyphenated: 'SRCL-13100' });
  assert.equal(splitCatalog('!!!'), null);
});

// ---- universal-music.co.jp ----
const UMJ_URL = 'https://www.universal-music.co.jp/yorushika/products/upxh-1105/';
const umjFixture = html(
  'ヨルシカ LIVE 「盗作」 [通常盤][Blu-ray] - ヨルシカ - UNIVERSAL MUSIC JAPAN',
  ['<meta property="og:image" content="https://content-jp.umgi.net/products/up/UPXH-1105_xyF_extralarge.jpg?07082026064817">',
   '<meta property="og:url" content="' + UMJ_URL + '">',
   '<meta name="twitter:image" content="https://content-jp.umgi.net/products/up/UPXH-1105_xyF_extralarge.jpg?07082026064817">'],
  '<div>品 番 UPXH-1105</div><div>発売日 2026-01-21</div><div>レーベル UNITY</div><div>フォーマット Blu-ray</div><p>収録曲 Disc1 01. 劣等生 02. 思想犯</p>'
);
test('umj: slug/CODE 与完整 URL 均可，字段抽取与品番核对', async () => {
  const impl = fakeFetch({ 'upxh-1105': { html: umjFixture } });
  const viaPair = await fetchUniversalMusic('yorushika/UPXH-1105', { fetchImpl: impl, delay: noSleep });
  assert.equal(viaPair.publisher, 'universal_music');
  assert.equal(viaPair.title, 'ヨルシカ LIVE 「盗作」 [通常盤][Blu-ray]');
  assert.equal(viaPair.artist, 'ヨルシカ');
  assert.equal(viaPair.catalog_number, 'UPXH-1105');
  assert.equal(viaPair.release_date, '2026-01-21');
  assert.equal(viaPair.product_url, UMJ_URL);
  assert.match(viaPair.image_urls[0], /extralarge\.jpg/);
  assert.match(viaPair.tracklist, /劣等生/);
  assert.equal(viaPair.raw.label, 'UNITY');
  const viaUrl = await fetchUniversalMusic(UMJ_URL, { fetchImpl: impl, delay: noSleep });
  assert.equal(viaUrl.catalog_number, 'UPXH-1105');
});
test('umj: 裸品番 → bad_input；非本站主机 → bad_input', async () => {
  await assert.rejects(fetchUniversalMusic('UPXH-1105'), (e) => e instanceof PublisherError && e.kind === 'bad_input');
  await assert.rejects(fetchUniversalMusic('https://example.com/yorushika/products/upxh-1105/', { fetchImpl: fakeFetch({}) }), (e) => e.kind === 'bad_input');
});

// ---- ponycanyon.co.jp ----
const PC_FIXTURE = html(
  'TVアニメ『テムパル』Original Soundtrack-藤澤慶昌 | ポニーキャニオン',
  ['<meta property="og:title" content="TVアニメ『テムパル』Original Soundtrack-藤澤慶昌 | ポニーキャニオン">',
   '<meta property="og:url" content="https://www.ponycanyon.co.jp/music/PCSP000007652">',
   '<meta property="og:image" content="https://www.ponycanyon.co.jp/images/wcms/accessor/bin/jacket/PCSP000007652.jpg?size=2&order=1">'],
  '<img src="https://www.ponycanyon.co.jp/images/wcms/accessor/bin/jacket/PCSP000007652.jpg?size=4&amp;order=1"><p>発売日 2026年10月3日</p>'
);
test('ponycanyon: jacket 图统一 ?size=3&order=1；品番反补横杠', async () => {
  const impl = fakeFetch({ 'PCSP000007652': { html: PC_FIXTURE } });
  const r = await fetchPonyCanyon('PCSP-7652', { fetchImpl: impl, delay: noSleep });
  assert.equal(r.publisher, 'pony_canyon');
  assert.equal(r.title, 'TVアニメ『テムパル』Original Soundtrack-藤澤慶昌');
  assert.equal(r.catalog_number, 'PCSP-7652');
  assert.equal(r.release_date, '2026-10-03');
  assert.ok(r.image_urls.length >= 1);
  for (const img of r.image_urls) {
    assert.match(img, /jacket/i);
    assert.match(img, /\?size=3&order=1$/, 'jacket 图必须带 size=3&order=1：' + img);
  }
  assert.equal(r.raw.site_code, 'PCSP000007652');
});
test('ponycanyon: 完整 URL 输入 + 非商品路径 → bad_input', async () => {
  const impl = fakeFetch({ 'PCSP000007652': { html: PC_FIXTURE } });
  const r = await fetchPonyCanyon('https://www.ponycanyon.co.jp/music/PCSP000007652/', { fetchImpl: impl, delay: noSleep });
  assert.equal(r.product_url, 'https://www.ponycanyon.co.jp/music/PCSP000007652');
  await assert.rejects(fetchPonyCanyon('https://www.ponycanyon.co.jp/artistlist', { fetchImpl: impl }), (e) => e.kind === 'bad_input');
});

// ---- canime.jp ----
const CANIME_FIXTURE = html(
  '立花日菜 × 矢野妃菜喜「ハートリコシェ」初回限定盤 | きゃにめ',
  ['<meta property="og:title" content="立花日菜 × 矢野妃菜喜「ハートリコシェ」初回限定盤 | きゃにめ">',
   '<meta property="og:url" content="https://canime.jp/product/PCCG000002541/">',
   '<meta property="og:image" content="https://canime.jp/upload/jacket/PCCG000002541/org/1692501001_1.jpg">'],
  '<dl><dt>発売日</dt><dd>2026-10-28</dd></dl><p>価格：¥3,300（税込）</p><ul class="tracks">収録曲：全6曲 01.ハートリコシェ 02.ユアマイヒーロー</ul><h3>関連商品</h3><img src="/upload/product/PCCG-02542.jpg">'
);
test('canime: 品番→URL 补零、og:image 兜底、字段抽取', async () => {
  let seenUrl = null;
  const impl = async (url) => { seenUrl = url; return { status: 200, url, headers: { get: () => null }, text: async () => CANIME_FIXTURE }; };
  const r = await fetchCanime('PCCG-2541', { fetchImpl: impl, delay: noSleep });
  assert.equal(seenUrl, 'https://canime.jp/product/PCCG000002541/');
  assert.equal(r.publisher, 'canime');
  assert.equal(r.title, '立花日菜 × 矢野妃菜喜「ハートリコシェ」初回限定盤');
  assert.equal(r.catalog_number, 'PCCG-2541');
  assert.equal(r.release_date, '2026-10-28');
  assert.match(r.price, /3,300/);
  assert.match(r.tracklist, /ハートリコシェ/);
  assert.ok(!/関連/.test(r.tracklist));
  assert.ok(r.image_urls.includes('https://canime.jp/upload/jacket/PCCG000002541/org/1692501001_1.jpg'));
  assert.equal(r.product_url, 'https://canime.jp/product/PCCG000002541/');
});

// ---- sonymusic.co.jp ----
const SONY_FIXTURE = html(
  'B-EACH TIME L-ONG 40th Anniversary Edition【通常盤CD】 | 大滝詠一 | ソニーミュージックオフィシャルサイト',
  ['<meta property="og:title" content="B-EACH TIME L-ONG 40th Anniversary Edition【通常盤CD】 | 大滝詠一 | ソニーミュージックオフィシャルサイト">',
   '<meta property="og:url" content="https://www.sonymusic.co.jp/artist/EiichiOhtaki/discography/SRCL-13100">',
   '<meta property="og:image" content="https://www.sonymusic.co.jp/adm_image/common/artist_image/83152000/83152074/jacket_image/335907.jpg">'],
  '<p>品番：SRCL-13100</p>'
);
const SONY_SHELL = html('ソニーミュージックオフィシャルサイト',
  ['<meta property="og:image" content="https://www.sonymusic.co.jp/common/assets/images/favicon/ogp.jpg">',
   '<meta property="og:title" content="ソニーミュージックオフィシャルサイト">'],
  '<div>SPA 壳页</div>');
test('sonymusic: slug/CATALOG 拼 URL；og 三段式标题；品番来自 URL', async () => {
  const impl = fakeFetch({ 'SRCL-13100': { html: SONY_FIXTURE } });
  const r = await fetchSonyMusic('EiichiOhtaki/SRCL-13100', { fetchImpl: impl, delay: noSleep });
  assert.equal(r.publisher, 'sony_music');
  assert.equal(r.title, 'B-EACH TIME L-ONG 40th Anniversary Edition【通常盤CD】');
  assert.equal(r.artist, '大滝詠一');
  assert.equal(r.catalog_number, 'SRCL-13100');
  assert.match(r.image_urls[0], /jacket_image/);
  assert.equal(r.raw.artist_slug, 'EiichiOhtaki');
});
test('sonymusic: 伪 200 壳页 → notfound；裸品番 → bad_input', async () => {
  const impl = fakeFetch({ 'discography': { html: SONY_SHELL, finalUrl: 'https://www.sonymusic.co.jp/artist/Nope/discography/ZZZZ-9999' } });
  await assert.rejects(fetchSonyMusic('Nope/ZZZZ-9999', { fetchImpl: impl, delay: noSleep }), (e) => e instanceof PublisherError && e.kind === 'notfound' && e.retryable === false);
  await assert.rejects(fetchSonyMusic('SRCL-13100'), (e) => e.kind === 'bad_input');
});
test('sonymusic: 不存在的品番回落到索引页时报 notfound，不拼假记录', async () => {
  // 2026-10-09 live 实测：lisa/ZZZZ-99999 落到 /artist/lisa/discography/ 索引页。
  const indexPage = html('ディスコグラフィ | LiSA | ソニーミュージックオフィシャルサイト',
    ['<meta property="og:title" content="ディスコグラフィ | LiSA | ソニーミュージックオフィシャルサイト">',
     '<meta property="og:url" content="https://www.sonymusic.co.jp/artist/lisa/discography/">',
     '<meta property="og:image" content="https://www.sonymusic.co.jp/adm_image/common/artist_image/73100000/73100441/artist_photo/71574.jpg">'],
    '<div>索引页</div>');
  const impl = fakeFetch({ 'discography': { html: indexPage, finalUrl: 'https://www.sonymusic.co.jp/artist/lisa/discography/' } });
  await assert.rejects(fetchSonyMusic('lisa/ZZZZ-99999', { fetchImpl: impl, delay: noSleep }),
    (e) => e instanceof PublisherError && e.kind === 'notfound' && e.retryable === false && /索引页/.test(e.message));
});

// ---- 错误分类与退避 ----
test('错误分类：404→notfound / 403→blocked / 传输失败→network 且重试', async () => {
  const mk = (route) => ({ fetchImpl: fakeFetch({ 'canime.jp': route }), delay: noSleep });
  await assert.rejects(fetchCanime('PCCG-2541', mk({ status: 404, html: 'not found' })), (e) => e.kind === 'notfound' && e.retryable === false);
  await assert.rejects(fetchCanime('PCCG-2541', { ...mk({ status: 403, html: '<html>Access Denied</html>' }) }), (e) => e.kind === 'blocked' && e.status === 403);
  let calls = 0;
  const flaky = async () => { calls++; throw Object.assign(new Error('socket hang up'), { name: 'TypeError' }); };
  await assert.rejects(fetchCanime('PCCG-2541', { fetchImpl: flaky, delay: noSleep }), (e) => e.kind === 'network' && e.retryable === true);
  assert.equal(calls, 2, 'network 失败应重试 attempts 次');
});
test('404/410 挑战页或网关错误属于未知状态，不判商品不存在', async () => {
  const cases = [
    { status: 404, html: '<title>Just a moment...</title><script src="https://challenges.cloudflare.com/turnstile"></script>', kind: 'blocked' },
    { status: 410, html: 'No Route matched with those values', kind: 'network' },
    { status: 404, html: 'Error Code: 404', kind: 'network' },
  ];
  for (const route of cases) {
    await assert.rejects(fetchCanime('PCCG-2541', { fetchFn: fakeFetch({ 'canime.jp': route }), delay: noSleep }), (e) =>
      e instanceof PublisherError && e.kind === route.kind && e.status === route.status && e.retryable === (route.kind === 'network'));
  }
});
test('429：遵守 Retry-After 一次后成功', async () => {
  let n = 0; const waits = [];
  const impl = async (url) => {
    n++;
    if (n === 1) return { status: 429, url, headers: { get: (h) => (String(h).toLowerCase() === 'retry-after' ? '1' : null) }, text: async () => 'busy' };
    return { status: 200, url: 'https://canime.jp/product/PCCG000002541/', headers: { get: () => null }, text: async () => CANIME_FIXTURE };
  };
  const r = await fetchCanime('PCCG-2541', { fetchImpl: impl, delay: async (ms) => { waits.push(ms); } });
  assert.equal(n, 2); assert.deepEqual(waits, [1000]);
  assert.equal(r.catalog_number, 'PCCG-2541');
});
test('findReleaseDate 归一化', () => {
  assert.equal(findReleaseDate('発売日 2026年10月3日'), '2026-10-03');
  assert.equal(findReleaseDate('発売日：2026/1/9'), '2026-01-09');
  assert.equal(findReleaseDate('発売日未定'), null);
  // 2026-10-09 pony_canyon live 实测形状：日期在前、“発売”在后。
  assert.equal(findReleaseDate('DVD\n2010.9.3 発売\n本編収録時間'), '2010-09-03');
  assert.equal(findReleaseDate('CD 2026/10/28 発売'), '2026-10-28');
  assert.equal(findReleaseDate('2010.09.03'), null, '无“発売”锚点的裸日期不采纳');
});
test('findPrice: “価格”只出现在菜单/营销文案时回退全文首个金额', () => {
  // 2026-10-09 canime live 实测：“価格が安い順”排序菜单在后、真价格在前。
  assert.equal(findPrice('CD 2026/10/28 発売\n¥3,300 (税込)\nカートに追加\n価格が安い順\n価格が高い順'), '¥3,300 (税込)');
  // pony_canyon live 实测：营销文案“キャンペーン価格で発売”先于定价出现。
  assert.equal(findPrice('キャンペーン価格で発売!!\n2010.09.03\nDVD\n¥2,200(税込)'), '¥2,200(税込)');
  assert.equal(findPrice('価格：¥3,300（税込）'), '¥3,300（税込）');
  assert.equal(findPrice('発売日未定 特典なし'), null);
});

// ---- Bushiroad Music / BanG Dream 官方商品页 ----
const BUSHIROAD_URL = 'https://bushiroad-music.com/musics/brmm-11079/';
const BANG_DREAM_URL = 'https://bang-dream.com/discographies/4218/';
const BUSHIROAD_FIXTURE = readFileSync(new URL('./__fixtures__/publisher-bushiroad.html', import.meta.url), 'utf8');
const BANG_DREAM_FIXTURE = readFileSync(new URL('./__fixtures__/publisher-bang-dream.html', import.meta.url), 'utf8');
const BUSHIROAD_PRICES_FIXTURE = readFileSync(new URL('./__fixtures__/publisher-bushiroad-prices-reversed.synthetic.html', import.meta.url), 'utf8');
const BUSHIROAD_WP_PAGE_1 = JSON.parse(readFileSync(new URL('./__fixtures__/publisher-bushiroad-wp-page-1.synthetic.json', import.meta.url), 'utf8'));
const BUSHIROAD_WP_PAGE_2 = JSON.parse(readFileSync(new URL('./__fixtures__/publisher-bushiroad-wp-page-2.synthetic.json', import.meta.url), 'utf8'));
const BUSHIROAD_WP_PAGE_2_NO_MATCH = JSON.parse(readFileSync(new URL('./__fixtures__/publisher-bushiroad-wp-page-2-no-match.synthetic.json', import.meta.url), 'utf8'));

test('Bushiroad Music: BRMM slug 回核、多品番不猜版次、保留原始曲目', async () => {
  assert.ok(PUBLISHERS.includes('bushiroad_music'));
  assert.equal(DISPATCH.bushiroad_music, fetchBushiroadMusic);
  const result = await runPublisherOp('bushiroad', 'BRMM-11079', { fetchFn: fakeFetch({ 'brmm-11079': { html: BUSHIROAD_FIXTURE } }), delay: noSleep });
  assert.equal(result.publisher, 'bushiroad_music');
  assert.equal(result.source_url, BUSHIROAD_URL);
  assert.equal(result.title, 'MyGO!!!!!×Ave Mujica ツーマンライブ「“moment / memory”」Blu-ray');
  assert.equal(result.release_date, '2026-09-30');
  assert.equal(result.requested_catalog_number, 'BRMM-11079');
  assert.equal(result.catalog_number, null, '存在两种品番时不选择其一');
  assert.deepEqual(result.catalog_candidates, [
    { edition: '5,000枚限定生産特装版', catalog_number: 'BRMM-11079' },
    { edition: '通常版', catalog_number: 'BRMM-11080' },
  ]);
  assert.equal(result.field_status.edition_association, 'ambiguous');
  assert.equal(result.price, null);
  assert.deepEqual(result.price_candidates, []);
  assert.equal(result.field_status.price, 'not_found');
  assert.equal(result.field_status.image_urls, 'candidates_not_assigned_to_editions');
  assert.match(result.tracklist, /Ave Mujica 1\.Choir ‘S’ Choir/);
  assert.match(result.tracklist, /MyGO!!!!! 13\.回層浮/);
  assert.ok(result.image_urls.some((url) => url.endsWith('moment-memory-limited.jpg')));
  assert.ok(result.image_urls.some((url) => url.endsWith('moment-memory-standard.jpg')));
  await assert.rejects(fetchBushiroadMusic('BRMM-11079', { fetchFn: fakeFetch({ 'brmm-11079': { html: BUSHIROAD_FIXTURE.replaceAll('BRMM-11079', 'BRMM-99999') } }), delay: noSleep }),
    (e) => e instanceof PublisherError && e.kind === 'parse' && /未能回核/.test(e.message));
});

test('BanG Dream: 只接受官方唱片详情 URL，保留多版候选而不推断图片归属', async () => {
  assert.ok(PUBLISHERS.includes('bang_dream'));
  assert.equal(DISPATCH.bang_dream, fetchBangDream);
  const result = await runPublisherOp('bangdream', BANG_DREAM_URL, { fetchFn: fakeFetch({ '4218': { html: BANG_DREAM_FIXTURE } }), delay: noSleep });
  assert.equal(result.publisher, 'bang_dream');
  assert.equal(result.product_url, BANG_DREAM_URL);
  assert.equal(result.title, 'MyGO!!!!!×Ave Mujica ツーマンライブ「“moment / memory”」Blu-ray');
  assert.equal(result.release_date, '2026-09-30');
  assert.equal(result.catalog_number, null);
  assert.deepEqual(result.catalog_candidates.map((item) => item.catalog_number), ['BRMM-11079', 'BRMM-11080']);
  assert.equal(result.field_status.catalog_number, 'multiple_editions_ambiguous');
  assert.equal(result.field_status.edition_association, 'ambiguous');
  assert.equal(result.field_status.tracklist, 'raw_source_text_unverified');
  assert.match(result.tracklist, /バックステージコメント映像/);
  await assert.rejects(fetchBangDream('4218'), (e) => e instanceof PublisherError && e.kind === 'bad_input');
  await assert.rejects(fetchBangDream('https://bang-dream.com/discographies/not-a-numeric-id/'), (e) => e.kind === 'bad_input');
});

test('重定向逐跳校验；外域不会收到请求或调用方凭据', async () => {
  const requests = [];
  const safeRedirect = async (url, init) => {
    requests.push({ url, init });
    if (requests.length === 1) return { status: 302, url, headers: { get: (name) => name.toLowerCase() === 'location' ? 'https://www.bang-dream.com/discographies/4218/' : null } };
    return { status: 200, url, headers: { get: () => null }, text: async () => BANG_DREAM_FIXTURE };
  };
  const result = await fetchBangDream(BANG_DREAM_URL, { fetchFn: safeRedirect, headers: { Authorization: 'MF-secret', Cookie: 'MF-session' }, delay: noSleep });
  assert.equal(result.source_url, 'https://www.bang-dream.com/discographies/4218/');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].init.redirect, 'manual');
  for (const request of requests) {
    assert.equal(Object.hasOwn(request.init.headers, 'Authorization'), false);
    assert.equal(Object.hasOwn(request.init.headers, 'Cookie'), false);
  }

  let externalCalls = 0;
  await assert.rejects(fetchBangDream(BANG_DREAM_URL, { fetchFn: async (url) => {
    externalCalls++;
    return { status: 302, url, headers: { get: () => 'https://example.invalid/collect' } };
  }, delay: noSleep }), (e) => e instanceof PublisherError && e.kind === 'blocked');
  assert.equal(externalCalls, 1, '跨域 Location 在第二次请求前被拒绝');
});

test('最终 URL 必须仍属本站；HTTP 200 挑战页显式报 blocked', async () => {
  let challengeBodyRead = false;
  await assert.rejects(fetchBangDream(BANG_DREAM_URL, { fetchFn: async (url) => ({
    status: 200, url: 'https://example.invalid/discographies/4218/', headers: { get: () => null },
    text: async () => { challengeBodyRead = true; return BANG_DREAM_FIXTURE; },
  }), delay: noSleep }), (e) => e instanceof PublisherError && e.kind === 'blocked');
  assert.equal(challengeBodyRead, false, '不解析外域最终响应正文');

  await assert.rejects(fetchBangDream(BANG_DREAM_URL, { fetchFn: fakeFetch({ '4218': { html: '<html><title>Just a moment...</title><body>cf-challenge verify you are human</body></html>' } }), delay: noSleep }),
    (e) => e instanceof PublisherError && e.kind === 'blocked' && e.status === 200);
});

// ---- Bushiroad WordPress API 品番目录兜底与价格候选 ----
function publisherResponse(url, { status = 200, body = '', headers = {}, finalUrl = url } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    status,
    url: finalUrl,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

function wpResponse(url, body, { total = 101, totalPages = 2, status = 200, headers = {}, finalUrl = url } = {}) {
  return publisherResponse(url, {
    status, body, finalUrl,
    headers: {
      'x-wp-total': String(total),
      'x-wp-totalpages': String(totalPages),
      ...headers,
    },
  });
}

function makePublisherFetch(handler) {
  const requests = [];
  const fetchFn = async (url, init = {}) => {
    const request = { url: String(url), init };
    requests.push(request);
    return handler(new URL(String(url)), init, requests);
  };
  return { fetchFn, requests };
}

function bushiroadFallbackFetch({ pages = {}, products = {}, guess = null } = {}) {
  return makePublisherFetch((url) => {
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    if (pathname === '/wp-json/wp/v2/musics') {
      const pageNumber = Number(url.searchParams.get('page') || 1);
      const route = pages[pageNumber] ?? { body: [], totalPages: 2 };
      if (route.throw) throw Object.assign(new Error(route.throw), { name: 'TypeError' });
      const total = route.total ?? 101;
      const totalPages = route.totalPages ?? 2;
      const expectedLength = Math.min(100, Math.max(0, total - (pageNumber - 1) * 100));
      let body = route.body;
      if (Array.isArray(body) && route.padRows !== false && body.length < expectedLength) {
        body = [...body];
        while (body.length < expectedLength) {
          const id = 900000 + pageNumber * 100 + body.length;
          body.push({
            id,
            link: `https://bushiroad-music.com/musics/catalog-filler-${id}/`,
            title: { rendered: `fixture filler ${id}` },
            acf: { d_pnumber: '', d_description: '' },
          });
        }
      }
      return wpResponse(url.href, body, { ...route, total, totalPages });
    }
    if (pathname.toLowerCase() === '/musics/brmm-11078') {
      return guess ?? publisherResponse(url.href, { status: 404, body: 'Not Found' });
    }
    const product = products[pathname.toLowerCase()];
    if (product) return publisherResponse(url.href, product);
    return publisherResponse(url.href, { status: 404, body: 'Not Found' });
  });
}

function wpApiRequests(requests) {
  return requests.filter(({ url }) => new URL(url).pathname.replace(/\/+$/, '') === '/wp-json/wp/v2/musics');
}

function assertNoCallerCredentials(requests) {
  for (const { init } of requests) {
    const names = Object.keys(init.headers ?? {}).map((name) => name.toLowerCase());
    assert.equal(names.includes('authorization'), false, 'Authorization 不得传给官网');
    assert.equal(names.includes('cookie'), false, 'Cookie 不得传给官网');
  }
}

function pricePage({ path = 'brmm-12001', catalogLines, priceLines, priceLabel = '価格：', tail = '' }) {
  const url = `https://bushiroad-music.com/musics/${path}/`;
  const body = [
    '<h1>テスト商品</h1>',
    '<p>【品番】</p>', ...catalogLines.map((line) => `<p>${line}</p>`),
    `<p>${priceLabel}${priceLines.join(' ')}</p>`,
    tail,
  ].join('\n');
  return html('テスト商品｜ディスコグラフィー｜ブシロードミュージック',
    [`<meta property="og:url" content="${url}">`], body);
}

test('BRMM-11078 slug 404 后分页扫描官方 ACF 描述，定位 BRMM-11077 并保留请求品番', async () => {
  const { fetchFn, requests } = bushiroadFallbackFetch({
    pages: {
      1: { body: BUSHIROAD_WP_PAGE_1, totalPages: 2 },
      2: { body: BUSHIROAD_WP_PAGE_2, totalPages: 2 },
    },
    products: { '/musics/brmm-11077': { body: BUSHIROAD_PRICES_FIXTURE } },
  });
  const result = await fetchBushiroadMusic('BRMM-11078', {
    fetchFn, delay: noSleep, pace: { attempts: 1 },
    headers: { Authorization: 'MF-secret', Cookie: 'MF-session' },
  });

  assert.equal(result.requested_catalog_number, 'BRMM-11078');
  assert.equal(result.source_url, 'https://bushiroad-music.com/musics/brmm-11077/');
  assert.equal(result.catalog_number, null, '原页面的多版 catalog_number 仍为 null');
  assert.deepEqual(result.catalog_candidates, [
    { edition: 'グッズ付初回生産限定盤', catalog_number: 'BRMM-11077' },
    { edition: '通常盤', catalog_number: 'BRMM-11078' },
  ]);
  assert.equal(result.price, '1,650円（税込）', '精确命中请求品番对应的通常盤价格');
  assert.equal(result.price_candidates.find((candidate) => candidate.catalog_number === 'BRMM-11078').amount, 1650);
  assert.match(result.price_candidates.find((candidate) => candidate.catalog_number === 'BRMM-11078').raw, /通常盤.*1,650円（税込）/);
  assert.equal(result.field_status.price, 'source_reported_unverified');
  assert.equal(result.field_status.image_urls, 'candidates_not_assigned_to_editions');

  const apiRequests = wpApiRequests(requests);
  assert.deepEqual(apiRequests.map(({ url }) => Number(new URL(url).searchParams.get('page'))), [1, 2]);
  assert.ok(apiRequests.every(({ url, init }) => new URL(url).hostname.endsWith('bushiroad-music.com') && init.redirect === 'manual'));
  assert.ok(apiRequests.every(({ url }) => new URL(url).searchParams.get('per_page') === '100'));
  assert.ok(apiRequests.every(({ url }) => /acf\.d_pnumber/.test(new URL(url).searchParams.get('_fields') ?? '') && /acf\.d_description/.test(new URL(url).searchParams.get('_fields') ?? '')));
  assertNoCallerCredentials(requests);
  assert.ok(!requests.some(({ url }) => new URL(url).pathname.toLowerCase().includes('brmm-11075')),
    'millsage《鳴らす》的 BRMM-11075 不能替代请求品番');
});

test('官方 WP API 第二页可命中；完整分页无匹配时才报告 notfound，BRMM-11075 不替代', async () => {
  const found = bushiroadFallbackFetch({
    pages: {
      1: { body: BUSHIROAD_WP_PAGE_1, totalPages: 2 },
      2: { body: BUSHIROAD_WP_PAGE_2, totalPages: 2 },
    },
    products: { '/musics/brmm-11077': { body: BUSHIROAD_PRICES_FIXTURE } },
  });
  const result = await fetchBushiroadMusic('BRMM-11078', { fetchFn: found.fetchFn, delay: noSleep, pace: { attempts: 1 } });
  assert.equal(result.title, 'MyGO!!!!!×Ave Mujica ツーマンライブ「“moment / memory”」Blu-ray');
  assert.ok(wpApiRequests(found.requests).some(({ url }) => new URL(url).searchParams.get('page') === '2'));

  const missing = bushiroadFallbackFetch({
    pages: {
      1: { body: BUSHIROAD_WP_PAGE_1, totalPages: 2 },
      2: { body: BUSHIROAD_WP_PAGE_2_NO_MATCH, totalPages: 2 },
    },
  });
  await assert.rejects(fetchBushiroadMusic('BRMM-11078', { fetchFn: missing.fetchFn, delay: noSleep, pace: { attempts: 1 } }),
    (e) => e instanceof PublisherError && e.kind === 'notfound' && e.retryable === false);
  assert.deepEqual(wpApiRequests(missing.requests).map(({ url }) => Number(new URL(url).searchParams.get('page'))), [1, 2]);
  assert.ok(!missing.requests.some(({ url }) => /\/musics\/brmm-11075\//i.test(url)));
});

test('只有原 slug 明确 notfound 才启动目录扫描', async () => {
  const { fetchFn, requests } = bushiroadFallbackFetch({ guess: publisherResponse('https://bushiroad-music.com/musics/brmm-11078/', { status: 403, body: 'Access Denied' }) });
  await assert.rejects(fetchBushiroadMusic('BRMM-11078', { fetchFn, delay: noSleep, pace: { attempts: 1 } }),
    (e) => e instanceof PublisherError && e.kind === 'blocked');
  assert.equal(wpApiRequests(requests).length, 0, 'blocked/network/http 等状态不能启动 notfound 兜底');
});

test('WP API 分页失败、缺页界、坏 JSON 或错误结构均保持未知，不降级成 notfound', async (t) => {
  const cases = [
    ['第二页网络失败', { 1: { body: BUSHIROAD_WP_PAGE_1, totalPages: 2 }, 2: { throw: 'socket hang up' } }, 'network'],
    ['第二页 HTTP 失败', { 1: { body: BUSHIROAD_WP_PAGE_1, totalPages: 2 }, 2: { body: 'temporary failure', status: 503, totalPages: 2 } }, null],
    ['目录 API 自身返回 404', { 1: { body: 'Not Found', status: 404, total: 101, totalPages: 2 } }, null],
    ['缺少总页数边界', { 1: { body: BUSHIROAD_WP_PAGE_1, headers: { 'x-wp-totalpages': null, 'x-wp-total': '1121' } } }, null],
    ['坏 JSON', { 1: { body: '{', total: 1, totalPages: 1, headers: { 'content-type': 'application/json' } } }, null],
    ['JSON 顶层不是数组', { 1: { body: { items: BUSHIROAD_WP_PAGE_1 }, total: 1, totalPages: 1 } }, null],
    ['数组项缺少 WP/ACF 字段', { 1: { body: [{ id: 99, title: '残缺记录' }], total: 1, totalPages: 1 } }, null],
    ['ACF 对象为空', { 1: { body: [{ id: 99, link: 'https://bushiroad-music.com/musics/empty-acf/', title: { rendered: '空 ACF' }, acf: {} }], total: 1, totalPages: 1 } }, 'parse'],
    ['ACF 缺少 d_description', { 1: { body: [{ id: 99, link: 'https://bushiroad-music.com/musics/missing-description/', title: { rendered: '缺描述' }, acf: { d_pnumber: 'BRMM-11075' } }], total: 1, totalPages: 1 } }, 'parse'],
    ['WP id 为零', { 1: { body: [{ id: 0, link: 'https://bushiroad-music.com/musics/zero-id/', title: { rendered: '零 ID' }, acf: { d_pnumber: '', d_description: '' } }], total: 1, totalPages: 1 } }, 'parse'],
    ['WP id 为负数', { 1: { body: [{ id: -1, link: 'https://bushiroad-music.com/musics/negative-id/', title: { rendered: '负 ID' }, acf: { d_pnumber: '', d_description: '' } }], total: 1, totalPages: 1 } }, 'parse'],
    ['第二页条数越过分页边界', { 1: { body: BUSHIROAD_WP_PAGE_1, total: 101, totalPages: 2 }, 2: { body: [], total: 101, totalPages: 2, padRows: false } }, null],
    ['目录超过有界扫描上限', { 1: { body: BUSHIROAD_WP_PAGE_1, total: 2101, totalPages: 22 } }, null],
    ['反爬挑战', { 1: { body: '<html>Just a moment... verify you are human</html>', status: 403 } }, 'blocked'],
  ];
  for (const [name, pages, expectedKind] of cases) {
    await t.test(name, async () => {
      const { fetchFn, requests } = bushiroadFallbackFetch({ pages });
      await assert.rejects(fetchBushiroadMusic('BRMM-11078', { fetchFn, delay: noSleep, pace: { attempts: 1 } }), (e) => {
        assert.ok(e instanceof PublisherError);
        assert.notEqual(e.kind, 'notfound', '不完整或无效的目录读取不能证明品番不存在');
        if (expectedKind) assert.equal(e.kind, expectedKind);
        return true;
      });
      assert.ok(wpApiRequests(requests).length > 0);
    });
  }
});

test('WP API 外域重定向在发出第二次请求前拒绝，且请求头不含调用方凭据', async () => {
  let externalCalls = 0;
  const { fetchFn, requests } = makePublisherFetch((url) => {
    if (url.pathname.replace(/\/+$/, '').toLowerCase() === '/musics/brmm-11078') return publisherResponse(url.href, { status: 404, body: 'Not Found' });
    if (url.pathname.replace(/\/+$/, '') === '/wp-json/wp/v2/musics') {
      return publisherResponse(url.href, { status: 302, headers: { location: 'https://collector.invalid/steal' } });
    }
    if (url.hostname === 'collector.invalid') externalCalls++;
    return publisherResponse(url.href, { status: 200, body: '[]' });
  });
  await assert.rejects(fetchBushiroadMusic('BRMM-11078', {
    fetchFn, delay: noSleep, pace: { attempts: 1 }, headers: { Authorization: 'MF-secret', Cookie: 'MF-session' },
  }), (e) => e instanceof PublisherError && e.kind === 'blocked');
  assert.equal(externalCalls, 0);
  assertNoCallerCredentials(requests);
});

test('目录分页中两个页面都命中同一请求品番时报告歧义，不提前或任意选页面', async () => {
  const first = {
    id: 9001,
    link: 'https://bushiroad-music.com/musics/first-match/',
    title: { rendered: '第一条候选' },
    acf: { d_pnumber: 'BRMM-11078', d_description: '通常盤 BRMM-11078' },
  };
  const second = {
    id: 9002,
    link: 'https://bushiroad-music.com/musics/second-match/',
    title: { rendered: '第二条候选' },
    acf: { d_pnumber: 'BRMM-11077', d_description: '限定盤 BRMM-11077、通常盤 BRMM-11078' },
  };
  const { fetchFn, requests } = bushiroadFallbackFetch({
    pages: { 1: { body: [first], totalPages: 2 }, 2: { body: [second], totalPages: 2 } },
  });
  await assert.rejects(fetchBushiroadMusic('BRMM-11078', { fetchFn, delay: noSleep, pace: { attempts: 1 } }),
    (e) => e instanceof PublisherError && e.kind === 'parse' && e.kind !== 'notfound');
  assert.deepEqual(wpApiRequests(requests).map(({ url }) => Number(new URL(url).searchParams.get('page'))), [1, 2]);
  assert.ok(!requests.some(({ url }) => /\/musics\/(?:first-match|second-match)\//.test(url)), '发现重复候选后不能任意读取其一');
});

test('分页总量稳定但 item.id 重复或页面内容重复时，不得标记 complete/notfound', async (t) => {
  const repeated = {
    id: 7001,
    link: 'https://bushiroad-music.com/musics/repeated-entry/',
    title: { rendered: '重复页记录' },
    acf: { d_pnumber: 'BRMM-11075', d_description: 'BRMM-11075' },
  };
  const cases = [
    ['同页重复 item.id', { 1: { body: [repeated, { ...repeated, title: { rendered: '同页重复记录' } }], total: 2, totalPages: 1 } }],
    ['跨页重复 item.id/重复记录', {
      1: { body: [repeated], total: 101, totalPages: 2 },
      2: { body: [{ ...repeated }], total: 101, totalPages: 2 },
    }],
  ];
  for (const [name, pages] of cases) {
    await t.test(name, async () => {
      const { fetchFn, requests } = bushiroadFallbackFetch({ pages });
      await assert.rejects(fetchBushiroadMusic('BRMM-11078', { fetchFn, delay: noSleep, pace: { attempts: 1 } }), (e) => {
        assert.ok(e instanceof PublisherError);
        assert.notEqual(e.kind, 'notfound', '重复数据不能作为完整且无匹配的目录扫描结果');
        return true;
      });
      assert.ok(wpApiRequests(requests).length > 0);
    });
  }
});

test('裸品番遇到 HTTP 200 官方 404 标题时也扫描目录并定位正确商品', async () => {
  const fake404 = publisherResponse('https://bushiroad-music.com/musics/brmm-11078/', {
    status: 200,
    body: '<!doctype html><html><head><title>404 NOT FOUND</title></head><body>Page not found</body></html>',
  });
  const { fetchFn, requests } = bushiroadFallbackFetch({
    guess: fake404,
    pages: {
      1: { body: BUSHIROAD_WP_PAGE_1, totalPages: 2 },
      2: { body: BUSHIROAD_WP_PAGE_2, totalPages: 2 },
    },
    products: { '/musics/brmm-11077': { body: BUSHIROAD_PRICES_FIXTURE } },
  });
  const result = await fetchBushiroadMusic('BRMM-11078', { fetchFn, delay: noSleep, pace: { attempts: 1 } });
  assert.equal(result.requested_catalog_number, 'BRMM-11078');
  assert.equal(result.source_url, 'https://bushiroad-music.com/musics/brmm-11077/');
  assert.ok(wpApiRequests(requests).length > 0);
});

test('BanG Dream 不产生 requested_catalog_number；多版价格候选保留且不任选', async () => {
  const result = await fetchBangDream(BANG_DREAM_URL, { fetchFn: fakeFetch({ '4218': { html: BANG_DREAM_FIXTURE } }), delay: noSleep });
  assert.equal(result.requested_catalog_number, null);
  assert.equal(result.catalog_number, null);
  assert.deepEqual(result.price_candidates.map(({ edition, catalog_number, amount, currency, tax_included }) => ({
    edition, catalog_number, amount, currency, tax_included,
  })), [
    { edition: '5,000枚限定生産特装版', catalog_number: 'BRMM-11079', amount: 19800, currency: 'JPY', tax_included: true },
    { edition: '通常版', catalog_number: 'BRMM-11080', amount: 8800, currency: 'JPY', tax_included: true },
  ]);
  assert.ok(result.price_candidates.every(({ raw }) => typeof raw === 'string' && raw.length > 0));
  assert.equal(result.price, null);
  assert.equal(result.field_status.price, 'multiple_editions_ambiguous');
});

test('Bushiroad 多版按明确版名关联价格，不按价格/品番出现顺序配对', async () => {
  const byCode = (code) => fetchBushiroadMusic(code, {
    fetchFn: fakeFetch({
      'brmm-11077': { html: BUSHIROAD_PRICES_FIXTURE },
      'brmm-11078': { html: BUSHIROAD_PRICES_FIXTURE },
    }),
    delay: noSleep,
  });
  const limited = await byCode('BRMM-11077');
  const standard = await byCode('BRMM-11078');
  assert.equal(limited.requested_catalog_number, 'BRMM-11077');
  assert.equal(limited.catalog_number, null);
  assert.equal(limited.price, '4,400円（税込）');
  assert.equal(standard.requested_catalog_number, 'BRMM-11078');
  assert.equal(standard.catalog_number, null);
  assert.equal(standard.price, '1,650円（税込）');
  assert.deepEqual(limited.price_candidates.map(({ edition, catalog_number, amount, currency, tax_included }) => ({
    edition, catalog_number, amount, currency, tax_included,
  })), [
    { edition: '通常盤', catalog_number: 'BRMM-11078', amount: 1650, currency: 'JPY', tax_included: true },
    { edition: 'グッズ付初回生産限定盤', catalog_number: 'BRMM-11077', amount: 4400, currency: 'JPY', tax_included: true },
  ]);
  assert.ok(limited.price_candidates.every(({ raw }) => typeof raw === 'string' && raw.length > 0));
  assert.match(limited.price_candidates.find(({ catalog_number }) => catalog_number === 'BRMM-11077').raw, /グッズ付初回生産限定盤.*4,400円（税込）/);
  assert.equal(limited.field_status.price, 'source_reported_unverified');
});

test('无品番 slug 的多版 URL 保留价格候选但 price 为空', async () => {
  const url = 'https://bushiroad-music.com/musics/moment-memory/';
  const result = await fetchBushiroadMusic(url, { fetchFn: fakeFetch({ 'moment-memory': { html: BUSHIROAD_PRICES_FIXTURE } }), delay: noSleep });
  assert.equal(result.requested_catalog_number, null);
  assert.equal(result.catalog_number, null);
  assert.equal(result.price, null);
  assert.equal(result.field_status.price, 'multiple_editions_ambiguous');
  assert.equal(result.price_candidates.length, 2);
});

test('单版官方定价允许回填；不把店铺价计作定价，曲目在特典段前结束', async () => {
  const fixture = pricePage({
    catalogLines: ['通常盤：BRMM-12001'],
    priceLabel: '定価：', priceLines: ['2,750円（税込）'],
    tail: '<h2>【収録曲】</h2><p>01. 本編の曲</p><h3>【法人別特典】</h3><p>販売店価格：1,980円</p><p>特典映像 99,999円</p>',
  });
  const result = await fetchBushiroadMusic('BRMM-12001', { fetchFn: fakeFetch({ 'brmm-12001': { html: fixture } }), delay: noSleep });
  assert.equal(result.requested_catalog_number, 'BRMM-12001');
  assert.equal(result.catalog_number, 'BRMM-12001');
  assert.match(result.price, /2,750円（税込）/);
  assert.deepEqual(result.price_candidates.map(({ edition, catalog_number, amount, currency, tax_included }) => ({
    edition, catalog_number, amount, currency, tax_included,
  })), [{ edition: null, catalog_number: 'BRMM-12001', amount: 2750, currency: 'JPY', tax_included: true }]);
  assert.match(result.price_candidates[0].raw, /2,750円（税込）/);
  assert.equal(result.price, '2,750円（税込）');
  assert.match(result.tracklist, /本編の曲/);
  assert.doesNotMatch(result.tracklist, /法人別特典|販売店価格|特典映像/);

  const viaUrl = await fetchBushiroadMusic('https://bushiroad-music.com/musics/single-item/', {
    fetchFn: fakeFetch({ 'single-item': { html: fixture } }), delay: noSleep,
  });
  assert.equal(viaUrl.requested_catalog_number, null);
  assert.equal(viaUrl.price, '2,750円（税込）', '整页恰有一个价格候选与一个品番时允许使用该价格');
});

test('税抜、币种未知和税制未知按原文分别报告；不从裸数字猜 JPY', async () => {
  const taxExcluded = pricePage({
    path: 'brmm-12002', catalogLines: ['通常盤：BRMM-12002'], priceLabel: '定価：', priceLines: ['¥2,500（税抜）'],
  });
  const unknownCurrencyAndTax = pricePage({
    path: 'brmm-12003', catalogLines: ['通常盤：BRMM-12003'], priceLabel: '定価：', priceLines: ['2,500'],
  });
  const run = (code, fixture) => fetchBushiroadMusic(code, {
    fetchFn: fakeFetch({ [code.toLowerCase()]: { html: fixture } }), delay: noSleep,
  });
  const excluded = await run('BRMM-12002', taxExcluded);
  assert.equal(excluded.price_candidates[0].amount, 2500);
  assert.equal(excluded.price_candidates[0].currency, 'JPY');
  assert.equal(excluded.price_candidates[0].tax_included, false);

  const unknown = await run('BRMM-12003', unknownCurrencyAndTax);
  assert.equal(unknown.price_candidates[0].amount, 2500);
  assert.equal(unknown.price_candidates[0].currency, null);
  assert.equal(unknown.price_candidates[0].tax_included, null);
  assert.equal(unknown.field_status.price, 'source_reported_unverified');
});

test('同一版名出现多价或价格版名无法归版时保留候选并令 price 为空', async () => {
  const duplicatePrices = pricePage({
    path: 'brmm-12004', catalogLines: ['通常盤：BRMM-12004'],
    priceLines: ['通常盤：1,650円（税込）', '通常盤：1,700円（税込）'],
  });
  const unmatchedEdition = pricePage({
    path: 'brmm-12005',
    catalogLines: ['初回限定盤：BRMM-12005', '通常盤：BRMM-12006'],
    priceLines: ['キャンペーン価格：1,000円（税込）'],
  });
  const run = (code, fixture) => fetchBushiroadMusic(code, {
    fetchFn: fakeFetch({ [code.toLowerCase()]: { html: fixture } }), delay: noSleep,
  });
  const duplicate = await run('BRMM-12004', duplicatePrices);
  assert.equal(duplicate.price, null);
  assert.equal(duplicate.field_status.price, 'multiple_editions_ambiguous');
  assert.equal(duplicate.price_candidates.length, 2);
  assert.ok(duplicate.price_candidates.every(({ catalog_number }) => catalog_number === 'BRMM-12004'));

  const unmatched = await run('BRMM-12005', unmatchedEdition);
  assert.equal(unmatched.price, null);
  assert.equal(unmatched.field_status.price, 'multiple_editions_ambiguous');
  assert.equal(unmatched.price_candidates.length, 1);
  assert.equal(unmatched.price_candidates[0].catalog_number, null);
  assert.match(unmatched.price_candidates[0].raw, /キャンペーン価格/);
});

test('金额紧贴的货币符号不算版名：单版单价允许回填', async () => {
  // 2026-10-09 bang-dream.com/discographies/122/ live 实测形状：价格标签与金额分行，
  // “￥7,000”的 ￥ 不得成为 edition，否则会阻断单版价格回填。
  const body = [
    '<h1>BanG Dream! Vol.7</h1>',
    '<p>発売日</p><p>2017年11月22日</p>',
    '<p>価格</p><p>￥7,000</p>',
    '<p>品番</p><p>OVXN-0035</p>',
    '<h2>収録内容</h2><p>#13,完全新作OVA</p>',
  ].join('\n');
  const fixture = html('BanG Dream! Vol.7｜ディスコグラフィ｜BanG Dream!（バンドリ！）公式サイト',
    [`<meta property="og:url" content="${BANG_DREAM_URL}">`], body);
  const result = await fetchBangDream(BANG_DREAM_URL, { fetchFn: fakeFetch({ '4218': { html: fixture } }), delay: noSleep });
  assert.equal(result.catalog_number, 'OVXN-0035');
  assert.equal(result.price, '￥7,000');
  assert.deepEqual(result.price_candidates.map(({ edition, catalog_number, amount, currency }) => ({
    edition, catalog_number, amount, currency,
  })), [{ edition: null, catalog_number: 'OVXN-0035', amount: 7000, currency: 'JPY' }]);
  assert.equal(result.field_status.price, 'source_reported_unverified');
});

test('单版页出现未匹配的明确版名时，不把唯一品番自动赋给该价格', async () => {
  const fixture = pricePage({
    path: 'brmm-12007', catalogLines: ['通常盤：BRMM-12007'],
    priceLines: ['初回限定盤：1,650円（税込）'],
  });
  const result = await fetchBushiroadMusic('BRMM-12007', {
    fetchFn: fakeFetch({ 'brmm-12007': { html: fixture } }), delay: noSleep,
  });
  assert.equal(result.catalog_candidates.length, 1);
  assert.equal(result.price_candidates.length, 1);
  assert.match(result.price_candidates[0].edition, /初回限定盤/);
  assert.equal(result.price_candidates[0].catalog_number, null);
  assert.equal(result.price, null);
  assert.equal(result.field_status.price, 'multiple_editions_ambiguous');
});
