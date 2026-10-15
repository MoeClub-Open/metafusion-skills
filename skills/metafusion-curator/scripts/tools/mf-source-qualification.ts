// 字段证据资格与 API 运营方分开；社区资料可作证据，核心身份结论仍核字段与作用域。
const auxiliary = (scope, fieldLimits = []) => ({
  level: "AUX-P2", can_independently_support_core_identity: false,
  scope, field_limits: fieldLimits,
});
const primary = (scope, fieldLimits = []) => ({
  level: "CORE-P1", can_independently_support_core_identity: true,
  scope, field_limits: fieldLimits,
});

const QUALIFICATIONS = {
  discogs: auxiliary("社区编目的具体发行版与辅助字段"),
  openlibrary: auxiliary("社区书目记录；对应版本、题名与外部标识需另核"),
  internetarchive: auxiliary("上传件与存档；存档继承原页面的字段来源资格", ["不得把上传者资料当权利方声明"]),
  tmdb: auxiliary("电影、剧集及人物的聚合资料"),
  anilist: auxiliary("动画与漫画的聚合资料"),
  myanimelist: auxiliary("动画与漫画的聚合资料"),
  kitsu: auxiliary("动画与漫画的社区资料", ["简介引用的原始出处另核", "海报不自动对应发行版"]),
  vndb: auxiliary("视觉小说、角色、人员及版次的社区资料", ["品番、条码与身份归属须核原始出处"]),
  coverartarchive: auxiliary("release_of_record 指向发行版的社区图片", ["逐张核图像内容、具体版次及权利"]),
  musicbrainz: auxiliary("音乐社区编目与标识候选", ["MBID 命中或题名相符不自动证明同一对象"]),
  wikidata: auxiliary("社区知识库的声明与候选标识", ["逐条核声明引用的原始来源"]),
  bangumi: auxiliary("社区作品、人物与角色资料"),
  vgmdb: auxiliary("社区发行目录与辅助署名"),
  openbd: auxiliary("日本出版物 ONIX 书目复核", ["正式题名以版元商品页为准", "丛书序号不等于卷号", "未收录不代表不存在"]),
  gutenberg: primary("Project Gutenberg 自己发行的数字版次", ["不能单独证明原作 Work 的身份、题名、作者或首发日", "公版声明仅覆盖声明地域"]),
  isni: primary("登记机构自己的 ISNI 记录与明示字段"),
  viaf: primary("VIAF 聚合登记标识与明示权威记录", ["不为未展示的作品或发行关系背书"]),
  oclc: primary("OCLC FAST 词表自己的标识与明示字段", ["本连接器不读取 WorldCat 书目"]),
  ndl: primary("NDL 权威记录自己的标识与明示字段"),
  itunes: primary("Apple Music/iTunes 对应商店的具体数字发行", ["图片文件名条码仅为候选", "不能移用到实体或其他版次"]),
  steam: primary("Steam AppID 对应地区与语种的商店发行", ["AppID、题名和发行类型核对后归位", "不能移用到其他平台或版次"]),
  umj: primary("Universal Music Japan 明示的商品与对应品番"),
  publisher: primary("注册出版方或授权渠道自己的商品与对应品番", ["未明确归版的图片和价格只作候选"]),
};

export function sourceQualification(source) {
  const entry = QUALIFICATIONS[source] || auxiliary("来源资格尚未登记；按字段核原始出处");
  return { ...entry, field_limits: [...entry.field_limits] };
}
