# API 行为

实例响应与文档冲突时先核当前 OpenAPI 和实际能力；不要通过旧端点或近似字段补偿写入。

## 读取与模型

- 元数据 API 统一 `/api`。字段、词表、关系、模板和 locator 以当前 `definitions.document` 为准，不把种子快照当作实例能力。
- `404` 表示不存在或对当前用户不可见；401/403、限流、网络与解析失败不能当成零结果。分页完整性仅覆盖成功遍历的可见范围。
- 正常实体列表排除 deleted/merged；历史 ID 用 resolve/identity 解析。当前修订以 `revision.version == entity.version` 确定，不默认第一行最新。
- 修订的 snapshot 是写后快照；Track 历史投影可能按可见性裁剪，不能当作完整备份。已有来源只说明其实际支持范围，不自动为最新快照的所有字段背书。
- Release.subjects 和 Track.contents 是结构事实，不是关系边；可在同一副本暂存后原子合入。

## 协作边界

- 正式目录只由工作副本 push 或 PR merge 的同一合并器更新。stage 与 commit 仅改变副本，不能把新 ID 或私有内容显示成已生效事实。
- 一个副本支持多次暂存、多次不可变 commit、多个成员。每次改变用 expected_version，push/rebase 还固定 expected_head；PR merge 固定 PR version 与 source head。
- 合并比较基线、正式目录与副本 tip 的净变更，不相交字段自动合并，重叠不同值整批冲突。对象按键、数组原子；kind 与固定归属不可随普通编辑改变。
- 免审用户 push 直接应用，普通用户 push 创建或更新 PR；PR merge 需要 `catalog.review.manage`。两种路径都保留原作者，合并者单列，实际合入后才计公开贡献。
- 来源、查证记录和质量诊断不是提交条件。身份候选查询可辅助去重，不要求候选确认数组。
- 工作副本成员权限不等于正式目录写权限；私有副本、未合入提交和 PR 不向无权用户公开。
- commit 与 rebase 使用调用方 UUID 确认请求身份；未知结果先查询，不盲目改 ID 重建。创建副本没有客户端幂等 ID，响应丢失后先列出副本确认。

身份合并/删除、定义与文件管理有独立权限和边界，没有跨服务事务。具体流程见[工作副本](workflow.md)，鉴权见[接口范围](endpoint-scope.md)。
