# 条目正文

正文保存于 `translations[locale].body`，与结构化资料使用同一工作副本、commit 和合并流程。summary 是简短纯文本，body 是 Markdown；单语言最多 100000 个 Unicode 码点，不接受 NUL。论坛承载讨论和考据文章。

标题、表格、图片、脚注和 `/catalog/{canonical-id}` 内链都可用于正文；已有结构化事实仍放对应字段。编辑单一语言时保留该语言的标题、摘要、别名及其他语言内容。新建语言行要同时提供 title，无官方译名时保留原名。

checkout 后暂存正文 patch，例如 operations.json：

```json
[
  {"target":"entity","action":"update","id":"ENTITY_UUID","patch":[
    {"path":"/translations/ja/body","value":"## 概览\n\n条目正文。"}
  ]}
]
```

```sh
node scripts/tools/mf-workspace.ts stage --dir TASK_DIR --file operations.json
node scripts/tools/mf-workspace.ts commit --dir TASK_DIR --message "修订正文"
node scripts/tools/mf-workspace.ts push --dir TASK_DIR
```

正文的来源与引用按需要添加，不强制提交来源或查证记录。清空正文时明确设置空字符串，不删除整个语言行。同一语言正文冲突时阅读双方内容再 rebase；详见[协作流程](workflow.md)。
