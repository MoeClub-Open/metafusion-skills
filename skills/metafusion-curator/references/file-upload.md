# 文件上传与绑定（面向 Agent）

一句话分工：**目录回答"这个实体是什么、谁能看"，存储回答"这份文件的字节在哪、挂给谁、有什么用途"。**

- 文件本体、哈希、直传地址与下载都走 `/api/storage/*`；作品/专辑/曲目等事实走 `/api/catalog/*`。
- 两者不重复：**文件说"我是谁的什么用途"（`binding_role`），目录说"收录在第几轨、什么时间码"（Track `contents` 的 `locator`）**。
- 因此：**不要把哈希、对象键或下载地址写进实体字段或题名。**

## 存储协议与编目边界

完整端点、上传信封及下载行为维护在 [公共存储文档](https://github.com/MoeclubM/metafusion-docs/blob/main/docs/api-storage.md)，不在技能中复制。执行前核实例支持、任务授权与现有凭据；目录写权限不蕴含 storage.asset.upload/moderate。

- SHA-256 是资产身份，命中不自动秒传；只有 complete、hash_verified 且当前可读的资产可复用。摘要不授予读取权限，可读也不代表可为他人资产新增绑定；普通用户不能接管他人未完成上传。
- 直传地址仅用于传输字节，不携带 MetaFusion Bearer/Cookie。S3 complete 回读真实大小与摘要并验证；上传者声明、对象存在或初始化 200 均不能替代完成态与哈希核验。
- binding_role 是用途码，不是目录收录；绑定唯一键为 (asset_id,target_entity_id,binding_role)。target_entity_type 若填写须匹配目录权威 kind。
- 目标身份与可见性使用目录 `/api/catalog/entities/{id}/identity`（canonical entity、完整 aliases、complete=true），存储不缓存可见结论、不回退旧 resolve 组合；依赖失败不能解释成空文件列表。
- 普通读取排除 blocked 资产；未完成资产和上传者/审核者的权限另按端点判断，下载仍要求完成态。S3 预签名一旦发出，解绑或封禁不即时撤销已有 URL；按签名有效期说明访问窗口。

## 封面是跨服务、跨证据链的受控流程

目录 `pictures` 与存储资产/绑定是两套状态，没有自动同步或跨服务事务；技术上传成功也不代表版权通过。当前任务明确授权的图片操作可在该范围内执行；操作授权与许可证据分开记录，缺少权利材料标为 `unknown`，不能伪造 `passed`。

1. 按[字段级来源策略](source-policy.md)核对图像身份、具体版次与图源；权利材料另行记录，是否作为额外计数门槛按本批次定义。
2. 按获准范围上传或直传，回读资产 `sha256`、MIME、`complete`、`hash_verified`、`blocked` 等状态；禁止缩略图放大、截图、拼贴、拉伸、占位或水印图。
3. 用 `binding_role=cover_image` 绑定目录实体，GET `/api/storage/entities/{id}/files` 核对 asset_id 与角色完全一致。
4. 非 Track 实体使用完整 PUT 写 `pictures[]`，自托管图片项同时写对应资产 UUID 到 `asset_id`，保留合法 `url`、其它图片与实体字段，并带 `expected_version`；响应后回读实体、当前 revisions 和存储绑定。Track 禁止整实体 PUT，当前专用端点只修改收录或状态；需要维护 Track 图片时报告接口缺口，不能复用此步骤。
5. 任一步失败都停止并记录补偿清单；不得只看到目录 URL 或存储 200 就计为合规封面。

当前 `Picture` 包含 `url`、`caption`、`source` 和可选 `taken_at`、`version_label`、`usage_period`、`role`、`asset_id`。目录只检查 `asset_id` 的 UUID 形状，不保证资产存在、可读、已绑定或未封禁，因此仍需上述跨服务回读。`usage_period` 记录图片用于实体的事实时段，不是版权许可期限；授权范围/期限/合同引用须保存在 Catalog DTO 之外的审查证据包。
