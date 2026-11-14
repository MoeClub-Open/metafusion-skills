# 字段适用层级、分类词表与结构化字段

实体可写属性由目标实例 `GET /api/catalog/definitions` 中 `document.fields[code].applicable_kinds` 与 `enabled` 动态决定；实体与定义均无 `types` 字段。字段、词表、关系与模板均支持管理员通过后台 GUI 或实例 seed 扩展；以下完整列出标准基线，供 Agent 精确填写而无需猜测代码，写入实例自定义扩展项前仍以当前 `definitions` 为准。

## 实体共用字段与动态属性规则

- **可写顶层字段**：`title`、`original_language`、`translations`、`attributes`、`external_links`、`pictures`、`position`、`number`；结构归属（`work_id`、`content_unit_id`、`release_id`、`medium_id`、`parent_id`）与收录（`subjects`、`contents`）按 `kind` 校验，见[载荷模板](api-templates.md)。
- **只读投影字段**（写入时严禁提交或由副本自动剥离）：`id`、`version`、`state`、`review_status`、`created_by`、`updated_at`、`redirect_id`，以及 `kind=release` 读取时按活动子 `medium` 聚合的 `medium_formats`（`Record<string, number>`）。
- **适用层级校验**：没有 `applicable_kinds` 或未包含当前 `kind` 的字段（如仅供关系或内嵌组使用的字段）直接写入 `Entity.attributes` 会返回 `unknown_field`；选择展示模板不会扩大 `applicable_kinds` 白名单。
- **枚举与实体引用校验**：`enum` 字段必须填写 `document.vocabularies` 中启用的词项 `code`（提交显示名返回 `invalid_term`）。`entity` 引用字段（如 `Work.attributes.duration_source -> expression`、`Release.attributes.publisher -> agent`）要求目标实体存在、`kind` 匹配、对当前调用者可见且未处于 `deleted`/`merged`，不得填写纯文本名称。
- **自由文本字段**：`country`、`platform`、`version_label`、`credit_role`、`scope`、`magazine`、`broadcast_weekday`、`air_network`、`copyright`、`author` 类型均为 `text`，不是枚举词表。
- **模板匹配**：详情模板仅按显式 `match` 与 `priority` 自动匹配（如 `agent_type`、`collection_type`、`creation_form` 驱动细分模板），`match: []` 为该 `kind` 兜底布局；分类字段本身不限制同 `kind` 其他已启用字段的可写性。

## 八类实体主分类与标准属性基线

| 实体 `kind` | 主分类 / 核心标识字段 | 标准词项 `code` 与中文说明 | 同层级其他标准种子属性 / 结构 |
| --- | --- | --- | --- |
| `agent` | `attributes.agent_type`（enum `agent_type`） | `person`（个人）、`group`（团体 / 组合）、`organization`（机构 / 公司）、`character`（虚构角色） | `birth_date`（`allow_yearless: true`，支持 `--MM-DD`）、`death_date`、`formation_date`、`dissolution_date`、`occupations`（`string[]`）、`activity_periods`（`[{begin?, end?}]`）、`tags` |
| `collection` | `attributes.collection_type`（enum `collection_type`） | `franchise`（跨媒体企划）、`series`（作品系列）、`anthology`（选集 / 丛书）、`event_catalog`（展会 / 活动特辑） | `language`、`begin_date`、`end_date`、`tags`；成员作品用语义关系 `includes` 聚合 |
| `work` | `attributes.creation_form`（enum `creation_form`） | 见下表 `creation_form` 完整词项表（区分单首乐曲 `song` 与单曲/专辑企划） | `language`、`edition_date`、`copyright`、`imdb`、`infobox`、`events`、`duration`、`duration_source`（`entity -> expression`）、`author`、`volume_count`、`magazine`、`begin_date`、`end_date`、`episodes`、`platform`、`broadcast_start`、`broadcast_weekday`、`broadcast_end`、`air_network`、`tags` |
| `content_unit` | `attributes.entry_role`（enum `entry_role`） | `main`（本篇）、`opening`（片头曲）、`ending`（片尾曲）、`trailer`（预告 / 宣传）、`extra`（其它附加）、`other`（其它） | `air_date`（篇目级首播/发布日）、`language`、`tags`（无 `duration`；必填结构 `work_id`，可选 `parent_id`） |
| `expression` | `attributes.version_label`（自由文本） | 自由文本，如 `录音室版`、`现场版`、`Instrumental`、`导演剪辑版` | `isrc`、`duration`、`language`、`events`、`tags`（必填结构 `work_id`，可选 `content_unit_id`） |
| `release` | 正交枚举：`edition_type`、`edition_batch`、`distribution_channel`、`packaging` + `publisher`（`entity -> agent`） | 见下表 `release` 四维词项表 | `catalog_number`、`barcode`、`isbn`、`edition_date`、`country`、`platform`、`attachments`、`store_bonuses`、`events`、`tags`；结构字段 `Release.subjects[]`（`role` 取 `release_role`） |
| `medium` | `attributes.format`（enum `format`）+ `attributes.role`（enum `role`） | `format`：`cd`（CD）、`bd`（蓝光）、`uhd_bd`（超高清蓝光）、`dvd`（DVD）、`vinyl`（黑胶）、`sacd`（SACD）、`cassette`（磁带）、`paper`（纸质册）、`digital`（数字文件集）、`web`（网络配信） | `catalog_number`、`tags`（必填结构 `release_id`，可选 `parent_id`） |
| `track` | `attributes.role`（enum `role`） | 同下方 `role` 词表 | `duration`、`tags`；结构字段 `Track.contents[]`（必填结构 `medium_id`，可选 `parent_id`） |

### `work` 创作形态词表（`creation_form`）与边界

| 领域 | 标准词项 `code` 与中文说明 |
| --- | --- |
| 音乐 | `song`（歌曲 — 单首乐曲作品）、`single`（单曲）、`ep`（迷你专辑 / EP）、`original_album`（原创专辑）、`doujin_album`（同人专辑）、`soundtrack`（原声集）、`compilation_album`（精选集 / 合辑） |
| 动画 | `tv_anime`（TV动画）、`theater_anime`（剧场动画）、`ova`（OVA）、`ona`（Web动画） |
| 图书 / 画集 | `manga_serialized`（连载漫画）、`manga_volume`（漫画单行本）、`light_novel`（轻小说）、`novel_general`（一般小说）、`artbook`（画集 / 设定集）、`photobook`（写真集） |
| 游戏 | `visual_novel`（视觉小说）、`eroge`（美少女游戏）、`indie_game`（独立游戏）、`commercial_game`（商业游戏） |
| 音声 | `audio_drama`（音声作品）、`radio_drama`（广播剧） |
| 影视 / 视频 / 其他 | `film`（电影）、`tv_drama`（电视剧）、`music_video`（音乐视频）、`personal`（个人创作） |
| 宽泛兜底码 | `music`（音乐）、`literature`（文学）、`screen`（影视）、`photography`（写真）、`game`（游戏） |

- **`song` 与专辑/单曲 `Work` 严格区分**：单首乐曲建 `work` 一律填 `creation_form: "song"`，仅作为专辑/单曲中的曲目被收录时**绝不填** `original_album` 或 `single`。有独立企划/汇编创作身份的单曲、EP、专辑另建 `work` 并填 `single` / `ep` / `original_album` / `doujin_album` / `soundtrack` / `compilation_album`，通过 `includes` 关系包含各首 `song` `work`；同名主打歌（`song`）与同名标题单曲/专辑（`single` / `original_album`）是两个独立 `work`。
- 优先使用具体细化码，仅当来源无法区分细化形态时使用宽泛兜底码（`music` / `literature` / `screen` / `photography` / `game`）。

### `release` 正交枚举维度与发行方

| 字段码 | 类型 / 词表 | 标准词项 `code` 与中文说明 |
| --- | --- | --- |
| `edition_type` | enum `edition_type` | `standard`（普通版）、`limited`（限定版）、`deluxe`（豪华版）、`boxset`（套盒） |
| `edition_batch` | enum `edition_batch` | `regular`（通常发行）、`first_press`（初回发行）、`reissue`（再版 / 重发）、`reprint`（重印） |
| `distribution_channel` | enum `distribution_channel` | `mixed`（混合）、`physical`（实体）、`digital`（数字）、`web`（网络配信） |
| `packaging` | enum `packaging` | `standard`（标准包装）、`jewel`（Jewel Case）、`slipcase`（腰封 / 外封套）、`box`（盒装）、`boxset`（套盒）、`digipak`（Digipak） |
| `publisher` | `entity -> agent` | 指向出版商 / 唱片厂牌 `agent` 实体 UUID（禁止写字符串） |

四个枚举维度正交并存（例如日本初回限定实体 Digipak 盘可同时填 `edition_type="limited"`、`edition_batch="first_press"`、`distribution_channel="physical"`、`packaging="digipak"`、`country="JP"`）。

## 用途、番位、图片词表与 `credit_role`

| 词表 / 字段 | 适用位置 | 标准词项 `code` 与说明 |
| --- | --- | --- |
| `release_role` | `Release.subjects[].role` | `primary`（主作品）、`track_work`（曲目作品）、`compilation`（汇编作品）、`supplement`（附加作品） |
| `role` | `Medium.attributes.role`、`Track.attributes.role`、关系属性 `role` | `primary`（主要内容）、`supplement`（附加内容，标记为特典）、`side`（唱片面）、`extra`（额外收录）、`commentary`（解说音轨） |
| `character_rank` | 关系属性 `character_rank`（主要用于 `character_in`） | `main`（主角）、`supporting`（配角）、`guest`（客串 / 单集登场）、`ensemble`（群像）、`narrator`（旁白）、`cameo`（彩蛋登场） |
| `picture_role` | `Entity.pictures[].role`（`pictures[0]` 恒为主封面，不随 `role` 重排） | `key_visual`（主视觉）、`cover_art`（封面图）、`back_cover`（封底）、`booklet`（手册内页）、`disc_art`（盘面 / 载体图）、`obi`（侧标 / 腰封）、`packaging`（包装实拍）、`poster`（海报）、`character_portrait`（角色立绘）、`person_portrait`（人物肖像）、`logo`（标识）、`scene_still`（剧照 / 场景图）、`event_photo`（活动现场）、`scan`（内页扫描）、`screenshot`（界面截图） |
| `credit_role` | 关系属性 `credit_role`（自由文本 `text`） | 保存来源中的原始职衔文本（如 `アニメーション制作`、`シリーズ構成`、`Vo. & Gt.`），仅作修饰说明，**绝不替代专用语义关系码** |

## 结构化字段的形状

### `attachments` / `store_bonuses` / `events`（list，元素是同一个记录组）

以下是默认记录形状；实例可能扩展子字段，写入前核当前 definitions：

| 子字段 | 类型 | 说明 |
| --- | --- | --- |
| `label` | multilingual | **必填**，形如 `{"zh-CN":"初回特典 BD","ja":"初回特典 Blu-ray"}` |
| `content` | entity | 指向被附带的内容：`work` / `expression` / `content_unit` / `release` / `medium` |
| `store` | entity | 指向店铺/渠道主体（`agent`） |
| `amount` / `currency` | number / text | 金额与币种 |
| `quantity` | number | 数量 |
| `channel` | text | 渠道/平台原文 |
| `condition` | text | 批次、抽选规则或获取条件 |
| `date` | date | 相关日期 |
| `image` / `source_url` | url | 图片与来源链接（绝对 HTTP(S)） |
| `region` | text | 地区 |
| `time_zone` | text | 时区 |

真实例（初回限定同梱 BD + Amazon 店特）：

    "attachments": [
      {"label": {"zh-CN": "初回限定同梱 BD", "ja": "初回限定同梱 Blu-ray"},
       "content": "<medium-uuid>", "quantity": 1},
      {"label": {"zh-CN": "Amazon 特典挂画", "ja": "Amazon 特典タペストリー"},
       "store": "<amazon-agent-uuid>", "channel": "Amazon.co.jp", "condition": "先着"}
    ]

按语义选字段：`attachments` = 包装内同梱物；`store_bonuses` = 按渠道分发的店特；
`events` = 发布/放送事件。三者都能出现在 `release`（默认 `events` 也适用于 expression/work，实际取 applicable_kinds）。

### `infobox`

`[{"key": "...", "value": "..."}]`，`key` 与 `value` **都必填**（text）。隐藏字段，只放机器/存档用途的信息，
不当作用户可见正文。

### `tags`

`tags` 是八种 `kind` 共通的**纯字符串数组**（如 `["青春","乐队"]`），不是受控业务分类，不能代替 `creation_form`、`collection_type`、`agent_type`、`edition_type`、`edition_batch`、`attachments` 或 `store_bonuses`，也不能单独证明实体身份。音乐建议词（如 `pop`、`j_pop`、`jazz`、`hip_hop`、`electronic`、`alternative`、`rnb`、`children_music`、`spoken_word`、`asmr`）仅为建议而非白名单；按来源实际题材录入，不凭常识或题名补造。`GET /api/catalog/tags` 为只读频次聚合。

### 主体日期与履历边界

`agent` 日期默认须含年份；仅字段声明 `allow_yearless: true` 时支持无年份格式 `--MM-DD`（默认种子中 `birth_date` 已启用，常用于角色生日）。`occupations` 与 `activity_periods` 描述主体自身职业与活动期；主体在具体作品或发行中的职责必须走语义关系（见[关系](relations.md)），团体成员在籍期走 `member_of` 的 `begin_date`/`end_date`。

### `locator`

| 子字段 | 类型 | 语义 |
| --- | --- | --- |
| `relative_to` | enum `locator_reference` | **锚点**：`medium`（整张载体）/ `track`（整条音轨），只有这两个取值 |
| `page_start`、`page_end`、`path`、`chapter` | number / text | `locating`：**本版定位**，随排版/封装变化 |
| `time_start_ms`、`time_end_ms` | number | `content`：**实际内容范围**，参与版本对比 |

- **有任一子字段就必须给 `relative_to`**，否则 `locator: anchor_required: relative_to`；整轨/整篇收录允许 `locator` 为空。
- 显式配对的区间（`page_end` ↔ `page_start`、`time_end_ms` ↔ `time_start_ms`）**只在两端都有值**时校验大小；
  终点单独存在不会被拒。
- 未知子键 → `locator: unknown_field: <键>`。
- 黑胶的 A/B 面位：默认未提供面位字段，可用 `track.number` 写 `"A1"`（`number` 是字符串，保留官方原文）；
  是否存在可用的面位 scheme 取实例当前 definitions，不从旧快照推断。
- `time_*` 与 `page_*` 语义不同：同一 Expression 在不同版本换页码时，对比口径看 `time_*`。

### `inclusion_attributes` / `subject_attributes`

**种子是空组**：未扩展时组内没有任何子字段，`contents[].attributes`（收录附加属性）与 `subjects[].attributes`
（发行对象附加属性）写任何键都是 `unknown_field`，检索路径 `inclusion_attributes.x` / `subject_attributes.x`
同样不可用。收录语境属性可按授权在 GUI 为这些组新增子字段；可选来源位于 contents[].sources 独立键，不能塞进 attributes 或 locator。作品/表达自身事实和关系仍按各自身份填写，缺少落点时见[模型缺口](model-gaps.md)。

## `entry_role` 与 `air_date`

- `content_unit` 可写 `language`、`entry_role`、`air_date`（**没有 `duration`**）。
- `entry_role` 取 `main` / `opening` / `ending` / `trailer` / `extra` / `other`；
  **集数编号在各 `entry_role` 内各自起算**（本篇 1..N，OP/ED 各自从 1 起），不要把 OP 编成"第 13 话"。
- `air_date` 是**篇目级放送/发布日**（逐话首播）；作品级开播日走 work 的 `broadcast_start` / `broadcast_end`。

## `external_links`

`external_links` 是对象数组 `[{kind, url, external_id?, role?}]`（不再使用旧版键值对象 `external_ids`）：

- `kind`：必填，取自 `GET /api/catalog/external-databases` 当前启用预设的 `code`（外部库可由后台扩展，不假设固定清单）。未知平台码报 `invalid_external_key: <码>`；预设 `category` 不为 `all` 且与实体 `kind` 不符时报 `invalid_external_category: <码>`（例如 `steam` 仅限 `work`，写到 `release` 会被拒）。
- `url`：必填，须为绝对 HTTP(S) URL；无网页地址的纯编号（如 ISBN、ISRC、JAN/EAN）使用 `mf://external/<kind>/<经过路径编码的external_id>`，同时填写 `external_id`。空值、非法地址或同一实体内重复 `kind + url` 报 `invalid_external_link` / `duplicate_external_link`。
- `external_id`：可选，填写时按预设 `validation_regex` 校验（如 `musicbrainz` 36 位 UUID、`bangumi` 纯数字、`isrc` 12 位码），不匹配报 `invalid_external_id: <码>`。`official_website` / `publisher_website` 直接校验完整 HTTP(S) `url`。
- `role`：可选，允许 `official` / `primary` / `secondary` / `operator`（非法值报 `invalid_external_link_role`）。界面「官方」徽标仅由 `role="official"` 决定，不按平台码自动推断。

核实到作品、发行或主体的官方网站后，应写入 `external_links`（如 `{"kind":"official_website","url":"https://...","role":"official"}`），不要只留在修订说明或图片/收录 `sources` 中，否则详情页外部链接区不会展示官网入口。

搜索结果仅覆盖当前调用者可见实体；entity 引用还受目标状态、kind 和公开实体引用约束影响，搜索命中不保证引用可写。

## 写错时的错误码

| 现象 | 错误码 | 改法 |
| --- | --- | --- |
| 字段不适用于本 kind | `unknown_field: <码>` | 检查 `document.fields[码].applicable_kinds` 与当前实体 kind，不通过选择模板扩大白名单 |
| 枚举值不在词表 | `invalid_term`（可能带字段前缀） | 用词项代码，不提交显示名 |
| 组字段写了未声明的子键 | `unknown_field: <键>`（可能带前缀如 `locator: `） | 只写当前定义声明且启用的子字段 |
| `locator` 有子字段无锚点 | `anchor_required: relative_to` | 补 `relative_to` |
| 外链平台码、分类或格式错误 | `invalid_external_key: <码>` / `invalid_external_category: <码>` / `invalid_external_link` / `invalid_external_id: <码>` | 先读 `/api/catalog/external-databases` 核启用平台码、适用 category 与正则，`url` 填绝对 HTTP(S) 或 `mf://external/<kind>/<id>` |
| 翻译形状/长度不对 | `invalid_translation` / `invalid_locale` / `translation_too_long` | locale 必须是合法语言标签，`title` 非空且 ≤2000，`nonofficial` 仅非原始语种允许为 true，`aliases` 与 `nonofficial_aliases` 单项 ≤500 |

完整错误码表见 [API 错误码与修复动作](api-errors.md)。
