# 关系码、方向与属性（面向 Agent）

从目标实例 `GET /api/catalog/definitions` 的 `document.relations` 选择启用码；新增用途同时核 OpenAPI 与当前定义。ETag 用于防止保存覆盖，不是可读取的历史版本。

方向一律写作 `source → target`：载荷里的 `source_id` 在左、`target_id` 在右。
同 kind 端点方向写反可能仍被接受，但含义会改变；方向必须与来源核对，合法载荷不证明语义正确。

## 选择关系

不复制全量种子码表。按当前 `document.relations[code]` 核 `enabled`、`source_kinds/target_kinds`、`fields`、`usage` 与约束；动态扩展会改变可用端点，不能把种子未列出的 Track/Medium/ContentUnit 端点视为平台禁令。

常见语义误用：

- `soundtrack_of` 默认是 OST Work → 被配乐的 Work；`cover_of`/`translation_of` 默认连接 Expression。按来源与当前定义核方向，不以同名判断。
- 作词、作曲通常归歌曲 Work；某次录音的编曲、制作、录音及混音按来源归对应 Expression，并保留必要的发行 `context`。共同署名逐人建边；有准确关系时优先使用，通用参与关系保留 `credit_role` 职位原文，不能把只在某版注明的署名泛化到全部版本。
- `pressing_of` 表示再版自，不表示收录；Track 收录用 contents，Release 声明 Work 用 subjects。
- `store_bonus_for` 默认目标为店铺 Agent，不是发行；`credit_role` 表示署名职位，不能替代结构归属。
- 默认关系若不能表达某轨编曲者、某盘指挥或篇目改编，按 [定义扩展](model-gaps.md) 判断准确落点；不能为挂署名复制 Expression，或改挂 Work。

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
| `begin_date` / `end_date` | date | 任期/期间（"某人在某团体期间"只能落在这里） |
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

创建/更新/删除信封统一见 [关系载荷](api-templates.md#关系)，不在本页重复。关系当前版本从 `GET /api/catalog/entities/{id}/relations` 返回项取，写后回读集合；删除同样需要 expected_version/edit_note/sources。

关系接受证据不自动满足 CORE-P1。普通辅助关系可用 P2；用于作者、改编、系列归属或唯一身份锚点时，边与两端须按 [来源策略](source-policy.md) 核核心证据。引用要求目标存在、kind 相符、可见且未 deleted/merged；公开条目不可引用 draft。

拒绝码与修复动作见 [API 错误码](api-errors.md)。
