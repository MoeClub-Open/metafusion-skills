import assert from "node:assert/strict";
import { test } from "node:test";

import {
  auditReleaseTOC,
  buildSnapshot,
  collectEntities,
  parseArgs,
  selectReleases,
} from "./mf-catalog-snapshot.mjs";

const release = (id, publisher, catalogNumber) => ({
  id,
  kind: "release",
  title: `Release ${id}`,
  attributes: { publisher, catalog_number: catalogNumber },
});

function tocFixture({ releaseId = "release-1", contents, subjects = [{ work_id: "work-1", role: "primary", position: 1 }], expressions = { "expression-1": {
  id: "expression-1", kind: "expression", work_id: "work-1",
} } } = {}) {
  const track = { id: "track-1", kind: "track", medium_id: "medium-1", position: 1 };
  if (contents !== undefined) track.contents = contents;
  return {
    release: { id: releaseId, kind: "release", subjects },
    media: [{
      medium: { id: "medium-1", kind: "medium", release_id: releaseId, position: 1 },
      tracks: [track],
    }],
    expressions,
    definition_etag: "fixture-etag",
  };
}

test("collectEntities 复用统一分页并保留 coverage", async () => {
  const offsets = [];
  const result = await collectEntities({
    kind: "release",
    limit: 2,
    requestFn: async (pathname) => {
      const url = new URL(pathname, "https://local.invalid");
      assert.equal(url.searchParams.get("kind"), "release");
      const offset = Number(url.searchParams.get("offset"));
      offsets.push(offset);
      return offset === 0
        ? { status: 200, body: { items: [release("r1", "p1", "AA-1"), release("r2", "p1", "AA-2")], total: 3 } }
        : { status: 200, body: { items: [release("r3", "p2", "BB-1")], total: 3 } };
    },
  });

  assert.deepEqual(offsets, [0, 2]);
  assert.equal(result.items.length, 3);
  assert.equal(result.coverage.complete, true);
  assert.equal(result.coverage.rawCount, 3);
});

test("collectEntities 将列表中的错 kind 记为不完整 coverage", async () => {
  const result = await collectEntities({
    kind: "release",
    requestFn: async () => ({ status: 200, body: { items: [{ id: "wrong-kind", kind: "work" }], total: 1 } }),
  });
  assert.equal(result.coverage.complete, false);
  assert.ok(result.coverage.failures.some((failure) => failure.reason === "kind_mismatch" && failure.id === "wrong-kind"));
  assert.throws(() => selectReleases(result.items, { all: true }), /collection coverage/);
});

test("publisher 与品番前缀各自筛选，联合时 AND，include-release 额外 OR", () => {
  const releases = [
    release("r1", { id: "p1" }, "AA-100"),
    release("r2", "p1", "BB-200"),
    release("r3", "p2", "AA-300"),
  ];
  assert.deepEqual(selectReleases(releases, { publisher: "p1" }).items.map((item) => item.id), ["r1", "r2"]);
  assert.deepEqual(selectReleases(releases, { catalogPrefix: "aa-" }).items.map((item) => item.id), ["r1", "r3"]);

  const combined = selectReleases(releases, {
    publisher: "p1",
    catalogPrefix: "AA-",
    includeRelease: ["r3"],
  });
  assert.deepEqual(combined.items.map((item) => item.id), ["r1", "r3"]);
  assert.equal(combined.scope.filter_logic, "AND");
  assert.equal(combined.scope.include_logic, "OR");
  assert.equal(combined.selectionReasons.r1[0].type, "scope_filters");
  assert.equal(combined.selectionReasons.r3[0].type, "include_release");
});

test("无范围不默认选全站，all 或显式发行 ID 才能继续", () => {
  assert.throws(() => selectReleases([], {}), /必须明确指定/);
  assert.equal(parseArgs(["--all"]).all, true);
  assert.deepEqual(parseArgs(["--include-release", "release-1"]).includeRelease, ["release-1"]);
  assert.throws(() => parseArgs([]), /请指定/);
});

test("TOC 直接读取 contents，不依赖 relations 判断收录", async () => {
  const paths = [];
  const result = await auditReleaseTOC("release-1", {
    requestFn: async (pathname) => {
      paths.push(pathname);
      return {
        status: 200,
        body: {
          ...tocFixture({ contents: [{ expression_id: "expression-1", position: 1, locator: {} }] }),
          relations: [],
        },
      };
    },
  });

  assert.deepEqual(paths, ["/api/catalog/releases/release-1/toc"]);
  assert.equal(result.complete, true);
  assert.equal(result.counts.contents, 1);
  assert.equal(result.counts.expressionReferences, 1);
  assert.equal(result.counts.visibleExpressions, 1);
  assert.equal(result.findings.some((item) => item.reason === "empty_contents_track"), false);
});

test("visibleExpressions 统计 distinct ID，重复收录引用单独计数", async () => {
  const body = tocFixture({ contents: [{ expression_id: "expression-1", position: 1, locator: {} }] });
  body.media[0].tracks.push({
    id: "track-2",
    kind: "track",
    medium_id: "medium-1",
    position: 2,
    contents: [{ expression_id: "expression-1", position: 1, locator: { page: 2 } }],
  });
  const result = await auditReleaseTOC("release-1", { requestFn: async () => ({ status: 200, body }) });
  assert.equal(result.complete, true);
  assert.equal(result.counts.expressionReferences, 2);
  assert.equal(result.counts.visibleExpressions, 1);
});

test("TOC 归属不符时报告 medium/track ID 未遍历", async () => {
  const wrongMedium = tocFixture({ contents: [] });
  wrongMedium.media[0].medium.release_id = "another-release";
  const mediumResult = await auditReleaseTOC("release-1", { requestFn: async () => ({ status: 200, body: wrongMedium }) });
  assert.equal(mediumResult.complete, false);
  assert.ok(mediumResult.untraversed.some((item) => item.kind === "medium" && item.id === "medium-1"));
  assert.ok(mediumResult.untraversed.some((item) => item.kind === "track" && item.id === "track-1"));

  const wrongTrack = tocFixture({ contents: [] });
  wrongTrack.media[0].tracks[0].medium_id = "another-medium";
  const trackResult = await auditReleaseTOC("release-1", { requestFn: async () => ({ status: 200, body: wrongTrack }) });
  assert.equal(trackResult.complete, false);
  assert.ok(trackResult.untraversed.some((item) => item.kind === "track" && item.id === "track-1"));
});

test("缺失 contents 或不可见 expression 是 unknown，不解释成空收录", async () => {
  const missingField = await auditReleaseTOC("release-1", {
    requestFn: async () => ({ status: 200, body: tocFixture({}) }),
  });
  assert.equal(missingField.complete, false);
  assert.equal(missingField.counts.emptyContentsTracks, 0);
  assert.ok(missingField.unknown.some((item) => item.reason === "track_contents_missing_or_invalid"));

  const invisible = await auditReleaseTOC("release-1", {
    requestFn: async () => ({
      status: 200,
      body: tocFixture({ contents: [{ expression_id: "hidden-expression", position: 1, locator: {} }], expressions: {} }),
    }),
  });
  assert.equal(invisible.complete, false);
  assert.ok(invisible.unknown.some((item) => item.reason === "expression_not_visible_in_toc"));
});

test("空 contents 数组是真空候选，subjects 覆盖按表达的 work_id 核对", async () => {
  const result = await auditReleaseTOC("release-1", {
    requestFn: async () => ({
      status: 200,
      body: tocFixture({ contents: [], subjects: [] }),
    }),
  });
  assert.equal(result.complete, true);
  assert.equal(result.counts.emptyContentsTracks, 1);
  assert.ok(result.findings.some((item) => item.reason === "empty_contents_track"));

  const notCovered = await auditReleaseTOC("release-1", {
    requestFn: async () => ({
      status: 200,
      body: tocFixture({ contents: [{ expression_id: "expression-1", position: 1, locator: {} }], subjects: [] }),
    }),
  });
  assert.equal(notCovered.complete, true);
  assert.ok(notCovered.findings.some((item) => item.reason === "expression_work_missing_from_subjects"));
});

test("完整结果仍只表示当前可见列表与 TOC 范围", async () => {
  const calls = [];
  const snapshot = await buildSnapshot({ includeRelease: ["release-explicit"] }, {
    requestFn: async (pathname) => {
      calls.push(pathname);
      if (pathname.startsWith("/api/catalog/entities?")) {
        return { status: 200, body: { items: [release("release-listed", "p1", "AA-1")], total: 1 } };
      }
      if (pathname === "/api/catalog/entities/release-explicit") {
        return { status: 200, body: { ...release("release-explicit", "p2", "BB-1"), subjects: [] } };
      }
      if (pathname === "/api/catalog/releases/release-explicit/toc") {
        return { status: 200, body: tocFixture({ releaseId: "release-explicit", contents: [], subjects: [] }) };
      }
      throw new Error(`Unexpected request path: ${pathname}`);
    },
  });

  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.scope.selected_count, 1);
  assert.equal(snapshot.collectionCoverage.complete, true);
  assert.match(snapshot.coverage_basis, /当前调用者可见/);
  assert.deepEqual(calls, [
    "/api/catalog/entities?kind=release&limit=100&offset=0",
    "/api/catalog/entities/release-explicit",
    "/api/catalog/releases/release-explicit/toc",
  ]);
});
