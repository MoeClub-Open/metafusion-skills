---
name: lrm-catalog-standards
description: 选择 MetaFusion 实体层级、命名作品与发行版、判断跨发行内容复用。用于跨媒介编目和去重。
---

# 层级与命名

按资料实际描述的身份建模，不要求凑齐整条实体链。读写工具见[编目技能](../metafusion-curator/SKILL.md)，结构约束见[数据模型](../metafusion-curator/references/data-model.md)。

| 层级 | 保存什么 |
| --- | --- |
| Agent | 个人、团体/组合、机构/公司、虚构角色（`attributes.agent_type`：`person` / `group` / `organization` / `character`） |
| Collection | 跨媒体企划、作品系列、选集或展会特辑（`attributes.collection_type`：`franchise` / `series` / `anthology` / `event_catalog`），经 `includes` 聚合旗下动画、游戏、漫画、音乐等 Work |
| Work | 作品本身的名称与创作身份（`attributes.creation_form`）；单首乐曲建 `song` Work（仅作曲目收录时不填 `original_album`/`single`），单曲/EP/专辑企划另建 `single`/`ep`/`original_album`/`soundtrack`/`compilation_album` Work 并经 `includes` 包含 `song` Work |
| ContentUnit | 同一 Work 内稳定的章、集或篇目（`attributes.entry_role`：`main` / `opening` / `ending` / `trailer` / `extra` / `other`，编号按各 `entry_role` 独立起算） |
| Expression | 具体正文、译文、录音或剪辑（`attributes.version_label` 自由文本），可跨发行复用 |
| Release | 原样保留发行方为该版使用的名称；正交记录 `edition_type`、`edition_batch`、`distribution_channel`、`packaging` 与发行主体 `publisher`（`entity -> agent`） |
| Medium / Track | 实际承载单元（`attributes.format` + `role`）与收录位置（`attributes.role` + `Track.contents[]`），`number` 保留官方编号、`position` 表示顺序 |

- **新建前必须近似查重（Agent 硬规）**：执行任何 `action: "create"` 前，必须启用近似匹配运行身份候选查询（本地 `node mf-find-identity.ts --kind <kind> --title "<title>" --approximate`；MCP `catalog_identity_check` 或 `metafusion_candidates` 传 `include_approximate: true`；站内助手 `catalog_candidates` 传 `titles` 时默认开启）。命中 `reuse` 或 `review` 候选（含 `title_core` 核心题名与 `title_similar` 近似题名）时，必须核查 `assessment`（含 `agent_type_mismatch` / `creation_form_mismatch` / `collection_type_mismatch` 子类型冲突）并读取候选详情与关系，区分复用已有 UUID 与新建同名异物（如同名 `song` Work 与 `single`/`original_album` Work、不同季度动画）。
- 正式题名中的 Season、Vol、OST 等按来源保留，不自行增加 `[CD]`、品番或版本后缀。中文名称采用[官方或授权本地化译名](../metafusion-curator/references/source-policy.md#中文译名)，无官方译名就用原名。
- 社区通行译名不直接写成正式题名或别名；仅可在非原始语言显式设 `nonofficial: true` 或写入 `nonofficial_aliases`，不得把「非官方」拼进名称文本。
- 现场、重录、伴奏、混音按内容身份区分；同名或相近时长不证明同一表达，品番与商品名也不证明新录音。缺少内容差异证据时不机械复制 Expression。
- 歌曲录音仍属于歌曲 Work，专辑组成用相应关系；Release.subjects 声明收录 Work，Track.contents 引用实际 Expression。组成、版本组与本版曲序分别记录。
- 多作品盒装按 subjects + Medium/Track 收录；有独立汇编创作证据时再建 Work。有实际目录再建章、集或曲目，初回附件和真实特典盘分别表达。
- 署名严格区分职责：`created_by` 仅限原作者/原案/著作人；动画制作公司、制作委员会、制片人、同人社团、游戏厂商一律用 `produced_by`（原职衔写 `credit_role`，出版发行商写 `Release.attributes.publisher`）；专用署名码优先（如词曲编 `lyricist_of`/`composed_by`/`arranged_by`、团体成员 `member_of`），`credit_for` 仅作无专用码时的兜底且绝不重复建边。

完整分类词表、32 条语义关系与扩展规则见[字段](../metafusion-curator/references/types-and-fields.md)、[关系](../metafusion-curator/references/relations.md)和[定义扩展](../metafusion-curator/references/model-gaps.md)。
