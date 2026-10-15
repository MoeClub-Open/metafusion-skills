# MetaFusion API 载荷参考

本页是服务端 API 载荷示例的唯一维护处。提交前先读目标实例的 `/api/openapi.json` 与 `/api/catalog/definitions`；认证、字段码与可用值以实例为准，全站只有 `/api` 这一套前缀。工具参数和 plan schema 以相应工具 `--help` 为准，不在此复制。

## 请求头与证据

实体与关系写入位于 `/api/catalog/*`，需要登录；定义管理、导入与文件操作的路径见[接口范围](reference-endpoint-scope.md)。凭据三选一（都放在同一个请求头里）：

    Authorization: Bearer <会话令牌 / OAuth 访问令牌 / PAT>
    # PAT 是 `mfp_` 前缀的长期机器凭据：跑脚本或 Agent 时用它，不要共用某个人的会话令牌；
    # 它的有效权限 = 账号现时权限 ∩ 创建时选的 scopes（权限码），不够就 403，无效/吊销/过期是 401 invalid_token
    Content-Type: application/json
    Idempotency-Key: <uuid>        # handler 允许省略；仅创建实体 / 创建关系（非据 OpenAPI 缺席推断）
                                   # 持久 24h；键按操作 + 用户 + 请求键隔离，并保存载荷摘要。
                                   # 同键同载荷重放首次结果；同键异载荷 → 409 idempotency_conflict。

每次写入都要准备：

    "edit_note": "根据官方发行目录补充初版蓝光的品番与分集目录",
    "sources": [
      {"kind": "url", "citation": "发行方官方目录：支持 release.title、catalog_number、edition_date、subjects/contents", "url": "https://example.org/official-catalog"}
    ]

`sources[].kind` 只能是 `url` / `publication` / `self`；`citation` 必填并应明确列出所支持字段；带 `url` 时必须是可公开访问的 HTTP(S) 地址、不得含用户信息。缺 `edit_note` 或缺 `sources` 会被拒绝为 `evidence_required`——**这是服务端强制的载荷门，不代表证据权威或字段级合格**。

`self` 只能记录没有新增外部断言的维护、清理或限制说明，不能支撑题名、简介、编号、关系、身份锚点或封面权利。公开可访问的作者/机构自述应按 `url` 或 `publication` 登记，并仍按[字段级来源策略](reference-source-policy.md)判断是否满足核心门槛。服务端通过也不等于 CORE-P1 已核实。

## 变更集信封

Agent 普通编辑使用 checkout 与 CatalogCommit，完整协议只维护在[公开提交文档](https://github.com/MoeclubM/metafusion-docs/blob/main/docs/api-commits.md)，本地流程见[提交与恢复](reference-workflow.md)。操作携带 base_version、JSON Pointer patch；实体创建声明 reviewed_candidate_ids 与本批 ref。

**破坏性变更（无兼容模式）：** 每个 `sources[]` 必须有唯一 `key`；每个操作必须有非空 `source_refs`（`[{source:<key>, pointers?:[json-pointer]}]`）。缺 key → `source_key_required`；缺/空 `source_refs` → `400 {"error":"source_refs_required","applied":false,"operation":<从0起>}`；池中未被引用的来源 → `source_unused`。旧格式提交一律拒绝，客户端必须升级。本地 `mf-workspace commit` 会在缺省时自动补 `s1…` key 并把全部来源挂到每个操作；云端 MCP / 手写载荷必须自己写全。 本地默认映射要求所给来源确实支持每个操作；不同条目或字段使用不同证据时应拆分提交，不能把自动映射当作字段来源核验。

    {
      "id": "<固定 UUID>",
      "definitions_etag": "<checkout 返回值>",
      "edit_note": "根据官方目录补充题名",
      "sources": [
        {"key": "catalog", "kind": "url", "citation": "官方目录支持题名", "url": "https://example.org/catalog"}
      ],
      "operations": [
        {
          "target": "entity",
          "action": "update",
          "id": "<实体 UUID>",
          "base_version": 3,
          "reviewed_candidate_ids": [],
          "patch": [{"path": "/translations/zh-CN/title", "value": "中文题名"}],
          "source_refs": [{"source": "catalog", "pointers": ["/translations/zh-CN/title"]}]
        },
        {
          "target": "entity",
          "action": "create",
          "ref": "recording",
          "reviewed_candidate_ids": [],
          "document": {"kind": "expression", "title": "录音", "work_id": "<Work UUID>"},
          "source_refs": [{"source": "catalog"}]
        }
      ]
    }

## 单对象交互式信封

创建与更新共用同一信封：`POST /api/catalog/entities`（`expected_version` 必须为 0、`entity.id` 留空）与
`PUT /api/catalog/entities/{id}`（`expected_version` 为回读到的 `version`）。

    {
      "entity": { "...": "见下各 kind" },
      "expected_version": 0,
      "edit_note": "…",
      "sources": [{"kind": "url", "citation": "…", "url": "https://…"}]
    }

PUT 是**整实体替换**：带当前 `expected_version`，写后回读并逐字段核对。Track contents 可能因可见性被裁剪，不能把 GET 后整实体 PUT 说成能保全隐藏 contents；修改单条收录使用下文的专用 API。

状态切换由端点与 DTO 决定，不提交 `action`：`POST /api/catalog/entities/{id}/lifecycle` 的 `LifecycleEdit` 无 `action`（`target_id` 有值时合并，无值时删除）；发布走实体 `PUT` 并设 `entity.status: "published"`，至少需要一条翻译；`POST /api/catalog/entities/{id}/unpublish` 只允许 `published → draft`，其 DTO 不含 `target_id`。

本地 `mf-workspace` 与 `mf-track-content` 的 plan 字段和参数以各自 `--help` 为准。本页只维护服务端 API 请求形状；工具默认预览，执行开关不提供任务授权。

## 各 kind 允许的结构字段

| kind | 允许的归属字段（出现在实体上的结构性引用） | 备注 |
| --- | --- | --- |
| `agent` | 无 | 责任主体事实依实际字段、关系与来源表达 |
| `collection` | 无 | 聚合靠 `includes` 关系 |
| `work` | 无 | 创作署名走关系，不写字段 |
| `content_unit` | `work_id`、`parent_id` | `parent_id` 只能指向同一 Work 的目录项 |
| `expression` | `work_id`、`content_unit_id` | `content_unit_id` 若存在必须同 Work；**没有 `parent_id`** |
| `release` | 无（`subjects` 是唯一结构字段） | 不写 `work_id` |
| `medium` | `release_id`、`parent_id` | `parent_id` 只能指向同一 Release 的 Medium |
| `track` | `medium_id`、`parent_id`、`contents` | `parent_id` 只能指向同一 Medium；`contents` 是唯一收录来源 |

放错 kind 引用字段返回 `invalid_structural_field`；缺归属返回 `parent_required`。

## 动态属性字段

当前 Entity 不包含 types；可写属性取当前 `document.fields` 中 `applicable_kinds` 包含本 kind 的字段。展示模板和自由标签不改变可写范围。字段白名单、词表与结构化字段只维护在 [字段适用层级与结构化字段](reference-types-and-fields.md)，本页只给载荷示例。

注意两点易错项：

- 时长字段码是 **`duration`**（单位秒）；`duration_seconds` 会被严格解析拒收。
- 枚举字段（`format`、`packaging`、`role`、`edition_type`、`edition_batch`、`distribution_channel`、`entry_role`）
  的值是**词项代码**；不存在的码会被拒绝为 `invalid_term`。

## agent

    POST /api/catalog/entities
    {
      "entity": {
        "kind": "agent",
        "title": "新海诚",
        "original_language": "ja",
        "attributes": {},
        "translations": {
          "ja": {"title": "新海誠"},
          "zh-CN": {"title": "新海诚", "aliases": ["Makoto Shinkai"]},
          "en-US": {"title": "Makoto Shinkai"}
        },
        "status": "draft"
      },
      "expected_version": 0,
      "edit_note": "根据官方作品页建立创作者主体",
      "sources": [{"kind": "url", "citation": "官方作品页", "url": "https://example.org/creator"}]
    }

## work

    POST /api/catalog/entities
    {
      "entity": {
        "kind": "work",
        "title": "秒速5厘米",
        "original_language": "ja",
        "attributes": {"tags": ["动画", "剧场版"]},
        "external_ids": {},
        "pictures": [
          {
            "url": "https://example.org/covers/5cm.jpg",
            "caption": {"zh-CN": "官方海报", "en-US": "Official poster"},
            "source": {"kind": "url", "citation": "官方站点海报", "url": "https://example.org/official"}
          }
        ],
        "translations": {
          "ja": {"title": "秒速5センチメートル"},
          "zh-CN": {"title": "秒速5厘米", "summary": "作品级简介", "body": "## 创作背景\n根据外部资料撰写条目说明。[^official]\n\n[^official]: https://example.org/official", "aliases": ["5cm/s"]},
          "en-US": {"title": "5 Centimeters per Second", "summary": "English summary"}
        },
        "status": "draft"
      },
      "expected_version": 0,
      "edit_note": "根据官方作品页建立创作母体",
      "sources": [{"kind": "url", "citation": "官方作品页", "url": "https://example.org/official"}]
    }

- `title` 是基础题名，`original_language` 声明它属于哪个语种；原语言题名放在对应 locale 的 `translations` 行里。
- `external_ids` 的键必须来自实例预设；作品/发行/主体的官方站点用 `official_website` 记**完整 URL**
  （前端"外部资料"面板据此渲染官网入口并排在首位），核到官网就不要让它留在空对象里。
- `pictures[].url` 必须是绝对 HTTP(S) 地址：相对路径（如 `/assets/covers/x.webp`）会被拒绝为 `invalid_picture`。图片须匹配具体实体/发行版；当前任务的图片操作授权与版权/许可材料分开记录。明确的任务操作授权可在其范围内执行，但不等于权利已核实；权利材料未知时报告 `unknown`，不能写成 `passed`。计数条件按本次批次定义。
- 图片可带 `version_label`（多语言）、`usage_period: {begin?, end?}`（至少一端非空）、`role`（启用的 `picture_role` 词表码）与 `asset_id`（存储资产 UUID）；使用时段不表示版权期限。数组首项是手动封面，`taken_at` 不决定排序。自托管图片先完成 `cover_image` 绑定，再写 `asset_id` 并回读，流程见[文件上传与绑定](reference-file-upload.md)。
- **不要**提交顶层 `cover_aspect` / `cover_image_url`：它们不在写入 DTO 里，严格解析会直接 `400 invalid_payload`。

## content_unit

    {
      "entity": {
        "kind": "content_unit",
        "work_id": "<work-uuid>",
        "title": "第 1 话：樱花抄",
        "number": "1",
        "position": 1,
        "attributes": {},
        "translations": {
          "zh-CN": {"title": "第 1 话：樱花抄", "summary": ""},
          "en-US": {"title": "Episode 1: Cherry Blossom"}
        },
        "status": "draft"
      },
      "expected_version": 0,
      "edit_note": "根据官方分集目录建立内容单位",
      "sources": [{"kind": "url", "citation": "官方分集目录", "url": "https://example.org/episodes"}]
    }

`position` 是排序，`number` 是印刷/官方编号（字符串，保留 `A1`、`EX` 这类原文，不要改写成整数）。
目录树用同一 Work 内的 `parent_id` 表达：卷、部、篇可以建 group 型 content_unit，再挂子项。

## expression

    {
      "entity": {
        "kind": "expression",
        "work_id": "<work-uuid>",
        "content_unit_id": "<content-unit-uuid>",
        "title": "第 1 话 正片母版",
        "position": 1,
        "attributes": {"language": "ja", "duration": 1560},
        "translations": {
          "zh-CN": {"title": "第 1 话 正片母版"},
          "en-US": {"title": "Episode 1 master"}
        },
        "status": "draft"
      },
      "expected_version": 0,
      "edit_note": "按官方分集目录建立可复用表达",
      "sources": [{"kind": "url", "citation": "官方分集目录", "url": "https://example.org/episodes"}]
    }

`content_unit_id` 可以省略（表达直接挂在 Work 下）；给定时必须属于同一 Work。
表达是**被 Track 复用的那一层**：同一录音、正文或母版在多个发行里复用；Work 身份相同不代表 Expression 相同，现场、伴奏、混音等按实际表达区分。

## release

    {
      "entity": {
        "kind": "release",
        "title": "日本官方初版蓝光",
        "original_language": "ja",
        "subjects": [
          {"work_id": "<main-work-uuid>", "role": "primary", "position": 0},
          {"work_id": "<bonus-work-uuid>", "role": "compilation", "position": 1}
        ],
        "attributes": {
          "catalog_number": "VWBS-1531",
          "barcode": "4988104044952",
          "edition_date": "2008-04-18",
          "edition_type": "boxset",
          "edition_batch": "first_press",
          "country": "JPN",
          "packaging": "boxset",
          "distribution_channel": "physical"
        },
        "translations": {
          "ja": {"title": "日本官方初版 Blu-ray"},
          "zh-CN": {"title": "日本官方初版蓝光", "summary": "单碟发行"}
        },
        "status": "draft"
      },
      "expected_version": 0,
      "edit_note": "根据发行方目录核对品番、日期与包装",
      "sources": [{"kind": "url", "citation": "发行方目录", "url": "https://example.org/release"}]
    }

- **`release` 没有 `work_id`**。`subjects` 列出被其载体实际收录表达的**全部** Work；`role` 取 `release_role` 词表
  （`primary` 主作品 / `compilation` 汇编作品 / `supplement` 附加作品）。同一 `(work_id, role)` 只能出现一次。
- 发行中作为曲目收录的 Work 使用 `track_work` role（可含官方确认的影音作品），且仅在当前 `document.vocabularies.release_role.terms.track_work.enabled` 时可用；它是 Release subject role，不是关系码。先写正确 subjects，再维护 Track contents；两者的跨实体步骤不是原子事务。
- **发行版的版名由 `title` 承载**：没有 `edition_name` 字段。品番、条码、日期、版本类别、包装等字段码以
  `GET /api/catalog/definitions` 声明为准，未声明的码会被拒绝。
- 枚举字段填**词项代码**而不是显示名：`packaging` 取 `standard` / `jewel` / `slipcase` / `box` / `boxset` / `digipak`，
  `edition_type` 取 `standard` / `limited` / `deluxe` / `boxset`，`distribution_channel` 取
  `mixed` / `physical` / `digital` / `web`。显示名由前端按词表本地化，不要提交中文或英文显示名。
- `publisher` 是 **entity 型字段**，值是主体实体 ID（字段名就是 `publisher`）；
  与创作者/机构的署名关系仍走关系接口。

## medium

    {
      "entity": {
        "kind": "medium",
        "release_id": "<release-uuid>",
        "title": "Disc 1",
        "position": 1,
        "attributes": {"format": "bd", "role": "primary"},
        "translations": {
          "zh-CN": {"title": "第 1 张蓝光"},
          "en-US": {"title": "Disc 1"}
        },
        "status": "draft"
      },
      "expected_version": 0,
      "edit_note": "按盒内实物顺序登记主载体",
      "sources": [{"kind": "url", "citation": "包装实物图", "url": "https://example.org/package"}]
    }

`parent_id` 只能指向同一 Release 的 Medium（分卷、子容器）。`format` 取词项代码
（`cd` / `bd` / `uhd_bd` / `dvd` / `vinyl` / `sacd` / `cassette` / `paper` / `digital` / `web`），
`role` 取 `primary` / `supplement` / `side` / `extra` / `commentary`；多碟装各自的品番写在 `medium.attributes.catalog_number`。

## track

下例是服务端创建载荷。`mf-workspace` 可在同一批中先建作用域与表达，再以 `$ref` 创建 Track.contents；已存在 Track 的隐藏收录仍使用专用 contents 端点。

    {
      "entity": {
        "kind": "track",
        "medium_id": "<medium-uuid>",
        "title": "第 1 话：樱花抄",
        "position": 1,
        "attributes": {"duration": 1560, "role": "primary"},
        "contents": [
          {
            "expression_id": "<expression-uuid>",
            "position": 1,
            "locator": {"relative_to": "track", "time_start_ms": 0, "time_end_ms": 1560000}
          }
        ],
        "translations": {
          "zh-CN": {"title": "第 1 话：樱花抄"},
          "en-US": {"title": "Episode 1: Cherry Blossom"}
        },
        "status": "draft"
      },
      "expected_version": 0,
      "edit_note": "按蓝光目录建立第 1 轨并关联表达",
      "sources": [{"kind": "url", "citation": "碟面目录", "url": "https://example.org/disc-1"}]
    }

- **`contents` 是唯一收录来源**，新版项为 `{expression_id, position, locator, attributes?, sources?}`；先核目标实例 DTO，旧版可能不接受 sources。
  单内容引用走 `contents`（`expression_id` + `position` + `locator`），不要另加引用字段。
- `Track.contents` 是结构性收录，不是 relations。Release `subjects` 先声明实际收录的 Work，再建立对应 Track contents；两步不具跨实体原子性。
- **Track 上没有 `work_id`**：所属 Work 由 `medium → release → subjects` 推导。
  提交 `work_id` 会因为不在该 kind 的允许字段里被拒绝。
- 同一 Track 内 `position` 唯一；同一 `expression_id` **且 locator 完全相同**才算重复收录。
  同一表达按不同时间段切片可以在同一 Track 多次出现（如混音轨引用 0–30s 与 60–90s）。
- `locator` 按当前 definitions 的组字段校验；锚点与区间规则见 [定位字段](reference-types-and-fields.md#locator)，整轨收录允许空 locator。

书籍场景的 locator 示例：

    "locator": {"relative_to": "medium", "page_start": 12, "page_end": 40, "chapter": "第 1 章"}

### 单条收录（先核 OpenAPI 支持）

    POST /api/catalog/tracks/<track-uuid>/contents
    {
      "inclusion": {
        "expression_id": "<expression-uuid>",
        "position": 0,
        "locator": {},
        "attributes": {},
        "sources": [{"kind": "url", "citation": "官方目录确认本轨收录该录音", "url": "https://example.org/disc"}]
      },
      "expected_version": 7,
      "edit_note": "依据官方曲目表增加本轨录音收录",
      "sources": [{"kind": "url", "citation": "官方曲目表", "url": "https://example.org/disc"}]
    }

expected_version 来自 Track。PUT `/api/catalog/tracks/{id}/contents/{position}` 使用相同信封，URL 为回读的旧位置，inclusion.position 可以重排。DELETE 同路径只提交 expected_version/edit_note/sources；不要省略请求体。写后回读 Track、occurrences 与修订，409 时回读并合并；不要根据不可见记录的猜测位置操作。不可见收录或旧 position 无法核实时停止该项操作并报告未知。Track contents 来源省略规则见[API 行为参考](reference-api-behavior.md)。

### 单独修改状态（先核 OpenAPI 支持）

    PATCH /api/catalog/tracks/<track-uuid>/status
    {
      "status": "published",
      "expected_version": 7,
      "edit_note": "核对官方曲序与现有收录后发布",
      "sources": [{"kind": "url", "citation": "官方曲序：支持已核对的 Track 发布状态", "url": "https://example.org/disc"}]
    }

DTO 不含 `entity` 或 `contents`，服务端在事务内保留完整收录；`status` 仅接受 draft/pending_review/published，并遵循现有生命周期权限。已发布实体降级走 unpublish，不能借本端点绕过。缺端点不回退整实体 PUT。

## 关系

    POST /api/catalog/relations
    {
      "relation": {
        "type": "adaptation_of",
        "source_id": "<work-uuid>",
        "target_id": "<other-work-uuid>",
        "position": 0,
        "attributes": {}
      },
      "expected_version": 0,
      "edit_note": "官方说明该作为原作的改编",
      "sources": [{"kind": "url", "citation": "官方说明", "url": "https://example.org/about"}]
    }

- 关系码与允许的两端 `source_kinds` / `target_kinds` 来自 `GET /api/catalog/definitions` 的 `document.relations`，
  只使用其中 `enabled` 的条目；关系码清单只从 `document.relations` 取。
  方向、端点与属性及约束见 [关系规则](reference-relations.md)。
- 更新用 `PUT /api/catalog/relations/{id}`；删除用 `DELETE /api/catalog/relations/{id}`，
  **必须带 body**（`expected_version` + `edit_note` + `sources`），不带版本 → 409，完全不带 body → 400。

## 读回检查

不要只凭 2xx 判定成功。至少重新 GET：

- `/api/catalog/entities/{id}`（实体本体与 `version`）；
- `/api/catalog/entities/{id}/relations`（关系与对端实体）；
- `/api/catalog/entities/{id}/occurrences`（表达/内容单位的反向收录）；
- `/api/catalog/entities/{id}/revisions`（核对本次修订与证据；快照及可见性限制见[API 行为参考](reference-api-behavior.md)）；
- 实例支持时，`/api/catalog/expressions/{id}/composition` 与 `/api/catalog/releases/{id}/editions` 核对直接组成和显式版本组；不由 subjects 推测；
- 实体对比用 `/api/catalog/compare?ids=<id1>,<id2>`，返回 `items[].entity` 与 `items[].children`；发行/载体的子项形状是 `{medium, tracks}`，其他 kind 的 `children` 为空。

核对返回的 ID、归属（work / release / medium）、`position`、翻译回退、`pictures` 与 revision 内容是否与预期一致。
收到 409 `version_conflict` 时先回读再决定是否重放；响应不明时先查状态，不要盲目重试创建或自动删除已成功的数据。

## 外部来源只读查询

写导入路径（`POST /api/importer/*` 与 `catalog.import.submit`）已删除。使用：

- `GET /api/external-sources` — 列出真有适配器的来源（bangumi/dlsite/dmm）
- `POST /api/external-sources/query` — `op=search|lookup|detail`，返回 raw + FetchMeta（url/fetched_at/content_hash）；lookup/detail 另含既有 preview 映射

落库请走实体 / 关系端点或提交工作流；外部库 GUI 注册新码不会自动实现抓取适配器。
需要逐项审查、失败可恢复与可追溯修订时，使用上面的实体与关系端点。
