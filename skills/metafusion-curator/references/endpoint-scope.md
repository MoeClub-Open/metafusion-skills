# 接口归属与权限

可用端点以目标实例 OpenAPI 和响应为准，目录编辑流程见[工作副本](workflow.md)。

| 服务 | 职责与入口 |
| --- | --- |
| 目录 | 八类实体、关系、结构、工作副本、commit、PR、修订与贡献：`/api/catalog/*`、`/api/users/{id}/contributions`；动态定义与目录配置使用对应 `/api/admin/*` |
| 账号 | 用户、会话、OAuth、PAT 与用户管理：`/api/auth/*`、`/api/oauth/*`、`/api/users/{id}`、`/api/admin/users*` |
| 社区 | 论坛、评论、收藏和私信：`/api/community/*`、`/api/favorites/*`、`/api/messages/*`、用户 favorites/stats |
| 存储 | 文件、上传、绑定和下载：`/api/storage/*` |
| 网关 | 按路径分流，不提供另一套目录事实写接口 |

`/api/admin/*` 按具体资源归属，不能整体视为账号服务。目录资料和社区讨论分别调用对应服务，不把论坛内容当目录实体写入。

## 目录操作

- 公共正常实体按可见性读取，列表不含 deleted/merged。历史 ID 用 `/api/catalog/entities/{id}/resolve`，完整 canonical entity 与 aliases 用 `/identity`。
- 编辑使用 `/api/catalog/workspaces`，创建副本后 checkout、changes、commits、push/rebase；普通用户 push 发 PR，`catalog.review.bypass` 允许直接合入，`catalog.review.manage` 允许合并 PR。
- 副本成员可共同编辑副本，但不能扩大其正式目录编辑权限。私有副本和未合入记录不会因为公开个人主页而变为公开。
- 生命周期、definitions、货架、外部库注册与文件操作使用独立权限，不在副本提交中冒充跨服务原子操作。
- `/api/external-sources` 及 query 是外部资料只读适配器，不能直接导入写库。`/api/exchange/entities/{id}` 是快照导出。
- 公开契约读 `/api/openapi.json`；交互式 `/api/docs`、`/api/swagger` 按部署的管理权限开放，不从页面不可访问推断 API 未提供。

## 凭据

写端点需要有效凭据。会话/OAuth 无效时部分公开读接口会按匿名处理，因此公开 GET 的 200 不能证明令牌有效。PAT 使用 `Authorization: Bearer mfp_…`，由账号服务内省；无效、吊销、过期或账号封禁返回 `invalid_token`，依赖不可达返回 `auth_unavailable`。

有效操作权限取账号现时权限与令牌 scopes 的交集；免审身份按当前账号权限组判断，不把只读 key 变为写权限。MCP 使用独立委托凭据，不占个人 API Key 额度。角色、凭据、任务授权和对象可见性分别判断，不能由其中一项推断其余项。

真实令牌仅放本机被忽略的配置，见[运行时](../scripts/README.md)。错误和未知结果处理见[API 错误](api-errors.md)。
