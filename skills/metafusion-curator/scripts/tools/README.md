# 编目工具

在本目录运行。参数以工具 help/schema 为准；[凭据](../README.md)，[服务端载荷](../../references/api-templates.md)。

| 任务 | 工具 |
| --- | --- |
| 外部资料与官方商品页 | `mf-source`；[支持范围](README-providers.md) |
| 只读目录和当前修订 | `mf-platform` |
| 副本派生、暂存/提交、合并/变基、撤销/恢复、标签/stash、PR 与历史 | `mf-workspace` |
| 在副本中暂存单条 Track 收录 | `mf-track-content`，执行仅 stage，随后仍需 commit/push |
| 词项 upsert 与受控字段新增 | `mf-definitions` |
| 查重候选与目录快照 | `mf-find-identity`、`mf-catalog-snapshot` |
| 按需诊断 | `mf-audit`、`mf-check-structure`、`mf-audit-external-links`、`mf-audit-provenance`；不阻止编辑 |
| 已确认重复的身份合并 | `mf-merge`，独立管理员治理操作，多步过程非原子 |

```sh
node mf-source.ts list
node mf-platform.ts list
node mf-workspace.ts help
node mf-workspace.ts init --dir TASK_DIR --name "修订资料"
node mf-workspace.ts checkout --dir TASK_DIR --entity ENTITY_UUID
node mf-workspace.ts stage --dir TASK_DIR --file operations.json
node mf-workspace.ts commit --dir TASK_DIR --message "修订题名与收录"
node mf-workspace.ts push --dir TASK_DIR
node mf-workspace.ts pr-list
node mf-workspace.ts pr-get --pr PR_UUID
node mf-workspace.ts pr-diff --pr PR_UUID --target entity
node mf-workspace.ts history --record ENTITY_UUID --limit 20
node mf-workspace.ts revisions --record ENTITY_UUID --version 1
```

init 创建服务器副本，也可通过 `--workspace UUID` 连接已有副本。本地目录只保存连接状态与已观察到的 version/head，所有工作内容和提交都存服务器。副本可多次 stage、commit，并通过 members 共同编辑；普通用户 push 发 PR，免审用户直接合入。未知结果保留状态并读取副本、commit 与 PR；详见[协作流程](../../references/workflow.md)。

正文和图片都使用普通 stage patch，没有单独的文章写通道。source_refs、候选查证数组和来源池不是 stage/commit 参数。

计数或看图片/标签覆盖用 `mf-platform` 计划 `{"action":"entity.stats"}`；`entity.list` 会遍历全部匹配结果，limit 只是页大小。stage 文件接受操作数组或 `{operations:[…]}`；缺失 create ref 自动补名，成功结果在 `result.refs` 返回 UUID、`workspace.version` 返回新版本。创建/checkout 每次最多 100 个实体与关系，stage 每次最多 100 个操作，可分次保存后统一 commit。多行提交说明用 `commit --message-file message.txt`，或 `--message-file -` 从标准输入读取。

`mf-track-content` 计划是 `{workspace_id,expected_version,track_id,inclusion}`，expected_version 是副本版本；默认预览不写，`--apply` 仅暂存收录，不自动提交或合入。

`mf-merge` 前置事实整理通过服务器副本合入，只有 applied=true 才继续生命周期合并；部分成功不盲目重跑。定义、身份合并和文件操作各有独立权限，不能声称跨服务事务。

`mf-definitions` 支持词项 upsert 和 `action:"field.create"` 新增字段，不替换已有同码字段；list 字段必须有 items。定价示例见[list-price-field.json](templates/list-price-field.json)。定义默认预览，`--apply` 执行；开关不替代用户授权。

来源 help/list 不联网，读取用 `run <operation> <arg>`；完整运行输出保存在任务目录，不放进技能安装目录。所有来源与诊断工具都是可选辅助，不构成提交门槛。

AniList 搜索默认动画；漫画和轻小说用 `node mf-source.ts run anilist.search "检索词" --type MANGA`。详情裸 ID 也可用 `--type MANGA`，URL 中的 `/anime/`、`/manga/` 按原链接决定类型。
