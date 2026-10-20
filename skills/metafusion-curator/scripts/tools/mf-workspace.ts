#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { request, configuredOrigin, publicFailure } from "../metafusion-api.ts";
import type { CatalogWorkspace, RequestFn, WorkspaceOperation } from "../metafusion-api.ts";

const API = "/api/catalog";
const fields = {
  entity: new Set(
    "title original_language translations attributes external_links pictures content_unit_id parent_id position number contents subjects".split(
      " ",
    ),
  ),
  relation: new Set(["position", "attributes"]),
};
const record = (x: unknown): x is Record<string, any> => x !== null && typeof x === "object" && !Array.isArray(x);
const has = (x, k) => Object.hasOwn(x, k);
export function canonical(x) {
  if (Array.isArray(x)) return x.map(canonical);
  if (record(x))
    return Object.fromEntries(
      Object.keys(x)
        .sort()
        .map((k) => [k, canonical(x[k])]),
    );
  return x;
}
const same = (a, b) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const escape = (x) => x.replaceAll("~", "~0").replaceAll("/", "~1");
const clone = (x) => JSON.parse(JSON.stringify(x));
export function diffDocument(base, working, target, removals = []) {
  if (!fields[target] || !record(base) || !record(working))
    throw new Error("invalid_working_document");
  for (const k of new Set([...Object.keys(base), ...Object.keys(working)])) {
    if (!fields[target].has(k) && !same(base[k], working[k]))
      throw new Error(`immutable_field:${k}`);
  }
  const result = [];
  function diff(a, b, p, aok, bok) {
    if (aok === bok && same(a, b)) return;
    if (!bok) {
      // Missing keys are omissions. Deletion needs a separate explicit path.
      return;
    }
    if (record(a) && record(b)) {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)]))
        diff(a[k], b[k], `${p}/${escape(k)}`, has(a, k), has(b, k));
    } else if ((!aok || a === null) && record(b)) {
      // Sparse patches let independently added object keys merge.
      const keys = Object.keys(b);
      if (keys.length === 0) result.push({ path: p, value: b });
      else
        for (const k of keys)
          diff(undefined, b[k], `${p}/${escape(k)}`, false, true);
    } else result.push({ path: p, value: b });
  }
  for (const k of fields[target])
    diff(base[k], working[k], `/${escape(k)}`, has(base, k), has(working, k));
  if (!Array.isArray(removals)) throw new Error("invalid_explicit_removal");
  for (const p of new Set(removals)) {
    if (
      typeof p !== "string" || !p.startsWith("/") ||
      /~(?:[^01]|$)/.test(p) || !fields[target].has(parts(p)[0]) ||
      !getAt(base, p).exists || getAt(working, p).exists ||
      result.some((x) => x.path === p || x.path.startsWith(p + "/") || p.startsWith(x.path + "/"))
    ) throw new Error(`invalid_explicit_removal:${p}`);
    result.push({ path: p, remove: true });
  }
  if (result.length > 200) throw new Error("too_many_patch_paths");
  return result;
}
export function identityPatch(patch) {
  return patch.some(({ path: p }: Record<string, any>) => {
    const keys = parts(p);
    return keys[0] === "title" || keys[0] === "external_links" ||
      (keys[0] === "translations" && (keys.length <= 2 || keys[2] === "title"));
  });
}
function parts(pointer) {
  return pointer
    .slice(1)
    .split("/")
    .map((x) => x.replaceAll("~1", "/").replaceAll("~0", "~"));
}
function getAt(doc, p) {
  let x = doc;
  for (const k of parts(p)) {
    if (!record(x) || !has(x, k)) return { exists: false };
    x = x[k];
  }
  return { exists: true, value: x };
}
function putAt(doc, p, value, remove) {
  const keys = parts(p);
  let x = doc;
  for (const k of keys.slice(0, -1)) {
    if (!has(x, k) || !record(x[k]))
      Object.defineProperty(x, k, {
        value: {},
        writable: true,
        enumerable: true,
        configurable: true,
      });
    x = x[k];
  }
  if (remove) delete x[keys.at(-1)];
  else
    Object.defineProperty(x, keys.at(-1), {
      value: clone(value),
      writable: true,
      enumerable: true,
      configurable: true,
    });
}
export function rebasePatch(base, current, patch, resolutions = {}) {
  const working = clone(current),
    conflicts = [];
  for (const p of patch) {
    const b = getAt(base, p.path),
      c = getAt(current, p.path),
      want = p.remove ? { exists: false } : { exists: true, value: p.value };
    if (same(b, want)) continue;
    if (same(c, want)) continue;
    if (!same(b, c)) {
      const choice = resolutions[p.path];
      if (choice === "theirs") continue;
      if (choice !== "ours") {
        conflicts.push(p.path);
        continue;
      }
    }
    putAt(working, p.path, p.value, p.remove);
  }
  return { working, conflicts };
}

interface WorkspaceState {
  origin: string;
  workspace: CatalogWorkspace;
  pending?: { kind: string; pathname: string; body: Record<string, any>; method: string };
}
interface WorkspaceOptions {
  authorID?: string;
  since?: string;
  until?: string;
  state?: string;
  basis?: string;
  version?: number;
  ontoID?: string;
	baseID?: string;
	requestID?: string;
	target?: string;
	recordID?: string;
	pointer?: string;
  dir?: string;
  origin?: string;
  requestFn?: RequestFn;
  workspaceID?: string;
  entityIDs?: string[];
  relationIDs?: string[];
  name?: string;
  message?: string;
  title?: string;
  commitID?: string;
  pullRequestID?: string;
  file?: string;
  operations?: WorkspaceOperation[];
  resolutions?: Record<string, any>[];
  userIDs?: string[];
  edit?: Record<string, any>;
  limit?: number;
  offset?: number;
  status?: string;
}
const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
function save(file: string, value: unknown) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  try { fs.renameSync(temporary, file); }
  catch (error) { fs.unlinkSync(temporary); throw error; }
}
function isWorkspace(value: unknown): value is CatalogWorkspace {
  return record(value) && typeof value.id === "string" && Number.isSafeInteger(value.version)
    && value.version > 0 && Array.isArray(value.objects)
    && (value.head_commit_id === null || typeof value.head_commit_id === "string");
}
function input(options: WorkspaceOptions) {
  return options.file ? read(options.file) : undefined;
}
const encoded = (id: string) => encodeURIComponent(id);
function readQuery(options: WorkspaceOptions, mode: "page" | "records" | "history" | "branch" | "revisions" = "page") {
  const query = new URLSearchParams();
  if (options.limit !== undefined) {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100) throw new Error("invalid_limit");
    query.set("limit", String(options.limit));
  }
  if (options.offset !== undefined) {
    if (!Number.isSafeInteger(options.offset) || options.offset < 0) throw new Error("invalid_offset");
    query.set("offset", String(options.offset));
  }
  if (["records", "history", "branch"].includes(mode)) {
    if (options.target) query.set("target", options.target);
    if (options.recordID) query.set("record_id", options.recordID);
  }
  if (["history", "branch", "revisions"].includes(mode)) {
    if (options.authorID) query.set("author_id", options.authorID);
    if (options.since) query.set("since", options.since);
    if (options.until) query.set("until", options.until);
  }
  if (mode === "branch" && options.state) query.set("state", options.state);
  if (mode === "revisions" && options.version !== undefined) {
    if (!Number.isSafeInteger(options.version) || options.version < 1) throw new Error("invalid_version");
    query.set("version", String(options.version));
  }
  return query;
}
const queryPath = (pathname: string, query: URLSearchParams) => `${pathname}${query.size ? `?${query}` : ""}`;


/** The local file holds only the last observed server version, never a second
 *  branch implementation. All staged objects and immutable commits live on the
 *  server; the version/head below are compare-and-swap expectations. */
export async function runWorkspace(command: string, options: WorkspaceOptions = {}) {
  const { requestFn = request, entityIDs = [], relationIDs = [] } = options;
  const origin = new URL(options.origin ?? configuredOrigin()).origin;
  const send = async (pathname: string, method = "GET", body?: unknown) => {
    try { return await requestFn(pathname, { method, ...(body === undefined ? {} : { body }) }); }
    catch { return { status: 0, body: {} }; }
  };
  if (command === "list" || command === "pr-list") {
    const query = readQuery(options);
    if (command === "pr-list") {
      if (options.workspaceID) query.set("workspace_id", options.workspaceID);
      if (options.status) query.set("status", options.status);
    }
    const response = await send(`${API}/${command === "list" ? "workspaces" : "pull-requests"}${query.size ? `?${query}` : ""}`);
    return { ok: response.status === 200, status: response.status, result: response.status === 200 ? response.body : publicFailure(response) };
  }
  const independent = ["head", "history", "commit-diff", "pr-diff", "pr-commits", "revisions", "pr-get"].includes(command)
    || (["snapshot", "compare", "blame"].includes(command) && (!!options.commitID || !options.dir));
  if (independent) {
    let pathname: string;
    let query = readQuery(options, command === "history" || command === "pr-commits" ? "history" : command === "revisions" ? "revisions" : "records");
    if (command === "head") { pathname = `${API}/head`; query = new URLSearchParams(); }
    else if (command === "history") pathname = `${API}/history`;
    else if (command.startsWith("pr-")) {
      if (!options.pullRequestID) throw new Error("pull_request_id_required");
      if (command === "pr-get") query = new URLSearchParams();
      pathname = `${API}/pull-requests/${encoded(options.pullRequestID)}${command === "pr-get" ? "" : command === "pr-diff" ? "/diff" : "/commits"}`;
    } else if (command === "revisions") {
      if (!options.recordID) throw new Error("record_id_required");
      pathname = `${API}/entities/${encoded(options.recordID)}/revisions`;
    } else {
      if (!options.commitID) throw new Error("commit_id_required");
      pathname = `${API}/commits/${encoded(options.commitID)}/${command === "commit-diff" ? "diff" : command}`;
      if (command === "compare") {
        if (!options.baseID) throw new Error("base_commit_required");
        query.set("base", options.baseID);
      }
      if (command === "blame") {
        if (!options.target || !options.recordID || !options.pointer) throw new Error("field_path_required");
        query.set("pointer", options.pointer);
      }
    }
    const response = await send(queryPath(pathname, query));
    return { ok: response.status === 200, status: response.status, result: response.status === 200 ? response.body : publicFailure(response) };
  }
  if (!options.dir) throw new Error("workspace_directory_required");
  const directory = path.resolve(options.dir);
  fs.mkdirSync(directory, { recursive: true });
  const stateFile = path.join(directory, ".mf-workspace.json");
  const lockFile = path.join(directory, ".mf-workspace.lock");
  const lock = fs.openSync(lockFile, "wx", 0o600);
  fs.writeFileSync(lock, String(process.pid));
  try {
    if (command === "init" || command === "fork") {
      if (fs.existsSync(stateFile)) throw new Error("workspace_already_initialized");
      const pendingFile=path.join(directory,".mf-workspace-init.json");
      const initial=command==="fork"?{name:options.name??"",commit_id:options.commitID,entity_ids:entityIDs,relation_ids:relationIDs}:{name:options.name??"",entity_ids:entityIDs,relation_ids:relationIDs};
      if(command==="fork"&&!options.commitID)throw new Error("commit_id_required");
      let creation: {origin:string;command:string;initial:typeof initial;body:Record<string,unknown>};
      if(fs.existsSync(pendingFile)){creation=read(pendingFile);if(creation.origin!==origin||creation.command!==command||!same(creation.initial,initial))throw new Error("creation_result_unknown_keep_original_request");}
      else {creation={origin,command,initial,body:{...initial,id:options.requestID??randomUUID()}};if(!options.workspaceID||command==="fork")save(pendingFile,creation);}
      const response = options.workspaceID&&command==="init"
        ? await send(`${API}/workspaces/${encoded(options.workspaceID)}`)
        : await send(`${API}/workspaces${command==="fork"?"/fork":""}`, "POST", creation.body);
      if (![200, 201].includes(response.status) || !isWorkspace(response.body)) {
        return { ok: false, status: response.status, result: publicFailure(response),
          ...(response.status === 0 || response.status >= 500 ? { reason: "creation_result_unknown_keep_original_request",request:creation.body } : {}) };
      }
      save(stateFile, { origin, workspace: response.body });
      if(fs.existsSync(pendingFile))fs.unlinkSync(pendingFile);
      return { ok: true, workspace: response.body };
    }
    const state = read(stateFile) as WorkspaceState;
    if (state.origin !== origin) throw new Error("workspace_origin_mismatch");
    if (!isWorkspace(state.workspace)) throw new Error("invalid_workspace_state");
    const workspacePath = `${API}/workspaces/${encoded(state.workspace.id)}`;
    const responseResult = (response) => ({ ok: response.status >= 200 && response.status < 300,
      status: response.status, result: response.status >= 200 && response.status < 300 ? response.body : publicFailure(response) });
    const refresh = async () => {
      const current = await send(workspacePath);
      if (current.status !== 200 || !isWorkspace(current.body)) return false;
      state.workspace = current.body;
      save(stateFile, state);
      return true;
    };
    if (command === "get" || command === "status") {
      if (!await refresh()) return { ok: false, reason: "workspace_read_failed" };
      return { ok: true, workspace: state.workspace, ...(state.pending ? { unknown_request: state.pending } : {}) };
    }
    if (["commits","events","tags","stashes","merge-status","diff"].includes(command)) {
      const query = readQuery(options, command === "commits" ? "branch" : command === "diff" ? "records" : "page");
      if (command === "diff" && options.basis) query.set("basis", options.basis);
      return responseResult(await send(`${workspacePath}/${command==="merge-status"?"status":command}${query.size?`?${query}`:""}`));
    }
    if (["snapshot","compare","blame"].includes(command)) {
      const commit=options.commitID??state.workspace.head_commit_id;if(!commit)throw new Error("commit_id_required");const query=new URLSearchParams();
      for (const [key, value] of readQuery(options, "records")) query.set(key, value);
      if(command==="compare"){if(!options.baseID)throw new Error("base_commit_required");query.set("base",options.baseID)}
      if(command==="blame"){if(!options.target||!options.recordID||!options.pointer)throw new Error("field_path_required");query.set("target",options.target);query.set("record_id",options.recordID);query.set("pointer",options.pointer)}
      return responseResult(await send(`${API}/commits/${encoded(commit)}/${command}${query.size?`?${query}`:""}`));
    }
    if (command === "receipt") {
      const id = options.commitID ?? state.pending?.body.id ?? state.workspace.head_commit_id;
      if (!id) throw new Error("commit_id_required");
      const response = await send(`${API}/commits/${encoded(id)}`);
      if (response.status === 200 && response.body?.id === id) {
        const pending = state.pending;
        if (pending && ["commit", "rebase","version"].includes(pending.kind) && pending.body.id === id) {
          delete state.pending;
          save(stateFile, state);
        }
        const refreshed = await refresh();
        return { ok: true, commit: response.body, workspace_refreshed: refreshed, workspace: state.workspace,
          ...(state.pending ? { unknown_request: state.pending } : {}) };
      }
      return { ...responseResult(response), reason: "commit_result_not_confirmed_keep_id" };
    }
    if (state.pending && command !== "retry") throw new Error("request_result_unknown_read_receipt_or_retry_same_request");
    let pathname = workspacePath, method = "POST", body: Record<string, any>;
    const expected = { expected_version: state.workspace.version };
    const head = { ...expected, expected_head: state.workspace.head_commit_id ?? "" };
    switch (command) {
      case "version":
      case "tag":
      case "stash": {
        const payload=options.edit??input(options);if(!record(payload))throw new Error("version_payload_required");
        pathname+=command==="version"?"/version":command==="tag"?"/tags":"/stashes";
        body={...payload,...head,id:payload.id??options.requestID??randomUUID()};break;
      }
      case "checkout":
        pathname += "/checkout";
        body = { ...expected, entity_ids: entityIDs, relation_ids: relationIDs };
        break;
      case "stage": {
        const operations = options.operations ?? input(options);
        if (!Array.isArray(operations) || !operations.length) throw new Error("operations_array_required");
        pathname += "/changes";
        method = "PUT";
        body = { ...expected, operations };
        break;
      }
      case "members": {
        const users = options.userIDs ?? input(options);
        if (!Array.isArray(users) || users.some((id) => typeof id !== "string")) throw new Error("user_ids_array_required");
        pathname += "/members";
        method = "PUT";
        body = { ...expected, user_ids: users };
        break;
      }
      case "edit":
        method = "PATCH";
        body = { ...(options.edit ?? input(options)), ...expected };
        break;
      case "commit":
        if (!options.message?.trim()) throw new Error("commit_message_required");
        pathname += "/commits";
        body = { ...expected, id: options.commitID ?? randomUUID(), message: options.message };
        break;
      case "push":
        pathname += "/push";
        body = { ...head, ...(options.title ? { title: options.title } : {}) };
        break;
      case "rebase": {
        pathname += "/rebase";
        const payload = options.edit ?? input(options) ?? {};
        if (!record(payload)) throw new Error("rebase_payload_required");
        body = { ...payload, ...head, id: payload.id ?? options.commitID ?? randomUUID(), ...(options.message ? { message: options.message } : {}), ...(options.ontoID ? { onto_commit_id: options.ontoID } : {}) };
        break;
      }
      case "pr-create":
        pathname = `${API}/pull-requests`;
        body = { ...head, workspace_id: state.workspace.id, title: options.title ?? state.workspace.name };
        break;
      case "pr-edit":
      case "pr-merge": {
        if (!options.pullRequestID) throw new Error("pull_request_id_required");
        const prPath = `${API}/pull-requests/${encoded(options.pullRequestID)}`;
        // The PR version/head are the snapshot being approved, independently of
        // this local checkout. The server checks them again inside the merge.
        const pr = await send(prPath);
        if (pr.status !== 200 || !Number.isSafeInteger(pr.body?.version) || typeof pr.body?.source_head_id !== "string")
          return responseResult(pr);
        pathname = command === "pr-merge" ? `${prPath}/merge` : prPath;
        method = command === "pr-merge" ? "POST" : "PATCH";
        body = command === "pr-merge"
          ? { expected_version: pr.body.version, expected_head: pr.body.source_head_id }
          : { ...(options.edit ?? input(options)), expected_version: pr.body.version };
        break;
      }
      case "retry":
        if (!state.pending) throw new Error("no_unknown_request");
        ({ pathname, method, body } = state.pending);
        break;
      default: throw new Error(`unknown_command:${command}`);
    }
    state.pending = { kind: command === "retry" ? state.pending!.kind : command, pathname, method, body };
    save(stateFile, state);
    const response = await send(pathname, method, body);
    if (response.status === 0 || response.status >= 500) {
      return { ok: false, status: response.status, reason: "request_result_unknown_keep_same_request",
        request: state.pending, result: publicFailure(response) };
    }
    delete state.pending;
    const workspace = isWorkspace(response.body) ? response.body
      : isWorkspace(response.body?.workspace) ? response.body.workspace : undefined;
    if (workspace) state.workspace = workspace;
    save(stateFile, state);
    // A reviewer receives only the frozen PR/commits. A null workspace is an
    // intentional privacy boundary, not a reason to fetch the source worktree.
    if (response.status >= 200 && response.status < 300 && response.body?.workspace === null)
      return { ...responseResult(response), workspace: null };
    if (!workspace && response.status >= 200 && response.status < 300) {
      const refreshed = await refresh();
      return { ...responseResult(response), workspace_refreshed: refreshed, workspace: state.workspace };
    }
    return { ...responseResult(response), workspace: state.workspace };
  } finally {
    fs.closeSync(lock);
    fs.unlinkSync(lockFile);
  }
}

export async function runCli(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  if (!command || command === "help") {
    console.log("mf-workspace head|history|revisions|diff|commit-diff|pr-diff|pr-commits|init|fork|list|get|status|checkout|stage|commit|commits|push|rebase|receipt|retry|members|edit|version|tag|tags|stash|stashes|events|merge-status|snapshot|compare|blame|pr-list|pr-create|pr-get|pr-edit|pr-merge\n"
      + "--dir DIR holds the last observed server workspace, version and head; never credentials.\n"
      + "init: [--name NAME] [--entity UUID] [--relation UUID], or --workspace UUID to attach.\n"
      + "checkout: --entity UUID / --relation UUID (repeatable). stage: --file operations.json.\n"
      + "commit: --message TEXT [--commit UUID]. push: [--title TEXT].\n"
      + "rebase: [--onto UUID] [--file native-rebase.json] [--message TEXT] [--commit UUID]. receipt: [--commit UUID].\n"
      + "fork: --dir NEW_DIR --commit UUID [--name NAME] [--entity UUID / --relation UUID].\n"
      + "version|tag|stash: --file native-action.json [--request UUID]. Version/head come from the saved observed copy.\n"
      + "head/history need no --dir. revisions: --record UUID [--version N]. diff: --dir DIR [--basis head|base].\n"
      + "commit-diff/snapshot: --commit UUID (or snapshot uses saved head). pr-diff/pr-commits: --pr UUID. compare: --commit UUID --base UUID. blame: --commit UUID --target entity|relation --record UUID --pointer /field.\n"
      + "Paged reads: [--limit N --offset N]. History/changes: [--target entity|relation --record UUID]; history: [--author UUID --since RFC3339 --until RFC3339]; commits: [--state active|pending|integrated|replaced|all].\n"
      + "members: --file userids.json. edit: --file patch.json. pr-get/pr-edit/pr-merge: --pr UUID.\n"
      + "pr-create: [--title TEXT]. pr-edit: --file patch.json. Unknown outcomes retain the exact request; inspect receipt/status before retry.");
    return;
  }
  const options: WorkspaceOptions = { entityIDs: [], relationIDs: [] };
  const fields: Record<string, keyof WorkspaceOptions> = { "--dir": "dir", "--workspace": "workspaceID", "--name": "name",
    "--author":"authorID","--since":"since","--until":"until","--state":"state","--basis":"basis","--base":"baseID","--onto":"ontoID","--request":"requestID","--target":"target","--record":"recordID","--pointer":"pointer",
    "--message": "message", "--title": "title", "--commit": "commitID", "--pr": "pullRequestID", "--file": "file", "--status": "status" };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i], value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`missing_argument:${flag}`);
    if (flag === "--entity") options.entityIDs!.push(value);
    else if (flag === "--relation") options.relationIDs!.push(value);
    else if (["--limit", "--offset", "--version"].includes(flag)) options[flag.slice(2) as "limit" | "offset" | "version"] = Number(value);
    else if (fields[flag]) (options as Record<string, unknown>)[fields[flag]] = value;
    else throw new Error(`unknown_argument:${flag}`);
  }
  const result = await runWorkspace(command, options);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  runCli().catch((error) => { console.error(JSON.stringify({ ok: false, error: String(error) })); process.exitCode = 1; });
