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
- **新建前必须近似查重（Agent 硬规）**：协议层候选查询只读且不要求提交 `reviewed_candidate_ids`，但 Agent 在暂存任何新建实体（`action: "create"`）前，**必须**启用近似匹配执行候选查重（本地 CLI：`node mf-find-identity.ts --kind <kind> --title "<title>" --approximate`；MCP：`catalog_identity_check` 或 `metafusion_candidates` 传 `include_approximate: true`；站内助手 `catalog_candidates` 传 `titles` 时默认开启）。当返回候选（`reuse` 或 `review`，含默认 `title_core` 核心题名命中与近似 `title_similar` 命中）时，必须检查 `assessment`（含 `agent_type_mismatch` / `creation_form_mismatch` / `collection_type_mismatch` 等子类型冲突）并读取候选实体详情与关联边，确认复用已有 UUID 还是新建独立实体（如同名主打歌 `song` Work 与单曲/专辑 `single`/`original_album` Work、第 1 季与第 2 季）。
- **分类与署名核心边界**：定义支持后台 GUI / seed 扩展，运行时以目标实例 OpenAPI 与 `definitions` 为准，完整标准基线见[字段](references/types-and-fields.md)与[关系](references/relations.md)。单首乐曲 `Work` 的 `creation_form` 填 `song`（仅作曲目收录时不填 `original_album` 或 `single`），单曲/EP/专辑企划 `Work` 填 `single`/`ep`/`original_album`/`soundtrack`/`compilation_album` 并用 `includes` 包含 `song` `Work`；跨媒体企划 `Collection`（`collection_type="franchise"`）用 `includes` 聚合动画/游戏/音乐等 `Work`。署名关系中 `created_by` **仅限原作者/原案/著作人**；动画制作公司、制作委员会、制片人、同人社团、游戏厂商一律用 `produced_by`（原始职衔写 `credit_role`，发行版出版/发行商写 `Release.attributes.publisher`）；16 条专用署名码优先，`credit_for` 仅在无专用码适用时作兜底（必填 `credit_role`，严禁与专用码重复建边）。
- 层级和名称按[命名与建模](../lrm-catalog-standards/SKILL.md)；无官方中文译名时主标题保留原名，社区通行译名须显式标 `nonofficial` 或写入 `nonofficial_aliases`（见[来源说明](references/source-policy.md)）。
- 按需裁剪查询字段以节省上下文：检索、批量读取、单条读取、关系查询、定义读取与外部源查询均支持可选字段/语种/属性键过滤（如 `fields`、`locales`、`attribute_keys`、`include_body`、`include_entities`、`include_raw`），只请求当前判断所需的字段。
- 编辑流程为创建副本 → checkout → 多次 stage → commit → push。stage 与 commit 都不改变正式目录；免审用户 push 直接合入，其他用户生成 PR。一个副本可持续积累多次提交，协作者的提交各自署名。
- 冲突时比较 base、current 与 proposed，通过 rebase 生成解决后的新提交；保留原作者，不覆盖他人改动。版本、提交 ID 与恢复见[协作流程](references/workflow.md)。
- 任务完成或回合结束时，必须输出简洁完整的操作总结：列出涉及的 `/catalog/<id>` 实体链接、具体新增或修改的字段/译名/关系，以及最终合并（`applied=true`）或 PR 状态。

## 按需参考

| 问题 | 参考 |
| --- | --- |
| 层级、归属、收录与复用 | [数据模型](references/data-model.md) |
| 名称、来源与原始资料 | [来源说明](references/source-policy.md) |
| 字段、关系或定义扩展 | [字段](references/types-and-fields.md) · [关系](references/relations.md) · [定义扩展](references/model-gaps.md) |
| 正文或文件 | [条目正文](references/articles.md) · [文件绑定](references/file-upload.md) |
| 请求、权限与错误 | [载荷](references/api-templates.md) · [API 行为](references/api-behavior.md) · [接口范围](references/endpoint-scope.md) · [错误码](references/api-errors.md) |

可复制的启动提示词见[仓库 README](../../README.md#给-agent-的提示词)。
