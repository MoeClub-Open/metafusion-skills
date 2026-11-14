# 语义关系码表、方向与消歧规则

语义关系以目标实例 `GET /api/catalog/definitions` 的 `document.relations` 为运行时权威定义，支持管理员通过后台 GUI 或实例 seed 扩展关系码、允许端点与属性。方向一律固定为 `source -> target`（载荷 `source_id` 在左、`target_id` 在右）；同 `kind` 端点写反方向仍可能通过结构校验但语义相反，写入前必须核对方向。以下完整列出 32 条标准种子语义关系基线。

## 32 条标准语义关系基线

### 署名组 `credits`（17 条，`counts_as_credit=true`）

除 `character_in` 的 `participant_slot="character"` 外，其余 16 条均为 `participant_slot="person"`，默认 `acyclic=false`，均允许全部 9 个标准关系属性字段。

| 关系 `code` | 正向 ↔ 反向名称 | `source_kinds -> target_kinds` | 适用边界与填写规则 |
| --- | --- | --- | --- |
| `created_by` | 原作 / 作者 ↔ 原作 / 著作 | `work`\|`content_unit`\|`expression`\|`release` -> `agent` | **严格仅限原作者、原案、著作人**；严禁用于动画制作公司、制作委员会、同人社团、游戏厂商或唱片厂牌 |
| `produced_by` | 制作 / 出品 ↔ 制作了 | `work`\|`content_unit`\|`expression`\|`release` -> `agent` | 动画制作公司（`アニメーション制作`）、出品/制作委员会、制片人（`プロデューサー`）、音乐制作人、同人社团（`サークル`）、游戏品牌/厂商（`メーカー`）；具体原始职衔写 `credit_role`。发行版的出版/发行商优先写 `Release.attributes.publisher` |
| `directed_by` | 导演 ↔ 执导了 | `work`\|`content_unit`\|`expression` -> `agent` | 总导演、导演/监督、系列导演；单集演出无专用码时走 `credit_for` |
| `written_by` | 编剧 ↔ 编写了 | `work`\|`content_unit`\|`expression` -> `agent` | 系列构成、脚本、剧本 |
| `composed_by` | 作曲者 ↔ 作曲了 | `work`\|`content_unit`\|`expression` -> `agent` | 歌曲作曲、剧伴音乐作曲 |
| `lyricist_of` | 作词者 ↔ 作词了 | `work`\|`content_unit`\|`expression` -> `agent` | 作词 |
| `arranged_by` | 编曲者 ↔ 编曲了 | `work`\|`content_unit`\|`expression` -> `agent` | 编曲；通常挂对应录音 `expression`，仅作品级来源明确不分版本时挂 `work` |
| `performed_by` | 表演者 ↔ 表演了 | `work`\|`content_unit`\|`expression`\|`release` -> `agent` | 演唱、演奏、乐队/组合表演；团体成员归属另建 `member_of`（担当乐器/声部写 `credit_role`） |
| `voiced_by` | 配音者 ↔ 配音于 | `work`\|`content_unit`\|`expression`\|`release`\|`agent` -> `agent` | 声优/配音；在作品/表达上带 `attributes.character` 与 `language`，也可在角色 `agent -> cv agent` 上记录固定声优 |
| `character_in` | 角色登场 ↔ 登场角色 | `agent` -> `work`\|`collection` | `participant_slot=character`；虚构角色登场，番位填枚举 `character_rank`（不借 `credit_role` 写番位） |
| `illustrated_by` | 插画者 ↔ 绘制了 | `work`\|`content_unit`\|`expression`\|`release` -> `agent` | 小说插画、角色原案、封面绘制、原画设计 |
| `developed_by` | 开发者 ↔ 开发了 | `work`\|`content_unit`\|`expression`\|`release` -> `agent` | 游戏/软件开发团队或程序开发 |
| `photographed_by` | 摄影者 ↔ 拍摄了 | `work`\|`content_unit`\|`expression`\|`release` -> `agent` | 写真摄影、影像摄影监督 |
| `modeled_by` | 出镜者 ↔ 出镜于 | `work`\|`content_unit`\|`expression`\|`release` -> `agent` | 写真模特、真人出镜演员 |
| `narrated_by` | 朗读 / 旁白 ↔ 朗读了 | `work`\|`content_unit`\|`expression`\|`release` -> `agent` | 有声书朗读、旁白 |
| `translated_by` | 译者 ↔ 翻译了 | `work`\|`content_unit`\|`expression`\|`release` -> `agent` | 文本或字幕翻译 |
| `credit_for` | 参与主体 ↔ 参与记录 | `work`\|`content_unit`\|`expression`\|`release` -> `agent` | **兜底署名**：仅当以上 16 条专用署名均不适用时使用（如音响监督、美术监督、色彩设计、剪辑、分镜、单集演出、录音/混音工程等），必须填 `credit_role` 原文；**严禁与专用关系对同一职责重复建边** |

### 创作关系组 `creative`（9 条，`acyclic=true`，`participant_slot=peer`）

| 关系 `code` | 正向 ↔ 反向名称 | `source_kinds -> target_kinds` | 方向与语义说明 |
| --- | --- | --- | --- |
| `adaptation_of` | 改编自 ↔ 被改编为 | `work` -> `work` | 改编作品（如 TV 动画）→ 原作作品（如漫画/轻小说/游戏） |
| `sequel_of` | 续作于 ↔ 作为前作 | `work` -> `work` | 续作（如第 2 季）→ 前作（如第 1 季） |
| `spin_off_of` | 外传自 ↔ 衍生出 | `work` -> `work` | 外传 / 衍生作品 → 本篇 / 母作品 |
| `soundtrack_of` | 配乐用于 ↔ 配乐作品 | `work` -> `work` | 原声集 Work（`soundtrack`）→ 被配乐的动画 / 游戏 / 影视 Work |
| `translation_of` | 翻译自 ↔ 被翻译为 | `expression` -> `expression` | 译本表达 → 原文表达 |
| `revision_of` | 修订自 ↔ 被修订为 | `expression` -> `expression` | 修订版表达 → 旧版表达 |
| `cover_of` | 翻唱自 ↔ 被翻唱为 | `expression` -> `expression` | 翻唱 / 重编版本表达 → 原版表达 |
| `alternate_take_of` | 别版取自 ↔ 被用作别版 | `expression` -> `expression` | 别版 / 异录表达 → 基准表达 |
| `pressing_of` | 再版自 ↔ 被再版为 | `release` -> `release` | 再版 / 复刻发行 → 初版 / 原发行（不表示内容收录） |

### 组成与成员组 `membership`（6 条）

| 关系 `code` | 正向 ↔ 反向名称 | `source_kinds -> target_kinds` | 附加约束 | 适用说明 |
| --- | --- | --- | --- | --- |
| `includes` | 组成包含 ↔ 组成属于 | `collection`\|`work` -> `work`\|`collection` | `aggregate=true`, `acyclic=true`, `participant_slot=peer` | 跨媒体企划/作品系列 `collection` 收录各季动画、剧场版、游戏、漫画、音乐作品，或专辑/单曲 `work` 包含曲目 `song` `work` |
| `member_of` | 所属团体 ↔ 成员 | `agent` -> `agent` | `acyclic=true`, `participant_slot=peer` | 个人成员 → 乐队 / 组合 / 社团；担当声部/乐器（如 `Vo. & Gt.`）写 `credit_role`，在籍期写 `begin_date`/`end_date` |
| `expression_part` | 表达包含 ↔ 所属整体表达 | `expression` -> `expression` | `usage=expression_composition`, `scope=work`, `aggregate=true`, `unique_position=true`, `acyclic=true`, `cycle_group=expression_composition`, `fields=[]`, `participant_slot=peer` | 同 `work` 内整体表达有序包含部分表达 |
| `edition_of` | 发行组归属 ↔ 发行版本 | `release` -> `work`\|`collection` | `usage=release_group`, `max_outgoing=1`, `fields=[]`, `participant_slot=peer` | 显式声明发行版所属版本组 |
| `bonus_included_in` | 特典收录于 ↔ 收录特典 | `expression` -> `release`\|`medium` | `acyclic=true`, `participant_slot=peer` | 特典表达归属对应发行或载体 |
| `store_bonus_for` | 渠道特典归属 ↔ 拥有渠道特典 | `expression`\|`release` -> `agent` | `participant_slot=person`, `acyclic=true` | 目标为店铺 / 渠道 `agent`，不是 `release` |

## 署名与组成消歧规则

- **`created_by` / `produced_by` / 专用码 / `credit_for` 边界**：原作者/原案用 `created_by`；动画制作公司、出品委员会、制片人、音乐制作人、同人社团、游戏厂商一律用 `produced_by` 并把原始职衔填入 `credit_role`；发行商写 `Release.attributes.publisher`。已有 16 条专用署名码覆盖的职责严禁降级为 `credit_for`，也严禁同一职责同时建专用边与 `credit_for`。
- **一行多职拆分**：来源将多个职衔合并在同一行（如「監督・シリーズ構成・脚本 某人」）时，按各自语义拆成多条对应关系（`directed_by` 填 `監督`，`written_by` 填 `シリーズ構成・脚本`），不得将整串合并职衔原样贴到多条边上。
- **歌曲署名与乐队成员**：词曲（`lyricist_of`、`composed_by`）通常落歌曲 `work`（`creation_form="song"`）；具体录音版本的编曲（`arranged_by`）、演唱/演奏（`performed_by`）及录音/混音工程（`credit_for` + `credit_role`）落对应 `expression`（并按需带 `context`），不把单版署名泛化到整首 Work。团体表演挂团体 `agent`，已知成员组成用 `member_of` 连接个人与团体。
- **企划与专辑组成**：跨媒体企划（`collection_type="franchise"`）和系列（`series`）用 `includes` 聚合动画、剧场版、游戏、漫画、小说、音乐企划 `work`；专辑/单曲 `work` 用 `includes` 包含各首 `song` `work`。实际盘面曲序收录走 `Release.subjects` + `Medium` + `Track.contents`，不拿 `includes` 或 `pressing_of` 替代载体收录。
- 默认端点若未覆盖某盘/某轨/某篇目的特定署名，按[定义扩展](model-gaps.md)判断准确落点，不得为挂署名凭空复制 `Expression` 或错挂到 `Work`。

## 关系属性字段

目标实例可在定义 GUI 中调整关系允许的字段；写入前以当前生效定义的 `document.relations[code].fields` 与 `document.fields` 为准。

| 字段 | 类型 | 用法 |
| --- | --- | --- |
| `role` | enum `role` | `primary` / `side` / `extra` / `supplement` / `commentary` |
| `credit_role` | text | **职位原文**（"音楽""Animation Production"…），任意署名关系的自由文本落点 |
| `character_rank` | enum `character_rank` | `main` / `supporting` / `guest` / `ensemble` / `narrator` / `cameo` |
| `character` | entity → **`agent`** | 配音/出演的角色（角色本身也是 agent） |
| `context` | entity → `work`\|`content_unit`\|`expression`\|`release` | 该署名适用于哪部作品/哪个篇目 |
| `language` | text | 该署名对应的语言版本（`ja` / `zh-CN`…） |
| `begin_date` / `end_date` | date | 这条关系成立的任期或期间 |
| `scope` | text | 适用范围说明的自由文本 |

惯例两例：

    // 声优：同时给出角色与语言版本
    {"type": "voiced_by", "source_id": "<work-or-expression>", "target_id": "<cv-agent>",
     "attributes": {"character": "<character-agent>", "language": "ja"}}

    // 登场角色的番位
    {"type": "character_in", "source_id": "<character-agent>", "target_id": "<work>",
     "attributes": {"character_rank": "main"}}

属性键不在目标关系允许的 fields 内 → `unknown_field`；枚举值不在词表内 → `invalid_term`。上表为通用种子字段，新关系不保证允许全部字段。
Agent 自身可写字段以 applicable_kinds 为准；缺少主体生卒/设定时按授权扩展，不写成关系有效期或借 context 近似。

## 判重、作用域、成环与用途

1. `symmetric` 控制反向判重；种子关系为非对称。单条事实已有正反显示名，不能为反向展示再建一条边；独立反向事实也须满足无环等其他规则。
2. 普通关系按类型、端点、attributes 判重，position 不参与身份；只改 position 仍是 duplicate_relation。多角色署名用不同 character/credit_role 区分。expression_composition 另要求同一整体不能重复部分，即使换码或属性也不行。
3. `acyclic` 默认检查单码边集；声明相同非空 `cycle_group` 后，多码存活边共同检查环。未声明共同组的跨码路径不自动校验；保存、定义影响检查与合并回放使用同一规则。
4. `scope` 是同域约束：work（Work/ContentUnit/Expression）、release（Release/Medium/Track）、medium（Medium/Track）。Release.subjects 不是单值归属，不能用于推导共同 Work。不要与自由文本属性 attributes.scope 混淆。
5. `reference_scopes` 约束允许的 entity 属性，如 {"context":"source_work"}；被引用对象必须与 source 同 Work。字段目标 kind 与指定端点都需支持该域，否则定义无效。
6. `unique_position` 要求同源关系顺序唯一；expression_composition 在全部同用途码中共用顺序。release_group 的 max_outgoing=1 同样跨同用途码共同执行。其他基数按当前关系定义判断，不能假定所有关系无限制。

expression_composition 必须是 expression→expression、scope=work、acyclic=true、cycle_group=expression_composition、aggregate=true、unique_position=true、symmetric=false；release_group 必须是 release→work/collection、max_outgoing=1、symmetric=false。管理员可在 GUI 选择用途自动填入必要规则，再做影响检查。关系码与名称可扩展，用途执行语义仍受服务端支持范围限制。

## 写入与证据

创建/更新/删除通过副本暂存，见[协作载荷](api-templates.md#协作载荷)。统一 `/entities/{id}/links` 中，`relation:*` 的 key 是关系 ID、version 是当前版本；字段引用仍修改其所属实体，不重复建边。

按[来源说明](source-policy.md)记录关系的实际依据。引用目标按当前 API 核对 kind、可见性和生命周期；条目没有草稿状态，尚未合入的创建只存在于其工作副本。

拒绝码与修复动作见 [API 错误码](api-errors.md)。
