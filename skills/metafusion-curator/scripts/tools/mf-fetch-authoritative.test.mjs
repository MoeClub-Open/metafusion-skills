import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  fetchBangumiSubject,
  fetchMusicBrainzRecording,
  fetchMusicBrainzRelease,
  fetchMusicBrainzReleaseGroup,
  fetchUniversalMusicJapanProduct,
  fetchWikidataEntity,
  MUSICBRAINZ_PACE,
  runAuthoritativeOp,
  searchBangumiSubjects,
  searchMusicBrainzArtist,
  searchMusicBrainzRelease,
  searchMusicBrainzReleaseByField,
  searchWikidata,
} from "./mf-fetch-authoritative.mjs";
import { paceConfig } from "./mf-fetch-providers.mjs";

const productPage = `
<!doctype html>
<html><head>
  <title>Heat Wave [通常盤][CD] - Superfly - UNIVERSAL MUSIC JAPAN</title>
  <meta property="og:image" content="https://www.universal-music.co.jp/superfly/products/jacket.jpg">
</head>
<body>
  <p>フォーマット</p><p>CD</p>
  <p>組み枚数</p><p>1</p>
  <p>レーベル</p><p>Universal Sigma</p>
  <p>発売日</p><p>2023-05-24</p>
  <p>品 番</p><p>UMCK-7212</p>
  <p>別バージョンの品 番</p><p>UMCK-1749</p>
  <p>曲目</p><br>
  <p>1.Heat Wave</p><br>
  <p>2.春はグラデーション</p><br>
  <p>11.Farewell (Gospel Ver.)</p><br>
  <p>別バージョン</p>
</body></html>`;

const UUID = "5b11f4ce-a62d-471e-81fc-a69a8278c7da";
const UMJ_DIGITAL_FIXTURE = readFileSync(new URL("./__fixtures__/umj-digital-ur1as-01267.html", import.meta.url), "utf8");
const UMJ_DIGITAL_MISMATCH_FIXTURE = readFileSync(new URL("./__fixtures__/umj-digital-canonical-mismatch.synthetic.html", import.meta.url), "utf8");
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8" },
});

test("UMJ strict parser returns official image candidates and visible product fields", async () => {
  let request;
  const result = await fetchUniversalMusicJapanProduct("superfly", "umck-1749", {
    fetchImpl: async (input, init) => {
      request = { input: String(input), init };
      return new Response(productPage, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    },
    pace: { attempts: 1, timeoutMs: 500 },
  });
  assert.equal(request.input, "https://www.universal-music.co.jp/superfly/products/umck-1749/");
  assert.equal(request.init.redirect, "manual");
  assert.equal(result.catalog_number, "UMCK-1749");
  assert.equal(result.product_title, "Heat Wave [通常盤][CD]");
  assert.equal(result.artist, "Superfly");
  assert.equal(result.release_date, "2023-05-24");
  assert.equal(result.format, "CD");
  assert.equal(result.media_count, 1);
  assert.match(result.tracklist_excerpt, /11\.Farewell \(Gospel Ver\.\)/);
  assert.deepEqual(result.image_urls, ["https://www.universal-music.co.jp/superfly/products/jacket.jpg"]);
  assert.equal(result.field_status.catalog_number, "verified_exact");
  assert.equal(result.field_status.image_urls, "official_page_image_candidate");
});

test("UMJ rejects a page without the exact visible requested product code", async () => {
  await assert.rejects(
    fetchUniversalMusicJapanProduct("superfly", "umck-1749", {
      fetchImpl: async () => new Response(productPage.replace("UMCK-1749", "UPCH-0001"), { status: 200 }),
      pace: { attempts: 1 },
    }),
    error => error.kind === "identity_mismatch" && /完全匹配/.test(error.message),
  );
});

test("UMJ digital page without visible 品番 passes via canonical + ld+json double confirmation", async () => {
  const result = await fetchUniversalMusicJapanProduct("andteam", "ur1as-01267", {
    fetchImpl: async () => new Response(UMJ_DIGITAL_FIXTURE, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }),
    pace: { attempts: 1 },
  });
  assert.equal(result.catalog_number, "UR1AS-01267");
  assert.equal(result.field_status.catalog_number, "verified_canonical_ld");
  assert.equal(result.product_title, "Fearless[デジタル配信]");
  assert.equal(result.artist, "&TEAM");
  assert.equal(result.format, "デジタル配信");
  assert.equal(result.release_date, "2026-10-10");
  assert.ok(result.image_urls.length >= 1);
});

test("UMJ digital fallback still rejects canonical/ld+json pointing at another code", async () => {
  await assert.rejects(
    fetchUniversalMusicJapanProduct("andteam", "ur1as-01267", {
      fetchImpl: async () => new Response(UMJ_DIGITAL_MISMATCH_FIXTURE, { status: 200 }),
      pace: { attempts: 1 },
    }),
    error => error.kind === "identity_mismatch",
  );
  await assert.rejects(
    fetchUniversalMusicJapanProduct("andteam", "ur1as-01267", {
      // canonical 仍指向请求码，但 ld+json 面包屑/WebPage name 指向另一品番：双重确认不一致即拒绝。
      fetchImpl: async () => new Response(
        UMJ_DIGITAL_FIXTURE.replace('"name":"UR1AS-01267 - &amp;TEAM"', '"name":"UR1AS-99999 - &amp;TEAM"')
          .replace('"name":"UR1AS-01267"', '"name":"UR1AS-99999"'),
        { status: 200 },
      ),
      pace: { attempts: 1 },
    }),
    error => error.kind === "identity_mismatch",
  );
});

test("UMJ input validation runs before fetch and legacy global fetch remains supported", async t => {
  let called = false;
  await assert.rejects(
    fetchUniversalMusicJapanProduct("../secrets", "UMCK-1749", { fetchImpl: async () => { called = true; } }),
    /艺人 slug/,
  );
  assert.equal(called, false);

  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(productPage, { status: 200 });
  const result = await fetchUniversalMusicJapanProduct("superfly", "umck-1749");
  assert.equal(result.field_status.catalog_number, "verified_exact");
});

test("authoritative JSON readers use injected fetchImpl and Bangumi subject search is a JSON POST", async () => {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    if (url.hostname === "www.wikidata.org" && url.pathname === "/w/api.php") {
      return jsonResponse({ search: [{ id: "Q1", label: "Test", description: "Fixture", concepturi: "https://www.wikidata.org/entity/Q1" }] });
    }
    if (url.hostname === "www.wikidata.org") return jsonResponse({ entities: { Q42: { labels: { en: { value: "Forty-two" } }, claims: {} } } });
    if (url.pathname === "/v0/subjects/42") return jsonResponse({ id: 42, name: "Fixture", type: 2, tags: [] });
    if (url.pathname === "/v0/search/subjects") return jsonResponse({ total: 1, limit: 10, offset: 0, data: [{ id: 42, name: "Fixture" }] });
    if (url.pathname === "/ws/2/artist/") return jsonResponse({ artists: [{ id: UUID, name: "Fixture artist", type: "Group", country: "JP" }] });
    throw new Error("unexpected mocked endpoint");
  };

  assert.equal((await searchWikidata("Fixture", "en", { fetchImpl }))[0].id, "Q1");
  assert.equal((await fetchWikidataEntity("q42", { fetchImpl })).qid, "Q42");
  assert.equal((await fetchBangumiSubject("42", { fetchImpl })).id, "42");
  const bangumi = await searchBangumiSubjects("Fixture", { fetchImpl });
  assert.equal(bangumi.total, 1);
  assert.equal(bangumi.candidates[0].id, 42);
  assert.equal((await runAuthoritativeOp("mb_artist", "Fixture", { fetchImpl }))[0].id, UUID);
  const post = calls.find(call => call.url.pathname === "/v0/search/subjects");
  assert.equal(post.init.method, "POST");
  assert.equal(post.init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(post.init.body), { keyword: "Fixture" });
});

test("MusicBrainz detail MBIDs and inc values are validated, and each entity uses a legal default inc", async t => {
  const oldMinInterval = MUSICBRAINZ_PACE.minIntervalMs;
  const oldProviderMinInterval = paceConfig.minIntervalMs;
  MUSICBRAINZ_PACE.minIntervalMs = 0;
  paceConfig.minIntervalMs = 0;
  t.after(() => {
    MUSICBRAINZ_PACE.minIntervalMs = oldMinInterval;
    paceConfig.minIntervalMs = oldProviderMinInterval;
  });

  const urls = [];
  const fetchImpl = async input => {
    const url = new URL(String(input));
    urls.push(url);
    return jsonResponse({ id: UUID, title: "Fixture", media: [], releases: [] });
  };
  assert.equal((await fetchMusicBrainzRelease(UUID, { fetchImpl })).data.title, "Fixture");
  assert.equal((await fetchMusicBrainzReleaseGroup(UUID, { fetchImpl })).entity_type, "release-group");
  assert.equal((await fetchMusicBrainzRecording(UUID, { fetchImpl })).entity_type, "recording");
  assert.deepEqual(urls.map(url => url.pathname.split("/").at(-2)), ["release", "release-group", "recording"]);
  assert.equal(urls[0].searchParams.get("inc"), "labels+recordings+release-groups+media+artist-credits");
  assert.equal(urls[1].searchParams.get("inc"), "releases+artist-credits");
  assert.equal(urls[2].searchParams.get("inc"), "releases+release-groups+artist-credits+isrcs");

  await assert.rejects(fetchMusicBrainzRelease("12345", { fetchImpl }), error => error.kind === "bad_input");
  await assert.rejects(fetchMusicBrainzRelease(UUID, { fetchImpl, inc: ["not-a-valid-inc"] }), error => error.kind === "bad_input");
  assert.equal(urls.length, 3, "invalid IDs/inc are rejected before any request");
});

test("MusicBrainz release search returns candidate fields and keeps the source response", async t => {
  const oldMinInterval = MUSICBRAINZ_PACE.minIntervalMs;
  const oldProviderMinInterval = paceConfig.minIntervalMs;
  MUSICBRAINZ_PACE.minIntervalMs = 0;
  paceConfig.minIntervalMs = 0;
  t.after(() => {
    MUSICBRAINZ_PACE.minIntervalMs = oldMinInterval;
    paceConfig.minIntervalMs = oldProviderMinInterval;
  });

  let requestUrl;
  const result = await searchMusicBrainzRelease("Fixture Release", {
    fetchImpl: async input => {
      requestUrl = new URL(String(input));
      return jsonResponse({ count: 1, releases: [{ id: UUID, title: "Fixture Release", date: "2001", "artist-credit": [], "release-group": { id: UUID, title: "Fixture Group" } }] });
    },
  });
  assert.equal(requestUrl.pathname, "/ws/2/release/");
  assert.equal(requestUrl.searchParams.get("query"), "release:Fixture Release");
  assert.equal(result.total, 1);
  assert.equal(result.candidates[0].id, UUID);
  assert.equal(result.candidates[0].release_group.title, "Fixture Group");
  assert.equal(result.raw.count, 1);
});

test("MusicBrainz release barcode/catno lookups use field queries and validate before fetch", async t => {
  const oldMinInterval = MUSICBRAINZ_PACE.minIntervalMs;
  const oldProviderMinInterval = paceConfig.minIntervalMs;
  MUSICBRAINZ_PACE.minIntervalMs = 0;
  paceConfig.minIntervalMs = 0;
  t.after(() => {
    MUSICBRAINZ_PACE.minIntervalMs = oldMinInterval;
    paceConfig.minIntervalMs = oldProviderMinInterval;
  });

  const seen = [];
  const fetchImpl = async input => {
    const url = new URL(String(input));
    seen.push(url.searchParams.get("query"));
    return jsonResponse({ count: 1, releases: [{ id: UUID, title: "Fixture", "artist-credit": [] }] });
  };
  const byBarcode = await searchMusicBrainzReleaseByField("8804-775254 710", "barcode", { fetchImpl });
  assert.equal(byBarcode.field, "barcode");
  assert.equal(byBarcode.candidates[0].id, UUID);
  const byCatno = await runAuthoritativeOp("musicbrainz.release.catno", "UPCJ-9085", { fetchImpl });
  assert.equal(byCatno.field, "catno");
  assert.deepEqual(seen, ["barcode:8804775254710", "catno:UPCJ-9085"]);

  let called = false;
  const guard = { fetchImpl: async () => { called = true; } };
  await assert.rejects(searchMusicBrainzReleaseByField("ABC", "barcode", guard), error => error.kind === "bad_input");
  await assert.rejects(searchMusicBrainzReleaseByField("12345", "barcode", guard), error => error.kind === "bad_input");
  await assert.rejects(searchMusicBrainzReleaseByField("", "catno", guard), error => error.kind === "bad_input");
  await assert.rejects(searchMusicBrainzReleaseByField("x", "asin", guard), error => error.kind === "bad_input");
  assert.equal(called, false, "invalid field lookups are rejected before any request");
});

test("Bangumi and Wikidata validate identifiers and preserve shared HTTP error kinds safely", async () => {
  await assert.rejects(fetchWikidataEntity("https://example.test/Q42"), error => error.kind === "bad_input");
  await assert.rejects(fetchBangumiSubject("0"), error => error.kind === "bad_input");
  await assert.rejects(
    fetchBangumiSubject("42", { attempts: 1, fetchImpl: async () => new Response("private=fixture-secret", { status: 503 }) }),
    error => error.kind === "rate_limited" && error.status === 503 && !error.message.includes("fixture-secret") && !error.message.includes("api.bgm.tv"),
  );
  await assert.rejects(
    fetchBangumiSubject("42", { attempts: 1, fetchImpl: async () => new Response("private=fixture-secret", { status: 500 }) }),
    error => error.kind === "network" && error.status === 500 && !error.message.includes("fixture-secret") && !error.message.includes("api.bgm.tv"),
  );
});
