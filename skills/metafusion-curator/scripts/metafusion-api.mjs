import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LOCAL_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CREDENTIALS = join(LOCAL_DIR, "credentials.json");
const API_PREFIX = "/api/";
const READ_ONLY_ENTITY_FIELDS = new Set([
  "created_by",
  "redirect_id",
  "updated_at",
]);

let credentials;

const sleep = (ms) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

function normalizeBaseUrl(value) {
  const url = new URL(value);
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(
      "MetaFusion baseUrl 必须使用 HTTPS；只有本机 loopback 可使用 HTTP",
    );
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname && url.pathname !== "/")
  ) {
    throw new Error(
      "MetaFusion baseUrl 只能填写实例根地址，不能包含账号、查询串或路径前缀",
    );
  }
  return url.origin;
}

function apiUrl(baseUrl, pathname) {
  const rawPath = String(pathname).split(/[?#]/, 1)[0];
  const hasDotSegment = rawPath
    .split("/")
    .some((part) => part === "." || part === "..");
  if (
    !pathname.startsWith(API_PREFIX) ||
    hasDotSegment ||
    /[\\]|%2e|%2f|%5c/i.test(rawPath)
  ) {
    throw new Error(`请求路径必须是规范化后的 ${API_PREFIX} 路径`);
  }

  const base = new URL(baseUrl);
  const target = new URL(pathname, `${baseUrl}/`);
  if (
    target.origin !== base.origin ||
    !target.pathname.startsWith(API_PREFIX)
  ) {
    throw new Error("请求路径超出 MetaFusion API 范围");
  }
  return target;
}

function loadCredentials() {
  if (credentials) return credentials;

  const file = process.env.MF_CREDENTIALS
    ? resolve(process.env.MF_CREDENTIALS)
    : DEFAULT_CREDENTIALS;
  let stored = {};
  try {
    stored = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw new Error(`无法读取本地凭据文件：${file}`);
    }
  }

  const baseUrl = process.env.MF_BASE || stored.baseUrl || stored.base_url;
  const pat = String(process.env.MF_PAT || stored.pat || "").trim();
  if (!baseUrl || !pat) {
    throw new Error(
      `缺少 MetaFusion 凭据；请在本机填写 ${file}，或设置 MF_BASE / MF_PAT`,
    );
  }

  credentials = Object.freeze({ baseUrl: normalizeBaseUrl(baseUrl), pat });
  return credentials;
}

// Workspaces bind to an origin, never to a stored token.
export function configuredOrigin() {
  return loadCredentials().baseUrl;
}

export function publicFailure(response) {
  const allowed = {
    401: ["invalid_token", "authentication_required"],
    403: ["forbidden"],
    409: [
      "commit_conflict",
      "definitions_conflict",
      "idempotency_conflict",
      "version_conflict",
      "identity_candidates_changed",
    ],
    429: ["rate_limited"],
    500: ["internal_error", "database_error"],
    503: ["auth_unavailable", "search_unavailable", "transaction_busy"],
  };
  const code = response?.body?.error;
  const valid =
    allowed[response?.status]?.includes(code) ||
    (response?.status === 400 &&
      typeof code === "string" &&
      /^[a-z][a-z0-9_]{0,80}$/.test(code) &&
      !code.startsWith("mfp_"));
  const out = { error: valid ? code : `http_${response?.status ?? 0}` };
  const c = response?.body?.conflict;
  if (
    out.error === "commit_conflict" &&
    c &&
    typeof c.id === "string" &&
    Number.isSafeInteger(c.operation) &&
    Number.isSafeInteger(c.base_version) &&
    Number.isSafeInteger(c.current_version) &&
    Array.isArray(c.paths) &&
    c.paths.every((p) => typeof p === "string" && p.startsWith("/"))
  )
    out.conflict = {
      operation: c.operation,
      id: c.id,
      base_version: c.base_version,
      current_version: c.current_version,
      paths: c.paths,
    };
  const identity = response?.body?.identity_review;
  if (
    out.error === "identity_candidates_changed" &&
    Number.isSafeInteger(identity?.operation) &&
    Array.isArray(identity.candidate_ids) &&
    identity.candidate_ids.every(
      (x) => typeof x === "string" && /^[0-9a-f-]{36}$/.test(x),
    )
  )
    out.identity_review = identity;
  return out;
}

function redact(value, secret) {
  if (typeof value === "string") return value.replaceAll(secret, "[REDACTED]");
  if (Array.isArray(value)) return value.map((item) => redact(item, secret));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redact(item, secret)]),
    );
  }
  return value;
}

function parseBody(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function retryDelay(headers, attempt) {
  const value = headers.get("retry-after");
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds))
      return Math.min(Math.max(seconds * 1000, 250), 30_000);
    const date = Date.parse(value);
    if (Number.isFinite(date))
      return Math.min(Math.max(date - Date.now(), 250), 30_000);
  }
  return Math.min(750 * 2 ** attempt, 8_000);
}

export async function request(
  pathname,
  { method = "GET", body, idempotencyKey, tries = 4 } = {},
) {
  const { baseUrl, pat } = loadCredentials();
  const target = apiUrl(baseUrl, pathname);
  const normalizedMethod = method.toUpperCase();
  const safeMethod = ["GET", "HEAD", "OPTIONS"].includes(normalizedMethod);
  const attempts = safeMethod ? Math.max(1, tries) : 1;
  let result = { status: 0, body: { error: "network" }, headers: {} };

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const headers = {
        Accept: "application/json",
        Authorization: `Bearer ${pat}`,
        "User-Agent": "metafusion-curator-local/1.0",
      };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

      const response = await fetch(target, {
        method: normalizedMethod,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "manual",
      });
      result = {
        status: response.status,
        body: redact(parseBody(await response.text()), pat),
        headers: redact(
          {
            etag: response.headers.get("etag"),
            location: response.headers.get("location"),
            retryAfter: response.headers.get("retry-after"),
          },
          pat,
        ),
      };

      if (response.status !== 429 && response.status < 500) return result;
    } catch (error) {
      result = {
        status: 0,
        body: { error: "network", detail: redact(String(error), pat) },
        headers: {},
      };
    }

    if (attempt + 1 < attempts) {
      const retryAfter = result.headers?.retryAfter;
      const headers = retryAfter ? { "retry-after": retryAfter } : {};
      await sleep(retryDelay(new Headers(headers), attempt));
    }
  }
  return result;
}

function requireOk(result, operation) {
  if (result.status >= 200 && result.status < 300) return result.body;
  const code = result.body?.error || result.body?.code || result.status;
  throw new Error(`${operation} 失败：HTTP ${result.status} ${code}`);
}

export async function getEntity(id) {
  return request(`/api/catalog/entities/${encodeURIComponent(id)}`);
}

export async function getDefinitions() {
  const definitions = requireOk(
    await request("/api/catalog/definitions"),
    "读取 definitions",
  );
  return definitions?.document || definitions;
}

export function normalizePageLimit(limit = 100) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("实体列表 limit 必须是 1–100 的整数");
  }
  return limit;
}

const PAGINATION_PARAMS = new Set(["page", "offset", "limit"]);
const MAX_COLLECTION_PAGES = 200_000;

function pageFailure(offset, reason, extra = {}) {
  return { offset, reason, ...extra };
}

/**
 * 分页读取列表并报告可见范围覆盖。requestFn 可替换为离线 fixture/mock；
 * 每次调用收到带自动 limit/offset 的规范 API 路径，返回 {status, body}。
 */
export async function collectPages(
  pathname,
  { params = {}, limit = 100, requestFn = request } = {},
) {
  if (typeof pathname !== "string" || !pathname.startsWith(API_PREFIX)) {
    throw new Error(`请求路径必须以 ${API_PREFIX} 开头`);
  }
  const rawPathname = pathname.split(/[?#]/, 1)[0];
  if (
    rawPathname.split("/").some((part) => part === "." || part === "..") ||
    /[\\]|%2e|%2f|%5c/i.test(rawPathname)
  ) {
    throw new Error(`请求路径必须是规范化后的 ${API_PREFIX} 路径`);
  }
  const parsedPath = new URL(pathname, "https://local.invalid");
  if (
    parsedPath.origin !== "https://local.invalid" ||
    !parsedPath.pathname.startsWith(API_PREFIX)
  ) {
    throw new Error(`请求路径必须是规范化后的 ${API_PREFIX} 路径`);
  }
  const pathnamePaginationParams = [...parsedPath.searchParams.keys()].filter(
    (key) => PAGINATION_PARAMS.has(key.toLowerCase()),
  );
  if (pathnamePaginationParams.length) {
    throw new Error(
      `分页参数由 collectPages 管理，不能写在 pathname query 中：${pathnamePaginationParams.join(", ")}`,
    );
  }
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("分页 params 必须是对象");
  }
  const conflictingParams = Object.keys(params).filter((key) =>
    PAGINATION_PARAMS.has(key.toLowerCase()),
  );
  if (conflictingParams.length) {
    throw new Error(
      `分页参数由 collectPages 管理，不能从 params 传入：${conflictingParams.join(", ")}`,
    );
  }
  if (typeof requestFn !== "function") throw new Error("requestFn 必须是函数");
  limit = normalizePageLimit(limit);

  const items = [];
  const seenIds = new Set();
  const duplicateIds = new Set();
  const pageSignatures = new Set();
  const failures = [];
  let total = null;
  let rawCount = 0;
  let pages = 0;
  let offset = 0;

  for (; pages < MAX_COLLECTION_PAGES;) {
    const url = new URL(pathname, "https://local.invalid");
    for (const [key, value] of Object.entries(params))
      url.searchParams.set(key, String(value));
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));

    const pageOffset = offset;
    pages += 1;
    let result;
    try {
      result = await requestFn(`${url.pathname}${url.search}`);
    } catch (error) {
      failures.push(
        pageFailure(pageOffset, "request_threw", {
          errorName: error?.name ?? "Error",
        }),
      );
      if (total === null) break;
      offset += limit;
      if (offset >= total) break;
      continue;
    }

    const status = result?.status;
    if (
      status !== 200 ||
      !result?.body ||
      typeof result.body !== "object" ||
      Array.isArray(result.body)
    ) {
      failures.push(
        pageFailure(pageOffset, "request_failed", {
          status: Number.isInteger(status) && status > 0 ? status : null,
          code: result?.body?.error ?? result?.body?.code ?? null,
        }),
      );
      if (total === null) break;
      offset += limit;
      if (offset >= total) break;
      continue;
    }

    const body = result.body;
    const page = body.items;
    if (!Array.isArray(page)) {
      failures.push(pageFailure(pageOffset, "invalid_items_shape", { status }));
      break;
    }

    const pageTotal = body.total;
    const validTotal = Number.isSafeInteger(pageTotal) && pageTotal >= 0;
    let stopAfterPage = false;
    if (!validTotal) {
      failures.push(
        pageFailure(pageOffset, "invalid_total", { value: pageTotal ?? null }),
      );
      stopAfterPage = true;
    } else if (total === null) {
      total = pageTotal;
    } else if (pageTotal !== total) {
      failures.push(
        pageFailure(pageOffset, "total_drift", {
          expected: total,
          actual: pageTotal,
        }),
      );
      stopAfterPage = true;
    }

    if (page.length > limit)
      failures.push(
        pageFailure(pageOffset, "page_exceeds_limit", {
          limit,
          actual: page.length,
        }),
      );

    const pageIds = [];
    for (let index = 0; index < page.length; index += 1) {
      const item = page[index];
      if (
        !item ||
        typeof item !== "object" ||
        Array.isArray(item) ||
        typeof item.id !== "string" ||
        !item.id.trim()
      ) {
        failures.push(pageFailure(pageOffset, "invalid_item_shape", { index }));
        continue;
      }
      pageIds.push(item.id);
      if (seenIds.has(item.id)) {
        duplicateIds.add(item.id);
        failures.push(pageFailure(pageOffset, "duplicate_id", { id: item.id }));
      } else {
        seenIds.add(item.id);
        items.push(item);
      }
    }

    if (pageIds.length) {
      const signature = JSON.stringify(pageIds);
      if (pageSignatures.has(signature)) {
        failures.push(
          pageFailure(pageOffset, "repeated_page", { ids: pageIds }),
        );
        rawCount += page.length;
        offset += page.length;
        break;
      }
      pageSignatures.add(signature);
    }

    rawCount += page.length;
    offset += page.length;

    if (stopAfterPage) break;

    if (page.length === 0) {
      if (total === null || offset < total) {
        failures.push(
          pageFailure(pageOffset, "empty_page_before_total", { total }),
        );
      }
      break;
    }

    if (page.length < limit && total !== null && offset < total) {
      failures.push(
        pageFailure(pageOffset, "short_page_before_total", {
          count: page.length,
          nextOffset: offset,
          total,
        }),
      );
    }

    if (total !== null && offset >= total) {
      if (offset > total)
        failures.push(
          pageFailure(pageOffset, "raw_count_exceeds_total", {
            total,
            nextOffset: offset,
          }),
        );
      break;
    }

    if (page.length < limit && total === null) break;
  }

  if (pages >= MAX_COLLECTION_PAGES && (total === null || offset < total)) {
    failures.push(
      pageFailure(offset, "page_limit_exceeded", {
        maxPages: MAX_COLLECTION_PAGES,
      }),
    );
  }

  const coverage = {
    basis: "当前调用者可见的列表范围",
    pages,
    total,
    rawCount,
    uniqueCount: items.length,
    duplicateIds: [...duplicateIds],
    complete:
      total !== null &&
      rawCount === total &&
      items.length === total &&
      failures.length === 0,
    failures,
  };
  return { items, coverage };
}

export async function listAll(pathname, params = {}, limit = 100) {
  const { items, coverage } = await collectPages(pathname, { params, limit });
  if (!coverage.complete) {
    const statuses = [
      ...new Set(
        coverage.failures
          .map((failure) => failure.status)
          .filter((status) => Number.isInteger(status) && status > 0),
      ),
    ];
    const statusText = statuses.length ? ` HTTP ${statuses.join(",")}` : "";
    const error = new Error(
      `分页读取不完整${statusText}：${coverage.failures.length} 个分页异常；total=${coverage.total ?? "未知"} raw=${coverage.rawCount} unique=${coverage.uniqueCount}`,
    );
    error.coverage = coverage;
    throw error;
  }
  return items;
}

export function writableEntity(entity) {
  return Object.fromEntries(
    Object.entries(entity || {}).filter(
      ([key]) => !READ_ONLY_ENTITY_FIELDS.has(key),
    ),
  );
}
