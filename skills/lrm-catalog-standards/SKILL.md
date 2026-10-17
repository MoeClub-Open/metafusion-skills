---
name: lrm-catalog-standards
description: 选择 MetaFusion 实体层级、命名作品与发行版、判断跨发行内容复用。用于跨媒介编目和去重。
---

# 层级与命名

按资料实际描述的身份建模，不要求凑齐整条实体链。读写工具见[编目技能](../metafusion-curator/SKILL.md)，结构约束见[数据模型](../metafusion-curator/references/data-model.md)。

| 层级 | 保存什么 |
| --- | --- |
| Work | 作品本身的名称与创作身份；歌曲和有独立创作身份的专辑可各有 Work |
| ContentUnit | 同一 Work 内稳定的章、集或篇目 |
| Expression | 具体正文、译文、录音或剪辑，可跨发行复用 |
| Release | 原样保留发行方为该版使用的名称，另记编号、地区、包装 |
| Medium / Track | 实际承载单元与收录位置，`number` 保留官方编号、`position` 表示顺序 |

- 正式题名中的 Season、Vol、OST 等按来源保留。中文名称采用[官方或授权本地化译名](../metafusion-curator/references/source-policy.md#中文译名)，无官方译名就用原名。
- 现场、重录、伴奏、混音按内容身份区分；同名或相近时长不证明同一表达，品番与商品名也不证明新录音。缺少内容差异证据时不机械复制 Expression。
- 歌曲录音仍属于歌曲 Work，专辑组成用相应关系；Release.subjects 声明收录 Work，Track.contents 引用实际 Expression。组成、版本组与本版曲序分别记录。
- 多作品盒装按 subjects + Medium/Track 收录；有独立汇编创作证据时再建 Work。有实际目录再建章、集或曲目，初回附件和真实特典盘分别表达。

关系选择与准确落点见[关系](../metafusion-curator/references/relations.md)和[定义扩展](../metafusion-curator/references/model-gaps.md)。
