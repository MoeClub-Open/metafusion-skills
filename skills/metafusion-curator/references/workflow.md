# 服务器副本、提交与合并

服务器工作副本保存正式目录的基线、已提交内容和未提交改动。可以跨页面、跨会话编辑，多次操作合成一次 commit，也可以连续 commit 后一次 push。实时副本只对所有者和成员可见；审核人读取冻结 PR 和已 push 的提交，不能据审核权限读取实时副本。不能把副本中的新 ID 当作正式目录已存在的对象。

云端工具见[云端操作](cloud.md)，请求形状见[载荷](api-templates.md)。本地 `mf-workspace.ts` 保存实例与 workspace_id 等连接状态，不保存令牌；凭据见[本地运行时](../scripts/README.md)。

## 编辑与提交

在技能的 `scripts/tools/` 目录运行，`TASK_DIR` 是本任务的本地目录：

```sh
node mf-workspace.ts init --dir TASK_DIR --name "修订发行资料"
node mf-workspace.ts checkout --dir TASK_DIR --entity ENTITY_UUID
node mf-workspace.ts stage --dir TASK_DIR --file operations.json
node mf-workspace.ts commit --dir TASK_DIR --message "修订发行题名与收录"
node mf-workspace.ts status --dir TASK_DIR
node mf-workspace.ts push --dir TASK_DIR
```

`operations.json` 是 stage 的操作数组，示例见[协作载荷](api-templates.md#协作载荷)。已有副本可用 `init --dir TASK_DIR --workspace WORKSPACE_UUID` 连接。stage 可重复执行；读取返回的 refs，用稳定 UUID 在后续操作或提交中引用新对象。`commit` 固定当前未提交改动，生成不可变提交并记录实际操作者；提交后仍可继续编辑。`push` 合并副本基线到已提交 head 的净变更；存在未提交改动时，先完成 commit 再 push。

需要共同编辑时，由副本拥有者通过 `members --file userids.json` 管理成员；成员编辑同一副本时也使用返回的最新 version。多人各自创建副本则在合入时处理差异。来源和查证清单不替代身份判断，但它们均不是协议必填项。

## 推送与 PR

- 具有 `catalog.review.bypass` 的用户可直接 push 合入正式目录。
- 其他用户 push 创建或更新同一副本的 PR；返回 `applied=false` 和 `pull_request`，正式目录保持不变。PR 创建成功不表示没有合并冲突；合并时仍会重新检查。可以继续提交并再次 push 更新 PR。
- `pr-list`、`pr-get --pr UUID` 查看 PR，`pr-edit --pr UUID --file patch.json` 更新标题或状态，有审核权限的用户用 `pr-merge --pr UUID` 合并。作者与合并者分开记录，关闭 PR 不改变正式目录。
- `applied=true` 才表示正式目录已更新。合入后回读相关实体、关系与收录；个人主页只把实际合入的提交计作公开目录贡献。

实体删除/身份合并、定义管理和文件管理仍是各自的治理操作，不能声称它们与目录副本跨服务原子提交。

## 并发、冲突与恢复

每次改变副本带 `expected_version`，push/rebase 另带 `expected_head`；PR merge 带 PR 的 version 与 head。工具保存并提交读取时的版本，CAS 冲突后先重新读取，不用新版本号盲目重放旧编辑。

合并比较共同基线、当前正式目录和副本已提交内容。不同字段的修改可自动合并；同字段不同值返回冲突，数组按完整值处理。撤销回基线的内容不会再次覆盖正式目录。

`workspace_conflict` 的每项包含 target、id、pointer、base、current、proposed 和 current_version。核对双方意图后，用 `rebase --file resolutions.json` 提交每项的明确值或 remove；同时固定 expected_version/head，生成新提交，旧提交保留。若正式目录再次变化，重新获取冲突，不沿用过时的 current_version。resolution 形状见[载荷](api-templates.md#冲突解决)。

网络失败不能证明操作未执行。保留本地状态、workspace_id、commit ID 与 PR ID，通过 status、`receipt --commit UUID` 和 pr-get 确定实际结果；不把未知结果当作需要新建提交。遵守 `Retry-After`，不自动增加并发绕过限流。仅在结果明确且无恢复需要后清理本任务的本地文件。
