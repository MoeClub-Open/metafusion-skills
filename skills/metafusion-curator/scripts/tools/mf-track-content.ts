#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { request as apiRequest } from "../metafusion-api.ts";

const record = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const clone = (x) => JSON.parse(JSON.stringify(x));
const canonical = (x) => Array.isArray(x) ? x.map(canonical) : record(x)
  ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, canonical(x[key])])) : x;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

export function validatePlan(plan) {
  if (!record(plan) || Object.keys(plan).some((key) => !["workspace_id", "expected_version", "track_id", "inclusion"].includes(key)))
    return "invalid_plan";
  if (typeof plan.workspace_id !== "string" || !plan.workspace_id.trim() ||
      typeof plan.track_id !== "string" || !plan.track_id.trim() ||
      !Number.isSafeInteger(plan.expected_version) || plan.expected_version < 1) return "invalid_plan";
  const inclusion = plan.inclusion;
  if (!record(inclusion) || Object.keys(inclusion).some((key) => !["expression_id", "position", "locator", "attributes", "sources"].includes(key)) ||
      typeof inclusion.expression_id !== "string" || !inclusion.expression_id.trim() ||
      !Number.isSafeInteger(inclusion.position) || inclusion.position < 0) return "invalid_inclusion";
  if (inclusion.locator !== undefined && !record(inclusion.locator)) return "invalid_inclusion_locator";
  if (inclusion.attributes !== undefined && !record(inclusion.attributes)) return "invalid_inclusion_attributes";
  if (inclusion.sources !== undefined && !Array.isArray(inclusion.sources)) return "invalid_inclusion_sources";
  try { clone(plan); } catch { return "invalid_json_value"; }
  return null;
}

/** Stage one inclusion on an existing server copy. Commit and push remain explicit. */
export async function addTrackContent({ plan, apply = false, requestFn = apiRequest }: Record<string, any> = {}) {
  const failure = (reason, extra = {}) => ({ ok: false, outcome: "rejected", applied: false, staged: false, reason, ...extra });
  const invalid = validatePlan(plan);
  if (invalid) return failure(invalid);
  if (typeof requestFn !== "function") return failure("invalid_request_function");
  const root = `/api/catalog/workspaces/${encodeURIComponent(plan.workspace_id)}`;
  let workspace;
  try {
    const response = await requestFn(root, { method: "GET" });
    if (response.status !== 200 || response.body?.id !== plan.workspace_id ||
        !Array.isArray(response.body?.objects)) return failure("workspace_unavailable", { httpStatus: response.status });
    workspace = response.body;
  } catch { return failure("workspace_read_failed"); }
  if (workspace.version !== plan.expected_version) return failure("workspace_version_conflict", { currentVersion: workspace.version });
  const object = workspace.objects.find((item) => item.target === "entity" && item.id === plan.track_id);
  const track = object?.document;
  if (!record(track) || track.kind !== "track" || (track.contents != null && !Array.isArray(track.contents)))
    return failure("track_not_checked_out");
  const contents = track.contents ?? [];
  const inclusion = clone({ ...plan.inclusion, locator: plan.inclusion.locator ?? {} });
  if (contents.some((item) => item.expression_id === inclusion.expression_id && same(item.locator ?? {}, inclusion.locator)))
    return failure("duplicate_content");
  if (contents.some((item) => item.position === inclusion.position)) return failure("position_conflict");
  const body = { expected_version: workspace.version, operations: [{
    target: "entity", action: "content", id: plan.track_id,
    content_change: { action: "add", position: inclusion.position, inclusion },
  }] };
  if (!apply) return { ok: true, outcome: "preview", applied: false, staged: false, workspace_id: workspace.id,
    request: { method: "PUT", path: `${root}/changes`, body } };
  let response;
  try { response = await requestFn(`${root}/changes`, { method: "PUT", body, tries: 1 }); }
  catch { return failure("stage_result_unknown", { outcome: "unknown", staged: null, workspace_id: workspace.id }); }
  if (response.status === 0 || response.status >= 500)
    return failure("stage_result_unknown", { outcome: "unknown", staged: null, httpStatus: response.status, workspace_id: workspace.id });
  if (response.status === 409) return failure("workspace_conflict", { httpStatus: 409 });
  if (response.status < 200 || response.status >= 300) return failure("stage_rejected", { httpStatus: response.status });
  const next = response.body?.workspace;
  const nextTrack = next?.objects?.find((item) => item.target === "entity" && item.id === plan.track_id)?.document;
  const normalized = (item) => ({ ...item, locator: item.locator ?? {}, attributes: item.attributes ?? {}, sources: item.sources ?? [] });
  const expected = normalized(inclusion);
  const verified = next?.id === workspace.id && next.version === workspace.version + 1 &&
    record(nextTrack) && Array.isArray(nextTrack.contents) && nextTrack.contents.length === contents.length + 1 &&
    contents.every((old) => nextTrack.contents.some((item) => same(normalized(old), normalized(item)))) &&
    nextTrack.contents.filter((item) => same(normalized(item), expected)).length === 1;
  if (!verified) return failure("stage_receipt_invalid", { outcome: "unknown", staged: null, workspace_id: workspace.id });
  return { ok: true, outcome: "staged", applied: false, staged: true, workspace: next };
}

function usage() {
  return [
    "用法: node mf-track-content.ts --plan <JSON文件> [--apply] [--out <结果JSON文件>]",
    "默认只读预览；--apply 将收录保存到服务器副本，不改变正式目录。",
    "仅新增一条 Track.contents；后续使用 mf-workspace commit/push 合并。",
    "plan: { workspace_id, expected_version（副本版本）, track_id, inclusion: { expression_id, position, locator?, attributes?, sources? } }",
    "--out 可保存完整结果；stdout 只输出简短 JSON。--help 不读取凭据。",
  ].join("\n");
}

export function parseArgs(argv) {
  const options = { apply: false, plan: null, out: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--apply") options.apply = true;
    else if (arg === "--replace" || arg === "--delete") throw new Error("unsupported_operation");
    else if (arg === "--plan" || arg === "--out") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("invalid_cli_arguments");
      options[arg === "--plan" ? "plan" : "out"] = value;
      index += 1;
    } else throw new Error("invalid_cli_arguments");
  }
  if (options.help) return options;
  if (!options.plan) throw new Error("invalid_cli_arguments");
  if (options.out && path.resolve(options.out) === path.resolve(options.plan)) throw new Error("output_must_not_overwrite_plan");
  return options;
}

function compact(result) {
  return {
    ok: result.ok, outcome: result.outcome, reason: result.reason,
    workspace_id: result.workspace?.id ?? result.workspace_id,
    version: result.workspace?.version,
    staged: result.staged ?? false, applied: false,
  };
}

export async function runCli(argv = process.argv.slice(2), {
  requestFn = apiRequest,
  stdout = (text) => process.stdout.write(`${text}\n`),
  stderr = (text) => process.stderr.write(`${text}\n`),
}: Record<string, any> = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    const reason = error?.message === "unsupported_operation" ? "unsupported_operation" : "invalid_cli_arguments";
    stderr(JSON.stringify({ ok: false, outcome: "rejected", reason }));
    return 2;
  }
  if (options.help) {
    stdout(usage());
    return 0;
  }

  let plan;
  try {
    plan = JSON.parse(fs.readFileSync(options.plan, "utf8"));
  } catch {
    stderr(JSON.stringify({ ok: false, outcome: "rejected", reason: "plan_read_failed" }));
    return 2;
  }
  let outputFd = null;
  if (options.out) {
    try {
      outputFd = fs.openSync(options.out, "wx");
    } catch {
      stderr(JSON.stringify({ ok: false, outcome: "rejected", reason: "out_path_unavailable" }));
      return 2;
    }
  }
  const result = await addTrackContent({ plan, apply: options.apply, requestFn });
  if (outputFd !== null) {
    try {
      fs.writeFileSync(outputFd, `${JSON.stringify(result, null, 2)}\n`, "utf8");
      fs.closeSync(outputFd);
    } catch {
      try { fs.closeSync(outputFd); } catch { /* descriptor may already be closed */ }
      stdout(JSON.stringify(compact(result)));
      stderr(JSON.stringify({ ok: false, outcome: "local_output_failed", reason: "out_write_failed" }));
      return 2;
    }
  }
  stdout(JSON.stringify(compact(result)));
  return result.ok ? 0 : 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await runCli();
}
