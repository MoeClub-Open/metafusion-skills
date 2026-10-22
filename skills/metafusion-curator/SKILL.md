---
name: metafusion-curator
description: 查询和协作编辑 MetaFusion 目录实体、收录与署名关系，使用服务器工作副本、提交和合并请求。不用于项目开发或部署。
---

# MetaFusion 编目

按用户的目标与授权执行，可以只修改已确认的部分。来源、查证记录、质检与完整度不作为编辑或提交门槛，也不为满足工具而编造资料。

- **云端 MCP**：用 `metafusion_reference` 读技能、`metafusion_api_contract` 读当前契约；[云端操作](references/cloud.md)介绍工作副本工具，无需本地运行环境。
- **本地工具**：`mf-source` 读外部资料、`mf-platform` 读目录、`mf-workspace` 管理服务器副本。见[工具索引](scripts/tools/README.md)与[凭据配置](scripts/README.md)。
- **写之前必须读过（硬规）**：暂存的内容必须是操作者**逐条读过原文并作出判断**的结果——外部页面、书目库或权利方资料抓回来只供阅读，
  不得把未经阅读核对的抓取结果、模型生成的译名或推测字段直接拼成清单成批提交。条数多不是问题（提交本就不限条数），
  **没人读过才是问题**。译名、职衔署名、关系端点、季归属这四类尤其要对着原文一行行看；读不到依据就留空并在提交说明里写明。
  抓取脚本与编辑脚本都按常规用，但不许把「抓取→生成→提交」接成没人看内容的自动管道。
- 字段、词项与关系以目标实例的 OpenAPI、definitions 为准。层级和名称按[命名与建模](../lrm-catalog-standards/SKILL.md)；无官方中文译名时保留原名。
- 编辑流程为创建副本 → checkout → 多次 stage → commit → push。stage 与 commit 都不改变正式目录；免审用户 push 直接合入，其他用户生成 PR。一个副本可持续积累多次提交，协作者的提交各自署名。
- 冲突时比较 base、current 与 proposed，通过 rebase 生成解决后的新提交；保留原作者，不覆盖他人改动。版本、提交 ID 与恢复见[协作流程](references/workflow.md)。

## 按需参考

| 问题 | 参考 |
| --- | --- |
| 层级、归属、收录与复用 | [数据模型](references/data-model.md) |
| 名称、来源与原始资料 | [来源说明](references/source-policy.md) |
| 字段、关系或定义扩展 | [字段](references/types-and-fields.md) · [关系](references/relations.md) · [定义扩展](references/model-gaps.md) |
| 正文或文件 | [条目正文](references/articles.md) · [文件绑定](references/file-upload.md) |
| 请求、权限与错误 | [载荷](references/api-templates.md) · [API 行为](references/api-behavior.md) · [接口范围](references/endpoint-scope.md) · [错误码](references/api-errors.md) |

可复制的启动提示词见[仓库 README](../../README.md#给-agent-的提示词)。
