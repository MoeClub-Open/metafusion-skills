---
name: metafusion-curator
description: 查询和编辑 MetaFusion 目录实体、收录与署名关系，维护来源并处理提交。不用于项目开发或部署。
---

# MetaFusion 编目

按用户已明确的目标和授权执行，可以只修改当前确认的部分。质检、评分、完整度和核对清单都是可选参考，不作为编辑或提交门槛。

## 入口与提交

- **云端 MCP**：用 `metafusion_reference` 读技能、`metafusion_api_contract` 读当前契约，`metafusion_api_call` 查询；提交与文件工具见[云端操作](references/cloud.md)，无需本地运行环境。
- **本地工具**：`scripts/tools/` 中用 `mf-source` 查来源、`mf-platform` 读目录、`mf-workspace` 编辑和提交；参数看工具帮助。[工具索引](scripts/tools/README.md) · [凭据配置](scripts/README.md)。
- 字段、词项与关系以目标实例当前 OpenAPI、definitions 为准；层级、身份与复用按[命名和建模](../lrm-catalog-standards/SKILL.md)。中文名称遵循[官方译名规则](references/source-policy.md#中文译名)。
- 创建或改变身份时查询 canonical 候选，按 API 提供 `reviewed_candidate_ids`；普通字段修改不扩大为整库查重。
- 普通写入走 checkout → 修改 → commit → preview → push，只提交本次修改。每条来源有唯一 `key`，每个操作有 `source_refs`；具体载荷见[提交示例](references/api-templates.md#变更集信封)。
- HTTP 202 / `pending_review` 表示已入队，免审提交立即应用；待审不改变当前条目。结果未知时保留同一提交 ID 查回执，实际冲突再 rebase。写后回读受影响内容；详见[提交与恢复](references/workflow.md)。

## 按需参考

| 需要处理的问题 | 参考 |
| --- | --- |
| 实体层级、归属、收录和复用 | [数据模型](references/data-model.md) |
| 来源、名称、封面及原始资料 | [来源说明](references/source-policy.md) |
| 字段、关系或定义扩展 | [字段](references/types-and-fields.md) · [关系](references/relations.md) · [定义扩展](references/model-gaps.md) |
| Wiki 正文或文件绑定 | [条目正文](references/articles.md) · [文件绑定](references/file-upload.md) |
| 自定义请求、权限或错误恢复 | [API 行为](references/api-behavior.md) · [接口范围](references/endpoint-scope.md) · [错误码](references/api-errors.md) |
| 用户要求核对数据 | [可选核对参考](references/qa-checklist.md) |

本地工作副本和运行产物放独立任务目录；可复制的启动提示词见[仓库 README](../../README.md#给-agent-的提示词)。
