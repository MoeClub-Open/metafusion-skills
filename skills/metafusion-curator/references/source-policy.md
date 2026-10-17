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

## 字段来源依据

| 字段/结论 | 要求 |
| --- | --- |
| kind、内容身份、父级、subjects/contents、正式 title、版名、简介 | CORE-P1；简介仅忠实转述，译名不替代正式题名 |
| 品番、ISBN、条码、用于身份判断的外部 ID/ISRC/编号/locator | CORE-P1，匹配具体 kind、资源类型与版次 |
| 日期、时长、语言、格式、包装、地区、标签及普通辅助署名 | AUX-P2；参与身份/合并判断时升级 CORE-P1 |
| 作者、改编、系列归属等身份关系 | 关系与两端均须 CORE-P1 |
| 中文译名 | CORE-P1，须核权利方或授权本地化渠道实际使用的名称、地区和对应作品/版次；不单独判身份 |
| 原语别名、公开使用的署名 | AUX-P2；中文译名不能借别名字段绕过官方来源要求，不单独判身份 |
| 图片 | 核图源与具体版次，权利另判；系统 id/version/编辑者不作事实证据 |

官方主页写 `external_links` 中 `kind="official_website"` 的 `url` 完整 URL，渠道/资讯页不替代。Apple Music/iTunes 官方页可支持对应数字发行；专辑 ID 写 `external_links` 中 `kind="apple_music"` 的 `external_id`，不套用到其他版次。

## 中文译名

没有可靠官方中文译名时保留原名，只录入有依据的原语言资料；`translations` 是语言资料集合，不要求为中文界面补造中文题名。不得自行意译、音译、用机器翻译造名，或把社区常用译名直接写入 `translations.zh-CN/zh-TW.title`、中文 `aliases` 或基础 `title`。社区、聚合站和商店 API 的多语言题名只作候选，须另核对应权利方或授权本地化证据；同一地区/版次的题名不自动代表其他地区/版次的官方译名。

非官方译名只有在当前 OpenAPI/definitions 与展示界面明确支持名称级 `nonofficial` 标记时才能按标记录入。当前 `Translation` 只有 `title`、`summary`、`body`、`aliases`，没有该标记，因此默认不录入非官方译名；不得伪造字段、locale 或标签，也不要把「非官方」拼进名称。仅在来源备注中写明非官方不能替代展示标记。已有缺证中文名称列为待核，不因本规则自动批量删除。

iTunes 封面 URL 的文件名段（如 `4538182209493_cov.jpg`、`4547366532999.jpg`）常携带发行方编号，而连接器 `itunes.album` 的 `release_number` / `external_ids.barcode_candidate` 只做「6–14 位数字 + 可选 GTIN 校验提示」的保守提取，**不自行判定来源资格**：同一张数字发行可能用独立编号、沿用实体版条码或没有编号，文件名取值也不保证等于实体盘 UPC/JAN。因此它只是候选线索，除非与权利方页面或对应版次交叉核实，否则不满足上表「条码/编号」的 CORE-P1 门槛，不得直接写入 `identifiers`/`external_links`。封面 `images` 多尺寸同样只作图源候选，按「图片」一节核实图源、版次与权利。

2026-10-11 新增五个连接器（`caa.*`、`kitsu.*`、`vndb.*`、`openbd.isbn`、`gutenberg.*`）的字段级归位，仍按上表逐字段判，不给整站背书：

- **OpenBD（`openbd.isbn`）**：出版资料的 ONIX 书目复核入口，连接器资格为 AUX-P2，可辅助核**巻号 / 丛书 / 刊行年月 / 定价**；`summary.title` 可能缺副题或标点，**正式题名仍以版元商品页 `h1` 为准**。`collection_part_number` 是丛书序号（如電撃文庫 3159）而**不是巻号**，不得当 volume 写入。`[null]` 是「未收录」而非「不存在」：OpenBD 只收日本出版物，台版/繁中/简体引进版一律 `[null]`，据此判「查无此书」是错的。它不产图片授权。
- **Project Gutenberg（`gutenberg.*`）**：对它**自己发行的那个数字版次**是出版方，可支撑该 Release 的 `edition_date`、publisher、格式与语言；但原作 Work 层身份（作者、原作题名、首发年）必须另找一手来源，`dcterms:issued` 是 Gutenberg 上架日而不是原作出版日。`dcterms:rights` 实测为「Public domain in the USA.」，**只覆盖美国**，不得据此断言全球公版或可自由分发。
- **VNDB（`vndb.*`）**：整体是社区资料（AUX-P2），但 `vndb.releases` 的 `catalog_number` / `gtin` / `media` 属「品番、条码」一类——按字段门槛需 CORE-P1，因此**只能作候选线索**，写入 `identifiers` 前须与厂牌官方商品页交叉核实。`gtin_checksum_valid` 与 `isbn_checksum` 同理：校验位通过只说明这串数字自洽，不证明它属于这个版次。
- **Cover Art Archive（`caa.*`）**：图片由社区上传，一律走「图片」一节逐张核图源、版次与权利；来自 CAA 不免除核对。`release-group` 请求拿到的图属于 `release_of_record` 指向的那个 Release，**不得沿用上级实体**；`Case Front` 与 `Front` 是同一画面的再摄，不算第二张。

## 当前证据

`sources` 保存在修订中，不在 Entity 顶层。新提交的 `source_refs` 为每个操作选择来源，可用 JSON Pointer 指定字段；读取修订时对应为来源的 `pointers`。无指针表示支撑本次整个操作，不表示整份快照的所有字段。旧修订的 `scope="commit"` 仅代表整笔提交的来源池，不能证明某字段。

按 `revision.version == entity.version` 确认当前快照；核对某个字段时还须追到实际修改它的修订或提交，最新修订的来源不会自动覆盖未改字段。逐项核来源实际内容、作用域与版次，citation 写明支持事实；失效链接或接口接受载荷不补当前资格，核心缺证标“需补证/不计完整”。

### 证据范围与完整保留

- 商品页曲目表支持该版收录，不单独证明独立录音、母版差异或与另一发行共用录音。`version_label` 只保存有据的内容版本，不用商品名或品番填充。
- 艺人简介提到动画 OP/ED，不证明其整张专辑是原声带或每首歌用于动画；用途关系须有明确对应作品、歌曲与使用方式的证据。
- 包装与赠品保留适用版次、初回压制、渠道、数量及随机条件。初回封入不写成所有批次固定附送，随机一张不写成一套；店铺赠品与盒内附件分别记录。
- 逐曲署名保留每名共同参与者与职位，只扩展到来源实际覆盖的曲目、录音或版次。未注明混音不能由录音署名推得；落点见[关系](relations.md)。
- 来源抓取的 `raw`、`fetched_at`、`content_hash` 是响应内容及抓取元信息，提交 URL/citation 不会自动归档原网页。`tracklist_excerpt` 等提取摘要也不是完整原文；无法仅据这些字段声称“全部权威信息已保存”。要求完整保留时分别说明已存事实、可复核来源与尚未归档的原文或未映射信息。

## 图片

- 用品番/ISBN、格式/版次匹配；MV 缩略图不作音频封面，网文章节图不作实体书封面。
- `Picture.source` 是图源，`asset_id` 是存储绑定，`usage_period` 是事实使用时段；均不是许可证，Picture DTO 无许可字段。
- 当前任务已授权的操作按范围执行，不重复询问。权利材料覆盖实际用途才标 passed；缺材料 unknown、明确禁止 blocked。unknown 不改成 passed，也不自动追加审批。
- 需要“权利已核实”结论时记录图片/版次、来源、出示主体、许可依据及覆盖用途/地域/期限。官方可访问或普通 sources 不替代许可。

## 批次计数（需要时）

仅在用户需要批次统计时，按 canonical ID 去重，区分独立 Work、发行链与支持实体；新增支持实体不冒充完整作品。`count_eligible` 只表示当前核心证据、实体边界与去重均确认的统计口径；图片权利仅在批次明确要求时计入。统计标签和未核缺口不阻止编辑、提交或应用，普通操作无需运行统计或输出整套指标。
