import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  collectPages,
  listAll,
  normalizePageLimit,
  request,
  writableEntity,
} from "./metafusion-api.mjs";

process.env.MF_BASE = "https://example.com";
process.env.MF_PAT = "test-token-not-a-real-credential";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function currentEntity() {
  return {
    id: "entity-1",
    kind: "work",
    version: 4,
    title: "Example",
    original_language: "en-US",
    attributes: { language: "en" },
    external_links: {},
    pictures: [],
    translations: {
      "en-US": { title: "Example", summary: "Official summary" },
    },
    status: "draft",
    created_by: "user-1",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

test("normalizePageLimit 拒绝目标实例不会接受的边界", () => {
  assert.equal(normalizePageLimit(), 100);
  assert.equal(normalizePageLimit(1), 1);
  for (const invalid of [0, -1, 101, 1.5, Number.NaN]) {
    assert.throws(() => normalizePageLimit(invalid), /1–100/);
  }
});

test("collectPages 推进真实 offset 并核对完整分页", async () => {
  const calls = [];
  const pages = new Map([
    [0, { status: 200, body: { items: [{ id: "a" }, { id: "b" }], total: 3 } }],
    [2, { status: 200, body: { items: [{ id: "c" }], total: 3 } }],
  ]);
  const result = await collectPages("/api/catalog/entities", {
    params: { kind: "release" },
    limit: 2,
    requestFn: async (pathname) => {
      const url = new URL(pathname, "https://local.invalid");
      calls.push({
        offset: Number(url.searchParams.get("offset")),
        limit: Number(url.searchParams.get("limit")),
      });
      return pages.get(Number(url.searchParams.get("offset")));
    },
  });

  assert.deepEqual(calls, [
    { offset: 0, limit: 2 },
    { offset: 2, limit: 2 },
  ]);
  assert.deepEqual(
    result.items.map((item) => item.id),
    ["a", "b", "c"],
  );
  assert.deepEqual(result.coverage, {
    basis: "当前调用者可见的列表范围",
    pages: 2,
    total: 3,
    rawCount: 3,
    uniqueCount: 3,
    duplicateIds: [],
    complete: true,
    failures: [],
  });
});

test("collectPages 不把 total 未满足的短页或空页当完整", async () => {
  const offsets = [];
  const result = await collectPages("/api/catalog/entities", {
    limit: 2,
    requestFn: async (pathname) => {
      const offset = Number(
        new URL(pathname, "https://local.invalid").searchParams.get("offset"),
      );
      offsets.push(offset);
      return {
        status: 200,
        body: { items: offset === 0 ? [{ id: "a" }] : [], total: 3 },
      };
    },
  });

  assert.deepEqual(offsets, [0, 1]);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.rawCount, 1);
  assert.ok(
    result.coverage.failures.some(
      (failure) => failure.reason === "short_page_before_total",
    ),
  );
  assert.ok(
    result.coverage.failures.some(
      (failure) => failure.reason === "empty_page_before_total",
    ),
  );
});

test("collectPages 中页失败保留部分数据并记为不完整", async () => {
  const offsets = [];
  const result = await collectPages("/api/catalog/entities", {
    limit: 2,
    requestFn: async (pathname) => {
      const offset = Number(
        new URL(pathname, "https://local.invalid").searchParams.get("offset"),
      );
      offsets.push(offset);
      if (offset === 2) return { status: 503, body: { error: "unavailable" } };
      if (offset === 0)
        return {
          status: 200,
          body: { items: [{ id: "a" }, { id: "b" }], total: 5 },
        };
      return { status: 200, body: { items: [{ id: "e" }], total: 5 } };
    },
  });

  assert.deepEqual(offsets, [0, 2, 4]);
  assert.deepEqual(
    result.items.map((item) => item.id),
    ["a", "b", "e"],
  );
  assert.equal(result.coverage.rawCount, 3);
  assert.equal(result.coverage.complete, false);
  assert.ok(
    result.coverage.failures.some(
      (failure) => failure.reason === "request_failed" && failure.offset === 2,
    ),
  );
});

test("collectPages 检出重复页、重复 id 与 total 漂移", async () => {
  const repeated = await collectPages("/api/catalog/entities", {
    limit: 2,
    requestFn: async () => ({
      status: 200,
      body: { items: [{ id: "a" }, { id: "b" }], total: 4 },
    }),
  });
  assert.equal(repeated.coverage.complete, false);
  assert.deepEqual(repeated.coverage.duplicateIds, ["a", "b"]);
  assert.ok(
    repeated.coverage.failures.some(
      (failure) => failure.reason === "repeated_page",
    ),
  );

  const drifted = await collectPages("/api/catalog/entities", {
    limit: 2,
    requestFn: async (pathname) =>
      Number(
        new URL(pathname, "https://local.invalid").searchParams.get("offset"),
      ) === 0
        ? { status: 200, body: { items: [{ id: "a" }, { id: "b" }], total: 3 } }
        : { status: 200, body: { items: [{ id: "c" }], total: 4 } },
  });
  assert.equal(drifted.coverage.complete, false);
  assert.ok(
    drifted.coverage.failures.some(
      (failure) => failure.reason === "total_drift",
    ),
  );

  const duplicate = await collectPages("/api/catalog/entities", {
    limit: 2,
    requestFn: async (pathname) =>
      Number(
        new URL(pathname, "https://local.invalid").searchParams.get("offset"),
      ) === 0
        ? { status: 200, body: { items: [{ id: "a" }, { id: "b" }], total: 4 } }
        : {
            status: 200,
            body: { items: [{ id: "b" }, { id: "c" }], total: 4 },
          },
  });
  assert.deepEqual(duplicate.coverage.duplicateIds, ["b"]);
  assert.deepEqual(
    duplicate.items.map((item) => item.id),
    ["a", "b", "c"],
  );
  assert.equal(duplicate.coverage.complete, false);
});

test("分页参数归自动分页器管理，拒绝调用者覆盖", async () => {
  await assert.rejects(
    collectPages("/api/catalog/entities", {
      params: { offset: 10 },
      requestFn: async () => null,
    }),
    /分页参数由 collectPages 管理/,
  );
  await assert.rejects(
    collectPages("/api/catalog/entities", {
      params: { page: 2 },
      requestFn: async () => null,
    }),
    /分页参数由 collectPages 管理/,
  );
  await assert.rejects(
    collectPages("/api/catalog/entities?offset=20", {
      requestFn: async () => null,
    }),
    /不能写在 pathname query 中/,
  );
});

test("缺失或非法 total 保留单页数据后立即以 partial 停止", async () => {
  let calls = 0;
  const result = await collectPages("/api/catalog/entities", {
    limit: 1,
    requestFn: async () => {
      calls += 1;
      return { status: 200, body: { items: [{ id: "a" }] } };
    },
  });

  assert.equal(calls, 1);
  assert.equal(result.items.length, 1);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.failures[0].reason, "invalid_total");
});

test("listAll 保持数组 API，遇到不完整分页时抛出带 coverage 的异常", async () => {
  let offsetCalls = 0;
  globalThis.fetch = async (url) => {
    const offset = Number(new URL(String(url)).searchParams.get("offset"));
    offsetCalls += 1;
    return jsonResponse({
      items: offset === 0 ? [{ id: "a" }, { id: "b" }] : [],
      total: 4,
    });
  };

  await assert.rejects(listAll("/api/catalog/entities", {}, 2), (error) => {
    assert.equal(error.coverage.complete, false);
    assert.equal(error.coverage.rawCount, 2);
    return /分页读取不完整/.test(error.message);
  });
  assert.equal(offsetCalls, 2);
});

test("listAll 异常包含失败页 HTTP 状态", async () => {
  globalThis.fetch = async () => jsonResponse({ error: "forbidden" }, 403);
  await assert.rejects(listAll("/api/catalog/entities", {}, 2), (error) => {
    assert.match(error.message, /HTTP 403/);
    assert.equal(error.coverage.failures[0].status, 403);
    return true;
  });
});

test("request 遮盖 fetch 异常详情中的 PAT", async () => {
  const token = process.env.MF_PAT;
  globalThis.fetch = async () => {
    throw new Error(`socket failed with ${token}`);
  };

  const result = await request("/api/catalog/entities", { tries: 1 });
  assert.equal(result.status, 0);
  assert.ok(result.body.detail.includes("[REDACTED]"));
  assert.equal(result.body.detail.includes(token), false);
});

test("writableEntity 保留完整可写实体并剔除只读投影", () => {
  const writable = writableEntity(currentEntity());
  assert.deepEqual(writable.translations["en-US"], {
    title: "Example",
    summary: "Official summary",
  });
  assert.deepEqual(writable.attributes, { language: "en" });
  assert.equal(writable.created_by, undefined);
  assert.equal(writable.updated_at, undefined);
});
