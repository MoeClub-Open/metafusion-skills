// mf-providers-smoke.mjs - 对每个真实提供方各发一次只读请求，验证 mf-fetch-providers.mjs 的可用性结论
//
// 为什么单独一个脚本：README-providers.md 的提供方矩阵是"某天实测的结论"，会被反爬策略、
// 网关改版、限流政策悄悄改变。这个脚本就是那份结论的复核器：串行、每提供方一次、
// 不写任何线上数据、不带站内凭据、不打印任何环境变量值（只报"是否已配置"）。
//
// 用法：
//   node mf-providers-smoke.mjs                 // 全部提供方
//   node mf-providers-smoke.mjs --only discogs  // 只测某个提供方（可重复）
//   node mf-providers-smoke.mjs --json          // 机器可读结果
//   node mf-providers-smoke.mjs --images        // 额外 HEAD 一次返回的图片 URL（每提供方最多 1 张）
//
// 退出码：0 = 匿名官方/社区提供方都可达（OK 或明确 NOT_FOUND）；1 = 出现未预期失败
// （network / http / parse / rate_limited / blocked-on-anonymous）。
// credential_missing 与已记录的 unavailable 只报告，不算失败——它们就是矩阵里的结论。

import { describeError, runProviderOp, PROVIDER_MATRIX, paceConfig, USER_AGENT } from "./mf-fetch-providers.mjs";
import { pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
const ONLY = [];
argv.forEach((a, i) => { if (a === "--only" && argv[i + 1]) ONLY.push(argv[i + 1]); });
const AS_JSON = argv.includes("--json");
const CHECK_IMAGES = argv.includes("--images");

// 每个提供方一次最小请求；参数是真实存在的记录（不是编造的），便于逐字核对。
const PLAN = [
  { kind: "discogs", op: "discogs.search", arg: "daft punk discovery", expect: ["OK", "RATE_LIMITED"], why: "匿名 database/search" },
  { kind: "discogs", op: "discogs.release", arg: "2879", expect: ["OK", "RATE_LIMITED"], why: "匿名 releases/{id}" },
  { kind: "openlibrary", op: "openlibrary.search", arg: "the name of the rose", expect: ["OK"], why: "search.json" },
  { kind: "openlibrary", op: "openlibrary.edition", arg: "OL56967691M", expect: ["OK"], why: "books/{id}.json" },
  { kind: "openlibrary", op: "openlibrary.editions", arg: "OL8996439W", expect: ["OK"], why: "works/{id}/editions.json（找有封面的版本）" },
  { kind: "openlibrary", op: "openlibrary.author", arg: "OL76088A", expect: ["OK"], why: "authors/{id}.json（remote_ids.isni）" },
  { kind: "internetarchive", op: "archive.item", arg: "hot-buttered-rum-internet-archive-2022", expect: ["OK"], why: "/metadata/{identifier}" },
  { kind: "internetarchive", op: "archive.wayback", arg: "https://vgmdb.net/album/111949", expect: ["OK", "NOT_FOUND"], why: "wayback/available" },
  { kind: "tmdb", op: "tmdb.movie", arg: "550", expect: ["OK", "NO_KEY"], why: "需 TMDB_API_KEY / TMDB_ACCESS_TOKEN" },
  { kind: "anilist", op: "anilist.media", arg: "20757", expect: ["OK"], why: "公开 GraphQL" },
  { kind: "anilist", op: "anilist.search", arg: "Frieren", expect: ["OK"], why: "公开 GraphQL Page/media" },
  { kind: "myanimelist", op: "mal.anime", arg: "1", expect: ["OK", "NO_KEY", "BLOCKED"], why: "匿名 403；需 MAL_CLIENT_ID" },
  { kind: "isni", op: "isni.record", arg: "0000 0001 2138 9471", expect: ["OK", "BLOCKED"], why: "记录端点（实测被 Cloudflare 拦）" },
  { kind: "viaf", op: "viaf.record", arg: "59163545", expect: ["OK", "UNAVAILABLE", "BLOCKED"], why: "记录端点（实测网关 404）" },
  { kind: "oclc", op: "oclc.fast", arg: "mark twain", expect: ["OK", "UNAVAILABLE", "BLOCKED"], anonymousProbe: true, why: "FAST（匿名端点，实测网关错误）" },
  { kind: "ndl", op: "ndl.authority", arg: "00130315", expect: ["OK"], why: "id.ndl.go.jp 权威 JSON-LD" },
  { kind: "vgmdb", op: "vgmdb.album", arg: "111949", expect: ["OK", "BLOCKED"], why: "直连（实测反爬 403）" },
  { kind: "vgmdb", op: "vgmdb.archive", arg: "111949", expect: ["OK", "NOT_FOUND", "UNAVAILABLE"], why: "经 Internet Archive id_ 存档（2 次请求）" },
  { kind: "itunes", op: "itunes.search", arg: "AQUAPLUS", expect: ["OK"], why: "免费 Search API（media=music&entity=album，country=jp）" },
  { kind: "itunes", op: "itunes.album", arg: "541874266", expect: ["OK"], why: "lookup?id=<collectionId>&entity=song（含曲目）" },
  { kind: "steam", op: "steam.app", arg: "504230 langs=english,japanese,schinese", expect: ["OK"], why: "appdetails（AppID 504230 Celeste；三语种串行）" },
  { kind: "steam", op: "steam.search", arg: "Celeste", expect: ["OK"], why: "storesearch 候选（含原声/DLC 类型）" },
  { kind: "coverartarchive", op: "caa.release", arg: "23fd33ae-3d3d-4414-b5f1-94bf374bff90", expect: ["OK", "NOT_FOUND"], why: "发行版封面索引；无 front 不产生主候选" },
  { kind: "kitsu", op: "kitsu.anime", arg: "46474", expect: ["OK"], why: "JSON:API 条目；证据 URL 为实际 API" },
  { kind: "vndb", op: "vndb.vn", arg: "v17", expect: ["OK"], why: "POST /kana/vn；证据保留请求方法" },
  { kind: "openbd", op: "openbd.isbn", arg: "9784048923514", expect: ["OK", "NOT_FOUND"], why: "ONIX 书目；[null] 只表示未收录" },
  { kind: "gutenberg", op: "gutenberg.ebook", arg: "1513", expect: ["OK"], why: "ebook RDF；封面 URL 必须来自 hasFormat" },
];

const KIND_TO_OUTCOME = {
  credential_missing: "NO_KEY",
  blocked: "BLOCKED",
  unavailable: "UNAVAILABLE",
  rate_limited: "RATE_LIMITED",
  network: "NETWORK",
  http: "HTTP",
  parse: "PARSE",
  bad_input: "BAD_INPUT",
  unsupported: "UNSUPPORTED",
};

function hasCredential(provider) {
  const entry = PROVIDER_MATRIX[provider] || {};
  const names = entry.credentialEnv || [];
  const present = names.filter((n) => String(process.env[n] || "").trim());
  return { needed: names.length > 0, present: present };
}

export async function probeImageTransport(url, { fetchImpl = globalThis.fetch } = {}) {
  try {
    const res = await fetchImpl(url, { headers: { "User-Agent": USER_AGENT, Accept: "image/*,*/*" }, method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(20000) });
    const ct = res.headers.get("content-type") || "";
    return { status: res.status, responded: true, http_success: res.ok, declared_content_type: ct,
      content_verified: false, identity_status: "unknown", rights_status: "unknown" };
  } catch (err) {
    return { status: 0, responded: false, http_success: false, error: err?.name || "Error",
      content_verified: false, identity_status: "unknown", rights_status: "unknown" };
  }
}

export async function runSmoke() {
  const rows = [];
  paceConfig.minIntervalMs = Math.max(paceConfig.minIntervalMs, 400);

  for (const step of PLAN) {
    if (ONLY.length && !ONLY.includes(step.provider) && !ONLY.includes(step.op)) continue;
    const cred = hasCredential(step.provider);
    const started = Date.now();
    let row = { kind: step.provider, op: step.op, why: step.why, expects: step.expect, credential: cred.needed ? (cred.present.length ? "已配置 " + cred.present.join(",") : "未配置（" + (PROVIDER_MATRIX[step.provider].credentialEnv || []).join(" / ") + "）") : "匿名" };
    // 只有"这个 op 真的需要凭据且没配"才跳过；像 OCLC FAST 这种匿名端点即使矩阵标 credential 也要实测一次。
    const needsCredential = step.anonymousProbe ? false : (cred.needed && !cred.present.length);
    if (needsCredential) {
      rows.push(Object.assign(row, { outcome: "SKIP_NO_KEY", ms: 0 }));
      continue;
    }
    try {
      const out = await runProviderOp(step.op, step.arg);
      const outcome = out.found ? "OK" : "NOT_FOUND";
      row.outcome = outcome;
      row.id = out.id;
      row.title = out.title ? String(out.title).slice(0, 60) : null;
      row.image_url = out.image_url;
      row.dates = out.dates;
      row.notes = out.notes ? String(out.notes).slice(0, 140) : null;
      if (CHECK_IMAGES && out.image_url) {
        row.image_transport = await probeImageTransport(out.image_url);
      }
    } catch (err) {
      const d = describeError(err);
      row.outcome = KIND_TO_OUTCOME[d.kind] || "ERROR";
      row.detail = d.message;
      row.retryable = d.retryable;
      row.status = d.status;
      row.hint = d.hint;
    }
    row.ms = Date.now() - started;
    rows.push(row);
    await new Promise((r) => setTimeout(r, 350));
  }

  const matrixSays = (provider) => (PROVIDER_MATRIX[provider] || {}).access || "?";
  const surprising = rows.filter((r) => {
    if (r.expects.includes(r.outcome)) return false;
    if (r.outcome === "SKIP_NO_KEY") return false;
    return true;
  });

  if (AS_JSON) {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), userAgent: USER_AGENT, rows: rows }, null, 2));
  } else {
    console.log("mf-providers-smoke —— 每提供方一次真实只读请求");
    console.log("UA: " + USER_AGENT + "\n");
    for (const r of rows) {
      const flag = r.expects.includes(r.outcome) || r.outcome === "SKIP_NO_KEY" ? " " : "!";
      const bits = [
        flag + " " + r.op.padEnd(22),
        "[" + matrixSays(r.provider) + "]",
        r.outcome.padEnd(12),
        r.ms + "ms",
      ];
      if (r.id != null) bits.push("id=" + r.id);
      if (r.title) bits.push("\"" + r.title + "\"");
      if (r.dates && (r.dates.release || r.dates.start || r.dates.birth)) bits.push("date=" + (r.dates.release || r.dates.start || r.dates.birth));
      if (r.image_url) bits.push("img=" + String(r.image_url).slice(8, 54));
      if (r.image_transport) bits.push("imgHTTP=" + r.image_transport.status + "（仅传输；内容/身份/权利未核实）");
      console.log(bits.join("  "));
      if (r.detail) console.log("      " + String(r.detail).slice(0, 200));
      if (r.hint) console.log("      hint: " + String(r.hint).slice(0, 160));
    }
    const tally = {};
    for (const r of rows) tally[r.outcome] = (tally[r.outcome] || 0) + 1;
    console.log("\n计数: " + JSON.stringify(tally));
    if (surprising.length) {
      console.log("\n与矩阵结论不符（需要更新 README-providers.md 或换读取路径）：");
      for (const r of surprising) console.log("  ! " + r.op + " -> " + r.outcome + "（期望 " + r.expects.join("/") + "）" + (r.detail ? " | " + String(r.detail).slice(0, 120) : ""));
    } else {
      console.log("\n全部结果都落在矩阵已记录的范围内。");
    }
  }

  return surprising.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runSmoke();
}
