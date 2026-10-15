---
name: metafusion-curator
description: MetaFusion 实体编目、查重、关系维护与数据质检。用于目录数据读写，不用于代码开发或部署。
---

# MetaFusion 编目

## 入口

有云端 MCP 时，读取 `metafusion://skills/curator` 或调用 `metafusion_reference`，使用 `metafusion_api_contract` 与 `metafusion_api_call` 操作平台；提交、文件处理见[云端操作](references/cloud.md)。云端模式不要求终端、Node.js、Python 或本地文件系统。

在 `scripts/tools/` 使用 `mf-source` 检索来源、`mf-platform` 只读目录、`mf-workspace` 管理本地副本与 commit/push、`mf-definitions` upsert 词项或受控新增单个字段。参数查工具帮助；[工具索引](scripts/tools/README.md)，[凭据配置](scripts/README.md)。

外部信息获取由 Agent 自行规划：自行选择检索工具、来源、顺序及证据取舍。平台工具与本技能描述数据契约、质量要求和操作方法，不接管检索流程，不主动发现或选择外部来源。

## 规则

- 开始实例操作时核 OpenAPI 与 definitions；字段、关系、词项使用当前启用定义。
- 查重核 kind、内容身份、父级作用域与 canonical ID；同名或同 Work 不证明同一 Expression。正式题名不机械清洗。
- Release `subjects` 声明 Work，Track `contents` 引用 Expression；先声明 subjects，再补收录。
- 普通实体/关系编辑只走变更集：checkout → 构造修改 → commit → preview → push → 回执与展示核验，不调用旧整实体 PUT 工具。云端用 MCP 封存提交；本地模式使用系统临时目录下的独立任务工作区，所有中间脚本、草稿、查询与输出均放任务目录，不写入本仓库；[提交与恢复](references/workflow.md)。**提交证据必填：** 每条 source 要有唯一 `key`，每个操作要有 `source_refs`；旧格式会被 `source_refs_required` 拒绝（见[载荷模板](references/api-templates.md#变更集信封)）。本地 `mf-workspace commit` 会自动补 key/source_refs；MCP 手写载荷必须自己写全。
- 创建先核可见 canonical 候选，保存 reviewed_candidate_ids；有候选只在来源证明不同身份后列为已审查。服务端按题名、各语言题名、外部 ID 和结构作用域复核，集合变化需重新审查。
- 不同字段自动合并；同字段冲突须明确取舍再 rebase。未知推送保留同 ID、同载荷，先查回执；不能换 ID、重建计划、睡眠等全库稳定或盲目重试旧写接口。
- 结构和关系提交已按事务并行。`transaction_busy` 尊重 Retry-After 后显式推送原提交；服务端只自动重试数据库确认回滚的事务，不把网络未知结果当失败。不要等待全库低峰或增加 Agent 绕过热点。
- 条目没有草稿或发布状态。`state` 仅表示 active/deleted/merged 生命周期；已生效条目 `review_status=reviewed`。普通提交返回 HTTP 202、`applied=false`、`review_status=pending_review`：这是已确认入队，不是失败；保留同 ID，等待审核并用回执查询结果，不能重新提交或把模拟版本写回本地。`catalog.review.bypass` 免审立即生效；`catalog.review.manage` 审核整笔提交。审核期间条目保持旧内容、旧版本和已审核标记。退回后可依据当前版本重新准备新提交。
- Track 元数据使用 patch；单条收录可用 entity 的 `action=content` 与 `content_change={action:add|replace|delete,position,inclusion?}`，保留隐藏历史收录。关系删除使用 `target=relation,action=delete,id,base_version`；删除实体、身份合并、定义和文件操作按各自权限维护。

## 按需参考

| 任务 | 参考 |
| --- | --- |
| 层级、复用、命名 | [数据模型](references/data-model.md)、[命名规范](../lrm-catalog-standards/SKILL.md) |
| 来源、当前证据、封面 | [来源策略](references/source-policy.md) |
| Wiki 正文与多语言文章 | [条目正文](references/articles.md)；本地 `mf-workspace article` 只改工作副本 |
| 多 Agent、本地副本、批量推送或冲突 | [提交与恢复](references/workflow.md) |
| 自定义请求或接口失败 | [载荷](references/api-templates.md)、[API 行为](references/api-behavior.md)、[错误码](references/api-errors.md) |
| 权限与服务归属 | [接口范围](references/endpoint-scope.md) |
| 字段、关系或定义缺口 | [字段](references/types-and-fields.md)、[关系](references/relations.md)、[扩展定义](references/model-gaps.md) |
| 文件操作或质量审查 | [文件绑定](references/file-upload.md)、[质检清单](references/qa-checklist.md) |
