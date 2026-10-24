#!/usr/bin/env node
// Unified, read-only discovery and invocation entry point for registered sources.

import { lstat, stat, writeFile as writeFileFs } from "node:fs/promises";
import path from "node:path";
import { AUTHORITATIVE_OPS, runAuthoritativeOp } from "./mf-fetch-authoritative.ts";
import { PROVIDER_MATRIX, PROVIDER_OPS, runProviderOp } from "./mf-fetch-providers.ts";
import { PUBLISHERS, runPublisherOp } from "./mf-fetch-publishers.ts";
import { sourceQualification } from "./mf-source-qualification.ts";

const PROVIDER_SOURCE_IDS = { internetarchive: "archive", myanimelist: "mal", coverartarchive: "caa" };
const SOURCE_ALIASES = {
  "open-library": "openlibrary", open_library: "openlibrary",
  internetarchive: "archive", internet_archive: "archive",
  myanimelist: "mal", "my-anime-list": "mal",
  "music-brainz": "musicbrainz", wd: "wikidata",
  universal_music: "umj", universal: "umj", "universal-music": "umj", universal_music_japan: "umj",
  pony: "pony_canyon", ponycanyon: "pony_canyon", "pony-canyon": "pony_canyon",
  sony: "sony_music", sonymusic: "sony_music", "sony-music": "sony_music",
  bushiroad: "bushiroad_music", "bushiroad-music": "bushiroad_music",
  bangdream: "bang_dream", "bang-dream": "bang_dream",
  itunes_store: "itunes", "itunes-store": "itunes",
  coverartarchive: "caa", cover_art_archive: "caa", "cover-art-archive": "caa",
  coverart: "caa", cover_art: "caa",
  project_gutenberg: "gutenberg", "project-gutenberg": "gutenberg", pg: "gutenberg",
  "vn-db": "vndb", vn_db: "vndb",
};

const PUBLISHER_LABELS = {
  pony_canyon: "Pony Canyon 官方商品页",
  canime: "Canime 官方商品页",
  sony_music: "Sony Music 官方商品页",
  bushiroad_music: "Bushiroad Music 官方商品页",
  bang_dream: "BanG Dream 官方商品页",
};

const PROVIDER_OPERATION_LABELS = {
  "isni.record": "ISNI 权威记录",
  "viaf.record": "VIAF 权威记录",
  "oclc.fast": "OCLC FAST 标题检索",
};

const PUBLISHER_ADVERTISED_FIELDS = [
  "publisher", "product_url", "title", "catalog_number", "catalog_candidates",
  "requested_catalog_number", "release_date", "price", "price_candidates",
  "image_urls", "tracklist", "field_status",
];

const OPERATION_INPUTS = {
  "discogs.release": { argument: "1–12 位数字 release ID，或 URL 中含 discogs.com/release(s)/{数字 ID}。", example: "mf-source run discogs.release 123" },
  "discogs.master": { argument: "1–12 位数字 master ID，或 URL 中含 discogs.com/master(s)/{数字 ID}。", example: "mf-source run discogs.master 123" },
  "discogs.search": { argument: "非空检索词；作为 Discogs 搜索 query。", example: "mf-source run discogs.search Yorushika" },
  "openlibrary.edition": { argument: "OL{数字}M edition ID，或 /books/{ID} URL；裸 OL{数字} 也会补成 M。", example: "mf-source run openlibrary.edition OL123M" },
  "openlibrary.work": { argument: "OL{数字}W work ID，或 /works/{ID} URL；裸 OL{数字} 也会补成 W。", example: "mf-source run openlibrary.work OL123W" },
  "openlibrary.author": { argument: "OL{数字}A author ID，或 /authors/{ID} URL；裸 OL{数字} 也会补成 A。", example: "mf-source run openlibrary.author OL123A" },
  "openlibrary.search": { argument: "非空书目检索词；传给 OpenLibrary Search。", example: "mf-source run openlibrary.search HarukiMurakami" },
  "openlibrary.editions": { argument: "work ID（OL{数字}W）或 OpenLibrary /works/{ID} URL；按 work 查询版本。", example: "mf-source run openlibrary.editions OL123W" },
  "openlibrary.isbn": { argument: "ISBN-10（末位可为 X）或以 978/979 开头的 ISBN-13；只检查字符形状，不核验校验位。", example: "mf-source run openlibrary.isbn 9780000000000" },
  "archive.item": { argument: "Internet Archive identifier（2–200 位，首位字母/数字，其余可含 . _ -），或 /details/{id}、/metadata/{id} URL。", example: "mf-source run archive.item example_item" },
  "archive.search": { argument: "非空 Internet Archive advancedsearch/Lucene 查询式，可用 title:、creator:、mediatype: 等字段。", example: "mf-source run archive.search title:example" },
  "archive.wayback": { argument: "需要查询存档的完整 HTTP(S) 原始页面 URL。", example: "mf-source run archive.wayback https://example.org/item" },
  "tmdb.movie": { argument: "1–12 位数字 TMDB movie ID；不接受详情 URL。", example: "mf-source run tmdb.movie 123", note: "读取需要配置 TMDB_API_KEY 或 TMDB_ACCESS_TOKEN。" },
  "tmdb.tv": { argument: "1–12 位数字 TMDB TV ID；不接受详情 URL。", example: "mf-source run tmdb.tv 123", note: "读取需要配置 TMDB_API_KEY 或 TMDB_ACCESS_TOKEN。" },
  "tmdb.search": { argument: "非空电影检索词；此操作默认搜索 movie。", example: "mf-source run tmdb.search ExampleMovie", note: "读取需要配置 TMDB_API_KEY 或 TMDB_ACCESS_TOKEN。" },
  "anilist.media": { argument: "1–12 位数字 ID（裸 ID 默认 anime），或含 /anime/{id}/、/manga/{id}/ 的 AniList URL。", example: "mf-source run anilist.media 123" },
  "anilist.search": { argument: "非空 AniList media 检索词；--type ANIME（默认）或 MANGA（漫画/轻小说）。", example: "mf-source run anilist.search Frieren --type MANGA" },
  "mal.anime": { argument: "1–12 位数字 MAL ID（裸 ID 默认 anime），或 myanimelist.net/anime/{id} 页面 URL。", example: "mf-source run mal.anime 123", note: "读取需要配置 MAL_CLIENT_ID。" },
  "mal.search": { argument: "非空 MyAnimeList 检索词。", example: "mf-source run mal.search Frieren", note: "读取需要配置 MAL_CLIENT_ID。" },
  "isni.record": { argument: "16 位 ISNI（前 15 位数字，末位数字或 X）；可带空格/连字符或 <ISNI> 包装。", example: "mf-source run isni.record 0000000000000001", note: "该读取入口检查形状，不执行 MOD 11-2 校验位核验。" },
  "viaf.record": { argument: "VIAF 十进制记录 ID，或 https://viaf.org/viaf/{数字 ID} URL。", example: "mf-source run viaf.record 12345678" },
  "oclc.fast": { argument: "非空 FAST 标题/姓名检索词，作为 FAST query。", example: "mf-source run oclc.fast MarkTwain", note: "端点可用性可能变化；help/list 不探测，以本次 run 响应为准。" },
  "ndl.authority": { argument: "7–10 位 NDL 权威记录号，或 id.ndl.go.jp/auth/ndlna/{id}、/auth/entity/{id} URL。", example: "mf-source run ndl.authority 12345678" },
  "vgmdb.album": { argument: "1–12 位数字 VGMdb album ID，或 vgmdb.net/album/{数字 ID} URL。", example: "mf-source run vgmdb.album 123456" },
  "vgmdb.archive": { argument: "1–12 位数字 VGMdb album ID，或 vgmdb.net/album/{数字 ID} URL；读取 Internet Archive 快照。", example: "mf-source run vgmdb.archive 123456" },
  "itunes.search": {
    argument: "非空检索词，可带末尾 country=<两字母 storefront>（默认 jp，本仓库以日系音乐为主）；固定 media=music、entity=album。",
    example: "mf-source run itunes.search AQUAPLUS",
    note: "storefront 覆盖示例：run itunes.search LiSA country=us。检索结果是候选；无命中时返回 found:false 并在 notes 说明 resultCount=0，不静默返回空。",
  },
  "itunes.album": {
    argument: "1–12 位数字 collectionId，或 music.apple.com/.../album/... 链接中的数字 ID；可带末尾 country=<两字母 storefront>（默认 jp）。",
    example: "mf-source run itunes.album 541874266",
    note: "lookup 带 entity=song，返回专辑字段 + 曲目列表（discNumber/trackNumber/时长秒/试听）；不存在的 id 返回 found:false。",
  },
  "steam.app": {
    argument: "1–12 位 AppID，或 store.steampowered.com/app/<id> / steamdb.info/app/<id> 链接；可带末尾 langs=<逗号分隔语种，最多 4 个>、lang=<单语种>、cc=<两字母区域>。",
    example: "mf-source run steam.app 504230",
    note: "多语种与区域覆盖示例：run steam.app 504230 langs=english,japanese,schinese cc=us。cc 默认 us（既有游戏数字发行定价按 USD/US 区记录）；不写 cc 时 Steam 按请求来源地解析、结果不可复现。AppID 不存在是 HTTP 200 + success:false，按 found:false 判读，且只代表该 cc 区域。返回 titles（各语种商店题名）、dates.release（已归一）、developers/publishers、genres、platforms、price（未折扣标价 initial）。",
  },
  "steam.search": {
    argument: "非空检索词；可带末尾 lang=<单语种，默认 english>、cc=<两字母区域>。",
    example: "mf-source run steam.search Celeste",
    note: "storesearch 返回 AppID 候选（含原声/DLC 等 type）；检索结果是候选，写入前核对 AppID 与题名。无命中按 found:false 返回，并提示换 lang=schinese / japanese。",
  },
  "wikidata.search": { argument: "非空实体名称/关键词；检索语言固定为 ja。", example: "mf-source run wikidata.search artist-example" },
  "wikidata.entity": { argument: "Wikidata QID：Q 后跟 1–20 位数字；不接受实体 URL。", example: "mf-source run wikidata.entity Q123" },
  "bangumi.subject": { argument: "正整数 subject ID，最多 12 位数字。", example: "mf-source run bangumi.subject 123" },
  "bangumi.search": { argument: "非空 Bangumi subject 搜索词。", example: "mf-source run bangumi.search example-title", note: "搜索接口标为实验性，响应契约可能变化。" },
  "musicbrainz.artist.search": { argument: "非空艺人检索词；作为 MusicBrainz artist:{词} 查询。", example: "mf-source run musicbrainz.artist.search artist-example" },
  "musicbrainz.release.search": { argument: "非空发行检索词；作为 MusicBrainz release:{词} 查询（仅题名检索，不命中条码/品番字段）。", example: "mf-source run musicbrainz.release.search album-example" },
  "musicbrainz.release.barcode": { argument: "6–14 位数字条码（可带空格或连字符）；作为 MusicBrainz barcode:{数字} 查询。", example: "mf-source run musicbrainz.release.barcode 8804775254710", note: "无命中返回空候选；命中仍是候选，版次与身份须另核。" },
  "musicbrainz.release.catno": { argument: "出版方品编号（如 UPCJ-9085）；作为 MusicBrainz catno:{品番} 查询。", example: "mf-source run musicbrainz.release.catno UPCJ-9085", note: "MB 未收录时返回空候选；命中仍是候选，版次与身份须另核。" },
  "musicbrainz.release": { argument: "MusicBrainz release MBID：标准 36 位 UUID。", example: "mf-source run musicbrainz.release 12345678-1234-1234-1234-123456789abc" },
  "musicbrainz.release-group": { argument: "MusicBrainz release-group MBID：标准 36 位 UUID。", example: "mf-source run musicbrainz.release-group 12345678-1234-1234-1234-123456789abc" },
  "musicbrainz.recording": { argument: "MusicBrainz recording MBID：标准 36 位 UUID。", example: "mf-source run musicbrainz.recording 12345678-1234-1234-1234-123456789abc" },
  "caa.release": {
    argument: "MusicBrainz release MBID（标准 36 位 UUID），或含 /release/<mbid> 的 coverartarchive.org / musicbrainz.org 链接。",
    example: "mf-source run caa.release 6474e946-3fdd-4fcf-a902-25d8f203900a",
    note: "release 与 release-group 的 MBID 不可互换，层级写错会被拒绝而不是静默返回。没有封面时 CAA 返回 HTTP 404 + HTML「No cover art found」，按 found:false 判读——这只说明 CAA 没收录，不代表该版次没有封面。图片正文与 index.json 都托管在 archive.org 上；本机 2026-10-11 实测 archive.org 出现异常 DNS 解析（疑似 DNS 污染）（解析到 Meta 的 face:b00c 段）而不可达，取不到属网络问题，连接器归为 network/unavailable，不会谎报 found:false。选图判据是 types 与 front/back：Case Front 是正面再摄＝与 Front 重复，Back / Case Back 才是另一面。",
  },
  "caa.release-group": {
    argument: "MusicBrainz release-group MBID（标准 36 位 UUID），或含 /release-group/<mbid> 的链接。",
    example: "mf-source run caa.release-group 3f4c699a-953d-3e44-89d7-f95f9dd2c1ac",
    note: "release-group 请求会被 CAA 307 到它**选定的那一个发行版**的 index，所以图属于结果里 release_of_record 指向的 Release，不是整组通用。写 Release 封面必须按 release_of_record 归位，不得沿用上级实体——这正是 2026-09-25 封面复审要整改的形态。",
  },
  "kitsu.anime": {
    argument: "数字 id、slug，或 kitsu.io/anime/<id|slug> 链接。",
    example: "mf-source run kitsu.anime 46474",
    note: "不存在的 id 是 HTTP 404 + JSON:API errors.code=404，按 found:false 判读；404 但错误体不是这个形状时按不可用处理。titles 已按 BCP-47 归一（ja_jp→ja-JP、zh_cn→zh-CN），en_jp 是罗马音、单列在 romaji，不要当译名写。poster 各档带 width/height/short_edge，据此判封面尺寸门槛；coverImage 是宽幅横幅不是海报。synopsis 末尾的「(Source: Wikipedia)」是简介的真实出处，Kitsu 本身是聚合站不能当权威来源。relationships 只给链接，需要 cast/staff 时另取。",
  },
  "kitsu.manga": {
    argument: "数字 id、slug，或 kitsu.io/manga/<id|slug> 链接。",
    example: "mf-source run kitsu.manga 46474",
    note: "与 kitsu.anime 同形状；manga 层级另有 chapter_count / volume_count。层级与链接不符会被拒绝。",
  },
  "kitsu.search": {
    argument: "非空检索词；默认查 anime，opts.kind=manga 换层级。",
    example: "mf-source run kitsu.search frieren",
    note: "meta.count=0 或空 data 是明确的无命中；无命中不代表作品不存在。检索词含空格时按 shell 规则整体引号包住（`run kitsu.search \"sousou no frieren\"`）。检索结果只含索引字段，写入前用 kitsu.anime/kitsu.manga 取全字段并核对身份锚点。",
  },
  "vndb.vn": {
    argument: "v<数字>、裸数字，或 vndb.org/v<数字> 链接（v 后最多 8 位）。",
    example: "mf-source run vndb.vn v17",
    note: "released 用 00 表示未知的月/日（2003-05-00＝2003 年 5 月、2003-00-00＝2003 年），连接器按此降级到能确证的精度，不当非法日期。description 是 BBCode 且常带 [url=…Wikipedia[/url]] 出处标注——description_text 是机械去标签的纯文本，原文保留在 raw。image.sexual / violence 是社区投票数、不是分级结论。版次字段要用 vndb.releases 另取。",
  },
  "vndb.releases": {
    argument: "VN 的 id：v<数字>、裸数字或 vndb.org/v<数字> 链接（注意是作品层，不是 r<数字>）。",
    example: "mf-source run vndb.releases v17",
    note: "这里是 VNDB 最值钱的部分：gtin（条码，附 scheme 与 checksum_valid 提示）、catalog（品番）、media（载体与枚数，可对应站内 Medium 层）、producers 的 publisher/developer 分工、minage（年龄分级）。producers 里 publisher=true 才是发行方；建 agent 与署名关系前按来源策略核对权利链。minage 是数字、不等于站内 content_rating 词表，映射前查 definitions。official/patch 会影响它算不算独立版次。",
  },
  "vndb.character": {
    argument: "c<数字>、裸数字，或 vndb.org/c<数字> 链接。",
    example: "mf-source run vndb.character c17",
    note: "name 多为拉丁转写、original 是原文，写站内 agent 时按语种键归位，别把转写当原文。appears_in 的 spoiler 是剧透等级，公开简介不要引用高剧透条目。",
  },
  "vndb.staff": {
    argument: "s<数字>、裸数字，或 vndb.org/s<数字> 链接。",
    example: "mf-source run vndb.staff s17",
    note: "aliases 里 ismain=true 的才是主名。VNDB 的 staff **没有** birthday 字段（schema 核过），别把别处看到的生日当成 VNDB 佐证。",
  },
  "vndb.schema": {
    argument: "任意非空占位（如 -）；本操作不读取参数内容。",
    example: "mf-source run vndb.schema -",
    note: "返回 VNDB API v2 的权威字段名与枚举。fields 报错（HTTP 400「Invalid 'fields' member」）时查这个，不要试错：嵌套对象必须显式给子字段（titles.lang,titles.title / media.medium,media.qty / languages.lang）。分页参数是 results 不是 count；端点是 POST /kana/<type> 而不是 POST /kana（后者返回纯文本 404「Not found.」，容易误判成端点失效）。",
  },
  "openbd.isbn": {
    argument: "ISBN-13（978/979 开头共 13 位）或 ISBN-10（9 位数字 + 校验位，末位可为 X）；可带空格或连字符。",
    example: "mf-source run openbd.isbn 9784048923514",
    note: "查无是 HTTP 200 + [null]，按 found:false 判读。OpenBD 只收日本出版物：台版、繁中版、简体引进版返回 [null] 是收录范围问题，不是站点故障，更不能据此判定该书不存在（繁中版走台灣角川官方商店）。summary.title 可能缺副题或标点，题名以版元商品页 h1 为准，OpenBD 只用来复核巻号·丛书·刊行年月。author 是 ONIX 倒装形（「師走,トオル」＝姓,名）。isbn_checksum.valid=false 只提示校验位不合、不拒绝查询。切勿调用同域名的 /v1/coverage：它忽略 isbn 参数、返回全量清单（实测 59MB）。",
  },
  "gutenberg.ebook": {
    argument: "纯数字 ebook id，或 gutenberg.org/ebooks/<id>（含 .html.images 等变体）链接。",
    example: "mf-source run gutenberg.ebook 1513",
    note: "读的是 /cache/epub/<id>/pg<id>.rdf 而不是页面 HTML：实测 ebook 1513 的 HTML 里 RDFa content 属性交叉错位（property=\"dcterms:issued\" content 是最后更新日、property=\"dcterms:modified\" content 才是发行日），只有 RDF 的 dcterms:issued 可靠。creator 的 pgterms:name 是倒装形（「Shakespeare, William」）。dcterms:rights 实测为「Public domain in the USA.」——只覆盖美国公版，不能据此断言全球公版。这个 ebook 是 Gutenberg 自己的数字版次，可建 Release，但原作 Work 层身份要另找一手来源。",
  },
  "gutenberg.search": {
    argument: "非空检索词（试原文题名或作者姓效果更好）。",
    example: "mf-source run gutenberg.search Shakespeare",
    note: "返回按 Gutenberg 排序（通常下载量）的候选，含 id / title / author(subtitle) / extra(下载量) / cover_thumb。多词检索用引号整体包住（`run gutenberg.search \"shakespeare romeo\"`）。结果里混着同名异书、不同译本与不同编者版本，subtitle 只是署名线索、不足为凭：必须逐条用 gutenberg.ebook 取 RDF 核对 creator 与 issued 后再用。",
  },
  "umj.product": { argument: "artist-slug/product-code；slug 为 ASCII 字母/数字/连字符，品番为字母数字段（可用连字符分段），不接受 URL。", example: "mf-source run umj.product demo-artist/abcd-1234" },
  "publisher.pony_canyon": { argument: "2–6 位字母前缀 + 可选连字符 + 1–13 位数字；或 Pony Canyon HTTPS 官方 /music/{站内码}、/visual/{站内码} URL。", example: "mf-source run publisher.pony_canyon PCCG-12345" },
  "publisher.canime": { argument: "品番（2–6 位字母前缀及数字，可含连字符），或 HTTPS canime.jp/product/{站内码} 官方 URL；裸站内码为前缀加 9–10 位数字。", example: "mf-source run publisher.canime PCCG-2541" },
  "publisher.sony_music": { argument: "artist-slug/CATALOG（slug/品番组合须符合站内路径格式），或 Sony Music HTTPS /artist/{slug}/discography/{品番} 官方 URL；裸品番不足以定位。", example: "mf-source run publisher.sony_music demo-artist/SRCL-12345" },
  "publisher.bushiroad_music": {
    argument: "BRMM- 后跟恰好 5 位数字，或 Bushiroad Music HTTPS /musics/{slug}/ 官方 URL。",
    example: "mf-source run publisher.bushiroad_music BRMM-11078",
    note: "requested_catalog_number 保留原请求品番；品番直达失败时扫描官方目录 ACF（不使用 WordPress search）。price 保留原文，仅唯一明确归版时填写，不按价格顺序猜版；否则价款保留在 price_candidates。image_urls 不自动归版。",
    advertisedFields: PUBLISHER_ADVERTISED_FIELDS,
  },
  "publisher.bang_dream": {
    argument: "完整 HTTPS 官方 URL：https://bang-dream.com/discographies/{数字 ID}/；不接受 HTTP 或裸 ID。",
    example: "mf-source run publisher.bang_dream https://bang-dream.com/discographies/123/",
    note: "URL 未提供品番时 requested_catalog_number 为 null；price 保留原文，仅唯一明确归版时填写，不按价格顺序猜版；否则价款保留在 price_candidates。image_urls 不自动归版。",
    advertisedFields: PUBLISHER_ADVERTISED_FIELDS,
  },
};

const HELP_NOTE = "示例仅展示命令与输入形状，不表示记录已核或实时请求成功；list/help 不联网且不读取凭据。";
const MF_SOURCE_COMMAND = "node mf-source.ts";

const LEGACY_UMJ_SOURCE_NOTE = "umj.product 使用严格解析，并核对页面可见品番与请求完全相同。";

export class SourceCommandError extends Error {
  kind: string;
  source: string | null;
  operation: string | null;
  status: number | null;
  retryable: boolean;
  constructor(kind: string, message: string, meta: { source?: string; operation?: string; status?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = "SourceCommandError";
    this.kind = kind;
    this.source = meta.source ?? null;
    this.operation = meta.operation ?? null;
    this.status = meta.status ?? null;
    this.retryable = meta.retryable ?? false;
  }
}

function providerSourceId(provider) {
  return PROVIDER_SOURCE_IDS[provider] ?? provider;
}

function canonicalSourceId(input) {
  const key = String(input ?? "").trim().toLowerCase();
  return SOURCE_ALIASES[key] ?? key;
}

function canonicalPublisherKey(input) {
  const source = canonicalSourceId(input);
  if (source === "umj") return null;
  return source;
}

function publisherKeys() {
  const keys = new Set(PUBLISHERS.map(canonicalPublisherKey).filter(Boolean));
  for (const reserved of ["bushiroad_music", "bang_dream"]) keys.add(reserved);
  return [...keys];
}

function accessRequirement(info, operationId = null) {
  if (operationId === "oclc.fast") return { type: "connector_uses_no_credentials" };
  if (info?.credentialEnv?.length) return { type: "credential_required", environment_names: [...info.credentialEnv] };
  if (info?.access === "anonymous") return { type: "anonymous" };
  return { type: "not_stated" };
}

function makeRegistry() {
  const sources = new Map();
  const operations = new Map();
  const ensureSource = (id, metadata) => {
    if (!sources.has(id)) {
      sources.set(id, {
        id,
        label: metadata.label ?? id,
        authority: metadata.authority ?? "unspecified",
        source_qualification: metadata.source_qualification ?? sourceQualification(id),
        access_requirement: metadata.access_requirement ?? { type: "not_stated" },
        endpoints: metadata.endpoints ?? null,
        rate_limit: metadata.rate_limit ?? null,
        status: "not_probed",
        limitations: [...(metadata.limitations ?? [])],
        operation_ids: [],
      });
    }
    return sources.get(id);
  };

  for (const [id, entry] of Object.entries(PROVIDER_OPS)) {
    const sourceId = providerSourceId(entry.provider);
    const providerInfo = PROVIDER_MATRIX[entry.provider];
    const inputHelp = OPERATION_INPUTS[id];
    const source = ensureSource(sourceId, {
      label: providerInfo?.label ?? entry.provider,
      authority: providerInfo?.authority ?? "unspecified",
      source_qualification: providerInfo?.source_qualification,
      access_requirement: accessRequirement(providerInfo, id),
      endpoints: providerInfo?.baseUrl ?? null,
      rate_limit: providerInfo?.rateLimit ?? null,
      limitations: ["连接状态只在单次调用后报告；该列表不执行连通性探测。"],
    });
    const operation = {
      id,
      source: sourceId,
      label: PROVIDER_OPERATION_LABELS[id] ?? entry.label,
      backend: "provider",
      source_qualification: source.source_qualification,
      argument: inputHelp?.argument ?? "参数格式尚未登记",
      example: inputHelp?.example?.replace(/^mf-source/, MF_SOURCE_COMMAND),
      ...(inputHelp?.note ? { input_note: inputHelp.note } : {}),
      access_requirement: accessRequirement(providerInfo, id),
      status: "registered",
    };
    source.operation_ids.push(id);
    operations.set(id, operation);
  }

  for (const [id, entry] of Object.entries(AUTHORITATIVE_OPS)) {
    const inputHelp = OPERATION_INPUTS[id];
    const source = ensureSource(entry.source, {
      label: entry.source === "umj" ? "Universal Music Japan" : entry.source === "musicbrainz" ? "MusicBrainz" : entry.source === "wikidata" ? "Wikidata" : "Bangumi",
      authority: entry.authority,
      source_qualification: entry.source_qualification,
      access_requirement: { type: entry.access },
      endpoints: null,
      rate_limit: entry.source === "musicbrainz" ? "每秒不超过 1 次请求" : null,
      limitations: entry.source === "bangumi" && id === "bangumi.search" ? ["官方 OpenAPI 将搜索接口标为实验性，契约可能变化。"] : [],
    });
    source.operation_ids.push(id);
    operations.set(id, {
      id,
      source: entry.source,
      label: entry.label,
      backend: "authoritative",
      source_qualification: source.source_qualification,
      argument: inputHelp?.argument ?? "参数格式尚未登记",
      example: inputHelp?.example?.replace(/^mf-source/, MF_SOURCE_COMMAND),
      ...(inputHelp?.note ? { input_note: inputHelp.note } : {}),
      access_requirement: { type: entry.access },
      status: "registered",
    });
  }

  for (const key of publisherKeys()) {
    if (key === "universal_music") continue;
    const sourceId = key;
    const id = `publisher.${key}`;
    const inputHelp = OPERATION_INPUTS[id];
    const label = PUBLISHER_LABELS[key] ?? `${key} 官方来源`;
    const source = ensureSource(sourceId, {
      label,
      authority: "版权方官方来源",
      source_qualification: sourceQualification("publisher"),
      access_requirement: { type: "anonymous" },
      limitations: ["仅使用注册连接器允许的官方域名和输入形状。", "返回字段取决于页面可见内容；缺失字段以连接器结果为准。"],
    });
    source.operation_ids.push(id);
    operations.set(id, {
      id,
      source: sourceId,
      label,
      backend: "publisher",
      source_qualification: source.source_qualification,
      argument: inputHelp?.argument ?? "参数格式尚未登记",
      example: inputHelp?.example?.replace(/^mf-source/, MF_SOURCE_COMMAND),
      ...(inputHelp?.note ? { input_note: inputHelp.note } : {}),
      ...(inputHelp?.advertisedFields ? { advertised_fields: [...inputHelp.advertisedFields] } : {}),
      access_requirement: { type: "anonymous" },
      status: "registered",
    });
  }

  const umj = sources.get("umj");
  if (umj) umj.limitations = [...umj.limitations, LEGACY_UMJ_SOURCE_NOTE];

  for (const source of sources.values()) {
    source.operation_ids.sort();
    const operationRequirements = [...new Set(source.operation_ids.map(id => operations.get(id)?.access_requirement?.type).filter(Boolean))];
    if (operationRequirements.length > 1) source.access_requirement = { type: "operation_specific" };
    else if (operationRequirements.length === 1) {
      const requirementOps = source.operation_ids.map(id => operations.get(id)?.access_requirement).filter(req => req?.type === operationRequirements[0]);
      const environmentNames = [...new Set(requirementOps.flatMap(req => req.environment_names ?? []))];
      source.access_requirement = { type: operationRequirements[0], ...(environmentNames.length ? { environment_names: environmentNames } : {}) };
    }
  }
  return { sources, operations };
}

export function listSources() {
  const { sources } = makeRegistry();
  return [...sources.values()].map(source => ({ ...source, operation_ids: [...source.operation_ids], limitations: [...source.limitations] })).sort((a, b) => a.id.localeCompare(b.id));
}

function copyOperation(operation) {
  return {
    ...operation,
    ...(Array.isArray(operation.advertised_fields) ? { advertised_fields: [...operation.advertised_fields] } : {}),
  };
}

export function listSourceOperations() {
  const { operations } = makeRegistry();
  return [...operations.values()].map(copyOperation).sort((a, b) => a.id.localeCompare(b.id));
}

function normalizeOutput(value, key = "") {
  if (/(^|[_-])(authorization|access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key|password|credential|token)([_-]|$)/i.test(key)) return "[REDACTED]";
  if (typeof value === "string") {
    return value
      .replace(/(\bBearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[REDACTED]")
      .replace(/([?&](?:api_key|access_token|refresh_token|client_secret|token|key)=)[^&#\s]+/gi, "$1[REDACTED]");
  }
  if (Array.isArray(value)) return value.map(item => normalizeOutput(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, normalizeOutput(child, childKey)]));
  }
  return value;
}

function candidateArrays(data) {
  if (Array.isArray(data)) return [data];
  if (!data || typeof data !== "object") return [];
  const arrays = [];
  const keys = ["candidates", "results", "hits", "editions", "artists", "releases", "docs", "items"];
  for (const object of [data, data.raw, data.raw?.response, data.raw?.data]) {
    if (!object || typeof object !== "object" || Array.isArray(object)) continue;
    for (const key of keys) if (Array.isArray(object[key])) arrays.push(object[key]);
  }
  if (Array.isArray(data.data)) arrays.push(data.data);
  return arrays;
}

function sourceFields(data) {
  const arrays = candidateArrays(data);
  if (arrays.length) {
    return [...new Set(arrays.flatMap(items => items.slice(0, 5).flatMap(value => value && typeof value === "object" ? Object.keys(value) : [])))].sort();
  }
  const sourceObject = data?.data && typeof data.data === "object" && !Array.isArray(data.data)
    ? data.data
    : data?.raw && typeof data.raw === "object" && !Array.isArray(data.raw)
      ? data.raw
      : data;
  return sourceObject && typeof sourceObject === "object" ? Object.keys(sourceObject).sort() : [];
}

function normalizedFields(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  return Object.keys(data).filter(key => key !== "raw").sort();
}

function candidateCount(data) {
  const arrays = candidateArrays(data);
  return arrays.length ? arrays[0].length : null;
}

function resultEnvelope(operation, rawData) {
  const registry = makeRegistry();
  const op = registry.operations.get(operation);
  const source = registry.sources.get(op.source);
  const data = normalizeOutput(rawData);
  const catalogCandidates = Array.isArray(data?.catalog_candidates) ? data.catalog_candidates : null;
  const limitations = [...source.limitations];
  if (Array.isArray(rawData?.limitations)) limitations.push(...rawData.limitations.map(String));
  const output: Record<string, any> = {
    response_status: "ok",
    source: {
      id: source.id,
      label: source.label,
      authority: source.authority,
      source_qualification: source.source_qualification,
      access_requirement: source.access_requirement,
      connection_status: "not_probed_by_list; this response completed",
    },
    operation: { id: operation, label: op.label },
    available_fields: op.backend === "publisher" || op.id === "umj.product" ? normalizedFields(data) : sourceFields(data),
    candidate_count: candidateCount(data),
    ...(catalogCandidates ? { catalog_candidate_count: catalogCandidates.length } : {}),
    limitations: [...new Set(limitations)],
    data,
  };
  if (/\.search$/.test(operation) || ["archive.search", "openlibrary.search", "bangumi.search"].includes(operation)) {
    output.search_completeness = "returned_candidates_only";
    output.search_note = "仅为来源当前检索与分页返回的候选，不保证覆盖该来源全部记录。";
  }
  return output;
}

const SAFE_ERROR_MESSAGES = {
  bad_input: "输入格式无效或操作不支持",
  notfound: "来源明确返回未找到",
  identity_mismatch: "来源页面的身份字段未通过匹配校验",
  credential_missing: "该操作需要配置来源凭据",
  blocked: "来源拒绝了本次读取",
  unavailable: "来源当前不可用",
  rate_limited: "来源限流；请降低请求频率后重试",
  network: "来源网络请求失败或超时",
  http: "来源拒绝了本次请求",
  parse: "来源响应无法解析",
  unsupported: "该来源操作当前未实现",
  output_exists: "输出文件已存在；为避免覆盖已停止写入",
  output_path_missing: "输出目录不存在；请先创建目录或选择已有目录",
  output_path_invalid: "输出路径的父项不是目录",
  output_write_failed: "写入输出文件失败",
  unexpected: "来源调用失败",
};

function errorKind(err) {
  const known = new Set(Object.keys(SAFE_ERROR_MESSAGES));
  return known.has(err?.kind) ? err.kind : "unexpected";
}

/**
 * 透传 hint 前先脱敏。hint 是连接器自己写的"下一步怎么办"，对 agent 有实际价值
 * （例如 VNDB fields 报错时提示"嵌套对象必须给子字段，用 vndb.schema 查权威字段名"），
 * 但它在 mf-fetch-* 里也可能被调用方通过 opts 注入，所以按凭据形态再挡一层：
 * normalizeOutput 只管 URL 查询串与 Bearer，这里补上 `XXX_TOKEN=value` 这种裸赋值。
 */
function scrubSecretText(value) {
  if (typeof value !== "string") return null;
  const scrubbed = String(normalizeOutput(value, "hint"))
    .replace(/\b[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|CLIENT_?ID|CREDENTIAL)[A-Za-z0-9_]*\s*[=:]\s*\S+/gi, "[REDACTED]");
  return scrubbed.trim() || null;
}

function errorEnvelope(err, requestedOp = null) {
  const registry = makeRegistry();
  const kind = errorKind(err);
  const op = requestedOp ? registry.operations.get(requestedOp) : null;
  const knownSource = op?.source ?? (registry.sources.has(err?.source) ? err.source : null);
  const status = Number.isInteger(err?.status) ? err.status : null;
  const hint = scrubSecretText(err?.hint);
  return {
    response_status: "error",
    error: {
      kind,
      source: knownSource,
      operation: op?.id ?? null,
      status,
      retryable: Boolean(err?.retryable),
      message: err instanceof SourceCommandError ? err.message : SAFE_ERROR_MESSAGES[kind],
      // 只在确有可执行提示时出现，避免每份错误信封都多一个 null 键。
      ...(hint ? { hint } : {}),
    },
  };
}

export async function dispatchSourceOperation(operation, arg, deps: Record<string, any> = {}) {
  const registry = makeRegistry();
  const entry = registry.operations.get(operation);
  if (!entry) throw new SourceCommandError("bad_input", "未知操作", { operation: null });
  if (!String(arg ?? "").trim()) throw new SourceCommandError("bad_input", "缺少操作参数", { source: entry.source, operation });

  const {
    fetchImpl,
    runProviderOpImpl = runProviderOp,
    runAuthoritativeOpImpl = runAuthoritativeOp,
    runPublisherOpImpl = runPublisherOp,
    ...connectorOptions
  } = deps;
  if (fetchImpl) connectorOptions.fetchImpl = fetchImpl;

  let result;
  if (entry.backend === "provider") {
    result = await runProviderOpImpl(operation, arg, connectorOptions);
  } else if (entry.backend === "authoritative") {
    result = await runAuthoritativeOpImpl(operation, arg, connectorOptions);
  } else {
    if (fetchImpl) connectorOptions.fetchFn = fetchImpl;
    result = await runPublisherOpImpl(entry.source, arg, connectorOptions);
  }
  return resultEnvelope(operation, result);
}

function helpPayload(target) {
  const registry = makeRegistry();
  if (!target) return {
    usage: [
      `${MF_SOURCE_COMMAND} list`,
      `${MF_SOURCE_COMMAND} help [source|operation]`,
      `${MF_SOURCE_COMMAND} run <operation> <arg> [--type ANIME|MANGA] [--out <path>]`,
    ],
    operations: [...registry.operations.values()].map(copyOperation).sort((a, b) => a.id.localeCompare(b.id)),
    note: `请在 skills/metafusion-curator/scripts/tools 目录运行命令。${HELP_NOTE} 连接状态只由单次 run 响应报告。`,
  };
  const operation = registry.operations.get(target);
  if (operation) return { usage: `${MF_SOURCE_COMMAND} run <operation> <arg> [--type ANIME|MANGA] [--out <path>]`, note: `请在 skills/metafusion-curator/scripts/tools 目录运行命令。${HELP_NOTE}`, operation: copyOperation(operation) };
  const sourceId = canonicalSourceId(target);
  const source = registry.sources.get(sourceId);
  if (source) return {
    note: `请在 skills/metafusion-curator/scripts/tools 目录运行命令。${HELP_NOTE}`,
    source: { ...source, operation_ids: [...source.operation_ids], limitations: [...source.limitations] },
    operations: source.operation_ids.map(id => copyOperation(registry.operations.get(id))),
  };
  throw new SourceCommandError("bad_input", "未知来源或操作");
}

function parseOutputOption(argv) {
  const args = [...argv];
  if (args.length === 0) args.push("help");
  if (args[0] === "--help" || args[0] === "-h") args[0] = "help";
  let outPath = null;
  let mediaType: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--type") continue;
    const value = args[index + 1]?.toUpperCase();
    if (mediaType || !["ANIME", "MANGA"].includes(value)) throw new SourceCommandError("bad_input", "--type 只允许 ANIME 或 MANGA");
    mediaType = value;
    args.splice(index, 2);
    index -= 1;
  }
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--out") {
      if (outPath !== null || !args[index + 1] || args[index + 1].startsWith("--")) throw new SourceCommandError("bad_input", "--out 需要且只允许一个文件路径");
      outPath = args[index + 1];
      args.splice(index, 2);
      break;
    }
    if (value.startsWith("--out=")) {
      if (outPath !== null || !value.slice(6)) throw new SourceCommandError("bad_input", "--out 需要且只允许一个文件路径");
      outPath = value.slice(6);
      args.splice(index, 1);
      break;
    }
  }
  if (args.some(value => value.startsWith("--"))) throw new SourceCommandError("bad_input", "不支持的命令选项");
  return { args, outPath, mediaType };
}

export async function executeMfSource(argv, deps: Record<string, any> = {}) {
  const { args, mediaType } = parseOutputOption(argv);
  const [command, ...rest] = args;
  if (command === "list" && rest.length === 0) return { sources: listSources() };
  if (command === "help" && rest.length <= 1) return helpPayload(rest[0]);
  if (command === "run" && rest.length >= 2) {
    const [operation, ...argParts] = rest;
    if (mediaType && !["anilist.search", "anilist.media"].includes(operation)) throw new SourceCommandError("bad_input", "--type 适用于 anilist.search / anilist.media");
    return dispatchSourceOperation(operation, argParts.join(" "), { ...deps, ...(mediaType ? { type: mediaType } : {}) });
  }
  throw new SourceCommandError("bad_input", `用法：${MF_SOURCE_COMMAND} list | help [source|operation] | run <operation> <arg> [--out <path>]`);
}

export async function runSourceCli(argv = process.argv.slice(2), deps: Record<string, any> = {}) {
  let requestedOp = argv[0] === "run" ? argv[1] ?? null : null;
  try {
    const parsed = parseOutputOption(argv);
    requestedOp = parsed.args[0] === "run" ? parsed.args[1] ?? null : null;
    let absolutePath = null;
    if (parsed.outPath) absolutePath = await preflightOutputPath(parsed.outPath);
    const output = await executeMfSource(argv, deps);
    const serialized = `${JSON.stringify(output, null, 2)}\n`;
    if (parsed.outPath) {
      try {
        await (deps.writeFileImpl ?? writeFileFs)(absolutePath, serialized, { flag: "wx" });
      } catch (err) {
        const kind = err?.code === "EEXIST" ? "output_exists" : "output_write_failed";
        throw new SourceCommandError(kind, SAFE_ERROR_MESSAGES[kind]);
      }
      (deps.stdout ?? (text => process.stdout.write(text)))(`${JSON.stringify({ response_status: "ok", output_file: absolutePath }, null, 2)}\n`);
    } else {
      (deps.stdout ?? (text => process.stdout.write(text)))(serialized);
    }
    return 0;
  } catch (err) {
    (deps.stderr ?? (text => process.stderr.write(text)))(`${JSON.stringify(errorEnvelope(err, requestedOp), null, 2)}\n`);
    return 1;
  }
}

async function preflightOutputPath(outputPath) {
  const absolutePath = path.resolve(outputPath);
  try {
    await lstat(absolutePath);
    throw new SourceCommandError("output_exists", SAFE_ERROR_MESSAGES.output_exists);
  } catch (err) {
    if (err instanceof SourceCommandError) throw err;
    if (err?.code !== "ENOENT") throw new SourceCommandError("output_write_failed", SAFE_ERROR_MESSAGES.output_write_failed);
  }
  try {
    const parent = await stat(path.dirname(absolutePath));
    if (!parent.isDirectory()) throw new SourceCommandError("output_path_invalid", SAFE_ERROR_MESSAGES.output_path_invalid);
  } catch (err) {
    if (err instanceof SourceCommandError) throw err;
    if (err?.code === "ENOENT") throw new SourceCommandError("output_path_missing", SAFE_ERROR_MESSAGES.output_path_missing);
    throw new SourceCommandError("output_write_failed", SAFE_ERROR_MESSAGES.output_write_failed);
  }
  return absolutePath;
}

if (import.meta.main || process.argv[1]?.endsWith("mf-source.ts")) {
  process.exitCode = await runSourceCli();
}
