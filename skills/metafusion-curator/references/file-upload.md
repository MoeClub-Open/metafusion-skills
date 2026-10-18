# 文件上传与绑定

目录保存实体、收录与图片说明；存储服务保存文件字节、上传状态、用途与绑定。不要把对象键或下载地址写进实体题名和目录属性。完整协议见[公共存储文档](https://github.com/MoeclubM/metafusion-docs/blob/main/docs/api-storage.md)。

## 上传与封面

- 上传封面时 initiate 不传 target_entity_id；可传 binding_role=cover_image 说明用途。完成传输和 complete 后取得 asset_id，初始化成功不等于文件已完成。
- 把 asset_id 与权威存储内容 URL（实例地址加 `/api/storage/assets/{asset_id}/content`）放入 pictures，经普通工作副本 stage、commit、push/PR merge 保存。stage 自动私有预留，不需要额外预留请求，不改变正式目录或公开封面。
- 新引用资产须已完成、哈希验证且未封禁或回收；保存者须是上传者或当前具有 storage.asset.moderate 权限。图片 source 可选，已有真实来源保留；来源、存储绑定和转载许可是不同事实。
- 合入后，目录事件自动同步正式 cover_image 绑定并保留原保存者。客户端不直接增删封面绑定；公开封面 bind、带 target 的封面 initiate 或删除封面绑定会返回 `409 catalog_managed_binding`。移除或替换图片仍通过目录副本提交。
- 回读正式实体与 `/api/storage/entities/{id}/files` 确认同步结果。目录合入与存储同步不在同一事务，尚未同步时说明实际状态，不另调用 bind 补写。

## 私有预览

副本预览使用 `/api/catalog/workspaces/{id}/assets/{asset_id}/content`；PR 与提交预览分别使用 `/api/catalog/pull-requests/{id}/assets/{asset_id}/content`、`/api/catalog/commits/{id}/assets/{asset_id}/content`。这些是带上下文权限的预览地址，不能写回 pictures.url。

工作副本预览仅供拥有者和成员；审核者通过 PR 冻结内容或提交自身引用预览，不读取正在编辑的工作副本。读取失败不改用公开绑定或替换 URL 绕过权限。

直传 URL 不携带平台 Bearer/Cookie；上传结果未知时保留 asset_id 并查询，不盲目重传。普通资源文件仍使用各自存储接口和绑定权限。Picture 的 usage_period 表示图片用于实体的事实时段，不是许可期限。
