---
name: metafusion-relationship-query
description: 通过 MetaFusion 只读 API 批量查询归属、发行收录、版本组与署名关联。不执行编目写入。
---

# 关系查询

先核目标 ID；同名候选须区分 kind、外部标识与所属关系。接口以实例 `/api/openapi.json` 为准。

## 调用

在技能目录运行 [脚本](scripts/query_relationships.py)，使用 Python 3 标准库；参数查 `--help`。`--base-url` 是实例根地址，私有读取凭据取环境变量 `MF_API_TOKEN`。

```bash
python scripts/query_relationships.py --base-url https://example.com --rules
python scripts/query_relationships.py --base-url https://example.com --id <release-uuid> --direction outgoing --class ownership --peer-kind medium --limit 25
python scripts/query_relationships.py --base-url https://example.com --id <work-uuid> --class semantic --class reference --limit 50
```

- `--rules` 读取运行时规则。`structure:` 是固定事实投影，`relation:` 是语义关系，`attribute:` 是声明的属性引用；用完整 code，不从显示名猜码。
- 普通查询是只读 `POST /api/catalog/relationships/query`。`--id/--class/--rule-code/--peer-kind` 可重复；`--class` 可选 `ownership` / `placement` / `inclusion` / `semantic` / `reference`，服务端直接裁剪无关的关系表扫描（例如只读署名与字段引用时传 `--class semantic --class reference` 可跳过结构表扫描）。最多 20 主体，limit ≤ 100、offset 为非负整数；逐主体分页。
- direction 相对 `subject_id`；事实始终是 `source_id → target_id`，反向名称不改变边方向。
- `entities` 是可见摘要，不能用于整实体编辑；`unavailable_ids` 不区分不存在与不可见。
- `has_more=true` 时用同一主体/筛选继续，offset += 本页 limit，并核对 `definition_etag`。多页不是同一快照，未遍历页不等于无关系；每次只查一跳，只覆盖当前可见的声明关系。

## 选路径

| 问题 | 路径 |
| --- | --- |
| 发行介质与完整曲序 | Release outgoing → Medium；全目录用 `GET /api/catalog/releases/{id}/toc` |
| 表达被哪些发行收录 | Expression incoming → Track；跨发行链用 `GET /api/catalog/entities/{id}/occurrences` |
| 作品章节 | Work outgoing → ContentUnit；直接子项用当前 `content_unit_parent` 规则 |
| 普通/限定/地区版 | `GET /api/catalog/releases/{id}/editions`；语义码从 definitions.document.relations 的 `usage=release_group` 选取（`--rules` 不含 usage） |
| 署名 | 从规则选 `relation:` 码，按方向与对端 kind 筛选，保留相关角色/上下文 |

只输出相关实体 ID、边与查询缺口。脚本不自动重放请求；失败不当空结果，只读结构 key 不作可写关系 UUID。
