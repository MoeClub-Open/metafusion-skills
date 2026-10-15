# 实体与层级

创作与发行分开；字段/关系以实例当前 definitions 为准。命名见 [LRM 规范](../lrm-catalog-standards/SKILL.md)，请求见 [API 载荷](reference-api-templates.md)。

## 八种实体

```text
Agent：个人 / 机构 / 团体 / 虚构角色
Collection：系列 / 企划，经 includes 聚合
Work：创作身份与正式题名
├── ContentUnit：同 Work 的章 / 集 / 篇目，parent_id 构成目录树
└── Expression：可复用正文 / 译文 / 录音 / 正片版本
Release：具体发行，经 subjects 声明 Work
└── Medium：盘 / 卷 / 文件集
    └── Track：容器内位置
        └── contents[] → Expression（position、locator、sources）
```

Agent 不是旧 artist/franchise kind；系列与世界观用 Collection。文件、哈希、对象键与下载地址属于 [存储服务](reference-file-upload.md)，不写入创作题名或目录属性。

## 归属与收录

- ContentUnit/Expression 必须有 work_id；ContentUnit.parent_id 同 Work。Expression 可有同 Work 的 content_unit_id，**没有 parent_id**。
- Medium.release_id 必填，parent_id 同 Release；Track.medium_id 必填，parent_id 同 Medium。父级不得自环、跨域或成环。
- 普通 PUT 不改 kind/work_id/release_id/medium_id；换归属须重建。
- Track.contents 是结构性收录，不是 relation；expression_id 指表达，position 是该 Track 内顺序，locator 是实际载体的页码/时间码/路径等。sources 保存收录证据，旧值空缺不补造。
- contents.position 在该 Track 内唯一；兄弟 Track.position 服务端不保证唯一，曲序需另核。
- Release.subjects 声明全部收录 Expression 所属 Work；遗漏会 `undeclared_release_subject`。role 取当前启用 release_role，(work_id,role) 不重复。
- `track_work` 是 release_role 词项，不是 relation；仅启用时表示发行中作为曲目收录的 Work（可含已证实影音作品）。词项结构 names/enabled，不虚构 description/source/metadata；role 不能替代 Expression 收录。
- subjects/medium 可为空而入库，但不等于收录完整。先写 subjects，再补 Track.contents；跨实体不原子，失败核已提交部分。
- attributes 受当前 enabled/applicable_kinds 与词表约束，没有实体 types；细节见 [字段](reference-types-and-fields.md)。

## 条目正文

目标实例的 OpenAPI 声明 `Translation.body` 时，`translations.<locale>.summary` 保存简短纯文本简介，`body` 保存可选 Markdown 条目说明（每语种最多 100000 个 Unicode 字符）。正文由目录服务共同维护，沿用实体权限、状态、来源和修订；它不等于被编目 Expression 的原文，也不替代日期、署名、收录及关系等结构化事实。社区承载讨论与署名考据。

只改正文时使用 `/translations/<locale>/body` patch 和对应 `source_refs.pointers`，保留其它语言与字段，不提交身份复核数组。脚注用于展示引用，提交仍需有效外部来源；同一正文的并发冲突需人工合并。实例尚未声明该字段时不能尝试写入或借 `attributes` 绕过。

## 表达与版本

| 能力 | 约束 |
| --- | --- |
| `usage=expression_composition`（种子 expression_part） | 同 Work 的有序表达组成；跨同用途码不可重复部分/position，共同无环；parts/wholes 只给直接边，不递归展平或证明等同 |
| `usage=release_group`（种子 edition_of） | Release 显式归 Work/Collection；跨同用途码每个发行最多一组；共同 subjects 不证明版本组 |
| 跨发行收录 | 同一 Expression 可被多个 Track 引用；反查用 `GET /api/catalog/entities/{id}/occurrences` |

新能力须确认已部署；改编、续作、原声带、角色登场用相应语义关系，不改表达创作归属。

Work 唯一不代表 Expression 唯一；录音室、现场、伴奏、混音按实际身份区分，不能只凭标题、Work 或共同发行合并。表达证据不足时只补已确认 subjects，contents 留空。

多作品盒装保留各作品自己的 Expression，用 subjects + Medium/Track 收录。仅汇编有独立创作证据时另建 Work；盒装品番不挂单部 Work，不伪造 work_id 绕过校验。

## 跨媒介落点

| 场景 | 编目 |
| --- | --- |
| 动画 | Work + 有证据的分集 ContentUnit/Expression；真实蓝光/DVD/数字版建 Release、盘建 Medium、收录位置建 Track。盘数不生成“盘作品” |
| 音乐 | 专辑可有自己的 Work，独立歌曲各自 Work，专辑经当前允许 includes 组成；录音留在歌曲 Work 下。发行 subjects 覆盖专辑及实际收录歌曲，CD/黑胶/精选复用同一录音；MV/现场特典盘建真实载体与表达 |
| 图书/漫画 | 有目录证据才建 ContentUnit；单行本/精装/电子版各自 Release。章节表达跨版复用，页码留在本版 locator；整本/章节原文与译文用表达组成和 translation_of 关联，实际出版顺序走 Track/contents |

电影本体与同名 OST 都可能是 Work；按内容、责任主体与来源区分，标签不单独判身份。仅重排/定位变化复用内容，真实章节拆合或内容修订再区分 ContentUnit/Expression。

审查见 [质检清单](reference-qa-checklist.md)；来源与需要时的批次计数见 [来源策略](reference-source-policy.md)。
