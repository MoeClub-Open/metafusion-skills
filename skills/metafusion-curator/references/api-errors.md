# API 错误码与修复动作（面向 Agent）

写库被拒时响应体形如 `{"error":"<code>"}`。**很多码带前缀或补充信息**，实测形态有：

    {"error":"unknown_field: duration_seconds"}
    {"error":"unknown_field: not_a_field"}
    {"error":"invalid_structural_field: work_id"}
    {"error":"invalid_payload: work.title"}
    {"error":"locator: invalid_term"}
    {"error":"locator: unknown_field: bogus_key"}
    {"error":"locator: anchor_required: relative_to"}
    {"error":"packaging: invalid_term"}
    {"error":"not_supported: media_type_hint"}
    {"error":"four_locale_names_required: ja"}

按 `error == "码"` 做精确匹配的脚本会漏判，请用**前缀匹配**（`error.startsWith("unknown_field")` 这类）。
下表取自真实实例的实测结果；与本文不符时以实例响应为准。

## 证据与载荷

| 错误码 | 含义 | 修复动作 |
| --- | --- | --- |
| `evidence_required` | 缺 `edit_note`，或 `sources` 为空 | 补具体修改说明 + 至少一条来源；这只是载荷门，仍须按[字段级来源策略](source-policy.md)逐字段核验 P1 |
| `source_refs_required` | 某个操作缺或空 `source_refs`（响应常带 `applied:false` 与 `operation` 索引） | 给该操作补 `source_refs:[{source:<sources[].key>, pointers?:[...]}]`；无兼容模式，旧格式会被拒绝 |
| `source_key_required` / `invalid_source_key` / `duplicate_source_key` | 来源池缺 key、key 不合规或重复 | 每条 source 给唯一 `key`（`^[A-Za-z][A-Za-z0-9_-]{0,63}$`） |
| `source_unused` / `unknown_source_ref` / `duplicate_source_ref` | 池中有未被引用的来源，或操作引用了不存在/重复的 key | 每个 key 至少被一个操作引用一次；删掉多余来源或补引用 |
| `invalid_source_pointer` / `source_pointer_not_in_document` / `source_pointer_not_patched` | 指针非法，或不在 create document / update patch 覆盖范围内 | 指针用 JSON Pointer（以 `/` 开头）；create 必须能在 document 里解析，update 必须覆盖某条 patch 路径 |
| `commit_conflict` | 同字段产生不同并发改动，整批回滚 | 保留提交，核证据后明确 ours/theirs 并 rebase |
| `transaction_busy`（503） | 数据库已回滚本次请求，有界尝试耗尽；提交响应带 `applied=false` | 尊重 Retry-After，稍后显式 push 同 ID、同载荷；此前未知的推送仍须查回执，不能被本次失败覆盖 |
| `definitions_conflict` | 定义基线变化 | 核当前动态约束再 rebase |
| `identity_candidates_changed` | 可见身份候选与审查列表不同 | 核新候选身份，复用或有证据地更新审查，不能机械全选 |
| `identity_candidates_incomplete` / `identity_candidate_unresolved` | 无完整候选集合 | 收窄或核未解析身份，停止依赖创建 |
| `invalid_source` | 来源格式不对 | `kind` 只能是 `url`/`publication`/`self`；`citation` 必填并列出支持字段；带 `url` 时必须为合法 HTTP(S) 且不含用户信息。`self` 不能支撑字段事实 |
| `invalid_payload` | 载荷形状不对（含未知顶层字段）；消息可能指明位置（`invalid_payload: work.title`） | 严格按当前 DTO 写：发行版名用 `title`、时长用 `duration`、证据用 `sources` 对象数组；未知键一律删掉再试 |
| `id_must_be_empty` | 创建时带了 `entity.id` | 创建一律留空 id、`expected_version` 传 0 |
| `invalid_entity` | kind 不在八类现行值里（如 `artist` 会走到这里）；`title` 缺失/超长 | kind 只用现行八类；`title` 任何 kind 都必填（trim 非空、≤2000） |
| `invalid_entity_type` | importer 的 `entity_type` 不在支持范围 | 当前接受 work/artist/organization/character；release 不是此参数值。显式来源 URL 可决定实际返回类型，回读确认 |
| `not_supported: <开关>` | 该导入开关/来源不支持（如 `media_type_hint`） | 去掉该开关或换来源 |
| `invalid_picture` | 图片形状不对（相对路径、缺 source…） | `pictures[].url` 必须绝对 HTTP(S)；`source` 满足证据规则 |
| `invalid_picture_time` | 图片的可选时间字段不合法 | 去掉或修正 `taken_at` |
| `invalid_picture_period` | `usage_period` 两端都空、日期非法或区间明确反向 | 至少填写一端，按部分日期或 RFC3339 表达图片用于实体的事实时段；它不是许可期限 |
| `invalid_picture_asset` | `pictures[].asset_id` 不是 UUID | 使用已核对的存储资产 UUID；通过形状校验不证明资产存在或有 `cover_image` 绑定 |
| `duplicate_picture` / `too_many_pictures` | 同实体重复图片 URL，或超过 40 张 | 去掉重复项并控制数量，保留手动数组顺序；首项是封面 |
| `invalid_url` / `text_too_long` | URL 不合法 / 文本超长 | 按字段上限裁剪，别用截断后的半截 URL |

## 字段适用层级、属性、词表与翻译

| 错误码 | 含义 | 修复动作 |
| --- | --- | --- |
| `unknown_field: <码>` | 字段未声明或不适用于本实体 kind | 检查 `document.fields[码].applicable_kinds`；当前协议没有实体 types |
| `invalid_term` | 枚举值不在词表里；消息常带字段前缀（`packaging: invalid_term`、`locator: invalid_term`） | 用该字段 `vocabulary` 的**词项代码**；自由文本字段不要当枚举填 |
| `disabled_field` | 该字段码当前未启用 | 换用已启用字段，或按模型缺口上报 |
| `invalid_translation` / `invalid_locale` / `translation_too_long` | 翻译行形状不对 / locale 不是合法语言标签 / 文本超上限 | `translations` 是对象 `{locale:{title,summary,aliases}}`；`title` 非空且 ≤2000，`summary` 与 `aliases` 单项 ≤500 |
| `translation_required` | 发布态没有任何翻译 | 至少给一个语种（通常含 `original_language` 那行）再发布 |
| `invalid_number` / `invalid_date` / `invalid_position` | 数字/日期/序号不合法；消息可能带字段前缀（`edition_date: invalid_date`） | `position` 必须 ≥0；日期用实例接受的格式 |
| `invalid_external_id` / `invalid_external_category` | 外部 ID 的键未注册，或该码的 category 不含这个 kind | 先读 `GET /api/catalog/external-databases` 的 35 个预设与 category |
| `field_not_searchable` | `field=` 检索用了不可检索的码 | 只用顶层 `searchable` 字段（`tags`、`duration`…）；点号路径当前不可用 |
| `four_locale_names_required: <缺的语种>` | 定义/货架/外部库的 `names` 没有四语齐备 | 补 `zh-CN`、`zh-TW`、`en-US` 与 `ja` 或 `ja-JP` |

## 结构归属

| 错误码 | 含义 | 修复动作 |
| --- | --- | --- |
| `parent_required` | `content_unit`/`expression` 缺 `work_id`、`medium` 缺 `release_id`、`track` 缺 `medium_id` | 补归属；归属是实体身份的一部分，不是可选字段 |
| `invalid_structural_field: <码>` | 结构性字段放错 kind：`contents` 不在 track、`subjects` 不在 release、`expression` 带 `parent_id`、`release` 带 `work_id`、`track` 带 `work_id` | 按 kind 只保留允许的结构字段（见 [API 载荷模板](api-templates.md)） |
| `immutable_scope` | PUT 想改 `kind`/`work_id`/`release_id`/`medium_id` | 换归属要重建实体并走 lifecycle 合并/停用，不能改字段 |
| `undeclared_release_subject` | Track 收录的表达所属 Work 没在该发行的 `subjects` 里声明 | 在该发行上补 `subjects`（`primary`/`compilation`/`supplement`）；多作品盒装是受支持能力 |
| `duplicate_subject` | 同一 `(work_id, role)` 声明了两次 | 去重；`position` 不是身份 |
| `duplicate_position` | **同一个 `track.contents` 数组内部**的收录序号重复（或为负） | 改 `contents[].position`。注意：**同一 `medium` 下多张 `track` 的 `position` 重复服务端不拦**（实测 200），那不是这个码 |
| `duplicate_content` | 同一 Track 内同一 Expression **且 locator 完全相同** | 换 locator（不同时间段切片是允许的）或去重 |
| `constraint_violation` | 数据库完整性约束冲突，如跨 Work/Release/Medium 的父子 | 父子只能在同一归属域；按当前 definitions 与实际冲突核查，不能通过改 position 伪造关系身份 |
| `locator: unknown_field: <键>` | `locator` 里写了未声明的子键 | 只写定义声明的子字段 |
| `locator: anchor_required: relative_to` | `locator` 填了子字段却没给锚点 | 有页码/时间码/路径时必须给 `relative_to`（`locator_reference` 词表：`medium` / `track`） |
| `invalid_reference` | 被引用实体不存在／kind 不符／**不可见**／已 `deleted`/`merged` | 引用目标必须可见（`published`）；先读该实体确认；合并过的先 `/resolve` |

## 关系

| 错误码 | 含义 | 修复动作 |
| --- | --- | --- |
| `invalid_relation_type` | 关系码不存在或未启用 | 只用 `definitions.document.relations` 里 `enabled` 的码（种子快照见 [关系码、方向与属性](relations.md)） |
| `invalid_endpoints` | 两端 kind 不符合该关系的 `source_kinds`/`target_kinds`（**自环也走这里**） | 按定义选两端；自环一律不支持 |
| `relation_cycle` | acyclic 关系会在单码或共同 cycle_group 中成环 | 按来源修正方向；未声明共同组的跨码路径不自动检查 |
| `duplicate_relation` | 普通同码/同端点/同属性关系重复；expression_composition 中相同部分也跨码判重 | 普通多边按真实 character/credit_role 等区分；组合不重复部分。只改 position 无效 |
| `duplicate_relation_position` | 声明 unique_position 的同源关系顺序重复；表达组合跨同用途码共同检查 | 回读同源关系并按真实目录安排唯一非负顺序 |
| `relation_scope_mismatch` / `relation_reference_scope_mismatch: <字段>` | 端点或 entity 属性不符合 scope/reference_scopes | 核对固定 work/release/medium 归属，不能借 subjects 推导单 Work |
| `cardinality_exceeded` | 超过当前定义基数；release_group 跨全部同用途码最多一组 | 核对已有组或关系，按真实来源调整，不能换关系码绕过 |
| `invalid_relation_scope` / `invalid_cycle_group` / `invalid_reference_scope` / `invalid_relation_usage` | 定义规则不满足端点/字段/用途支持范围 | 在 GUI 修正规则并做影响检查，读目标实例实际错误字段 |
| `invalid_template_match` / `invalid_template_block` | 模板条件的字段/操作/值不相容，或区块未知/重复 | 用适用于模板 kind 的字段、支持的条件和区块；先做影响检查 |
| `merge_relation_conflict` | 合并会产生"自己指向自己"的边 | 先删掉造成自环的那条关系再合并 |

**反向边是否判重由 `symmetric` 决定**：声明 `symmetric=true` 的关系会检查反向重复边；种子关系为非对称，
A→B 与 B→A 可能都被服务器接受；同一事实的反向展示不需要另建边，只有来源证明另一条独立事实时才新增，不能以服务器接受为正确性证明。

## 生命周期与并发

| 错误码 | 含义 | 修复动作 |
| --- | --- | --- |
| `version_conflict`（409） | 实体/关系的 `expected_version` 不匹配，或 definitions 的 `expected_etag` 缺失/不匹配 | 回读完整目标，确认并发改动后再决定是否基于当前状态重做；客户端不得自动重放 mutate。关系删除不带版本也走这里 |
| `use_lifecycle_endpoint` | 在普通事实写入中声明终态或重定向 | 实体删除与合并使用 `POST /api/catalog/entities/{id}/lifecycle`；普通编辑通过提交，不写状态 |
| `invalid_status` | 生命周期用于已删除或已合并实体 | 先读取 state，终态不能再次应用生命周期操作 |
| `invalid_merge_target` | 合并目标与源不同 kind／不同归属／不同父级，或目标未发布 | 只合并同一层级、同一容器里的重复建档，目标必须 `published` |
| `forbidden`（403） | 角色不足：普通角色碰已发布条目、非管理员走 lifecycle、member 建关系或调 importer；**停用（`deleted`/`merged`）实体上的关联边删不掉也走这里** | 用 `catalog.entity.edit` 维护已发布条目；发布/合并/停用归 `catalog.lifecycle.manage`；悬空边清理属实例侧缺口，上报而不是反复重试 |
| `authentication_required`（401） | **写端点**没有有效令牌（会话 / OAuth 令牌缺失或验签失败） | 核对本地凭据或重新登录；读端点返回 200 不代表写权限凭据有效 |
| `invalid_token`（401） | **PAT（`mfp_` 前缀）** 无效 / 已吊销 / 已过期 / 账号被封禁，不细分原因 | 确认凭据失效后再选择其他有效凭据；不要因任务结束自动轮换 |
| `auth_unavailable`（503） | PAT 请求问不到账号服务：内省端点不可达 / 超时 / 该服务没配 `AUTH_URL` | 依赖故障，退避重试即可；**不要**当凭据问题去换令牌（换令牌同样 503） |
| `idempotency_conflict`（409） | 同一创建操作、用户和 `Idempotency-Key` 被用于不同载荷摘要 | 不要把响应当重放成功；新的一次创建必须换新 key，原 key 的网络重试必须复用完全相同载荷 |

## 限流

| 错误码 | 含义 | 修复动作 |
| --- | --- | --- |
| `rate_limited`（429） | 超过进程内账户/IP + 路由模板的固定窗配额；实际额度取账号/用户组/全局策略或路由默认 | 读 `Retry-After` 与 `X-RateLimit-*` 退避；读取可重试，写入不自动或立刻重放。后台策略可调整或 unlimited；多副本计数独立，不是全局精确上限 |
| `invalid_limit` / `invalid_offset` / `invalid_page` / `pagination_conflict`（400） | 实体列表分页违反 `limit=1..100`、非负整数 offset、正整数 page，或同时传 page+offset | 修正客户端参数；服务端不会静默收敛。`page` 与 `offset` 二选一 |

基数校验由当前关系定义及其用途控制。新版种子 edition_of 有 max_outgoing=1，不能再把 cardinality_exceeded 标为种子不可达；旧实例是否支持新规则须核 OpenAPI 与 definitions。关系端点使用 kind 白名单，已无业务类型端点白名单。

## 遇到没见过的错误

1. 先读目标实例的 `GET /api/openapi.json` 与 `GET /api/catalog/definitions`（枚举与字段码的唯一来源）；
2. 用最小载荷复现一次（只留必需字段），先排除自身载荷形状问题；
3. 仍无法解释：**停止写入**，在报告里给出"错误码 + 请求摘要 + 目标实体"，按"实现缺口"上报；
   不要用近似数据填充，也不要绕过接口改库。
