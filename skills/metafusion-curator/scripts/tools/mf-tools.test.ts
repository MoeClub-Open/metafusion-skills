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
import { mergeEntity, unionInto, identityConflicts } from "./mf-lib.ts";
import { checkBangumi, checkMusicBrainz, selectAuditLinks } from "./mf-audit-external-links.ts";

process.env.MF_BASE = "https://example.com";
process.env.MF_PAT = "test-token-not-a-real-credential";
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const linkPage = (id, relations) => json({subject_id: id, limit: 100, has_more: false, entities: {}, items: relations.map((r) => ({key:r.id, version:r.version, rule_code:`relation:${r.type}`, class:"semantic",source_id:r.source_id,target_id:r.target_id,position:r.position,attributes:r.attributes}))});
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
  state: "active", review_status: "reviewed",
  translations: { "en-US": { title: "Same" } },
  attributes: { tags: ["song"] },
  external_links: [{ kind: "isrc", url: "mf://external/isrc/USAAA2600001", external_id: "USAAA2600001" }],
  pictures: [],
  ...extras,
});
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function mergeFixture(keep, lose, { keepRels = [], loseRels = [], pushStatus = 200, pending = false,
  readbackFailure = false, stageStatus = 200, forkVersionChanged = false, lifecycleStatus = 200,
  pushThrows = false } = {}) {
  const calls = [];
  let currentKeep = structuredClone(keep), workspace, commit;
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, method, body });
    if (path === "/api/catalog/workspaces" && method === "POST") {
      workspace = { id: "workspace", version: 1, head_commit_id: null, objects: [
        { target: "entity", id: keep.id, base_version: keep.version + (forkVersionChanged ? 1 : 0), document: keep },
        { target: "entity", id: lose.id, base_version: lose.version, document: lose },
        ...loseRels.map((r) => ({ target: "relation", id: r.id, base_version: r.version, document: r })),
      ] };
      return json(workspace, 201);
    }
    if (path.endsWith("/changes")) {
      if (stageStatus !== 200) return json({ error: "version_conflict" }, stageStatus);
      assert.equal(method, "PUT");
      assert.equal(body.expected_version, workspace.version);
      workspace.version++;
      return json({ workspace, refs: {} });
    }
    if (path.endsWith("/commits") && method === "POST") {
      assert.equal(body.expected_version, workspace.version);
      commit = { id: body.id, workspace_id: workspace.id };
      workspace.version++;
      workspace.head_commit_id = body.id;
      return json(commit, 201);
    }
    if (path.endsWith("/push")) {
      if (pushThrows) throw new Error("network interrupted");
      if (pushStatus !== 200) return json({ error: "workspace_conflict" }, pushStatus);
      assert.equal(body.expected_version, workspace.version);
      assert.equal(body.expected_head, commit.id);
      if (pending) return json({ applied: false, workspace, commits: [commit], pull_request: { id: "pr" } }, 202);
      currentKeep = { ...currentKeep, ...unionInto(keep, lose, { kind: keep.kind }).entity, version: keep.version + 1 };
      return json({ applied: true, workspace, commits: [commit], pull_request: null });
    }
    if (path === "/api/catalog/workspaces/workspace") return json(workspace);
    if (path.endsWith("/lifecycle")) return json(lifecycleStatus === 200 ? { ...lose, state: "merged", redirect_id: keep.id } : { error: "forbidden" }, lifecycleStatus);
    if (path.endsWith(`${keep.id}/links`)) return linkPage(keep.id, keepRels);
    if (path.endsWith(`${lose.id}/links`)) return linkPage(lose.id, loseRels);
    if (path.endsWith(`/${keep.id}`)) return readbackFailure && currentKeep.version > keep.version ? json({ error: "forbidden" }, 403) : json(currentKeep);
    if (path.endsWith(`/${lose.id}`)) return json(lose);
    throw new Error(`Unexpected request: ${method} ${path}`);
  };
  return calls;
}

test("缺来源和查证记录不阻断副本提交或管理员身份合并", async () => {
  const keep = entity("keep"), lose = entity("lose", { attributes: { language: "ja" } });
  const calls = mergeFixture(keep, lose);
  const result = await mergeEntity({ kind: "work", keep, lose, dryRun: false });
  assert.equal(result.ok, true);
  assert.deepEqual(result.completedSteps, ["workspace_created", "staged", "committed", "workspace_merged", "lifecycle"]);
  assert.ok(calls.filter((c) => c.method !== "GET").every((c) => !Object.hasOwn(c.body, "sources")));
  assert.equal(calls.some((c) => c.path.endsWith("/candidates")), false);
  assert.equal(calls.some((c) => c.path === "/api/catalog/commits"), false);
});

test("预检版本变化和fork创建竞态不会覆盖正式目录", async () => {
  const keep = entity("keep"), lose = entity("lose", { attributes: { language: "ja" } });
  let calls = mergeFixture({ ...keep, version: 5 }, lose);
  let result = await mergeEntity({ kind: "work", keep, lose, dryRun: false });
  assert.match(result.reason, /version_conflict/);
  assert.ok(calls.every((c) => c.method === "GET"));
  calls = mergeFixture(keep, lose, { forkVersionChanged: true });
  result = await mergeEntity({ kind: "work", keep, lose, dryRun: false });
  assert.match(result.reason, /version_conflict/);
  assert.equal(calls.some((c) => c.path.endsWith("/changes")), false);
  assert.equal(result.applied, false);
});

test("并集及删除冗余边在同一副本一次暂存提交，不走旧写API", async () => {
  const keep = entity("keep"), lose = entity("lose", { attributes: { language: "ja" } });
  const edge = (id, source_id) => ({ id, source_id, target_id: "agent", type: "credit_for", attributes: {}, version: 2 });
  const calls = mergeFixture(keep, lose, { keepRels: [edge("keep-edge", keep.id)], loseRels: [edge("lose-edge", lose.id)] });
  const result = await mergeEntity({ kind: "work", keep, lose, dryRun: false });
  assert.equal(result.ok, true);
  assert.equal(result.edgeDeletes, 1);
  const operations = calls.find((c) => c.path.endsWith("/changes")).body.operations;
  assert.equal(operations.length, 2);
  assert.deepEqual(operations[1], { target: "relation", action: "delete", id: "lose-edge" });
  assert.equal(calls.some((c) => c.method === "DELETE" || c.method === "PUT" && !c.path.endsWith("/changes")), false);
});

test("PR待合入、真实冲突、暂存失败或未知push均停止生命周期，写入不重放", async () => {
  const keep = entity("keep"), lose = entity("lose", { attributes: { language: "ja" } });
  for (const options of [{ pending: true }, { pushStatus: 409 }, { stageStatus: 409 }, { pushThrows: true }]) {
    const calls = mergeFixture(keep, lose, options);
    const result = await mergeEntity({ kind: "work", keep, lose, dryRun: false });
    assert.equal(result.ok, false);
    assert.equal(result.partial, false);
    assert.equal(calls.some((c) => c.path.endsWith("/lifecycle")), false);
    assert.ok(calls.filter((c) => c.path.endsWith("/push")).length <= 1);
    if (options.pending) { assert.equal(result.reason, "pull_request_open_stop_merge"); assert.equal(result.applied, false); }
  }
});

test("正式目录已合入后回读失败或生命周期失败明确报告部分完成", async () => {
  const keep = entity("keep"), lose = entity("lose", { attributes: { language: "ja" } });
  for (const options of [{ readbackFailure: true }, { lifecycleStatus: 403 }]) {
    const calls = mergeFixture(keep, lose, options);
    const result = await mergeEntity({ kind: "work", keep, lose, dryRun: false });
    assert.equal(result.ok, false);
    assert.equal(result.partial, true);
    assert.equal(result.atomic, false);
    assert.equal(result.applied, true);
    assert.ok(result.completedSteps.includes("workspace_merged"));
    assert.equal(result.completedSteps.includes("lifecycle"), false);
    if (options.readbackFailure) assert.equal(calls.some((c) => c.path.endsWith("/lifecycle")), false);
  }
});

test("dry-run只读且无来源门槛；无事实并集时仅执行独立管理员生命周期动作", async () => {
  const keep = entity("keep"), lose = entity("lose");
  let calls = mergeFixture(keep, lose);
  const preview = await mergeEntity({ kind: "work", keep, lose });
  assert.equal(preview.ok, true);
  assert.deepEqual(preview.operations, []);
  assert.ok(calls.every((c) => c.method === "GET"));
  calls = mergeFixture(keep, lose);
  const applied = await mergeEntity({ kind: "work", keep, lose, dryRun: false });
  assert.equal(applied.ok, true);
  assert.equal(calls.filter((c) => c.method !== "GET").length, 1);
  assert.ok(calls.find((c) => c.method === "POST").path.endsWith("/lifecycle"));
});

test("外链并集冲突、不同身份与不同方向关系均不静默抹平", async () => {
  const keep = entity("keep");
  for (const patch of [{ role: "official" }, { url: "https://example.org/other" }]) {
    const result = unionInto(keep, entity("other", { external_links: [{ ...keep.external_links[0], ...patch }] }));
    assert.deepEqual(result.conflicts, ["external_links.isrc"]);
  }
  const lose = entity("lose", { translations: { "en-US": { title: "Other" } } });
  const calls = mergeFixture(keep, lose);
  const result = await mergeEntity({ kind: "work", keep, lose, dryRun: false });
  assert.equal(result.ok, false);
  assert.ok(calls.every((c) => c.method === "GET"));
});

test("收录并集保留同一表达的不同定位并避免位置冲突", () => {
  const first = { expression_id: "expr", position: 1, locator: { relative_to: "track", time_start_ms: 0 } };
  const second = { expression_id: "expr", position: 1, locator: { relative_to: "track", time_start_ms: 1000 } };
  const result = unionInto({ contents: [first] }, { contents: [second] }, { kind: "track" });
  assert.deepEqual(result.entity.contents.map((c) => c.locator.time_start_ms), [0, 1000]);
  assert.equal(new Set(result.entity.contents.map((c) => c.position)).size, 2);
  assert.equal(second.position, 1);
});

test("外部库权限或网络未知不能被归为所有类型 404", async () => {
  let count = 0;
  const result = await checkMusicBrainz(entity("work"), { kind: "musicbrainz", url: "https://musicbrainz.org/release-group/12345678-1234-1234-1234-123456789abc" }, {
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
      entity("agent", { kind: "agent", attributes: {} }),
      { kind: `bangumi_${type}`, url: `https://bgm.tv/${type}/1` },
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
  const match = await checkBangumi(entity("work"), { kind: "bangumi", url: "https://bgm.tv/subject/1" }, {
    lookup: async () => ({ status: 200, json: { name: "Same" } }),
  });
  assert.equal(match.ok, true);
  assert.equal(match.identity_verified, false);
  const unreadable = await checkBangumi(entity("work"), { kind: "bangumi", url: "https://bgm.tv/subject/1" }, {
    lookup: async () => ({ status: 200, json: {} }),
  });
  assert.equal(unreadable.ok, null);
});

test("外链审计覆盖专用类型并从 URL 取 ID", async () => {
  const mbid = "12345678-1234-1234-1234-123456789abc";
  const links = [
    { kind: "bangumi_person", url: "https://bgm.tv/person/1" },
    { kind: "bangumi_character", url: "https://bgm.tv/character/2" },
    { kind: "bangumi_episode", url: "https://bgm.tv/ep/3" },
    { kind: "musicbrainz_release", url: `https://musicbrainz.org/release/${mbid}` },
    { kind: "recording_mbid", url: `https://musicbrainz.org/recording/${mbid}` },
  ];
  assert.equal(selectAuditLinks({ external_links: links }, "bangumi").length, 3);
  assert.equal(selectAuditLinks({ external_links: links }, "musicbrainz").length, 2);
  let requested;
  const result = await checkMusicBrainz(entity("release"), links[3], {
    lookup: async (url) => { requested = new URL(url).pathname; return { status: 200, json: { title: "Same" } }; },
    pace: async () => {},
  });
  assert.equal(requested, `/ws/2/release/${mbid}`);
  assert.equal(result.ok, true);
  assert.equal(result.identity_verified, false);
});

test("外链审计区分错标路径与 ID 冲突", async () => {
  const mbid = "12345678-1234-1234-1234-123456789abc";
  const result = await checkMusicBrainz(entity("agent", { kind: "agent" }), { kind: "musicbrainz", url: `https://musicbrainz.org/release-group/${mbid}` }, {
    lookup: async (url) => new URL(url).pathname.includes("/artist/") ? { status: 200, json: { name: "Same" } } : { status: 404 },
    pace: async () => {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.matchedType, "artist");
  assert.equal(result.urlType, "release-group");
  let lookups = 0;
  const invalid = await checkBangumi(entity("agent"), { kind: "bangumi_person", url: "https://bgm.tv/person/1", external_id: "2" }, {
    lookup: async () => { lookups++; return { status: 404 }; },
  });
  assert.equal(invalid.ok, false);
  assert.equal(lookups, 0);
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
          external_links: [{ kind: "isrc", url: "mf://external/isrc/USAAA2600002", external_id: "USAAA2600002" }],
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
    await import("./mf-audit.ts?fixture");
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
    await assert.rejects(import("./mf-audit.ts?failed-list"), /HTTP 403/);
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
    await import("./mf-audit-provenance.ts?failed-revision");
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
      if (target.pathname.endsWith("/links"))
        return json({ error: "forbidden" }, 403);
      const items =
        target.searchParams.get("kind") === "work" ? [entity("work")] : [];
      return json({ items, total: items.length });
    };
    await import("./mf-check-structure.ts?failed-relation");
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
  state: "active", review_status: "reviewed",
  translations: { "ja-JP": { title: "DRIVE US CRAZY" } },
  attributes: {},
  external_links: [],
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
