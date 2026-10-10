# 云端平台操作

连接实例的 `/mcp` Streamable HTTP 端点，通过 MetaFusion 登录，在 `/mcp/manage` 勾选该客户端所需权限。MCP 权限与账号现时权限取交集；admin 组免业务 RPM 限流，不绕过授权与数据约束。

信息获取仍由 Agent 自行决定。MCP 不运行检索计划、不选择外部来源、不根据任意网页文字自动编目。`sources` 与修改内容由 Agent 提供；文件工具只下载明确传入的 URL 或处理明确提供的内容。

## 读取契约与操作

- `metafusion_api_contract`：当前目录 OpenAPI；动态字段另读 `/api/catalog/definitions`。
- `metafusion_reference`：读取技能与链接的 reference 文档，或 `source=docs, path=docs/api-storage.md` 等公开 API 手册；返回部署锁定的版本。
- `metafusion_api_call`：按现有 HTTP API 传 method、path、query、body、headers；JSON、base64 和 multipart 均可，不需要客户端执行环境。包含搜索、实体、关系、定义、导入、通知、互动、文件及已授权的管理操作。
- 原生状态码、冲突、Retry-After 和回执保留。API 查询分页按原契约继续；一次响应不意味着关系全集。

## 提交

1. 按当前候选接口核查新建身份；checkout 获取 base_version 与 definitions_etag。
2. Agent 构造 operations、sources、edit_note，调用 `metafusion_commit_prepare`。平台只生成 UUID、保存不可变载荷，30 天有效，不提交事实数据。
3. 用 `metafusion_commit` 的 `preview` 校验同一 ID，再显式 `push`。`get` 可取回封存载荷；`recover` 只查回执。
4. 未知结果先 recover，不换 ID 或自动重放。确认 `transaction_busy/applied:false` 才按 Retry-After 显式重试原 ID。409 真冲突必须取舍并 rebase，形成新提交。

封存不做自动查重、自动选源或自动编辑；这些决定仍由 Agent 根据用户任务作出。也可直接用原生 preview/push 工具提交 Agent 构造的完整载荷。

## 文件

`metafusion_file_inspect` 根据明确提供的公开 HTTPS source_url 或 base64 内容计算摘要与大小；`metafusion_upload` 在云端完成计算、initiate、传输与 complete，可指定绑定实体。URL 文件上限 1 GiB，base64 受 8 MiB 请求体限制；超出时使用独立文件客户端。文件必须可被服务端访问，客户端私有本地路径不是 URL。

上传失败保留 asset_id，先通过存储 API 检查状态；未知结果不能盲目重传。上传目标只接受部署允许的对象存储源站，不向文件源或对象存储发送平台凭据。

账号登录、口令、OAuth 授权与机器令牌管理在浏览器完成，不把会话凭据作为工具参数。平台的普通管理 API 使用已批准权限，经现有 API 执行并记录审计。
