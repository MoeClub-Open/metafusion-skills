# 编目质检

只检查本次操作涉及的项。工具见 [索引](../scripts/tools/README.md)，结构约束见 [数据模型](data-model.md)。

## 身份与结构

- [ ] 按题名/译名/别名、外部 ID、编号查候选，并核 kind、内容身份、父级作用域与 canonical ID；Work 去重未替代表达去重。
- [ ] 正式题名未机械改写，展示回退值未回写基础 title；未按盘数/卷数推造内容。
- [ ] 归属与 parent_id 同域、无环；Expression 没有 parent_id；版次/组成关系有来源，不由共同 subjects 推断。
- [ ] Release subjects 覆盖全部收录 Work、role 启用且 (work_id,role) 不重复；先声明后收录，跨实体失败核对已提交部分。
- [ ] Track contents 引用可见 Expression，position 唯一，expression + locator 不重复；同 Medium 曲序另核，服务端不保证兄弟 Track position 唯一。
- [ ] attributes 符合当前 enabled/applicable_kinds 与词表/子组约束；实体 translations 是 locale 对象，发布至少一条翻译。

## 关系与来源

- [ ] 关系启用、两端 kind/方向/作用域正确；角色等 attributes 区分事实，position 不制造新事实，反向展示不重复建边。
- [ ] 组成与循环/唯一位置按当前 usage、scope、reference_scopes、cycle_group 检查；局部检查不声称全库无环。
- [ ] 核心字段与身份锚点按 [来源策略](source-policy.md) 映射到当前证据；citation 明确支持字段。
- [ ] 核实官网时 `external_links` 中 `kind="official_website"` 的 `url` 写完整官方 URL，不能只留 sources。
- [ ] 图片匹配具体版次，数组顺序保留手选封面；自托管资产绑定已回读。图像授权与权利材料分别判断。

## 写后回读

- [ ] 写入已授权且预览已审；版本当前、未改字段保留。工作副本按对象键生成稀疏 patch、数组替换；遗漏键保留原值并列入 `ignored_omissions`，删除使用明确 `--remove`，`null` 明确赋值。
- [ ] 实体身份字段变动已重新查候选并提供 `--reviews`；推送后的追加编辑已完成 receipt 刷新或明确解决 `receipt_refresh_conflict`，未把待提交本地编辑当作线上事实。
- [ ] Track 未做整实体 PUT；单条收录来源继承与其余收录保留符合 [API 契约](api-behavior.md)。
- [ ] 创建幂等键未换载荷复用；409 或结果不明先回读，不自动重放。
- [ ] 回读实际改动、版本与当前修订（version 匹配），以及受影响 relations/occurrences；可见性裁剪部分未冒充完整验证。
- [ ] 定义变更执行 impact、expected_etag 与完整文档保存，并回读内容；names 四语、实体 translations 分开核对。

## 批次操作

- [ ] 查询集合明确：品番前缀、publisher 引用、署名关系的结果不互代；分页核 total、成功/失败页与未遍历项。
- [ ] 并行写入按实体/身份作用域互斥；暂停核对在途请求。
- [ ] 只报告实际完成范围与缺口；失败、未遍历或未回读标 partial/未核验。计数仅在任务需要时按 [批次口径](source-policy.md) 执行。
