import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { identityPatch, rebasePatch } from "./mf-workspace.mjs";
import { mergeEntity, unionInto, identityConflicts } from "./mf-lib.mjs";
import { checkBangumi, checkMusicBrainz } from "./mf-audit-external-links.mjs";

process.env.MF_BASE = "https://example.com";
process.env.MF_PAT = "test-token-not-a-real-credential";
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const sources = [
  {
    kind: "url",
    url: "https://example.org/official",
    citation: "官方目录：支持两端身份、language 与收录关系",
  },
];
const entity = (id, extras = {}) => ({
  id,
  kind: "work",
  title: "Same",
  version: 4,
  status: "published",
  translations: { "en-US": { title: "Same" } },
  attributes: { tags: ["song"] },
  external_links: { isrc: "USAAA2600001" },
  pictures: [],
  ...extras,
});
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function mergeFixture(
  keep,
  lose,
  {
    keepRels = [],
    loseRels = [],
    deleteStatus = 204,
    deleteNetworkFailure = false,
    readbackFailure = false,
    candidateRows,
    candidateResponse,
    candidateStatus = 200,
    commitStatus = 200,
  } = {},
) {
  const calls = [];
  let currentKeep = structuredClone(keep);
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, method, body });
    if (path.endsWith("/definitions")) return json({ etag: "defs" });
    if (path.endsWith("/candidates")) {
      const rows = candidateRows ?? [keep, lose].map((e) => ({ matched: e, canonical: e }));
      return json(candidateResponse ?? { basis: "postgres_repeatable_read", total: rows.length, complete: true, items: rows }, candidateStatus);
    }
    if (path.endsWith("/commits")) {
      if (identityPatch(body.operations[0].patch)) assert.ok(Array.isArray(body.operations[0].reviewed_candidate_ids));
      else assert.equal(Object.hasOwn(body.operations[0], "reviewed_candidate_ids"), false);
      if (commitStatus !== 200) return json({ error: "identity_candidates_changed",
        identity_review: { operation: 0, candidate_ids: [lose.id, "10000000-0000-0000-0000-000000000001"] } }, commitStatus);
      currentKeep = {
        ...rebasePatch(currentKeep, currentKeep, body.operations[0].patch)
          .working,
        version: currentKeep.version + 1,
      };
      return json({
        id: body.id,
        applied: true,
        refs: {},
        items: [
          {
            target: "entity",
            id: currentKeep.id,
            version: currentKeep.version,
            changed: true,
            merged: false,
          },
        ],
      });
    }
    if (method === "DELETE") {
      if (deleteNetworkFailure) throw new Error("network interrupted");
      return deleteStatus === 204
        ? new Response(null, { status: 204 })
        : json({ error: "version_conflict" }, deleteStatus);
    }
    if (method === "POST") return json({ ...lose, status: "merged" });
    if (path.endsWith(`${keep.id}/relations`)) return json({ items: keepRels });
    if (path.endsWith(`${lose.id}/relations`)) return json({ items: loseRels });
    if (path.endsWith(`/${keep.id}`))
      return readbackFailure && currentKeep.version > keep.version
        ? json({ error: "forbidden" }, 403)
        : json(currentKeep);
    if (path.endsWith(`/${lose.id}`)) return json(lose);
    throw new Error(`Unexpected request: ${method} ${path}`);
  };
  return calls;
}

test("合并实际写入缺真实来源或只有 self 时不发请求", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("must not request");
  };
  for (const evidence of [[], [{ kind: "self", citation: "same name" }]]) {
    const result = await mergeEntity({
      kind: "work",
      keep: entity("keep"),
      lose: entity("lose"),
      dryRun: false,
      sources: evidence,
    });
    assert.equal(result.ok, false);
    assert.equal(result.partial, false);
  }
  assert.equal(calls, 0);
});

test("预检版本变化时不把旧并集覆盖到新实体", async () => {
  const keep = entity("keep"),
    lose = entity("lose");
  const calls = mergeFixture({ ...keep, version: 5 }, lose);
  const result = await mergeEntity({
    kind: "work",
    keep,
    lose,
    dryRun: false,
    sources,
  });
  assert.match(result.reason, /version_conflict/);
  assert.ok(calls.every((c) => c.method === "GET"));
});

test("同名但官方身份锚点冲突、冲突字段都不能合并", async () => {
  for (const lose of [
    entity("lose", { external_links: { isrc: "USAAA2600002" } }),
    entity("lose", { translations: { "en-US": { title: "Other" } } }),
  ]) {
    const keep = entity("keep");
    const calls = mergeFixture(keep, lose);
    const result = await mergeEntity({
      kind: "work",
      keep,
      lose,
      dryRun: false,
      sources,
    });
    assert.equal(result.ok, false);
    assert.ok(calls.every((c) => c.method === "GET"));
  }
});

test("收录并集保留同一表达的不同定位并避免位置冲突", () => {
  const first = {
    expression_id: "expr",
    position: 1,
    locator: { relative_to: "track", time_start_ms: 0 },
  };
  const second = {
    expression_id: "expr",
    position: 1,
    locator: { relative_to: "track", time_start_ms: 1000 },
  };
  const result = unionInto(
    { contents: [first] },
    { contents: [second] },
    { kind: "track" },
  );
  assert.equal(result.entity.contents.length, 2);
  assert.deepEqual(
    result.entity.contents.map((c) => c.locator.time_start_ms),
    [0, 1000],
  );
  assert.equal(new Set(result.entity.contents.map((c) => c.position)).size, 2);
  assert.equal(second.position, 1);
});

test("合并身份并集复核完整候选并排除保留方 canonical aliases", async () => {
  const keep = entity(randomUUID()),
    lose = entity(randomUUID(), { external_links: { ...keep.external_links, wikidata: "Q123" } }),
    alias = entity(randomUUID(), { status: "merged" });
  const calls = mergeFixture(keep, lose, { candidateRows: [
    { matched: keep, canonical: keep }, { matched: alias, canonical: keep }, { matched: lose, canonical: lose },
  ] });
  const result = await mergeEntity({ kind: "work", keep, lose, dryRun: false, sources });
  assert.equal(result.ok, true);
  const query = calls.find((c) => c.path.endsWith("/candidates")).body;
  assert.deepEqual(query.titles, ["Same", "Same"]);
  assert.ok(query.external_links.some((p) => p.provider === "wikidata" && p.value === "Q123"));
  assert.deepEqual(calls.find((c) => c.path.endsWith("/commits")).body.operations[0].reviewed_candidate_ids, [lose.id]);
});

test("合并发现第三 canonical 身份默认在全部写入前停止，显式审查后可继续", async () => {
  const keep = entity(randomUUID()),
    lose = entity(randomUUID(), { external_links: { ...keep.external_links, wikidata: "Q123" } }),
    other = entity(randomUUID()),
    rows = [keep, lose, other].map((e) => ({ matched: e, canonical: e }));
  let calls = mergeFixture(keep, lose, { candidateRows: rows });
  const blocked = await mergeEntity({ kind: "work", keep, lose, dryRun: false, sources });
  assert.equal(blocked.reason, "identity_review_required");
  assert.equal(blocked.partial, false);
  assert.deepEqual(blocked.unreviewed_candidate_ids, [other.id]);
  assert.ok(calls.every((c) => c.method === "GET" || c.path.endsWith("/candidates")));
  calls = mergeFixture(keep, lose, { candidateRows: rows });
  const reviewed = await mergeEntity({ kind: "work", keep, lose, dryRun: false, sources, reviewedCandidateIDs: [other.id] });
  assert.equal(reviewed.ok, true);
  assert.deepEqual(calls.find((c) => c.path.endsWith("/commits")).body.operations[0].reviewed_candidate_ids, [lose.id, other.id].sort());
});

test("合并身份候选按结构归属查询；错 scope、截断、未解析或失败均禁止写入", async () => {
  for (const [kind, scopeField] of [["expression", "work_id"], ["content_unit", "work_id"], ["medium", "release_id"], ["track", "medium_id"]]) {
    const keep = entity(randomUUID(), { kind, [scopeField]: randomUUID() }),
      lose = entity(randomUUID(), { ...keep, id: randomUUID(), external_links: { ...keep.external_links, wikidata: "Q123" } });
    const calls = mergeFixture(keep, lose);
    const dry = await mergeEntity({ kind, keep, lose, sources });
    assert.equal(dry.ok, true);
    assert.equal(calls.find((c) => c.path.endsWith("/candidates")).body[scopeField], keep[scopeField]);
    assert.deepEqual(dry.reviewed_candidate_ids, [lose.id]);
    assert.ok(calls.every((c) => c.method === "GET" || c.path.endsWith("/candidates")));
  }
  const keep = entity(randomUUID(), { kind: "medium", release_id: randomUUID() }),
    lose = entity(randomUUID(), { ...keep, id: randomUUID(), external_links: { ...keep.external_links, wikidata: "Q123" } });
  for (const options of [
    { candidateRows: [{ matched: { ...lose, release_id: randomUUID() }, canonical: lose }] },
    { candidateRows: [{ matched: lose, canonical: null }] },
    { candidateResponse: { basis: "postgres_repeatable_read", total: 2, complete: false, items: [{ matched: lose, canonical: lose }] } },
    { candidateResponse: { error: "rate_limited" }, candidateStatus: 429 },
  ]) {
    const calls = mergeFixture(keep, lose, options);
    const result = await mergeEntity({ kind: "medium", keep, lose, dryRun: false, sources });
    assert.equal(result.reason, "identity_review_unverified");
    assert.ok(calls.every((c) => c.method === "GET" || c.path.endsWith("/candidates")));
  }
});

test("并发改变候选使合并commit返回409时不删边也不执行lifecycle", async () => {
  const keep = entity(randomUUID()),
    lose = entity(randomUUID(), { external_links: { ...keep.external_links, wikidata: "Q123" } }),
    edge = (id, source_id) => ({ id, source_id, target_id: "agent", type: "credit_for", attributes: {}, version: 1 });
  const calls = mergeFixture(keep, lose, { commitStatus: 409,
    keepRels: [edge("keep-edge", keep.id)], loseRels: [edge("lose-edge", lose.id)] });
  const result = await mergeEntity({ kind: "work", keep, lose, dryRun: false, sources });
  assert.equal(result.reason, "identity_candidates_changed");
  assert.equal(result.partial, false);
  assert.deepEqual(result.completedSteps, []);
  assert.ok(result.identity_review.candidate_ids.includes(lose.id));
  assert.equal(calls.some((c) => c.method === "DELETE" || c.path.endsWith("/lifecycle")), false);
});

test("合并已审列表不能包含自身、无效ID或本次未命中的第三对象", async () => {
  const keep = entity(randomUUID()), lose = entity(randomUUID(), { external_links: { ...keep.external_links, wikidata: "Q123" } });
  for (const reviewedCandidateIDs of [[keep.id], ["not-a-uuid"], [lose.id, lose.id], null]) {
    const calls = mergeFixture(keep, lose);
    const result = await mergeEntity({ kind: "work", keep, lose, dryRun: false, sources, reviewedCandidateIDs });
    assert.equal(result.reason, "invalid_identity_review");
    assert.ok(calls.every((c) => c.method === "GET"));
  }
  const calls = mergeFixture(keep, lose);
  const result = await mergeEntity({ kind: "work", keep, lose, dryRun: false, sources, reviewedCandidateIDs: [randomUUID()] });
  assert.equal(result.reason, "identity_candidates_changed");
  assert.ok(calls.every((c) => c.method === "GET" || c.path.endsWith("/candidates")));
});

test("删重复关系失败后不继续 lifecycle，并明确并集已提交", async () => {
  const keep = entity("keep"),
    lose = entity("lose", { attributes: { language: "ja" } });
  const edge = (id, source_id) => ({
    id,
    source_id,
    target_id: "agent",
    type: "credit_for",
    attributes: {},
    version: 2,
  });
  const calls = mergeFixture(keep, lose, {
    keepRels: [edge("keep-edge", keep.id)],
    loseRels: [edge("lose-edge", lose.id)],
    deleteStatus: 409,
  });
  const result = await mergeEntity({
    kind: "work",
    keep,
    lose,
    dryRun: false,
    sources,
  });
  assert.equal(result.ok, false);
  assert.equal(result.partial, true);
  assert.equal(result.atomic, false);
  assert.deepEqual(result.completedSteps, ["keep_union"]);
  assert.equal(result.edgeDeletes, 0);
  assert.equal(
    calls.some((c) => c.path.endsWith("/lifecycle")),
    false,
  );
  assert.ok(
    calls
      .filter((c) => c.method !== "GET")
      .every((c) => c.body.sources[0].kind === "url"),
  );
});

test("反方向独立关系不当作重复边删除", async () => {
  const keep = entity("keep"),
    lose = entity("lose");
  const calls = mergeFixture(keep, lose, {
    keepRels: [
      {
        id: "keep-edge",
        source_id: keep.id,
        target_id: "agent",
        type: "related_to",
        attributes: {},
        version: 1,
      },
    ],
    loseRels: [
      {
        id: "lose-edge",
        source_id: "agent",
        target_id: lose.id,
        type: "related_to",
        attributes: {},
        version: 1,
      },
    ],
  });
  const result = await mergeEntity({
    kind: "work",
    keep,
    lose,
    dryRun: false,
    sources,
  });
  assert.equal(result.ok, true);
  assert.equal(
    calls.some((c) => c.method === "DELETE"),
    false,
  );
  assert.equal(calls.filter((c) => c.method === "POST").length, 1);
});

test("删除网络失败不当作成功，写后读取失败报告已完成步骤", async () => {
  for (const options of [
    { deleteNetworkFailure: true },
    { readbackFailure: true },
  ]) {
    const keep = entity("keep"),
      lose = entity("lose", { attributes: { language: "ja" } });
    const edge = (id, source_id) => ({
      id,
      source_id,
      target_id: "agent",
      type: "credit_for",
      attributes: {},
      version: 2,
    });
    const calls = mergeFixture(keep, lose, {
      keepRels: [edge("keep-edge", keep.id)],
      loseRels: [edge("lose-edge", lose.id)],
      ...options,
    });
    const result = await mergeEntity({
      kind: "work",
      keep,
      lose,
      dryRun: false,
      sources,
    });
    assert.equal(result.ok, false);
    assert.equal(result.partial, true);
    assert.deepEqual(result.completedSteps, ["keep_union"]);
    assert.equal(
      calls.some((c) => c.path.endsWith("/lifecycle")),
      false,
    );
    assert.equal(result.edgeDeletes, 0);
  }
});

test("外部库权限或网络未知不能被归为所有类型 404", async () => {
  let count = 0;
  const result = await checkMusicBrainz(entity("work"), "external", {
    lookup: async () => ({ status: ++count === 1 ? 403 : 404 }),
    pace: async () => {},
  });
  assert.equal(result.ok, null);
  assert.deepEqual(result.unknownStatuses, [403]);
  assert.equal(result.identity_verified, false);
});

test("Bangumi 主体查 persons/characters，403 为未知且同名不证明身份", async () => {
  for (const [type, resource] of [
    ["person", "persons"],
    ["character", "characters"],
  ]) {
    let requested;
    const result = await checkBangumi(
      entity("agent", { kind: "agent", attributes: { tags: [type] } }),
      "1",
      {
        lookup: async (url) => {
          requested = new URL(url).pathname;
          return { status: 403 };
        },
      },
    );
    assert.equal(requested, `/v0/${resource}/1`);
    assert.equal(result.ok, null);
  }
  const match = await checkBangumi(entity("work"), "1", {
    lookup: async () => ({ status: 200, json: { name: "Same" } }),
  });
  assert.equal(match.ok, true);
  assert.equal(match.identity_verified, false);
});

async function isolatedAudit(run) {
  const directory = mkdtempSync(join(tmpdir(), "metafusion-tools-test-"));
  const oldOutput = process.env.MF_AUDIT_OUT;
  const oldLog = console.log;
  const oldExit = process.exitCode;
  const logs = [];
  process.env.MF_AUDIT_OUT = directory;
  console.log = (...args) => logs.push(args.join(" "));
  try {
    await run(directory, logs);
  } finally {
    console.log = oldLog;
    process.exitCode = oldExit;
    if (oldOutput === undefined) delete process.env.MF_AUDIT_OUT;
    else process.env.MF_AUDIT_OUT = oldOutput;
    assert.ok(realpathSync(directory).startsWith(realpathSync(tmpdir()) + sep));
    rmSync(directory, { recursive: true, force: true });
  }
}

test("审计保留真实断链/覆盖问题和未知项，不把可选篇目引用当必填", async () => {
  await isolatedAudit(async (directory) => {
    const byKind = {
      work: [
        entity("song"),
        entity("album", {
          attributes: { tags: ["album"] },
          external_links: { isrc: "USAAA2600002" },
        }),
      ],
      content_unit: [
        {
          id: "cu",
          kind: "content_unit",
          title: "Chapter",
          work_id: "hidden-work",
        },
      ],
      expression: [
        { id: "expr", kind: "expression", title: "Recording", work_id: "song" },
      ],
      release: [
        { id: "release", kind: "release", title: "Release", subjects: [] },
      ],
      medium: [
        { id: "medium", kind: "medium", title: "CD", release_id: "release" },
      ],
      track: [
        {
          id: "track",
          kind: "track",
          title: "Track",
          medium_id: "medium",
          contents: [
            { expression_id: "expr" },
            { expression_id: "hidden-expr" },
          ],
        },
      ],
      agent: [],
      collection: [],
    };
    globalThis.fetch = async (url, init = {}) => {
      assert.equal(init.method || "GET", "GET");
      const target = new URL(url);
      if (target.pathname === "/api/catalog/entities") {
        const items = byKind[target.searchParams.get("kind")];
        return json({ items, total: items.length });
      }
      return json({ error: "not_found" }, 404);
    };
    await import("./mf-audit.mjs?fixture");
    const report = JSON.parse(
      readFileSync(join(directory, "gap-report.json"), "utf8"),
    );
    assert.equal(report.summary.dangling_refs.missing, 2);
    assert.equal(report.summary.dangling_refs.empty_ref, 0);
    assert.equal(report.summary.undeclared_release_subjects_tracks, 1);
    assert.equal(report.coverage.subject_checks_unknown, 1);
    assert.equal(report.coverage.current_sources_verified, false);
    assert.equal(report.duplicates.work.groups, 1);
    assert.equal(report.coverage.duplicate_identity_verified, false);
    const markdown = readFileSync(join(directory, "gap-report.md"), "utf8");
    assert.match(markdown, /subjects 未覆盖 1 条，未能核验 1 条/);
    assert.doesNotMatch(markdown, /断链复核结果为空/);
  });
});

test("列表权限失败不生成空库通过报告", async () => {
  await isolatedAudit(async (directory) => {
    globalThis.fetch = async () => json({ error: "forbidden" }, 403);
    await assert.rejects(import("./mf-audit.mjs?failed-list"), /HTTP 403/);
    assert.equal(existsSync(join(directory, "gap-report.json")), false);
  });
});

test("来源线索读取失败必须输出未知而非来源通过", async () => {
  await isolatedAudit(async (directory) => {
    globalThis.fetch = async (url) => {
      const target = new URL(url);
      if (target.pathname.endsWith("/revisions"))
        return json({ error: "forbidden" }, 403);
      const items =
        target.searchParams.get("kind") === "work" ? [entity("work")] : [];
      return json({ items, total: items.length });
    };
    await import("./mf-audit-provenance.mjs?failed-revision");
    const report = JSON.parse(
      readFileSync(join(directory, "provenance-audit.json"), "utf8"),
    );
    assert.equal(report.flagged, 0);
    assert.equal(report.unknown, 1);
    assert.equal(report.current_sources_verified, false);
  });
});

test("抽样关系读取失败不得声称全部结构合规", async () => {
  await isolatedAudit(async (_directory, logs) => {
    globalThis.fetch = async (url) => {
      const target = new URL(url);
      if (target.pathname.endsWith("/definitions"))
        return json({ document: { relations: {} } });
      if (target.pathname.endsWith("/relations"))
        return json({ error: "forbidden" }, 403);
      const items =
        target.searchParams.get("kind") === "work" ? [entity("work")] : [];
      return json({ items, total: items.length });
    };
    await import("./mf-check-structure.mjs?failed-relation");
    assert.equal(process.exitCode, 1);
    assert.ok(logs.some((line) => line.includes("结论未确认")));
    assert.ok(logs.every((line) => !line.includes("全部 100%")));
  });
});
// ── 2026-10-03 merge-safe-apply 回归：expression 的 version_label 是身份字段 ──
const expr = (id, extras = {}) => ({
  id,
  kind: "expression",
  title: "DRIVE US CRAZY",
  version: 2,
  status: "published",
  translations: { "ja-JP": { title: "DRIVE US CRAZY" } },
  attributes: {},
  external_links: {},
  pictures: [],
  ...extras,
});
test("expression version_label 两侧不等 → 身份冲突", () => {
  const a = expr("a", { attributes: { version_label: "Studio Recording" } });
  const b = expr("b", { attributes: { version_label: "Live, 東京公演" } });
  const cs = identityConflicts(a, b);
  assert.ok(
    cs.some((c) => String(c).includes("version_label")),
    "必须拒绝：不同录音版本",
  );
});
test("expression version_label 单侧缺失 → 身份冲突（禁止把现场标签并进无标签录音室表达）", () => {
  const a = expr("a", {});
  const b = expr("b", { attributes: { version_label: "RUMBLEHEADZ DAY2" } });
  assert.ok(
    identityConflicts(a, b).some((c) => String(c).includes("version_label")),
  );
});
test("expression 两侧都无 version_label → 不因该字段拒绝（其余守卫仍适用）", () => {
  const a = expr("a", {});
  const b = expr("b", { attributes: {} });
  assert.ok(
    !identityConflicts(a, b).some((c) => String(c).includes("version_label")),
  );
});
test("非 expression（work 同名双胞胎）不受 version_label 单侧缺失影响", () => {
  const a = expr("a", { kind: "work" });
  const b = expr("b", { kind: "work", attributes: { version_label: "X" } });
  assert.ok(
    !identityConflicts(a, b).some((c) => String(c).includes("version_label")),
  );
});
