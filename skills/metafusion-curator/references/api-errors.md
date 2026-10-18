# API 错误与处理

错误可能带字段前缀或补充数据，保留完整响应。下表集中说明会改变编辑决策的情况；载荷和实际错误以目标实例为准。

| 错误 | 处理 |
| --- | --- |
| `workspace_version_conflict` / `workspace_head_conflict` | 副本已被修改。重新读取副本和提交链，比较自己的改动，不盲目替换版本号重放 |
| `pull_request_version_conflict` | PR 或 source head 已变化，重新读取并检查本次将合并的内容 |
| `workspace_conflict` | 正式目录与副本有三方冲突；读取 base/current/proposed，用当前版本的 resolution rebase，再 push |
| `uncommitted_changes` | 先提交副本未提交改动，再 push 或 rebase |
| `no_changes` | 没有可提交或合入的净变更，不为了通过接口制造无意义改动 |
| `workspace_archived` / `pull_request_merged` | 已归档副本由拥有者恢复 active 后才能编辑；已合并 PR 不能重开 |
| `invalid_commit_patch` / `invalid_payload` / `server_fields_forbidden` | 按当前 DTO 修正路径或形状，不提交只读 id/version/state 等服务端字段 |
| `unknown_field` / `disabled_field` / `invalid_term` | 读取当前 definitions，核字段适用 kind 与启用词项；不要用显示名代替 code |
| `immutable_scope` / `invalid_structural_field` / `parent_required` | 核八种实体和固定归属；普通编辑不改变 kind/work_id/release_id/medium_id |
| `undeclared_release_subject` / `invalid_reference` / `constraint_violation` | 核收录、归属和目标可见性，同一副本补齐相关结构后再合入；不以近似关系规避 |
| `invalid_relation_type` / `invalid_endpoints` / `relation_cycle` / `cardinality_exceeded` | 核关系定义、方向、范围和现有关系；反向展示不要求另建反向边 |
| `invalid_source` / `invalid_picture` | 提供了元数据时修正其形状；来源本身可省略，不编造来源以通过校验 |
| `use_lifecycle_endpoint` | 已生效实体删除/身份合并是独立治理操作，不伪装成普通事实修改 |
| `forbidden` / `authentication_required` / `invalid_token` | 分别核任务权限、登录和凭据 scopes；读接口可匿名成功，不证明令牌有效 |
| `auth_unavailable` / `transaction_busy` | 依赖故障，遵守 Retry-After；先确定未知写结果，不通过更换令牌或新 ID 掩盖 |
| `rate_limited` | 按 Retry-After 降低频率，不开更多 Agent 绕过同一账号预算 |

冲突与恢复请求见[载荷](api-templates.md#冲突解决)。网络超时不能证明失败；创建 commit/rebase 后先按原 ID 读取，push 后先读副本、PR 与正式事实。遇到未说明的错误，按当前契约检查最小载荷；不能解释时说明尚未完成的部分，不绕过 API 改库。
