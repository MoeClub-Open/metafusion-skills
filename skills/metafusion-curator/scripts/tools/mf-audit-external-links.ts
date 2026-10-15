#!/usr/bin/env node
// 外部标识同一性审计（只读）：核验 external_links[].kind 是否真的指向"同一个对象"。
//
// 为什么值得单独一趟：**标识指错对象比字段缺失更危险**——它会让系统把别的作品/人物
// 当成同一对象，而结构校验看不出来。实战中在 54 条 bangumi 外链里查出 3 条错配、
// 在 193 条 musicbrainz 外链里查出 25 首歌挂了所属专辑的 release-group id 与 1 条死链。
//
// 用法：
//   node mf-audit-external-links.ts --provider musicbrainz [--limit N]
//   node mf-audit-external-links.ts --provider bangumi [--limit N]
//
// 产出：系统临时目录中的 external-id-audit-<provider>.json；MF_AUDIT_OUT 可指定任务目录
//
// 口径（踩过坑，务必保留）：
//   · **必须先穷举提供方的实体类型**。musicbrainz 的歌曲是 recording、公司是 label；
//     只按 release-group/artist 查会把正确数据误报成 86 个假 404。
//   · **题名比对必须容忍排版差异**（连字符 U+002D/U+2010、撇号 ' / ’、全半角斜杠、
//     括号后缀、中外文别名），否则会把对的判成错的。
//   · **404 才算目标不存在**；429/网络失败属"未知"，不得当作失效。

import { auditOutputDirectory } from "./mf-output.ts";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { KINDS, listKind, sleep } from "./mf-lib.ts";

const argv = process.argv.slice(2);
const opt = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PROVIDER = opt("--provider", "musicbrainz");
const LIMIT = Number(opt("--limit", "0"));
if (!Number.isInteger(LIMIT) || LIMIT < 0) throw new Error("--limit 必须为非负整数");
const OUT_DIR = auditOutputDirectory();
const UA = { "User-Agent": "metafusion-curator-local/1.0 ( +https://findverse.cc )" };

const norm = (s) => String(s || "")
  .normalize("NFKC")
  .replace(/[\s　「」『』（）()【】\[\]・:：\-–—~～!！?？.,、。×’'&/／|]/g, "")
  .toLowerCase();

/** 题名是否算"对得上"：归一化后相等，或一方含另一方（仅当较短者 ≥4 字符）。 */
const titleMatch = (ours, candidates) => {
  const o = norm(ours);
  if (!o) return false;
  return candidates.map(norm).filter(Boolean).some((c) => c === o || (o.length >= 4 && c.includes(o)) || (c.length >= 4 && o.includes(c)));
};

async function fetchJSON(url) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const r = await fetch(url, { headers: UA });
      if (r.status === 429 || r.status >= 500) { await sleep(1500 * attempt); continue; }
      if (r.status !== 200) return { status: r.status };
      return { status: 200, json: await r.json() };
    } catch { await sleep(1200 * attempt); }
  }
  return { status: 0 };
}

// ── musicbrainz：按 kind/tags 推断最可能类型并依次回退 ──
const MB_ORDER = (e) => {
  if (e.kind === "agent") return ["artist", "label"];
  if (e.kind === "release") return ["release", "release-group"];
  const tags = e.attributes?.tags ?? [];
  if (tags.includes("song") || tags.includes("music")) return ["recording", "work", "release-group", "release"];
  return ["release-group", "release", "recording", "work", "label"];
};
// 公司/厂牌类 agent 的标签线索
const looksLikeOrg = (e) => (e.attributes?.tags ?? []).some((t) => /organization|label|company|レコード会社|出版社|制作/i.test(String(t)));

export async function checkMusicBrainz(entity, id, { lookup = fetchJSON, pace = sleep }: Record<string, any> = {}) {
  const order = looksLikeOrg(entity) ? ["label", "artist"] : MB_ORDER(entity);
  let found = null, mtype = null;
  const unknownStatuses = [];
  for (const t of order) {
    const r = await lookup(`https://musicbrainz.org/ws/2/${t}/${encodeURIComponent(id)}?fmt=json`);
    if (r.status === 200) { found = r.json; mtype = t; break; }
    if (r.status !== 404) unknownStatuses.push(r.status);
    await pace(1100); // MB 限流 ~1 req/s
  }
  if (!found && unknownStatuses.length) return { ok: null, identity_verified: false, matchedType: null, why: "候选类型读取未完成", unknownStatuses };
  if (!found) return { ok: false, identity_verified: false, matchedType: null, why: "全部已检查候选类型返回 404" };
  const names = [found.name, found.title, ...(found.aliases ?? []).map((a) => a.name)].filter(Boolean);
  return { ok: titleMatch(entity.title, names), identity_verified: false, matchedType: mtype, mbName: found.name ?? found.title, candidates: names };
}

// ── bangumi：条目 name / name_cn / 别名 ──
export async function checkBangumi(entity, id, { lookup = fetchJSON }: Record<string, any> = {}) {
  const resource = entity.kind === "agent" ? (entity.attributes?.tags?.includes("character") ? "characters" : "persons") : "subjects";
  const r = await lookup(`https://api.bgm.tv/v0/${resource}/${encodeURIComponent(id)}`);
  if (r.status !== 200) return { ok: r.status === 404 ? false : null, identity_verified: false, matchedType: resource, why: `HTTP ${r.status}` };
  const aliases = (r.json.infobox ?? [])
    .filter((b) => /别名|alias/i.test(String(b.key)))
    .flatMap((b) => (Array.isArray(b.value) ? b.value.map((v) => v.v ?? v) : [b.value]));
  const names = [r.json.name, r.json.name_cn, ...aliases].filter(Boolean);
  return { ok: titleMatch(entity.title, names), identity_verified: false, matchedType: resource, mbName: r.json.name, candidates: names };
}

const PROVIDERS = {
  musicbrainz: { key: "musicbrainz", check: checkMusicBrainz, pacing: 1100 },
  bangumi: { key: "bangumi", check: checkBangumi, pacing: 400 },
};
const P = PROVIDERS[PROVIDER];
if (!P) { console.error(`不支持的 provider：${PROVIDER}（可选 ${Object.keys(PROVIDERS).join(" / ")}）`); process.exit(2); }

async function main() {
// 收集带该外链的实体
const rows = [];
for (const kind of KINDS) {
  const items = await listKind(kind);
  for (const it of items) {
    const v = (Array.isArray(it.external_links) ? it.external_links : [])
      .find((link) => link.kind === P.key)?.external_id
      || (Array.isArray(it.external_links) ? it.external_links : [])
      .find((link) => link.kind === P.key)?.url;
    if (v) rows.push({ kind, id: it.id, title: it.title, ext: String(v), attributes: it.attributes ?? {} });
  }
  await sleep(80);
}
const sample = LIMIT > 0 ? rows.slice(0, LIMIT) : rows;
console.log(`provider=${PROVIDER} 带该外链的实体：${rows.length}，本次核验 ${sample.length}`);

const problems = [];
const unknown = [];
let ok = 0;
for (let i = 0; i < sample.length; i += 1) {
  const e = sample[i];
  const r = await P.check(e, e.ext);
  if (r.ok === null) unknown.push({ ...e, ...r });
  else if (r.ok) ok += 1;
  else problems.push({ ...e, ...r, why: r.why ?? "题名不匹配" });
  if (i % 25 === 0) console.log(`  progress ${i}/${sample.length}`);
  await sleep(P.pacing);
}

const byType: Record<string, any> = {};
for (const e of sample) byType[e.kind] = (byType[e.kind] ?? 0) + 1;
console.log(`\n=== ${PROVIDER} 题名线索：matched=${ok} problems=${problems.length} unknown=${unknown.length} （按 kind ${JSON.stringify(byType)}）===`);
for (const p of problems.slice(0, 60)) {
  console.log(`  ${p.kind.padEnd(12)} | ${String(p.title).slice(0, 34).padEnd(34)} | ${p.ext} | ${p.matchedType ?? "-"} | ${p.mbName ?? "-"} | ${p.why}`);
}
fs.mkdirSync(OUT_DIR, { recursive: true });
const out = `${OUT_DIR}/external-id-audit-${PROVIDER}.json`;
fs.writeFileSync(out, JSON.stringify({ kind: PROVIDER, scope: "可访问性与题名线索，不能代替核心身份来源核验", identity_verified: false, checked: sample.length, ok, unknown, problems }, null, 2), "utf8");
console.log("写入", out);

}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
