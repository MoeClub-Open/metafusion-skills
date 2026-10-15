# 条目正文

条目正文由目录服务保存于 `translations[locale].body`，与结构化字段共用权限、提交、来源与修订。`summary` 是简短纯文本介绍；`body` 是 Markdown，单语言最多 100000 个 Unicode 码点，不接受 NUL。论坛承载讨论和署名考据；有来源支持的事实可写入条目正文，并引用原始资料。

标题、表格、图片、脚注与 `/catalog/{canonical-id}` 内链可以用于正文。不要用文章替代已有结构化字段，也不要把其他语言正文清空。编辑已有语言时保留该语言的标题、别名和摘要；新增语言须提供该语言标题。

## 云端

先 checkout；通过正常提交将 `/translations/zh-CN/body` 等路径设为正文字符串。正文也必须有对应的 `source_refs`；需要区分支持范围时在引用里填写相应 JSON Pointer。预览、显式推送、未知结果回执恢复沿用[提交工作流](workflow.md)。

## 本地

先 checkout 实体，在任务临时目录准备 UTF-8 Markdown，再修改工作副本：

```sh
node scripts/tools/mf-workspace.mjs article --dir TASK_DIR --entity ENTITY_UUID --lang zh-CN --file TASK_DIR/article.md --title 中文标题
```

已有语言可省略 `--title`；新建但尚未推送的实体用 `--ref` 代替 `--entity`。该命令只改工作副本，不请求平台写入，也不自动生成来源。之后执行 commit、preview、显式 push。清空正文时明确提供空 Markdown 文件，不删除整项翻译。

多语言正文可以分别提交；同一语言正文的并发编辑会形成字段冲突，应阅读双方内容并合并，不直接覆盖。
