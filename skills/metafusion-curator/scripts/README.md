# 本地运行时

[工具入口](tools/README.md)。所有 MetaFusion HTTP 经 `metafusion-api.mjs`。

## 凭据

本目录 `credentials.json` 已忽略：`{"baseUrl":"https://example.com","pat":"<本机填写>"}`。
`MF_BASE/MF_PAT` 可临时覆盖；`MF_CREDENTIALS` 可指定另一文件。真实凭据不进入日志或版本库。

## 客户端与工作区

`request` 提供认证与只读重试，`collectPages` 保留分页覆盖证明；不提供整实体 putEntity 写入 helper。编目编辑使用 [mf-workspace](../references/workflow.md)，凭据文件放工作区之外；每个 Agent 使用自己的目录。
