# 本地运行时

[工具入口](tools/README.md)。所有 MetaFusion HTTP 经 `metafusion-api.ts`。

本地工具使用 Node.js 24+ 原生运行 TypeScript；完整复制技能目录并保留上级 `package.json`。不提供 JavaScript 包装器或编译产物。仓库开发校验使用 `bun install --frozen-lockfile`、`bun run typecheck` 与 `bun run test`。

任务中新增的 Node 脚本也使用 `.ts`，通过 `node <脚本>.ts` 直接运行；导入使用当前技能目录中的 TypeScript 工具路径，不复制旧客户端。中间脚本放独立任务目录，不能放进技能安装目录。

## 凭据

本目录 `credentials.json` 已忽略：`{"baseUrl":"https://example.com","pat":"<本机填写>"}`。
`MF_BASE/MF_PAT` 可临时覆盖；`MF_CREDENTIALS` 可指定另一文件。真实凭据不进入日志或版本库。

## 客户端与工作区

`request` 提供认证与只读重试，`collectPages` 保留分页覆盖证明；不提供整实体 putEntity 写入 helper。编目编辑使用 [mf-workspace](../references/workflow.md)，凭据文件放工作区之外；每个 Agent 使用自己的目录。
