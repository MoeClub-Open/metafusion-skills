# 工作副本、提交与恢复

云端模式使用 [云端操作](reference-cloud.md)，无需执行下述本地命令。普通本地编目使用 `local/tools/mf-workspace.mjs`。每个 Agent 使用自己的工作区，最多 100 个实体/关系条目，一个待推送提交。工作区绑定实例 origin 与操作者，凭据仍从本机 credentials.json 或环境读，工作区不存 PAT。

## 编辑已有条目

先在系统临时目录下创建独立任务目录，把所有中间文件与工作副本放进去。以下命令在 `local/tools/` 运行（POSIX shell；PowerShell 使用 `$env:TEMP` 和 `$env:MF_TASK_DIR`）：

```bash
export MF_TASK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/metafusion-agent.XXXXXXXX")"
# init 要求工作副本目录尚不存在：
node mf-workspace.mjs init --dir "$MF_TASK_DIR/catalog"
node mf-workspace.mjs checkout --dir "$MF_TASK_DIR/catalog" --entity <UUID> --relation <UUID>
# 编辑 $MF_TASK_DIR/catalog/entities/<UUID>.json、relations/<UUID>.json；保持只读字段不变
node mf-workspace.mjs status --dir "$MF_TASK_DIR/catalog"
node mf-workspace.mjs commit --dir "$MF_TASK_DIR/catalog" --note "官方题名修订" --sources "$MF_TASK_DIR/sources.json"
node mf-workspace.mjs preview --dir "$MF_TASK_DIR/catalog"
node mf-workspace.mjs push --dir "$MF_TASK_DIR/catalog" --apply
```

Windows PowerShell 示例：`$env:MF_TASK_DIR = Join-Path $env:TEMP ("metafusion-agent-" + [guid]::NewGuid().ToString('N'))`，`New-Item -ItemType Directory -Path $env:MF_TASK_DIR`；随后用 `$env:MF_TASK_DIR/catalog` 指定 `--dir`。绝不复用其他 Agent 的任务目录。`--sources` 等路径指向临时任务目录中的真实文件，不能因为改到临时目录就跳过来源核验。**有 pending、未知回执或恢复需要时禁止删除工作副本**；完成并核对后仅清理本任务生成的文件。

先核 OpenAPI、definitions 与事实来源。`commit` 只写本地不可变请求，自动按对象键生成稀疏 patch；数组整体比较，不能以数组下标代表事实身份。`preview` 运行真实服务端校验后整笔回滚。`push --apply` 执行已获任务授权的写入，开关本身不是授权。

提交后保持工作文件不变，先完成推送回执与 checkout 再继续编辑。提交回执记录已提交版本；后续 checkout 可能包含其他编辑者的新版本，不能把更高版本当成本次失败。每个工作区有本地排他锁；进程异常退出时，先核锁中的 PID 已结束、待推送回执已查清，再移除该工作区遗留的 `.mf/lock`，不能全局删除其他 Agent 的锁。

## 新建与关系依赖

实体文件只写创建字段，引用本批对象时用 `{"$ref":"work"}`。先用 `mf-find-identity` 查询正式题名、各语言题名与外部 ID，不加入 duration 等弱条件；Expression/ContentUnit 带 `--work-id`，Medium 带 `--release-id`，Track 带 `--medium-id`。候选摘要不是可编辑 DTO。

身份审查文件形状是 `{"reviewed_candidate_ids":[]}`。非空时列 canonical UUID，并在任务证据中说明来源如何证明这些候选与新对象不同；有相同身份就复用，不创造新条目。同批先创建的候选可写 `@local:ref`。新 Work/Release/Medium 的下级作用域尚不存在，不把其他作用域的同名对象加入审查列表。

```bash
node mf-workspace.mjs create --dir ../../workspaces/agent-A --target entity --ref work --file work.json --review identity-review.json
node mf-workspace.mjs create --dir ../../workspaces/agent-A --target entity --ref recording --file expression.json --review identity-review.json
node mf-workspace.mjs create --dir ../../workspaces/agent-A --target relation --ref credit --file relation.json
```

工作区按照加入顺序提交；先声明 Work，再 Expression、Release.subjects、Medium、Track.contents 与关系。同一批实体创建在推送事务内复核候选集合，同身份条件并发创建会返回需要审查的新候选。跨用户私有数据和其他单对象/导入入口不因此获得全局唯一身份保证。

超过 100 个操作按能独立维持结构约束的批次拆分。一个来源任务可有多批次，但不能把多批次成功描述为一个原子事务。不同 Agent 尽量分派不同来源对象，热点同字段无法靠增加并发完成更多编辑。

服务端已移除全目录结构锁，结构实体和关系提交以 `SERIALIZABLE` 并行执行；数据库明确回滚的事务会由服务端有界重试。同发行、同身份条件或同一行仍有局部协调，不必等待全站“低峰”。每个 Agent 在自己的工作区准备较小的完整批次再推送；并发数不是连接池大小，也不能据此承诺线上吞吐。

## 冲突与结果不明

- `commit_conflict`：整批回滚，保留旧提交；checkout 冲突值并核证据。`rebase` 默认只合并互不冲突的路径，同字段需要 resolution 文件明确 `ours` 或 `theirs`。
- `identity_candidates_changed`：查询返回的候选详情与来源，复用相同实体或审查不同身份。`--reviews` 文件按创建 ref 提供新的 canonical ID 数组，不能机械复制所有候选当作已经审查。
- `definitions_conflict`：重新核当前动态约束，rebase 生成新基线与提交。
- `503 transaction_busy` 且 `applied=false`：本次请求已回滚。遵守 Retry-After，保留提交，稍后显式 push 同 ID、同载荷；不等待数分钟或增加 Agent。此前同 ID 推送若结果未知，此响应不能清除旧的不确定性，仍先查回执。
- 网络/其他5xx：结果不明。`receipt` 查询持久回执，404 可能仍在执行；保留同提交再次显式 push，服务端按同 ID/载荷重放。工具不自动重试写请求，不允许未知提交 rebase。
- 429：尊重 Retry-After；降低本工作区请求频率，不开更多 Agent 绕过账号预算。原提交与证据保留。
- 推送已成功但刷新失败：回执落在 `.mf/receipts/`，保留 pending，再运行 receipt 完成刷新；工作文件的额外改动会被保留并明确报告，不能假装 checkout 已完成。

```json
{"entity:<UUID>":{"/title":"ours","/attributes/language":"theirs"}}
```

```bash
node mf-workspace.mjs rebase --dir ../../workspaces/agent-A --resolutions resolutions.json --reviews reviewed-candidates-by-ref.json
node mf-workspace.mjs preview --dir ../../workspaces/agent-A
node mf-workspace.mjs push --dir ../../workspaces/agent-A --apply
node mf-workspace.mjs receipt --dir ../../workspaces/agent-A
```

每次 rebase 都生成新提交，旧不可变文件继续保留供恢复。只有明确拒绝的原提交才能 rebase；持久回执确认已应用时优先完成刷新。

## 迁移现有计划

`mf-platform` 已改为只读入口；旧 entity.create/entity.update/relation.create 写计划不再执行，`mf-guarded-update` 与整实体 putEntity helper 已移除。迁移时使用计划中的事实和证据建立工作副本，生成新的本地提交；未知旧写结果必须先按原实体 ID/创建键核验，不能把“工具已升级”视为旧写一定失败。

现有 Agent 不会在执行中自动重读技能。恢复任务前加载当前 SKILL.md 与本页，去掉全 kind 扫描、漂移后长睡眠和无限重试逻辑，再继续已保存进度。Track 隐藏收录用 `mf-track-content`，身份合并用 `mf-merge`；后者仍是多步非原子流程，部分完成不能盲重跑。

协议、权限与容量限制以实例 [OpenAPI](/api/openapi.json) 和[公开提交文档](https://github.com/MoeclubM/metafusion-docs/blob/main/docs/api-commits.md)为准。当前没有原生 git remote、服务端长期分支或跨服务事务。
