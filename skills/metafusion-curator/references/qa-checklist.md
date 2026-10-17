# 编目质检

只检查本次操作涉及的项。工具见 [索引](../scripts/tools/README.md)，结构约束见 [数据模型](data-model.md)。

## 身份与结构

- [ ] 按题名/译名/别名、外部 ID、编号查候选，并核 kind、内容身份、父级作用域与 canonical ID；Work 去重未替代表达去重。
- [ ] 正式题名未机械改写，展示回退值未回写基础 title；未按盘数/卷数推造内容。
- [ ] 新增中文译名有官方或授权本地化证据；没有则保留原名，未将自译、音译或社区译名混入无标记的题名/别名，未虚构 `nonofficial` 字段。
- [ ] 归属与 parent_id 同域、无环；Expression 没有 parent_id；版次/组成关系有来源，不由共同 subjects 推断。
- [ ] Release subjects 覆盖全部收录 Work、role 启用且 (work_id,role) 不重复；先声明后收录，跨实体失败核对已提交部分。
- [ ] 正常曲目未标为特典；商品品番、标题或收录位置未被当作独立录音/母版证据，未据此填 `version_label` 或机械复制 Expression。
- [ ] Track contents 引用可见 Expression，position 唯一，expression + locator 不重复；同 Medium 曲序另核，服务端不保证兄弟 Track position 唯一。
- [ ] attributes 符合当前 enabled/applicable_kinds 与词表/子组约束；实体 translations 是 locale 对象，至少一条语言资料可使用原文名称，无须补造中文译名。

## 关系与来源

- [ ] 关系启用、两端 kind/方向/作用域正确；角色等 attributes 区分事实，position 不制造新事实，反向展示不重复建边。
- [ ] 组成与循环/唯一位置按当前 usage、scope、reference_scopes、cycle_group 检查；局部检查不声称全库无环。
- [ ] 核心字段与身份锚点按 [来源策略](source-policy.md) 映射到当前证据；citation 明确支持字段。
- [ ] 用途与署名按来源逐项对应：未从艺人介绍推定专辑/歌曲的动画用途，共同署名未遗漏、未补造来源未列的职位；版次、初回、渠道及随机赠品条件保留。
- [ ] 核实官网时 `external_links` 中 `kind="official_website"` 的 `url` 写完整官方 URL，不能只留 sources。
- [ ] 图片匹配具体版次，数组顺序保留手选封面；自托管资产绑定已回读。图像授权与权利材料分别判断。

## 写后回读

- [ ] 写入已授权且预览已审；版本当前、未改字段保留。工作副本按对象键生成稀疏 patch、数组替换；遗漏键保留原值并列入 `ignored_omissions`，删除使用明确 `--remove`，`null` 明确赋值。
- [ ] 实体身份字段变动已重新查候选并提供 `--reviews`；推送后的追加编辑已完成 receipt 刷新或明确解决 `receipt_refresh_conflict`，未把待提交本地编辑当作线上事实。
- [ ] Track 未做整实体 PUT；单条收录来源继承与其余收录保留符合 [API 契约](api-behavior.md)。
- [ ] 创建幂等键未换载荷复用；409 或结果不明先回读，不自动重放。
- [ ] 回读实际改动、版本与当前修订（version 匹配），以及受影响 relations/occurrences；可见性裁剪部分未冒充完整验证。
- [ ] 定义变更执行 impact、expected_etag 与完整文档保存，并回读内容；names 四语、实体 translations 分开核对。

## 补全与审查的验收

- [ ] 将任务范围内的来源事实逐项列为已保存（实体/关系/字段）、待核、模型缺口或本次未覆盖；只对已核部分作完整性结论，不以实体数或凑齐层级代替覆盖。
- [ ] 质量 API 的 `status=complete` 只说明响应 `checks` 列出的自动项通过。它不验证来源是否支持结论、是否漏署名或误用角色；preview/push 成功同样不证明语义完整。
- [ ] 区分结构化事实、来源引用与原文归档；提取摘要或来源 URL 未冒充已完整保存权威网页。无法落入当前模型的事实单列缺口，不塞入近似字段。

## 批次操作

- [ ] 查询集合明确：品番前缀、publisher 引用、署名关系的结果不互代；分页核 total、成功/失败页与未遍历项。
- [ ] 并行写入按实体/身份作用域互斥；暂停核对在途请求。
- [ ] 只报告实际完成范围与缺口；失败、未遍历或未回读标 partial/未核验。计数仅在任务需要时按 [批次口径](source-policy.md) 执行。
