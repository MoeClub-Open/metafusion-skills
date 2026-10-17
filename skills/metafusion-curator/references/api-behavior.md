# MetaFusion API 行为参考

本页只记目标实例行为与跨任务不变量。命令参数由工具 `--help` 提供，服务端请求载荷见[载荷模板](api-templates.md)。实例响应与文档冲突时以实例为准；影响写入契约的差异先停止相关写入并记录。

## 实例发现与动态定义

- 元数据 API 统一位于 `/api`。开始实例操作时读取 `/api/openapi.json`、`/api/catalog/definitions`，再检查目标实体、权限和可见性；不要由旧快照或示例推断当前能力。
- 字段、词表、关系、模板和 locator 以 `definitions.document` 为准，只使用当前启用项；`names` 是显示文本，不是能力声明。definitions 只提供一份当前文档，无历史或回滚；没有结构引用字段的 kind，其 `structure.<kind>.fields` 可为 `null`。
- OpenAPI 是 handler 反射结果：schema 的 `required` 可能为空，`Idempotency-Key` 也可能只写在 operation summary 而未声明为 parameter。不要仅据这些形状推断字段或请求头必填/可选；核目标实例和实际处理器。
- 实体结构仍遵循八种固定 kind。`Release.subjects` 声明发行包含的 Work，`Track.contents` 结构性地引用 Expression；它们不是关系；同一 commit 可原子维护，跨批次仍须记录进度。`track_work` 若在当前 `release_role` 中启用，只能作为 subject role 使用，不是关系码。

## 读取与证据

- `404` 只表示当前调用者看不到对象或对象不存在，不能证明全库缺失。`401`、`403`、`429`、5xx、超时、网络失败和无法解析的响应都属于未知；停止依赖该读取结果的写入。
- 实体 List 始终排除 `state=deleted` 和 `state=merged` 的记录；核对历史重复时按旧 ID 调 GET/resolve，不能把列表未返回判作对象不存在。
- 分页结果只有在所有页成功遍历后才可用于完整性结论；部分范围、失败页或可见性限制须标为 partial。
- 当前修订只按 `revision.version == entity.version` 选择，不能默认列表首项最新。来源位于修订记录，新提交可通过 `source_refs` / `pointers` 归属到操作或字段；历史 `scope="commit"` 来源池不证明某字段。最新修订也不自动为未改字段补证，按[来源策略](source-policy.md#当前证据)追查实际修改与证据范围；载荷被接受不证明来源权威。
- 修订行只有写后 `snapshot`，没有 `before` / `after`；Track 历史投影也可能按可见性裁剪，不是完整备份，不能用来恢复不可见收录。

## 并发查重

- `mf-find-identity` 与 commit 创建复核 使用只读 `POST /api/catalog/entities/candidates`，在同一 PostgreSQL 快照中查题名/别名、外部 ID、标量属性并解析 canonical；无关实体新增或更新不要求重新扫描全库。
- `coverage.total` 统计匹配的原始候选，非整个 kind 的行数。`--limit` 是候选上限（默认/最大 1000），超过上限为 partial，收窄条件；不要反复扫描、睡眠等待低峰或移除属性绕过候选核验。
- 实例缺少候选端点、查询失败、候选截断或 canonical 未解析时停止依赖写入，不回退 offset 扫描，不把错误当零候选。快照不预留后续创建；不同 Agent 应避免重复分派同一身份，未知写结果保持原创建键并先回读。

## 写入边界

- 普通编目使用 [工作副本与提交](workflow.md)，服务端复用单实体的权限、动态 definitions、事实校验与审计。每批最多100个 create/update，所有事实、修订、通知与搜索 outbox 同一事务；预览整笔回滚。
- 更新由权威 base_version 与稀疏 patch 比较字段，互不重叠自动合并，相同值不增加修订，重叠不同值整批冲突。对象逐键、数组原子；归属和服务端字段不可修改。
- Track 元数据 patch 由服务端读取完整 facts，保留未提交的隐藏 contents。隐藏收录仍走专用 contents 操作；来源继承规则由服务端实现，不从可见投影推断所有旧事实。
- 固定 commit ID 与载荷可重放持久回执；未知结果查询回执，不更换 ID 或基线。明确拒绝才能 rebase；409 不盲目回写当前整份实体。
- 普通交互式 API 的 PUT 仍是整实体替换，本技能不走这个写通道。合并身份、删除、定义与文件操作有独立边界，不能声称跨服务或跨批次原子。
- 写后核当前条目、修订、关系与 occurrences；只读完整性仍按声明的可见范围，不由工具成功标志推断全库覆盖。

权限、实体可见性和跨服务边界见[接口归属与写入范围](endpoint-scope.md)；实体层级见[数据模型](data-model.md)。
