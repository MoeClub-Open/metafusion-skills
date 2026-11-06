# 字段适用层级、白名单与结构化字段（面向 Agent）

实体可写属性按当前生效 definitions 的字段适用层级判断。当前实体与定义均无业务分类 `types`；旧 `document.types`、实体 `types` 和基于它们的字段并集不适用。

## 唯一规则：字段自身的 `applicable_kinds` 决定适用层级

先读 `GET /api/catalog/definitions`，取 `document.fields` 中 `applicable_kinds` 包含实体 kind 的字段码。字段值按该字段的 `type`、词表、引用范围、启用状态及子组约束校验；字段的值类型不是实体业务分类。没有适用层级的字段不能直接写到 Entity.attributes，可能专供关系或内嵌组使用。

    {
      "entity": {
        "kind": "release",
        "attributes": {"catalog_number": "VWBS-1531"}
      }
    }

上述仅演示属性落点，完整创建信封与必填值见 [载荷模板](api-templates.md)。不要向当前请求添加已移除的 `types`；正式用途、媒介属性和身份依实际字段、收录与来源表达，标签不承担业务分类约束。新版可选 creation_form 仅作为 Work 的受控描述与模板条件，词项和模板可通过 GUI 编辑。

## 实体字段与动态属性

title、original_language、translations、attributes、external_links、pictures、position、number 是共用实体字段；归属与结构引用按 kind 校验，见 [载荷模板](api-templates.md)。state、review_status、created_by、updated_at、redirect_id 以及发行版（`kind=release`）读取时按活动子载体聚合的 `medium_formats`（`Record<string, number>`，写入副本时自动剥离）都是只读投影。attributes 不维护固定种子白名单：取当前启用字段的 applicable_kinds，不能靠选择模板扩大范围。

两个易错点：

- 默认种子中 `duration_source` 是 entity 字段且指向 expression，`publisher` 是 entity 字段且指向 agent；当前目标 kind 范围仍取 definitions
  （不能指向 release 自己的文本名）。entity 字段要求目标实体**存在、kind 相符、对当前用户可见且未 deleted/merged**。
- `tags` 是八种实体共通的自由标签，不是受控业务分类，也不能单独证明实体身份。版本类别、发行批次、同梱物和店铺特典仍优先写到 `edition_type` / `edition_batch` / `attachments` / `store_bonuses`；标签不能代替这些结构化事实。

## 词表与模板

枚举字段引用 `document.vocabularies`，写当前启用词项 code，不能提交本地化 names。字段必须启用且适用于当前 kind；词表可扩展，不把静态码表当作实例能力。非法词项返回 `invalid_term`，消息可能含字段前缀。

新版 `creation_form` 词项来自现有创作模板码及 song；不在本页复制清单，实际以实例启用词项为准。creation_form 可省略，不证明身份或限制其他字段可写性。
模板自动选择只按显式 `match` 与 `priority`，并列时回到通用事实布局；缺少 match 的模板仅供手工选择，不按已填字段猜类别。显式 `match: []` 表示该 kind 的兜底条件。
`country`、`platform`、`version_label`、`credit_role`、`scope`、`magazine` 是**自由文本**，不要当枚举填代码。

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

`tags` 的音乐建议词包括 `pop`、`j_pop`、`jazz`、`hip_hop`、`electronic`、`alternative`、`rnb`、`children_music`、`spoken_word`、`asmr` 等，以实例 definitions 为准。这些是建议词，不是白名单；来源给出的实际题材可以用自由标签保留，不能因词表缺项就退化为只写 album，也不能根据常识或题名补造题材。

**纯字符串数组**（不是对象、不是词项码）：`["动画","剧场版"]`。当前种子允许八种 kind 写该字段。
`GET /api/catalog/tags` 是对它的频次聚合，不是可写的字典表。

### 主体常用属性

主体（`agent`）支持受控词表字段 `agent_type`（词项：`person` 个人、`group` 团体/组合、`organization` 机构/公司、`character` 虚构角色，驱动 `agent_person` / `agent_group` / `agent_organization` / `agent_character` 细分模板与列表分面）以及 `birth_date`、`death_date`、`formation_date`、`dissolution_date`、`occupations`（字符串数组）与 `activity_periods`（`[{begin?,end?}]`），实际可写范围以当前 definitions 为准。日期默认含年份；只有字段声明 `allow_yearless:true` 时可用 `--MM-DD`（默认种子的 `birth_date` 已启用）。职业与活动期描述主体自身，在具体作品中的职责仍走语义关系，不能互相替代。新增字段与词项须由实例内容 seed 或管理操作发布后才能使用。

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
