#!/usr/bin/env node
// 实体层级合规审查（只读）：创作链（Work→CU→Expression）、承载链（Release→Medium→Track）、
// 跨链引用（Track.contents→Expression、Release.subjects→Work）与关系边规则（自环、端点类型契约）。
//
// 用法：node mf-check-structure.mjs
//
// 客户端统一走技能自带 metafusion-api.mjs（经 ./mf-lib.mjs）；取数失败即抛错，
// 绝不退化成空集后给出"0 违规"的假通过。

import { call, relationsOf, sleep } from "./mf-lib.mjs";



console.log("=== 正在运行线上实体层级与结构合规性系统性审查 ===");
const t0 = Date.now();

// 0. 加载服务端关系与实体元规则定义
console.log("正在加载元数据模型 definitions 与 relationship_rules 规则...");
const defsRes = await call("/api/catalog/definitions");
if (defsRes.status !== 200 || !defsRes.body) throw new Error("读取 definitions 失败 HTTP " + defsRes.status);
const ruleMap = new Map();
const definitions = defsRes.body.document || defsRes.body;
for (const [code, rule] of Object.entries(definitions.relations || {})) ruleMap.set(code, rule);
for (const r of defsRes.body?.relationship_rules || []) {
  const shortCode = r.code.replace(/^(relation:|structure:)/, "");
  if (!ruleMap.has(shortCode)) ruleMap.set(shortCode, r);
  if (!ruleMap.has(r.code)) ruleMap.set(r.code, r);
}
console.log("已加载关系定义规则: " + (defsRes.body?.relationship_rules?.length || 0) + " 条");

// 1. 抽样审计核心实体
const kinds = ["work", "content_unit", "expression", "release", "medium", "track"];
const sampleMap = new Map();
const entityCache = new Map();

for (const kind of kinds) {
  const r = await call("/api/catalog/entities?kind=" + kind + "&limit=50&sort=updated_at&order=desc");
  if (r.status !== 200 || !Array.isArray(r.body?.items)) throw new Error("读取抽样列表失败 kind=" + kind + " HTTP " + r.status);
  const items = r.body.items;
  for (const item of items) {
    sampleMap.set(item.id, item);
    entityCache.set(item.id, item);
  }
  console.log("已抽检 " + kind + " 最近 50 条记录 (总库共 " + (r.body?.total || items.length) + " 条)");
}

async function getEntity(id) {
  if (!id) return null;
  if (entityCache.has(id)) return entityCache.get(id);
  const r = await call("/api/catalog/entities/" + id);
  if (r.status === 200 && r.body) {
    entityCache.set(id, r.body);
    return r.body;
  }
  if (r.status === 404) return null;
  throw new Error("读取引用目标失败 HTTP " + r.status);
}

const violations = [];
const unknown = [];
const stats = {
  checkedEntities: sampleMap.size,
  creationChain: {
    cuChecked: 0,
    cuValid: 0,
    exprChecked: 0,
    exprValid: 0,
  },
  bearingChain: {
    mediumChecked: 0,
    mediumValid: 0,
    trackChecked: 0,
    trackValid: 0,
  },
  crossChain: {
    trackContentsChecked: 0,
    trackContentsValidExpr: 0,
    trackReleaseSubjectsChecked: 0,
    trackReleaseSubjectsMatch: 0,
    releaseSubjectsChecked: 0,
    releaseSubjectsValidWork: 0,
  },
  relations: {
    edgesChecked: 0,
    selfLoops: 0,
    invalidEndpoints: 0,
    validEdges: 0,
  }
};

// 2. 深度检查创作链、承载链与跨链引用
console.log("\n正在审查创作链、承载链与跨链引用...");
for (const [id, e] of sampleMap.entries()) {
  if (e.status === "deleted" || e.status === "merged") continue;

  // 创作链：content_unit 是否带 work_id，且 work_id 有效
  if (e.kind === "content_unit") {
    stats.creationChain.cuChecked++;
    if (!e.work_id) {
      violations.push({ level: "P0", entityId: e.id, kind: e.kind, rule: "cu_missing_work_id", msg: "content_unit 缺少必填父级 work_id" });
    } else {
      const parentWork = await getEntity(e.work_id);
      if (!parentWork || parentWork.kind !== "work") {
        violations.push({ level: "P0", entityId: e.id, kind: e.kind, rule: "cu_invalid_parent_work", msg: "content_unit 父级 work_id (" + e.work_id + ") 不存在或非 work 类型" });
      } else {
        stats.creationChain.cuValid++;
      }
    }
  }

  // 创作链：expression 是否带 work_id，且 work_id 有效
  if (e.kind === "expression") {
    stats.creationChain.exprChecked++;
    if (!e.work_id) {
      violations.push({ level: "P0", entityId: e.id, kind: e.kind, rule: "expr_missing_work_id", msg: "expression 缺少必填父级 work_id" });
    } else {
      const parentWork = await getEntity(e.work_id);
      if (!parentWork || parentWork.kind !== "work") {
        violations.push({ level: "P0", entityId: e.id, kind: e.kind, rule: "expr_invalid_parent_work", msg: "expression 父级 work_id (" + e.work_id + ") 不存在或非 work 类型" });
      } else {
        stats.creationChain.exprValid++;
      }
    }
  }

  // 承载链：medium 是否带 release_id，且 release_id 有效
  if (e.kind === "medium") {
    stats.bearingChain.mediumChecked++;
    if (!e.release_id) {
      violations.push({ level: "P0", entityId: e.id, kind: e.kind, rule: "medium_missing_release_id", msg: "medium 缺少必填父级 release_id" });
    } else {
      const parentRelease = await getEntity(e.release_id);
      if (!parentRelease || parentRelease.kind !== "release") {
        violations.push({ level: "P0", entityId: e.id, kind: e.kind, rule: "medium_invalid_parent_release", msg: "medium 父级 release_id (" + e.release_id + ") 不存在或非 release 类型" });
      } else {
        stats.bearingChain.mediumValid++;
      }
    }
  }

  // 承载链：track 是否带 medium_id，且 medium_id 有效
  if (e.kind === "track") {
    stats.bearingChain.trackChecked++;
    if (!e.medium_id) {
      violations.push({ level: "P0", entityId: e.id, kind: e.kind, rule: "track_missing_medium_id", msg: "track 缺少必填父级 medium_id" });
    } else {
      const parentMedium = await getEntity(e.medium_id);
      if (!parentMedium || parentMedium.kind !== "medium") {
        violations.push({ level: "P0", entityId: e.id, kind: e.kind, rule: "track_invalid_parent_medium", msg: "track 父级 medium_id (" + e.medium_id + ") 不存在或非 medium 类型" });
      } else {
        stats.bearingChain.trackValid++;
      }
    }

    // 跨链引用：track.contents 是否指向有效 expression，且所属 release.subjects 完整声明了其 work
    if (Array.isArray(e.contents) && e.contents.length > 0) {
      for (const item of e.contents) {
        stats.crossChain.trackContentsChecked++;
        if (!item.expression_id) {
          violations.push({ level: "P1", entityId: e.id, kind: e.kind, rule: "missing_expression_id", msg: "track.contents 项缺少 expression_id" });
          continue;
        }
        const expr = await getEntity(item.expression_id);
        if (!expr || expr.kind !== "expression") {
          violations.push({ level: "P0", entityId: e.id, kind: e.kind, rule: "invalid_track_content_expression", msg: "track.contents 引用的 expression (" + item.expression_id + ") 不存在或非 expression" });
        } else {
          stats.crossChain.trackContentsValidExpr++;
          // 向上反查 release.subjects 是否完整声明了该 expression 的所属 work_id
          if (e.medium_id) {
            const med = await getEntity(e.medium_id);
            if (med && med.release_id) {
              const rel = await getEntity(med.release_id);
              if (rel && Array.isArray(rel.subjects)) {
                stats.crossChain.trackReleaseSubjectsChecked++;
                const declared = rel.subjects.some((s) => s.work_id === expr.work_id);
                if (!declared) {
                  violations.push({
                    level: "P0",
                    entityId: rel.id,
                    kind: "release",
                    rule: "undeclared_release_subject",
                    msg: "Release " + rel.id + " 未在其 subjects 中完整声明 Track " + e.id + " 引用的 Expression " + expr.id + " 所属 Work " + expr.work_id,
                  });
                } else {
                  stats.crossChain.trackReleaseSubjectsMatch++;
                }
              }
            }
          }
        }
      }
    }
  }

  // 跨链引用：release.subjects 是否规范且指向有效 Work
  if (e.kind === "release") {
    if (e.subjects !== null && e.subjects !== undefined) {
      if (!Array.isArray(e.subjects)) {
        violations.push({ level: "P1", entityId: e.id, kind: e.kind, rule: "malformed_subjects", msg: "release.subjects 不是数组类型" });
      } else {
        for (const s of e.subjects) {
          stats.crossChain.releaseSubjectsChecked++;
          if (!s.work_id) {
            violations.push({ level: "P1", entityId: e.id, kind: e.kind, rule: "subject_missing_work_id", msg: "release.subjects 项缺少 work_id" });
          } else {
            const w = await getEntity(s.work_id);
            if (!w || w.kind !== "work") {
              violations.push({ level: "P0", entityId: e.id, kind: e.kind, rule: "subject_invalid_work", msg: "release.subjects 中的 work_id (" + s.work_id + ") 不存在或非 work 类型" });
            } else {
              stats.crossChain.releaseSubjectsValidWork++;
            }
          }
        }
      }
    }
  }
}

// 3. 抽样审查实体关系边：自环与端点 definitions 合规性
console.log("正在审查关系边规则（自环、端点类型契约）...");
const sampleEntities = Array.from(sampleMap.values()).slice(0, 30);
const seenRelIds = new Set();

for (const se of sampleEntities) {
  try {
    const rels = await relationsOf(se.id);
    for (const rel of rels) {
      if (seenRelIds.has(rel.id)) continue;
      seenRelIds.add(rel.id);
      stats.relations.edgesChecked++;

      // 规则：无自环 (self loop)
      if (rel.source_id === rel.target_id) {
        stats.relations.selfLoops++;
        violations.push({ level: "P0", entityId: rel.id, kind: "relation", rule: "self_loop", msg: "关系两端相同构成自环: " + rel.type + " (" + rel.source_id + ")" });
        continue;
      }

      // 规则：端点类型必须符合 definitions
      const rule = ruleMap.get(rel.type);
      if (!rule || rule.enabled === false) {
        violations.push({ level: "P1", entityId: rel.id, kind: "relation", rule: "unknown_relation_type", msg: "未在 definitions 中注册的关系类型: " + rel.type });
        continue;
      }

      const src = await getEntity(rel.source_id);
      const tgt = await getEntity(rel.target_id);
      if (!src || !tgt) {
        violations.push({
          level: "P0",
          entityId: rel.id,
          kind: "relation",
          rule: "dangling_relation_endpoint",
          msg: "关系端点实体缺失: " + rel.type + " (source: " + rel.source_id + " [" + !!src + "], target: " + rel.target_id + " [" + !!tgt + "])",
        });
        continue;
      }

      if (!Array.isArray(rule.source_kinds) || !Array.isArray(rule.target_kinds)) throw new Error("关系定义缺少端点约束: " + rel.type);
      if (!rule.source_kinds.includes(src.kind) || !rule.target_kinds.includes(tgt.kind)) {
        stats.relations.invalidEndpoints++;
        violations.push({
          level: "P0",
          entityId: rel.id,
          kind: "relation",
          rule: "invalid_endpoints",
          msg: "关系端点类型不符合定义: " + rel.type + " (源: " + src.kind + ", 目标: " + tgt.kind + "; 期望源 ∈ [" + rule.source_kinds.join(",") + "], 期望目标 ∈ [" + rule.target_kinds.join(",") + "])",
        });
      } else {
        stats.relations.validEdges++;
      }
    }
  } catch (err) {
    unknown.push({ entity_id: se.id, reason: String(err) });
  }
}

const elapsed = Date.now() - t0;
console.log("\n=== 实体层级合规审查报告 ===");
console.log("审查总耗时: " + elapsed + "ms");
console.log("抽样实体总数: " + stats.checkedEntities);
console.log("指标统计:");
console.log("  [创作链] ContentUnit work_id: " + stats.creationChain.cuValid + "/" + stats.creationChain.cuChecked + " 合规");
console.log("  [创作链] Expression work_id: " + stats.creationChain.exprValid + "/" + stats.creationChain.exprChecked + " 合规");
console.log("  [承载链] Medium release_id: " + stats.bearingChain.mediumValid + "/" + stats.bearingChain.mediumChecked + " 合规");
console.log("  [承载链] Track medium_id: " + stats.bearingChain.trackValid + "/" + stats.bearingChain.trackChecked + " 合规");
console.log("  [跨链引用] Track.contents 引用 Expression: " + stats.crossChain.trackContentsValidExpr + "/" + stats.crossChain.trackContentsChecked + " 有效");
console.log("  [跨链引用] Release.subjects 包含 Track 所引 Work: " + stats.crossChain.trackReleaseSubjectsMatch + "/" + stats.crossChain.trackReleaseSubjectsChecked + " 完整匹配");
console.log("  [跨链引用] Release.subjects 声明 Work 有效性: " + stats.crossChain.releaseSubjectsValidWork + "/" + stats.crossChain.releaseSubjectsChecked + " 有效");
console.log("  [关系规则] 关系边自环与端点校验: " + stats.relations.validEdges + "/" + stats.relations.edgesChecked + " 合规 (自环数: " + stats.relations.selfLoops + ", 端点违规: " + stats.relations.invalidEndpoints + ")");
console.log("发现违规总数: " + violations.length);
console.log("未能核验的关系样本: " + unknown.length);

if (violations.length > 0) {
  console.log("违规明细:", JSON.stringify(violations, null, 2));
  process.exitCode = 1;
} else if (unknown.length) {
  console.log("结论未确认：部分关系读取或定义检查失败", JSON.stringify(unknown));
  process.exitCode = 1;
} else {
  console.log("本次抽样未发现已执行检查项的结构违规；未证明全库或并发状态合规，未核验完整 DAG。");
}
