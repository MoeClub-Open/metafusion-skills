# 接口归属与写入范围（面向 Agent）

本页区分跨服务职责与鉴权；实例可用端点以 OpenAPI、响应及实际处理器为准。目录写入与可见性规则见 [API 行为](api-behavior.md)。

## 路径前缀与职责

| 系统 | 负责什么 | 对外路径前缀 | 实现仓库 |
| --- | --- | --- | --- |
| 元数据目录 catalog | 八类实体、动态定义、关系、结构、修订、检索、货架、外部权威库、快照导出与外部提案（`catalog.*`） | `/api/catalog/*`（含 `/api/catalog/me/home-preferences`）、`/api/external-sources/*`、`/api/exchange/*`、`/api/admin/catalog-definitions`、`/api/admin/shelves`、`/api/admin/external-databases`、`/api/openapi.json` | MetaFusion |
| 账号 auth | 用户、会话、OAuth 客户端/授权码/令牌、RSA 密钥（`auth.*`） | `/api/setup`、`/api/auth/*`、`/api/admin/users*`、`/api/oauth/*`、`/api/oidc/jwks`、`/api/.well-known/openid-configuration` | metafusion-auth |
| 互动 community | 论坛板块/主题/回复/标签、条目短评、收藏、私信（`community.*`） | `/api/community/*`、`/api/favorites/*`、`/api/messages/*`、`/api/users/{id}/favorites`、`/api/users/{id}/stats` | metafusion-community |
| 存储 storage | 物理文件、sha256 内容寻址、对象存储直传、文件→实体绑定、下载与预览的访问控制（`storage.*`） | `/api/storage/*` | metafusion-storage |
| 边缘网关 gateway | 无（只有路由表） | `/`、`/docs`，按前缀分流到上述单元 | MetaFusion 的 `deploy/nginx.conf`；`metafusion-api-gateway` 存放切流自检脚本 |

> 上表是**分工口径**，不是"实例已经提供"的清单：某组前缀在具体实例是否可用，**按实例响应为准**
> （单个请求 404 也可能是资源不可见或不存在，不能推出整组端点未提供），不要在报告里写成已有能力。

`/api/admin/*` **不是整段归账号**：`/api/admin/users*` 归账号，而 `/api/admin/catalog-definitions`、
`/api/admin/shelves`、`/api/admin/external-databases` 由目录服务提供（权限码 `catalog.definitions.manage`、
`catalog.shelves.manage`），是定义 / 货架 / 外部库的管理入口，与实体写入（`/api/catalog/entities/*`）不是同一范围；
别把"我只有编目权限"读成"目录里没有定义/货架管理入口"。

网关**按前缀分流**，不为切换服务而改前端调用点。`/api/users/{id}/favorites` 与用户资料同前缀，网关用精确正则
`^/api/users/[^/]+/favorites$` 单独分流到互动服务；`/api/users/{id}/stats` 也归互动，
`/api/users/{id}` 归账号，`/api/users/{id}/contributions` 归目录。

**编目者只写目录。** 论坛、短评、收藏、互动记录不是元数据事实：不要通过目录接口写入它们，也不要为它们在目录里建实体。

## 目录的其它入口（与实体写入无关）

同属目录服务、但不写实体的几条通道，先认准再调用：

- `GET /api/exchange/entities/{id}`：导出该实体的快照，只读，匿名可访问。
- 外部编辑统一使用 `POST /api/catalog/commits`；待审回执不改当前实体。
- `GET /api/catalog/me/home-preferences`：读调用者自己的主页偏好，与实体无关。
- `GET /api/docs`（Scalar）、`GET /api/swagger`（Swagger UI）：目录服务托管的交互式文档页，属**管理面**
  （需登录 + `catalog.lifecycle.manage`，页面与自托管资源同一道闸门），不是给接入方看的公开入口；
  要看公开契约用 `GET /api/openapi.json`，它对匿名开放。

## 读写的鉴权口径

- **读端点匿名可访问**：definitions、entities、tags、shelves、feed、exchange 快照这些读接口不带令牌也返回 200；
  但**草稿仍按调用者身份过滤**——匿名只看得到已发布内容，带上令牌才看得到自己有权限的草稿。
- **写端点无令牌一律 401**：不带 `Authorization` 调写接口返回 `401 authentication_required`，没有匿名写入。
- **会话 / OAuth 令牌无效时读接口不报 401**（按匿名处理，仍是 200）：所以"读接口调得通"证明不了令牌有效。
  草稿可见性与令牌有效性须分别核实，不把公开读接口的 200 当登录凭证。
- **PAT（`Authorization: Bearer mfp_…`）不适用上一条**：下游服务（目录 / 互动 / 存储共用这份契约）看到 `mfp_` 前缀
  就交给账号服务内省判定，无效 / 已吊销 / 已过期 / 账号被封禁一律 `401 invalid_token`（**读端点也返回 401**，
  不会按匿名继续）；账号服务不可达（或该服务没配 `AUTH_URL`）回 `503 auth_unavailable`——那是依赖故障，
  退避重试，别当凭据问题去换令牌。
  有效权限取「账号现时权限 ∩ 令牌 scopes」，不按角色兜底；创建 PAT 的 scopes 必须非空，之后交集仍可因权限变化为空，权限不足返回 `403 forbidden`。
- 读接口 200 不能验证令牌有效性，也不能单凭 200/401 推断部署版本。核目标服务的鉴权配置与实际处理器；不为探测令牌而新增写操作。
- PAT 吊销的下游缓存窗口最长 60 秒；缓存到期不超过令牌 expires_at，不把过期时间再延后 60 秒。正常调用使用现有凭据，配置见 [本地运行时](../scripts/README.md)。

## 身份解析与操作边界

- 普通实体读取用 `GET /api/catalog/entities/{id}`。历史 ID 单项解析用 `/resolve`；需要 canonical entity 与完整别名全集时用 `/identity`，存储服务依赖后者处理历史绑定。写入前重新解析相关 ID，不用本地缓存判断不存在；读取失败的处理见 [API 行为](api-behavior.md)。
- 实体编目、导入、定义管理、文件操作是不同授权范围；目录写权限不自动授予定义管理或存储写权限。导入适配器与 API 路径见 [载荷](api-templates.md#迁移与导入)，定义扩展见 [定义修改](model-gaps.md#定义修改)。
- 论坛、评论、收藏和私信属于互动，不能作为目录实体写入。目录不保存物理对象路径；文件用途、上传及绑定见 [文件上传与绑定](file-upload.md)。
