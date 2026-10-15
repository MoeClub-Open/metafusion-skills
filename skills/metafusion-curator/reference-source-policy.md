# 来源与封面

按字段判定证据资格，不给整站或整页统一背书。

## 来源等级

| 等级 | 用途 |
| --- | --- |
| CORE-P1 | 权利方、作者/艺人、制作/出版/发行方、官方注册机构、明确对应版次的官方/授权渠道；只支持明示字段 |
| AUX-P2 | MusicBrainz、Wikidata、Discogs、VGMdb、Bangumi、AniList/MAL、IMDb/TMDB、Kitsu、VNDB、Cover Art Archive 等聚合/社区资料；候选或辅助事实，不单独支撑核心身份、合并与完整计数 |
| DISCOVERY-W | Wiki/转述只作线索，引用的原始来源须另核 |

模型记忆、搜索摘要、站内旧值不是证据。本站页面与 `self` 不具备新提交的来源资格，不能封存为事实证据；历史 `self` 只可按旧维护记录解读。冲突不静默择一；可选字段无证留空，旧值缺证先标缺口，不擅删数据。

工具目录的 `source_qualification` 是机器可读的字段来源指引：`level` 为上述级别，`can_independently_support_core_identity` 说明是否能在 `scope` 范围内单独支撑核心身份，`field_limits` 列出限制。社区来源属于合法外部证据；该标记为 `false` 不表示禁止提交或封存，只提示核心身份结论仍须核原始出处。`authority` 只描述平台类型，不代替资格判定；官方 API、凭据和可访问性均不提升字段证据级别。该字段是客户端元信息，当前不冒充服务端 definitions 可配置资格。

## 字段门槛

| 字段/结论 | 要求 |
| --- | --- |
| kind、内容身份、父级、subjects/contents、正式 title、版名、简介 | CORE-P1；简介仅忠实转述，译名不替代正式题名 |
| 品番、ISBN、条码、用于身份判断的外部 ID/ISRC/编号/locator | CORE-P1，匹配具体 kind、资源类型与版次 |
| 日期、时长、语言、格式、包装、地区、标签及普通辅助署名 | AUX-P2；参与身份/合并判断时升级 CORE-P1 |
| 作者、改编、系列归属等身份关系 | 关系与两端均须 CORE-P1 |
| 译名/别名 | AUX-P2，官方本地化优先，不单独判身份 |
| 图片 | 核图源与具体版次，权利另判；系统 id/version/编辑者不作事实证据 |

官方主页写 `external_links.official_website` 完整 URL，渠道/资讯页不替代。Apple Music/iTunes 官方页可支持对应数字发行；专辑 ID 写 `external_links.apple_music`，不套用到其他版次。

iTunes 封面 URL 的文件名段（如 `4538182209493_cov.jpg`、`4547366532999.jpg`）常携带发行方编号，而连接器 `itunes.album` 的 `release_number` / `external_links.barcode_candidate` 只做「6–14 位数字 + 可选 GTIN 校验提示」的保守提取，**不自行判定来源资格**：同一张数字发行可能用独立编号、沿用实体版条码或没有编号，文件名取值也不保证等于实体盘 UPC/JAN。因此它只是候选线索，除非与权利方页面或对应版次交叉核实，否则不满足上表「条码/编号」的 CORE-P1 门槛，不得直接写入 `identifiers`/`external_links`。封面 `images` 多尺寸同样只作图源候选，按「图片」一节核实图源、版次与权利。

2026-10-11 新增五个连接器（`caa.*`、`kitsu.*`、`vndb.*`、`openbd.isbn`、`gutenberg.*`）的字段级归位，仍按上表逐字段判，不给整站背书：

- **OpenBD（`openbd.isbn`）**：出版资料的 ONIX 书目复核入口，连接器资格为 AUX-P2，可辅助核**巻号 / 丛书 / 刊行年月 / 定价**；`summary.title` 可能缺副题或标点，**正式题名仍以版元商品页 `h1` 为准**。`collection_part_number` 是丛书序号（如電撃文庫 3159）而**不是巻号**，不得当 volume 写入。`[null]` 是「未收录」而非「不存在」：OpenBD 只收日本出版物，台版/繁中/简体引进版一律 `[null]`，据此判「查无此书」是错的。它不产图片授权。
- **Project Gutenberg（`gutenberg.*`）**：对它**自己发行的那个数字版次**是出版方，可支撑该 Release 的 `edition_date`、publisher、格式与语言；但原作 Work 层身份（作者、原作题名、首发年）必须另找一手来源，`dcterms:issued` 是 Gutenberg 上架日而不是原作出版日。`dcterms:rights` 实测为「Public domain in the USA.」，**只覆盖美国**，不得据此断言全球公版或可自由分发。
- **VNDB（`vndb.*`）**：整体是社区资料（AUX-P2），但 `vndb.releases` 的 `catalog_number` / `gtin` / `media` 属「品番、条码」一类——按字段门槛需 CORE-P1，因此**只能作候选线索**，写入 `identifiers` 前须与厂牌官方商品页交叉核实。`gtin_checksum_valid` 与 `isbn_checksum` 同理：校验位通过只说明这串数字自洽，不证明它属于这个版次。
- **Cover Art Archive（`caa.*`）**：图片由社区上传，一律走「图片」一节逐张核图源、版次与权利；来自 CAA 不免除核对。`release-group` 请求拿到的图属于 `release_of_record` 指向的那个 Release，**不得沿用上级实体**；`Case Front` 与 `Front` 是同一画面的再摄，不算第二张。

## 当前证据

`sources` 是修订级证据，不在 Entity 顶层，也不提供字段级 provenance。按 `revision.version == entity.version` 选当前修订，再逐字段核来源实际内容、作用域与版次；citation 写支持字段。历史修订、失效链接或接口接受载荷不补当前资格；核心缺证标“需补证/不计完整”。

## 图片

- 用品番/ISBN、格式/版次匹配；MV 缩略图不作音频封面，网文章节图不作实体书封面。
- `Picture.source` 是图源，`asset_id` 是存储绑定，`usage_period` 是事实使用时段；均不是许可证，Picture DTO 无许可字段。
- 当前任务已授权的操作按范围执行，不重复询问。权利材料覆盖实际用途才标 passed；缺材料 unknown、明确禁止 blocked。unknown 不改成 passed，也不自动追加审批。
- 需要“权利已核实”结论时记录图片/版次、来源、出示主体、许可依据及覆盖用途/地域/期限。官方可访问或普通 sources 不替代许可。

## 批次计数（需要时）

按 canonical ID 去重，区分独立 Work、发行链与支持实体；新增支持实体不冒充完整作品。`count_eligible` 要求当前核心证据、实体边界与去重均确认；图片权利仅在批次明确要求时加入门槛。报告已核范围、核心缺口与相关权利状态，不强制普通操作输出整套批次指标。
