---
name: lrm-catalog-standards
description: 选择 MetaFusion 实体层级、命名作品与发行版、判断跨发行内容复用。用于跨媒介编目和去重。
---

# 层级与命名

读写工具见 [metafusion-curator](../metafusion-curator/SKILL.md)；结构细节见 [数据模型](../metafusion-curator/references/data-model.md)。

- **Work** 保存创作身份与正式题名。Season、Vol、OST 等是否属于题名按官方证据判断，不机械删词；出版社、品番、规格、包装放发行侧。
- **ContentUnit** 是同 Work 的逻辑章/集；**Expression** 是正文、译文、录音等可复用表达。现场、伴奏、重录、混音先核内容身份；不因同名或时长近似合并，也不为挂署名复制表达。
- **Release** 对应真实版次；普通、限定、地区、数字、再版按实际差异区分。购买渠道本身不制造版次；版本组须有明确来源，不从共同 subjects 推断。
- **Medium/Track** 按实际包装与目录建立；`number` 保留官方编号，`position` 表示顺序。同一表达跨发行复用 `Track.contents`。
- 歌曲可有独立 Work，单曲发行是 Release。专辑组成用当前启用关系，歌曲不改挂专辑；发行 subjects 覆盖实际收录 Work。
- 盒装用 subjects + Medium/Track；仅有独立创作证据时另建汇编 Work。附赠 MV/现场盘建真实内容链，附件清单不能代替收录。
- 无章节、曲目或表达证据时留空，不从卷数/盘数推造层级；可先补已确认的 subjects。

按需查 [来源](../metafusion-curator/references/source-policy.md)、[字段](../metafusion-curator/references/types-and-fields.md)、[关系](../metafusion-curator/references/relations.md)；无准确落点时查 [定义扩展](../metafusion-curator/references/model-gaps.md)。
