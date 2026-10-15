#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  request as apiRequest,
  collectPages,
  publicFailure,
} from "../metafusion-api.mjs";

const ACTIONS = [
  "entity.get",
  "entity.list",
  "entity.resolve",
  "entity.current-revision",
  "entity.relations",
  "entity.occurrences",
  "release.toc",
  "definitions",
  "contract",
];
const FILTERS = new Set(
  "kind kinds q status work_id content_unit_id release_id medium_id parent_id field value tags original_language has_pictures sort order locale".split(
    " ",
  ),
);
const record = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const entity = (x, id) =>
  record(x) &&
  typeof x.id === "string" &&
  (!id || x.id === id) &&
  typeof x.kind === "string" &&
  Number.isSafeInteger(x.version) &&
  x.version > 0 &&
  typeof x.title === "string" &&
  typeof x.status === "string";
export function listOperations() {
  return ACTIONS.map((action) => ({
    action,
    mode: "read",
    paginated: action === "entity.list",
  }));
}
export function schemaFor(action) {
  if (action !== undefined && !ACTIONS.includes(action))
    throw new Error("unsupported_action");
  const one = (a) => ({
    type: "object",
    additionalProperties: false,
    required: [
      "action",
      ...(["definitions", "contract", "entity.list"].includes(a) ? [] : ["id"]),
    ],
    properties: {
      action: { const: a },
      ...(["definitions", "contract"].includes(a)
        ? {}
        : a === "entity.list"
          ? {
              params: {
                type: "object",
                properties: Object.fromEntries(
                  [...FILTERS].map((k) => [k, {}]),
                ),
                additionalProperties: false,
              },
              limit: { type: "integer", minimum: 1, maximum: 100 },
            }
          : { id: { type: "string", minLength: 1 } }),
    },
  });
  return action === undefined ? { oneOf: ACTIONS.map(one) } : one(action);
}
export const PLAN_SCHEMA = Object.freeze(schemaFor());
export function validatePlan(plan) {
  if (!record(plan) || !ACTIONS.includes(plan.action))
    return "unsupported_action_use_mf_workspace_for_edits";
  const allowed =
    plan.action === "entity.list"
      ? ["action", "params", "limit"]
      : ["definitions", "contract"].includes(plan.action)
        ? ["action"]
        : ["action", "id"];
  if (Object.keys(plan).some((k) => !allowed.includes(k)))
    return "invalid_plan";
  if (
    allowed.includes("id") &&
    !(typeof plan.id === "string" && plan.id.trim())
  )
    return "invalid_plan";
  if (plan.action === "entity.list") {
    if (
      plan.params !== undefined &&
      (!record(plan.params) ||
        Object.keys(plan.params).some((k) => !FILTERS.has(k)))
    )
      return "invalid_list_params";
    if (
      plan.limit !== undefined &&
      (!Number.isSafeInteger(plan.limit) || plan.limit < 1 || plan.limit > 100)
    )
      return "invalid_limit";
  }
  return null;
}
const entityPath = (id, suffix = "") =>
  `/api/catalog/entities/${encodeURIComponent(id)}${suffix}`;
async function read(requestFn, p) {
  try {
    return await requestFn(p, { tries: 4 });
  } catch {
    return { status: 0, body: { error: "network" } };
  }
}
function failure(r) {
  return {
    ok: false,
    outcome:
      r.status === 0 || r.status >= 500
        ? "unknown"
        : r.status === 429
          ? "rate_limited"
          : "rejected",
    reason: publicFailure(r).error,
    httpStatus: r.status,
  };
}
export async function runPlan(plan, { requestFn = apiRequest } = {}) {
  const invalid = validatePlan(plan);
  if (invalid)
    return { ok: false, outcome: "rejected", applied: false, reason: invalid };
  if (plan.action === "entity.list") {
    const result = await collectPages("/api/catalog/entities", {
      params: plan.params ?? {},
      limit: plan.limit ?? 100,
      requestFn,
    });
    return {
      ok: result.coverage.complete,
      outcome: result.coverage.complete ? "complete" : "partial",
      ...result,
    };
  }
  const paths = {
    "entity.get": entityPath(plan.id),
    "entity.resolve": entityPath(plan.id, "/resolve"),
    "entity.relations": entityPath(plan.id, "/relations"),
    "entity.occurrences": entityPath(plan.id, "/occurrences"),
    "release.toc": `/api/catalog/releases/${encodeURIComponent(plan.id)}/toc`,
    definitions: "/api/catalog/definitions",
    contract: "/api/openapi.json",
  };
  if (plan.action === "entity.current-revision") {
    const current = await read(requestFn, entityPath(plan.id));
    if (current.status !== 200) return failure(current);
    if (!entity(current.body, plan.id))
      return { ok: false, outcome: "partial", reason: "entity_shape_invalid" };
    const history = await read(requestFn, entityPath(plan.id, "/revisions"));
    if (history.status !== 200) return failure(history);
    const candidates = history.body?.items?.filter(
      (x) => x.version === current.body.version,
    );
    if (
      !Array.isArray(candidates) ||
      candidates.length !== 1 ||
      !entity(candidates[0].snapshot, plan.id) ||
      candidates[0].snapshot.version !== current.body.version
    )
      return {
        ok: false,
        outcome: "partial",
        reason: "current_revision_shape_invalid",
      };
    return {
      ok: true,
      outcome: "complete",
      entity: current.body,
      revision: candidates[0],
      selectedBy: "revision.version === entity.version",
    };
  }
  const r = await read(requestFn, paths[plan.action]);
  if (r.status !== 200) return failure(r);
  const valid =
    plan.action === "entity.get"
      ? entity(r.body, plan.id)
      : plan.action === "entity.resolve"
        ? entity(r.body) && r.body.status !== "merged" && !r.body.redirect_id
        : plan.action === "definitions"
          ? record(r.body?.document) && typeof r.body.etag === "string"
          : plan.action === "contract"
            ? record(r.body?.paths) && typeof r.body.openapi === "string"
            : ["entity.relations", "entity.occurrences"].includes(plan.action)
              ? Array.isArray(r.body?.items)
              : record(r.body);
  return valid
    ? {
        ok: true,
        outcome: "complete",
        data: r.body,
        visibilityScope: "current caller-visible response",
      }
    : { ok: false, outcome: "partial", reason: "response_shape_invalid" };
}
export function helpText() {
  return "mf-platform list | schema [action] | --plan plan.json [--out result.json]\n只读目录查询；编辑使用 mf-workspace checkout/commit/preview/push，不支持旧写计划或 --apply。";
}
export async function runCli(
  argv = process.argv.slice(2),
  { requestFn = apiRequest, stdout = process.stdout } = {},
) {
  const print = (x) =>
    stdout.write(
      typeof x === "string" ? x + "\n" : JSON.stringify(x, null, 2) + "\n",
    );
  if (!argv.length || ["help", "--help"].includes(argv[0])) {
    print(helpText());
    return 0;
  }
  if (argv[0] === "list") {
    print(listOperations());
    return 0;
  }
  if (argv[0] === "schema") {
    print(schemaFor(argv[1]));
    return 0;
  }
  let planFile, out;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--plan") planFile = argv[++i];
    else if (argv[i] === "--out") out = argv[++i];
    else throw new Error(`unknown_argument:${argv[i]}`);
  }
  if (!planFile) throw new Error("plan_required");
  let fd;
  if (out) fd = fs.openSync(path.resolve(out), "wx", 0o600);
  try {
    const result = await runPlan(
      JSON.parse(fs.readFileSync(planFile, "utf8")),
      { requestFn },
    );
    if (fd !== undefined)
      fs.writeFileSync(fd, JSON.stringify(result, null, 2) + "\n");
    else print(result);
    return result.ok ? 0 : 1;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  runCli()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(JSON.stringify({ ok: false, error: String(error) }));
      process.exitCode = 1;
    });
