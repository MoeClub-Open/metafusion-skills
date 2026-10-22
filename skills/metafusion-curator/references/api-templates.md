# API 载荷

统一前缀 `/api`。执行前读取目标实例 `/api/openapi.json` 与 `/api/catalog/definitions`；字段、词项和关系码由实例决定。请求使用 `Authorization: Bearer <令牌>` 和 `Content-Type: application/json`，凭据不放进 JSON 文件。

普通编辑只有服务器工作副本这一条路径；来源依据、source_refs、身份查证数组都不是工作副本请求字段。已有真实资料不因协议迁移而清空。

## 协作载荷

创建副本：

```http
POST /api/catalog/workspaces
```

```json
{"name":"修订发行资料","entity_ids":["11111111-1111-4111-8111-111111111111"],"relation_ids":[]}
```

返回 workspace 的 id、version、head_commit_id、objects 与 dirty_count。objects 区分 base、committed 和 document；新副本还没有 head。后续 checkout 用 `POST /api/catalog/workspaces/{id}/checkout`，传 `{expected_version,entity_ids,relation_ids}` 加入其他正式对象。

暂存已有对象修改：

```http
PUT /api/catalog/workspaces/{id}/changes
```

```json
{
  "expected_version":1,
  "operations":[
    {"target":"entity","action":"update","id":"11111111-1111-4111-8111-111111111111","patch":[
      {"path":"/title","value":"发行方使用的原始名称"},
      {"path":"/attributes/obsolete_field","remove":true}
    ]}
  ]
}
```

示例字段需换成当前定义中实际存在的字段，删除路径也须对应实际事实。`patch` 使用 JSON Pointer；value 可以是 null，删除使用 remove。对象字段逐键处理，数组按完整值替换。`mf-workspace stage --file operations.json` 的文件内容只放上例 operations 数组。

新建多个关联对象时按依赖顺序声明 ref：

```json
{
  "expected_version":2,
  "operations":[
    {"target":"entity","action":"create","ref":"work","document":{
      "kind":"work","title":"桜","original_language":"ja","translations":{"ja":{"title":"桜"}},"attributes":{}
    }},
    {"target":"entity","action":"create","ref":"expression","document":{
      "kind":"expression","work_id":{"$ref":"work"},"title":"桜","original_language":"ja","translations":{"ja":{"title":"桜"}},"attributes":{}
    }},
    {"target":"relation","action":"create","ref":"edge","document":{
      "type":"created_by","source_id":{"$ref":"work"},"target_id":"01a1...已有对象id","attributes":{}
    }}
  ]
}
```

名称仅为载荷示例，不构成真实编目。返回 `refs` 将本批 ref 映射到稳定 UUID；之后的 stage 和 commit 直接使用该 UUID。关系的 `source_id`、`target_id` 同样可用 `{"$ref":"refname"}` 指向同批新建的实体，所以「新建人 + 挂署名边」在一个提交里就能完成，不必先推送再回读 ID。document 直接放 Entity 或 Relation，不包 entity/relation，不填写服务端 id、version、state 等字段。

提交、推送：

```http
POST /api/catalog/workspaces/{id}/commits
```

```json
{"id":"22222222-2222-4222-8222-222222222222","expected_version":3,"message":"修订发行资料"}
```

```http
POST /api/catalog/workspaces/{id}/push
```

```json
{"expected_version":4,"expected_head":"22222222-2222-4222-8222-222222222222","title":"修订发行资料"}
```

commit 的 author 是执行提交的账号，authors 保留修改贡献者，merged_by 单独记录合并者。PR 的只读 source_base_id 固定本次提交链基线。

version 使用最新读取的副本值；commit 后必要时 GET 副本获取，不按例子或提交次数递增猜测。push 前提交所有未提交改动。`applied=true` 才改变正式目录；普通用户返回 `applied=false` 及 PR。非副本成员的审核人合并时，结果中的 workspace 可为 null；只读取返回的冻结 PR 和提交，不再获取源副本。连续多次 commit 后可一同 push；同一个已确认 head 的 push 可读取相同合入结果或 PR。

PR 可用 `POST /api/catalog/pull-requests` 创建，传 `{workspace_id,expected_version,expected_head,title}`；读取 `/api/catalog/pull-requests/{id}`。合并传 PR 自己的 version 与 source_head_id：

```http
POST /api/catalog/pull-requests/{id}/merge
```

```json
{"expected_version":1,"expected_head":"22222222-2222-4222-8222-222222222222"}
```

副本成员替换用 `PUT /api/catalog/workspaces/{id}/members` 和 `{expected_version,user_ids}`；只有拥有者可管理成员。工作副本与 PR 列表按实例的 limit/offset 分页，不能把一页视作全集。

## 冲突解决

push 或 PR merge 的 `workspace_conflict` 返回每个冲突的 base/current/proposed、pointer、current_version。rebase 使用以下请求；resolutions 的 value 是明确选择或手动合并后的 JSON 值，不是 ours/theirs 字符串指令：

```http
POST /api/catalog/workspaces/{id}/rebase
```

```json
{
  "id":"33333333-3333-4333-8333-333333333333",
  "expected_version":5,
  "expected_head":"22222222-2222-4222-8222-222222222222",
  "message":"合并并发题名修改",
  "resolutions":[
    {"commit_id":"22222222-2222-4222-8222-222222222222","target":"entity","id":"11111111-1111-4111-8111-111111111111","pointer":"/title","current_version":8,"value":"合并后的题名"}
  ]
}
```

删除路径传 remove=true，不能同时带 value。pointer 原样使用冲突响应中的值；整对象级冲突不能随意当作单字段处理。本地 `rebase --file rebase.json` 接收原生请求对象（含 resolutions），version/head 由已读取的副本固定；commit_id 取重放冲突的 source_commit_id，后续冲突保留先前解决项。rebase 生成新提交而不改变正式目录，随后重新 push。

## 模型 DTO

| kind | 结构字段 |
| --- | --- |
| agent / collection / work | 没有固定父级 |
| content_unit | 必须 work_id，可有同 Work 的 parent_id |
| expression | 必须 work_id，可有同 Work 的 content_unit_id；没有 parent_id |
| release | subjects 声明 Work，没有 work_id |
| medium | 必须 release_id，可有同 Release 的 parent_id |
| track | 必须 medium_id，可有同 Medium 的 parent_id；contents 引用 Expression |

- title 保存对象自身名称。Work 只写作品名，Release 原样保存发行方的版本名称；不自行添加 `[CD]`、品番或“初版”等后缀。
- translations 是 `{locale:{title,summary?,body?,aliases?}}`，原语言内容也可满足语言资料要求。没有官方中文译名时不补造。
- attributes 使用当前适用于 kind 的字段；枚举填词项 code。外部标识是 `external_links:[{kind,url,external_id?}]`，不是旧 external_ids 对象。
- subjects 是 `[{work_id,role,position,attributes?}]`。Track.contents 是 `[{expression_id,position,locator,attributes?,sources?}]`，收录来源可省略。
- Relation document 是 `{type,source_id,target_id,attributes?}`；两端 kind、方向和属性由 definitions.document.relations 决定。
- Track 的单条收录可暂存 `{"target":"entity","action":"content","id":"TRACK_UUID","content_change":{"action":"replace","position":0,"inclusion":{"expression_id":"EXPRESSION_UUID","position":0,"locator":{}}}}`；content_change.position 使用副本中当前记录位置，未知或不可见内容不可凭猜测覆盖。
- pictures 是图片数组，url 为绝对 HTTP(S)，可带 caption、source、asset_id 等；图片来源可省略，已有资料保留。正文与图片仍通过副本提交，文件上传另见[文件绑定](file-upload.md)。

字段形状见[字段](types-and-fields.md)，层级与复用见[数据模型](data-model.md)，并发恢复见[工作流程](workflow.md)。外部来源只读查询使用 `/api/external-sources`，不直接写目录。
