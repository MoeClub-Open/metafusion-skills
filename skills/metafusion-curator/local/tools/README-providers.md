# 来源与提供方支持矩阵

本页是外部来源和出版方支持范围、凭据要求及失败判读的唯一文档入口。命令、参数与返回 schema 以 `mf-source` 的帮助输出为准；本矩阵描述连接器范围，不保证提供方此刻可用。查询到页面或记录也不自动满足 CORE-P1，须按[字段级来源策略](../../reference-source-policy.md)逐字段核实。

除下表列出的环境变量外，注册连接器未声明需要 API key；来源列表中的 `anonymous` 表示无需提供方凭据。连接状态只由单次读取结果报告，`list` / `help` 不做连通性探测。

## 官方来源与出版方页面

| 来源 | 连接器覆盖 | 输入与结果注意事项 |
| --- | --- | --- |
| Universal Music Japan | `umj.product` 官方商品页 | 输入 `artist-slug/product-code` 并严格核对页面品番：有可见「品番」行时须与请求完全一致（`verified_exact`）；数字发行页无品番行时须 canonical 路径 slug+品番与请求一致且 ld+json 面包屑/WebPage 双重确认同一品番（`verified_canonical_ld`），否则 `identity_mismatch`。结果含 `image_urls` 候选和 `field_status` 字段状态；按字段复核，不据此自动认定图片或曲目归属。 |
| Pony Canyon、Canime、Sony Music | `publisher.pony_canyon`、`publisher.canime`、`publisher.sony_music` 官方产品页 | 输入形式查工具 help。页面缺字段时按未核实处理；Sony 不存在的品番回落到艺人索引页时报 `notfound`（不拼输入品番）。Pony/Canime 支持 `YYYY.M.D 発売` 发售日与价格窗口回退全文。 |
| Bushiroad Music（`bushiroad_music`；别名 `bushiroad`） | `publisher.bushiroad_music` 商品页 | 示例 `node mf-source.mjs run publisher.bushiroad_music BRMM-11078` 查询同页候选 BRMM-11077/11078。品番直达失败时扫描官方目录 ACF（非 WordPress search）；`requested_catalog_number` 保留请求品番，多版时 `catalog_number` 为 `null`，`catalog_candidates` 形如 `{edition,catalog_number}`。 |
| BanG Dream（`bang_dream`；别名 `bangdream`） | `publisher.bang_dream` Discography 页面 | 只接受 HTTPS `/discographies/{numeric-id}/` 完整 URL；URL 未提供品番时 `requested_catalog_number` 为 `null`。多版时 `catalog_number` 为 `null`，候选见 `catalog_candidates`（`{edition,catalog_number}`）。 |
| Wikidata、Bangumi、MusicBrainz | `wikidata.*`；`bangumi.*`；`musicbrainz.*` 搜索或记录读取（含 `musicbrainz.release.barcode` 条码反查与 `musicbrainz.release.catno` 品番反查；`release.search` 仅题名检索） | 搜索结果是候选；核对 kind、具体作品/版次与身份锚点。它们作为聚合或编目来源不能仅凭站点名升级为 CORE-P1。 |

Bushiroad Music / BanG Dream：`price` 保留来源原始字符串，仅唯一明确归版时填写，否则为 `null` 并保留 `price_candidates`；不按价格顺序猜版。候选项为 `{edition,catalog_number,amount,currency,tax_included,raw}`，`raw` 是来源价格原文；日元（`円` / `¥`）为 `JPY`，币种不明时为 `null`，`tax_included` 为 `true` / `false` / `null`。`field_status.price` 为 `source_reported_unverified` / `multiple_editions_ambiguous` / `not_found`；`image_urls` 不自动归版。来源采集价格是证据，不表示目标 Release `attributes` 已有定价落点。

## 外部编目与登记连接器

| 提供方 | 支持范围 | 凭据 |
| --- | --- | --- |
| Discogs | `discogs.release`、`discogs.master`、`discogs.search` | 无连接器 key；图片可能由社区上传。 |
| Open Library | `openlibrary.search/work/edition/editions/author/isbn` | 无连接器 key。 |
| Internet Archive | `archive.item/search/wayback`；可为 VGMdb 读取存档 | 无连接器 key。空元数据需按连接器判读，不能只看 HTTP 状态。 |
| TMDB | `tmdb.movie/tv/search` | `TMDB_API_KEY` 或 `TMDB_ACCESS_TOKEN`。 |
| AniList | `anilist.media/search` | 无连接器 key；聚合内容仍按来源策略分级。 |
| MyAnimeList | `mal.anime/search` | `MAL_CLIENT_ID`。 |
| ISNI Registry、VIAF | `isni.record`、`viaf.record` | 未声明连接器 key。失败响应可能来自网关、代理或解析变化；仅连接器校验后的明确 `found:false` 表示未找到。HTTP 状态本身不作结论。 |
| OCLC FAST | `oclc.fast`：只读公开 FAST suggestion 查询，不实现带认证的 WorldCat API | 不读取 WorldCat 凭据。FAST 端点可能拒绝请求或发生变化；拒绝/解析失败按未知处理，不能据此声称 WorldCat 记录不存在或“配置 key 后即可用”。 |
| NDL Linked Data | `ndl.authority` | 无连接器 key；范围限权威记录，不代表 NDL 全部书目或检索服务。 |
| VGMdb | `vgmdb.album`、`vgmdb.archive` | 无连接器 key。直连拦截或无可用存档都属于未知/不可读取，不代表记录不存在；社区资料仅作候选。 |
| iTunes Store | `itunes.search`、`itunes.album`（lookup 含曲目） | 无连接器 key；Apple Search API 文档口径约 20 req/min（[文档](https://performance-partners.apple.com/search-api)）。storefront 默认 jp，可用末尾 `country=xx` 覆盖；不存在的 id 返回 HTTP 200 + `resultCount:0`，按 `found:false` 判读。结果含 `images`（`{60…3000}` 多尺寸封面 URL，实测 mzstatic 超 3000 回退 3000，可换 png/webp）与 `release_number`。 |

iTunes 封面编号：Apple 的 `artworkUrl*` 原图文件名段常常就是发行方编号（`4538182209493_cov.jpg`、`4547366532999.jpg`）。连接器**不做硬校验**：文件名以一段 6–14 位数字开头、后接分隔符或结尾即原样给出候选 `release_number`（搜索结果同名字段）与 `itunes.album` 的 `external_ids.barcode_candidate`，并附带 `scheme`（位数匹配时给 `ean-8`/`upc-a`/`ean-13`/`gtin-14`，否则 `null`）与 `checksum_valid` 提示，均标 `kind: candidate`。**这不是 Apple 字段**：Apple 响应本身不含 UPC/barcode；同一张数字发行可能用独立编号、沿用实体版条码，或（文件名非数字段时）没有编号。因此 `release_number` 一律由 agent 按技能核实确认后再用，不得直接当实体盘 UPC/JAN 或已核实 `identifiers`。
| Steam 商店 | `steam.app`（appdetails）、`steam.search`（storesearch） | 无连接器 key；Valve 商店接口口径 200 calls/5 min，批量导入须自行限速。区域默认 `cc=us`（不写 cc 时按请求来源地解析、不可复现）；AppID 不存在是 HTTP 200 + `success:false`（不是 404），按 `found:false` 判读且只代表该区域。题名/价格由发行商与 Valve 提供，`developers`/`publishers` 不是完整权利链。[steamdb.info](https://steamdb.info/) 是第三方聚合站、对机读返回 403，只作人工交叉核对；连接器仅从它的 `/app/<id>/` 链接取 AppID。 |
| Cover Art Archive | `caa.release`、`caa.release-group`（按 MBID 取封面图组） | 无连接器 key。没有封面时 CAA 返回 HTTP 404 + HTML「No cover art found」，按 `found:false` 判读——只代表 CAA 没收录，不代表该版次没有封面。**`caa.release-group` 会被 307 到 CAA 选定的那一个发行版**，图属于结果里 `release_of_record` 指向的 Release，不是整组通用：写 Release 封面按它归位，不得沿用上级实体。选图判据是 `types` 与 `front`/`back`（`Case Front` 是正面再摄＝与 `Front` 重复画面，`Back`/`Case Back` 才是另一面），`index.json` **不提供像素尺寸**，判尺寸门槛必须真的打开图片。index 与图片正文都托管在 archive.org：本机 2026-10-11 实测 archive.org 出现异常 DNS 解析（疑似 DNS 污染）（解析到 `2a03:2880:f134:83:face:b00c:0:25de`，连接超时），此时连接器抛 `network`／`retryable`，**不会**谎报 `found:false`；同机 `coverartarchive.org` 与 `musicbrainz.org` 正常 200。 |
| Kitsu | `kitsu.anime`、`kitsu.manga`、`kitsu.search` | 无连接器 key。JSON:API 形态；不存在的 id 是 HTTP 404 + `errors[].code=404`，只有这个形状才按 `found:false`，否则按 `unavailable`。`titles` 已按 BCP-47 归一（`ja_jp`→`ja-JP`、`zh_cn`→`zh-CN`），`en_jp` 是罗马音、单列在 `romaji`，不要当译名写入。`poster` 各档带 `width`/`height`/`short_edge`，据此判封面门槛；`cover_banner`（`coverImage`）是宽幅横幅，**不作封面候选**。`synopsis` 末尾的「(Source: Wikipedia)」「(Source: Crunchyroll)」是简介的真实出处——Kitsu 本身是社区聚合站，不能仅凭站点名升级为 CORE-P1。`relationships` 只给链接，需要 cast/staff 时另取。 |
| VNDB | `vndb.vn`、`vndb.releases`、`vndb.character`、`vndb.staff`、`vndb.schema` | 无连接器 key；官方口径约每分钟 1 次突发。`vndb.releases` 是最值钱的一路：`catalog_number`（品番）、`gtin`（条码，附 `gtin_scheme` 与 `gtin_checksum_valid` 提示）、`media`（载体与枚数，对应站内 Medium 层）、`producers` 的 `publisher`/`developer` 分工、`minage`。`minage` 是数字、**不等于**站内 `content_rating` 词表，映射前查 definitions。`released` 用 `00` 表示未知的月/日（`2003-05-00`＝2003 年 5 月），连接器已降级到能确证的精度。`description` 是 BBCode 且常带 `[url=…Wikipedia[/url]]` 出处标注，`description_text` 是机械去标签结果、原文保留在 `raw`。`image.dims`／`image.sexual`／`image.violence` 是像素与社区投票数，不是分级结论。端点是 `POST /kana/<type>`（不是 `POST /kana`），分页参数是 `results`（不是 `count`），`fields` 严格校验且嵌套对象必须显式给子字段——报错时先跑 `vndb.schema` 查权威字段名，不要试错。 |
| OpenBD | `openbd.isbn`（按 ISBN 取日本出版物书目） | 无连接器 key。查无是 **HTTP 200 + `[null]`**，按 `found:false`；HTTP 404 只可能是路径写错（端点是 `?isbn=` 查询参数），连接器抛 `unavailable` 而不是"没有这本书"。**OpenBD 只收日本出版物**：台版、繁中版、简体引进版返回 `[null]` 是收录范围问题，不是站点故障（繁中版走台灣角川官方商店）。`summary.title` 可能缺副题或标点，题名以版元商品页 `h1` 为准，OpenBD 只用来复核巻号·丛书·刊行年月。`collection_part_number` 是**丛书序号**（实测電撃文庫 3159）而**不是巻号**——巻号只在题名文字里，别把这个字段当 volume 写。`author` 是 ONIX 倒装形（「師走,トオル」＝姓,名）。`PublishingDateRole` 是 ONIX 代码，连接器不猜含义、原样给出。`isbn_checksum.valid=false` 只提示校验位不合、不拒绝查询。**切勿调用同域名的 `/v1/coverage`：它忽略 `isbn` 参数、返回全量收录清单（实测 59MB）**。`www.openbd.jp` 本机实测 `http=000` 连不上，而 `api.openbd.jp` 正常，故证据 URL 用实际读到的 API 地址。 |
| Project Gutenberg | `gutenberg.ebook`（读 RDF）、`gutenberg.search` | 无连接器 key。日期一律取 RDF 的 `dcterms:issued`：**页面 HTML 的 RDFa `content` 属性是交叉错位的**（实测 ebook 1513：`property="dcterms:issued"` 的 content 是最后更新日、`property="dcterms:modified"` 的 content 才是发行日；只有可见文本 `itemprop="datePublished"` 对）。`creators[].name` 是倒装形（「Shakespeare, William」），`aliases` 是历史拼写变体。`dcterms:rights` 实测为「Public domain in the USA.」——**只覆盖美国公版**，不能据此断言全球公版。这个 ebook 是 Gutenberg 自己的数字版次，可建 Release（publisher 记 Project Gutenberg），但原作 Work 层身份要另找一手来源。检索结果是候选且混着同名异书、不同译本与不同编者版本，`author`(subtitle) 只是线索、不足为凭：必须逐条用 `gutenberg.ebook` 核对 `creator` 与 `issued`。`gutendex.com` 是第三方镜像，连接器不用它。 |

## 失败与证据判读

`mf-fetch-providers.mjs` 完成读取后的顶层 `url` 是实际读取的响应地址（含重定向后的地址），`sha256` 对应该响应正文的原始读取字节，不能用解析后的 JSON、截断的 `raw` 或重新编码的文本重算。`request_url` / `request_method` 描述请求；POST 另带 `request_body_sha256`。`human_page` 与 `image_page_url` 只供人工导航，可能未请求过，不能替换证据 URL。检索返回的候选项 URL 同样只作导航；`found:false` 的证据地址仍指本次实际答复。纯 `map*` / `parse*` 不发请求，不提供实读摘要。

多语种读取在 `evidence_reads` 中逐次保留 URL、方法、HTTP 状态、字节摘要与读取时间；顶层 URL 和摘要对应主响应。带凭据的查询 URL 输出 `[REDACTED]` 并标 `url_redacted:true`，表示安全脱敏后的读取端点，不能声称该字面 URL 可直接复取同一响应；密钥不进入证据记录。Wayback 查询返回的 `snapshot_url` 是未读取的存档候选，读取存档正文后的 `url` / `sha256` 才是正文证据。

来源目录、操作帮助与调用结果的 `source_qualification` 提供 `level`、`can_independently_support_core_identity`、`scope`、`field_limits`。这是客户端的字段来源指引；社区来源可以作为证据，`false` 只表示不能单独支撑核心身份结论，不禁止封存。API 由站点维护、需要 key 或 HTTP 成功都不自动升级字段证据资格。OpenBD 用于书目复核，Gutenberg 只对自己的数字版次有出版方资格；这不是服务端 definitions 资格配置。

封面 URL 均为候选：CAA 仅把 `front=true` 的图作为主候选，无正面时 `image_url:null` 并保留图组；Gutenberg 仅返回本次 RDF `hasFormat` 明示的图片，没有明示图片时不按编号拼图。`mf-providers-smoke.mjs --images` 只用 HEAD 报告 `image_transport`（响应状态、HTTP 成功和声明的媒体类型），内容、身份与权利仍为未核实；不会输出 `image_check.ok` 或“封面正确”结论。

- 只把连接器明确验证为未找到的结果视作 `found:false`。对 ISNI / VIAF 尤其区分登记记录缺失与网关 404、反爬页或响应格式变化；`2xx` 或 HTTP 404 均不能单独证明有/无记录。
- 凭据缺失、401/403、限流、网络/超时、5xx、反爬、网关错误和解析失败都不是“没有数据”。依结构化错误的 `kind` / `retryable` / `hint` 处理；状态不明时停止依赖该结果的写入。
- 检索返回的是候选。写目录前复核实体 kind、父级作用域、身份锚点、发行版和来源实际支持的字段；不要把 `raw`、图片 URL 或曲目原文直接视为已核实事实。
- 连接器只读取外部来源，不向来源站发送 MetaFusion PAT，也不写目录库。提供方自己的 key 通过对应环境变量提供，变量名见上表；不要展示或记录密钥值。
- 速率限制和端点可用性可能变化；按工具提示与本次响应退避或换已支持的来源路径，不沿用历史 smoke 输出作为当前事实。

来源连接器的归一化结果仍以 `external_ids` 对象保存候选标识（可能含数组或未核实线索）；这不是目录实体写入载荷。核实后按当前外部库定义转换为 `external_links: [{kind,url,external_id?}]`，不得直接复制候选对象。来源注册与请求错误继续使用 `provider`。
