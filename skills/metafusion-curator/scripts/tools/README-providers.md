# 来源与提供方支持矩阵

本页说明外部连接器的支持范围、凭据与解析特点；参数和返回 schema 以 `mf-source` 帮助为准，可用性以本次请求为准。数据依据按[来源说明](../../references/source-policy.md)判断，不附加来源等级认证流程。

除下表列出的环境变量外，注册连接器未声明需要 API key；来源列表中的 `anonymous` 表示无需提供方凭据。连接状态只由单次读取结果报告，`list` / `help` 不做连通性探测。

## 官方来源与出版方页面

| 来源 | 连接器覆盖 | 输入与结果注意事项 |
| --- | --- | --- |
| Universal Music Japan | `umj.product` 官方商品页 | 输入 `artist-slug/product-code` 并严格核对页面品番：有可见「品番」行时须与请求完全一致（`verified_exact`）；数字发行页无品番行时须 canonical 路径 slug+品番与请求一致且 ld+json 面包屑/WebPage 双重确认同一品番（`verified_canonical_ld`），否则 `identity_mismatch`。结果含 `image_urls` 候选和 `field_status` 字段状态；按字段复核，不据此自动认定图片或曲目归属。 |
| Pony Canyon、Canime、Sony Music | `publisher.pony_canyon`、`publisher.canime`、`publisher.sony_music` 官方产品页 | 输入形式查工具 help。页面缺字段时按未核实处理；Sony 不存在的品番回落到艺人索引页时报 `notfound`（不拼输入品番）。Pony/Canime 支持 `YYYY.M.D 発売` 发售日与价格窗口回退全文。 |
| Bushiroad Music（`bushiroad_music`；别名 `bushiroad`） | `publisher.bushiroad_music` 商品页 | 示例 `node mf-source.ts run publisher.bushiroad_music BRMM-11078` 查询同页候选 BRMM-11077/11078。品番直达失败时扫描官方目录 ACF（非 WordPress search）；`requested_catalog_number` 保留请求品番，多版时 `catalog_number` 为 `null`，`catalog_candidates` 形如 `{edition,catalog_number}`。 |
| BanG Dream（`bang_dream`；别名 `bangdream`） | `publisher.bang_dream` Discography 页面 | 只接受 HTTPS `/discographies/{numeric-id}/` 完整 URL；URL 未提供品番时 `requested_catalog_number` 为 `null`。多版时 `catalog_number` 为 `null`，候选见 `catalog_candidates`（`{edition,catalog_number}`）。 |
| Wikidata、Bangumi、MusicBrainz | `wikidata.*`、`bangumi.*`、`musicbrainz.*` 搜索和详情 | 搜索结果是候选；`musicbrainz.release.barcode` / `catno` 支持条码 / 品番，`release.search` 是题名检索。使用时核对具体作品、录音或版次，保留原始出处。 |

Bushiroad Music / BanG Dream：`price` 保留来源原始字符串，仅唯一明确归版时填写，否则为 `null` 并保留 `price_candidates`；不按价格顺序猜版。候选项为 `{edition,catalog_number,amount,currency,tax_included,raw}`，`raw` 是来源价格原文；日元（`円` / `¥`）为 `JPY`，币种不明时为 `null`，`tax_included` 为 `true` / `false` / `null`。`field_status.price` 为 `source_reported_unverified` / `multiple_editions_ambiguous` / `not_found`；`image_urls` 不自动归版。来源采集价格是证据，不表示目标 Release `attributes` 已有定价落点。

## 外部编目与登记连接器

| 提供方 | 支持范围 | 凭据 |
| --- | --- | --- |
| Discogs | `discogs.release`、`discogs.master`、`discogs.search` | 无连接器 key；图片可能由社区上传。 |
| Open Library | `openlibrary.search/work/edition/editions/author/isbn` | 无连接器 key。 |
| Internet Archive | `archive.item/search/wayback`；可为 VGMdb 读取存档 | 无连接器 key。空元数据需按连接器判读，不能只看 HTTP 状态。 |
| TMDB | `tmdb.movie/tv/search` | `TMDB_API_KEY` 或 `TMDB_ACCESS_TOKEN`。 |
| AniList | `anilist.media/search`，CLI `--type MANGA` 查询漫画/轻小说，默认 `ANIME` | 无连接器 key；聚合资料按实际内容判断支持范围。 |
| MyAnimeList | `mal.anime/search` | `MAL_CLIENT_ID`。 |
| ISNI Registry、VIAF | `isni.record`、`viaf.record` | 未声明连接器 key。失败响应可能来自网关、代理或解析变化；仅连接器校验后的明确 `found:false` 表示未找到。HTTP 状态本身不作结论。 |
| OCLC FAST | `oclc.fast`：只读公开 FAST suggestion 查询，不实现带认证的 WorldCat API | 不读取 WorldCat 凭据。FAST 端点可能拒绝请求或发生变化；拒绝/解析失败按未知处理，不能据此声称 WorldCat 记录不存在或“配置 key 后即可用”。 |
| NDL Linked Data | `ndl.authority` | 无连接器 key；范围限权威记录，不代表 NDL 全部书目或检索服务。 |
| VGMdb | `vgmdb.album`、`vgmdb.archive` | 无连接器 key。直连拦截或无可用存档都属于未知/不可读取，不代表记录不存在；社区资料仅作候选。 |
| iTunes Store | `itunes.search`、`itunes.album`（lookup 含曲目） | 无连接器 key；Apple Search API 文档口径约 20 req/min（[文档](https://performance-partners.apple.com/search-api)）。storefront 默认 jp，可用末尾 `country=xx` 覆盖；不存在的 id 返回 HTTP 200 + `resultCount:0`，按 `found:false` 判读。结果含 `images`（`{60…3000}` 多尺寸封面 URL，实测 mzstatic 超 3000 回退 3000，可换 png/webp）与 `release_number`。 |

iTunes 的 `release_number` / `barcode_candidate` 来自封面文件名，不是 Apple 返回的条码字段；位数与校验位提示也不证明它属于实体版。用于 UPC/JAN 时核对对应发行资料。
| Steam 商店 | `steam.app`（appdetails）、`steam.search`（storesearch） | 无连接器 key；Valve 商店接口口径 200 calls/5 min，批量导入须自行限速。区域默认 `cc=us`（不写 cc 时按请求来源地解析、不可复现）；AppID 不存在是 HTTP 200 + `success:false`（不是 404），按 `found:false` 判读且只代表该区域。题名/价格由发行商与 Valve 提供，`developers`/`publishers` 不是完整权利链。[steamdb.info](https://steamdb.info/) 是第三方聚合站、对机读返回 403，只作人工交叉核对；连接器仅从它的 `/app/<id>/` 链接取 AppID。 |
| Cover Art Archive | `caa.release`、`caa.release-group` | 无连接器 key。404 +「No cover art found」表示 CAA 未收录；网络错误仍为未知。release-group 图片归 `release_of_record` 指向的具体发行；按 `types`、`front/back` 选择图源，像素尺寸需读取图片。 |
| Kitsu | `kitsu.anime`、`kitsu.manga`、`kitsu.search` | 无连接器 key。404 且 `errors[].code=404` 为未收录；`titles` 使用 BCP-47，`romaji` 是罗马音；`poster` 与 `cover_banner` 分别为海报和横幅。简介末尾可能标有原始出处，cast/staff 需沿 relationships 另取。 |
| VNDB | `vndb.vn`、`vndb.releases`、`vndb.character`、`vndb.staff`、`vndb.schema` | 无连接器 key。品番、gtin、载体与发行方可用于核对具体版次；校验位只验证数字格式。`minage` 不等于站内分级；日期中的 `00` 表示未知，description 原文为 BBCode。Kana 字段与可用筛选以 `vndb.schema` 为准。 |
| OpenBD | `openbd.isbn` | 无连接器 key，范围为日本出版物。HTTP 200 + `[null]` 表示未收录，非日版返回空不证明不存在；404 是路径异常。`summary.title` 可能省略副题，`collection_part_number` 是丛书序号，不是巻号。 |
| Project Gutenberg | `gutenberg.*` | 无连接器 key。RDF 描述的是 Gutenberg 数字发行，`issued` 是上架日；rights 中的美国公版说明不代表全球公版。保留原文及实际 hasFormat 图片，不按编号猜图。 |

## 失败与证据判读

`mf-fetch-providers.ts` 完成读取后的顶层 `url` 是实际读取的响应地址（含重定向后的地址），`sha256` 对应该响应正文的原始读取字节，不能用解析后的 JSON、截断的 `raw` 或重新编码的文本重算。`request_url` / `request_method` 描述请求；POST 另带 `request_body_sha256`。`human_page` 与 `image_page_url` 只供人工导航，可能未请求过，不能替换证据 URL。检索返回的候选项 URL 同样只作导航；`found:false` 的证据地址仍指本次实际答复。纯 `map*` / `parse*` 不发请求，不提供实读摘要。

多语种读取在 `evidence_reads` 中逐次保留 URL、方法、HTTP 状态、字节摘要与读取时间；顶层 URL 和摘要对应主响应。带凭据的查询 URL 输出 `[REDACTED]` 并标 `url_redacted:true`，表示安全脱敏后的读取端点，不能声称该字面 URL 可直接复取同一响应；密钥不进入证据记录。Wayback 查询返回的 `snapshot_url` 是未读取的存档候选，读取存档正文后的 `url` / `sha256` 才是正文证据。

`source_qualification` 提供来源背景与适用范围，作为选源参考；它不是服务端权限或提交条件。来源能证明什么仍取决于实际记录，HTTP 成功、API key 或平台名称都不代替内容核对。

封面 URL 均为候选：CAA 仅把 `front=true` 的图作为主候选，无正面时 `image_url:null` 并保留图组；Gutenberg 仅返回本次 RDF `hasFormat` 明示的图片，没有明示图片时不按编号拼图。`mf-providers-smoke.ts --images` 只用 HEAD 报告 `image_transport`（响应状态、HTTP 成功和声明的媒体类型），内容、身份与权利仍为未核实；不会输出 `image_check.ok` 或“封面正确”结论。

- 只把连接器明确验证为未找到的结果视作 `found:false`。对 ISNI / VIAF 尤其区分登记记录缺失与网关 404、反爬页或响应格式变化；`2xx` 或 HTTP 404 均不能单独证明有/无记录。
- 凭据缺失、401/403、限流、网络/超时、5xx、反爬、网关错误和解析失败都不是“没有数据”。依结构化错误的 `kind` / `retryable` / `hint` 处理；状态不明时停止依赖该结果的写入。
- 检索返回的是候选。写目录前复核实体 kind、父级作用域、身份锚点、发行版和来源实际支持的字段；不要把 `raw`、图片 URL 或曲目原文直接视为已核实事实。
- 连接器只读取外部来源，不向来源站发送 MetaFusion PAT，也不写目录库。提供方自己的 key 通过对应环境变量提供，变量名见上表；不要展示或记录密钥值。
- 速率限制和端点可用性可能变化；按工具提示与本次响应退避或换已支持的来源路径，不沿用历史 smoke 输出作为当前事实。

来源连接器的归一化结果仍以 `external_ids` 对象保存候选标识（可能含数组或未核实线索）；这不是目录实体写入载荷。核实后按当前外部库定义转换为 `external_links: [{kind,url,external_id?}]`，不得直接复制候选对象。来源注册与请求错误继续使用 `provider`。
