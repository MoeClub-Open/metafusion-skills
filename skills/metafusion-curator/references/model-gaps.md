# 定义扩展与固定限制

先查实例当前 definitions；种子未提供不等于平台不支持。缺准确落点时记“实体 + 事实 + 缺字段/词项/关系”，不借近似字段填充。

## 可扩展项

字段、词表、语义关系端点/属性、locator、模板与外部库注册可按授权在 GUI 扩展。词项 upsert 与受支持字段的单项新增可用 `mf-definitions`；其余定义修改按下节操作。

| 事实 | 落点/注意 |
| --- | --- |
| 创作形态、格式与技术规格 | creation_form/format 词项或适用 kind 的字段；不恢复实体 types |
| 发行事件、渠道、版名、特典、角色 | 按语义用 title/events/distribution_channel/attachments/store_bonuses/release_role；缺项扩展，不借 edition_batch 表达渠道或强套近似 role |
| 篇目、人物/团体自身日期或设定 | 适用 content_unit/agent 的字段，不移到关系有效期或表达版本名 |
| 分盘/分轨/篇目署名 | 扩展关系 source_kinds/target_kinds 与属性，不为署名复制 Expression |
| 收录/subject 附加事实 | 扩展 inclusion_attributes/subject_attributes 子字段，不塞 locator/附件 |
| 格式定位与外部 ID 类型 | 卷/盘号用 medium.number，轨号用 track.number；新增定位方案或外部库键/URL/category，勿借 infobox 装不适用 ID |

## 定义修改

权限 `catalog.definitions.manage`；未授权不改定义。

1. `GET /api/admin/catalog-definitions`，保留完整 document 与 etag。
2. `POST /api/admin/catalog-definitions/impact` 提交 `{document}`；issues 阻断，dangling_references 核查为已有引用欠账。
3. `PUT /api/admin/catalog-definitions` 提交 `{document,expected_etag}`，可按需附修改说明和来源，再 GET 核内容与新 etag；冲突回读，不盲重试。

`names` 需 zh-CN/zh-TW/en-US + ja 或 ja-JP，与实体 translations 不同。definitions 无历史、草稿或回滚；其余契约见 [API 行为](api-behavior.md)。

单条结构化记录使用 `group`，重复记录使用 `list` + `items.group`。可选 group 可整体省略，提供对象后再校验组内必填字段；不必为了可选记录额外包一层列表。

本地 `mf-definitions` 保留旧词项计划，并允许 `action: "field.create"` 新增字段；已有同码会拒绝。受控字段类型含 `list`，须提供受支持 Field 形状的 `items`。发行实体按 `attributes.list_price=[{amount,currency,tax_included?}]` 填写。模板见 [list-price-field.json](../scripts/tools/templates/list-price-field.json)。`tax_included` 可省略，省略表示未知；`currency` 虽标注 ISO 4217，但字段类型为普通 `text`，不会校验币种代码格式。

## 固定限制与清理

- 八种 kind 与归属外键不能靠 GUI 扩展；普通编辑不改 kind/work_id/release_id/medium_id。迁移归属须按授权重建并处理引用；没有实体 DELETE。
- 表达组合、跨 Work 收录、发行版本组已有模型，见 [数据模型](data-model.md)，不要作为缺口重造结构。
- deleted/merged 源端不可编辑，关系删除受源端权限阻断；仅目标端终态时管理员可能可删除。必要边整理在生命周期转换前完成，失败停止。
- entity 引用须可见；实体无草稿状态。副本中可用稳定 ID 引用自己尚未合入的新建对象，其他副本或正式目录不能把它当作已存在事实。分页期间并发修改会移动边界，按 ID 去重不等于同一快照。
- 外部来源适配器只读，预览与查询不自动创建目录事实；旧导入写接口已移除。其它鉴权与服务边界见 [接口范围](endpoint-scope.md)。

用户要求核对时，可使用 [仓内只读工具](../scripts/tools/README.md) 与 [核对参考](qa-checklist.md)。这些诊断不是编辑或提交门槛；subjects/medium 尚未补齐时仍可提交已确认的资料。
