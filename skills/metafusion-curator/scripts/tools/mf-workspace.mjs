#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  request,
  configuredOrigin,
  publicFailure,
} from "../metafusion-api.mjs";

const API = "/api/catalog";
const fields = {
  entity: new Set(
    "title original_language translations attributes external_links pictures content_unit_id parent_id position number contents subjects".split(
      " ",
    ),
  ),
  relation: new Set(["position", "attributes"]),
};
const record = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
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
const digest = (x) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(x)))
    .digest("hex");
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
function omittedPaths(base, working, target, removals = []) {
  const ignored = [];
  function visit(a, b, p) {
    for (const k of Object.keys(a)) {
      const child = `${p}/${escape(k)}`;
      if (!has(b, k)) {
        if (!removals.some((r) => child === r || child.startsWith(r + "/")))
          ignored.push(child);
      } else if (record(a[k]) && record(b[k])) visit(a[k], b[k], child);
    }
  }
  for (const k of fields[target]) {
    if (!has(base, k)) continue;
    const p = `/${escape(k)}`;
    if (!has(working, k)) {
      if (!removals.includes(p)) ignored.push(p);
    } else if (record(base[k]) && record(working[k])) visit(base[k], working[k], p);
  }
  return ignored;
}
export function identityPatch(patch) {
  return patch.some(({ path: p }) => {
    const keys = parts(p);
    return keys[0] === "title" || keys[0] === "external_links" ||
      (keys[0] === "translations" && (keys.length <= 2 || keys[2] === "title"));
  });
}
function validateReview(ids, allowLocal = false) {
  if (!Array.isArray(ids) || ids.length > 1000 || new Set(ids).size !== ids.length ||
      ids.some((id) => typeof id !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id) &&
        !(allowLocal && /^@local:[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id))))
    throw new Error("invalid_identity_review");
  return ids;
}

/** Commit evidence pool: every source needs a unique key; every operation must cite
 *  sources via source_refs. Auto-fills missing keys (s1, s2, …) and, when an
 *  operation omits source_refs, cites every pool source for the whole operation.
 *  Old format without keys/source_refs is rejected by the server; this keeps the
 *  local tool producing valid payloads so Agents do not submit failing commits. */
function normalizeCommitEvidence(evidence, operations) {
  if (!Array.isArray(evidence) || !evidence.length) throw new Error("commit_evidence_required");
  const reserved = new Set();
  for (const raw of evidence) {
    if (!record(raw)) throw new Error("invalid_source");
    if (raw.key !== undefined && typeof raw.key !== "string") throw new Error("invalid_source_key");
    const key = raw.key?.trim();
    if (key) {
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key)) throw new Error("invalid_source_key");
      if (reserved.has(key)) throw new Error("duplicate_source_key");
      reserved.add(key);
    }
  }
  const used = new Set();
  let counter = 0;
  const sources = evidence.map((raw) => {
    if (!record(raw)) throw new Error("invalid_source");
    let key = typeof raw.key === "string" ? raw.key.trim() : "";
    if (!key) {
      do { counter += 1; key = `s${counter}`; } while (reserved.has(key) || used.has(key));
    }
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key)) throw new Error("invalid_source_key");
    if (used.has(key)) throw new Error("duplicate_source_key");
    used.add(key);
    const { pointers, scope, ...rest } = raw;
    if (pointers !== undefined && pointers !== null && !(Array.isArray(pointers) && pointers.length === 0))
      throw new Error("source_pointers_not_allowed");
    if (scope) throw new Error("source_scope_not_allowed");
    return { ...rest, key };
  });
  const defaultRefs = sources.map((s) => ({ source: s.key }));
  const ops = operations.map((op) => {
    if (!record(op)) throw new Error("invalid_commit_operation");
    if (Array.isArray(op.source_refs) && op.source_refs.length)
      return op;
    return { ...op, source_refs: defaultRefs.map((r) => ({ ...r })) };
  });
  return { sources, operations: ops };
}

function evidenceEligible(evidence, origin, blockedHosts = []) {
  const blocked = new Set(["findverse.cc"]);
  for (const value of [origin, process.env.MF_API_ORIGIN, process.env.MF_BASE, ...blockedHosts]) {
    if (!value) continue;
    try { blocked.add(new URL(value.includes("://") ? value : `https://${value}`).hostname.toLowerCase().replace(/\.$/, "")); }
    catch { throw new Error("invalid_blocked_host"); }
  }
  for (const source of evidence) {
    if (source?.kind === "self") throw new Error("source_not_eligible");
    if (!record(source) || !["url", "publication"].includes(source.kind) ||
        typeof source.citation !== "string" || !source.citation.trim())
      throw new Error("invalid_source");
    if (source.kind === "url" || (source.url !== undefined && source.url !== "")) {
      let url;
      try { url = new URL(source.url); } catch { throw new Error("invalid_source"); }
      if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password)
        throw new Error("invalid_source");
      const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
      if ([...blocked].some((host) => hostname === host || hostname.endsWith(`.${host}`)))
        throw new Error("source_not_eligible");
    }
  }
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
function read(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function save(file, value, exclusive = false) {
  const text = JSON.stringify(value, null, 2) + "\n";
  if (exclusive) {
    const fd = fs.openSync(file, "wx", 0o600);
    try {
      fs.writeFileSync(fd, text, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return;
  }
  const temp = `${file}.${randomUUID()}.tmp`,
    fd = fs.openSync(temp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, text, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    // Windows scanners may briefly hold the destination. Keep the replacement
    // atomic even when retrying; copying over state/receipts can truncate them.
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(temp, file);
        return;
      } catch (err) {
        if (!["EPERM", "EBUSY"].includes(err.code) || attempt >= 5) throw err;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
      }
    }
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
function safeFile(root, rel) {
  const full = path.resolve(root, rel);
  if (!full.startsWith(root + path.sep))
    throw new Error("workspace_path_escape");
  let current = root;
  for (const p of path.relative(root, full).split(path.sep)) {
    current = path.join(current, p);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink())
      throw new Error("workspace_symlink");
  }
  return full;
}
function requireResponse(r) {
  if (r.status < 200 || r.status >= 300)
    throw new Error(`HTTP_${r.status}:${r.body?.error ?? "unknown"}`);
  return r.body;
}
function validateCheckout(body, entityIDs = [], relationIDs = []) {
  if (
    !record(body) ||
    typeof body.actor_id !== "string" ||
    !body.actor_id ||
    typeof body.definitions_etag !== "string" ||
    !Array.isArray(body.entities) ||
    !Array.isArray(body.relations)
  )
    throw new Error("invalid_checkout_response");
  for (const [target, ids] of [
    ["entity", entityIDs],
    ["relation", relationIDs],
  ]) {
    const items = body[target === "entity" ? "entities" : "relations"];
    if (
      items.length !== ids.length ||
      new Set(items.map((x) => x.id)).size !== ids.length ||
      items.some(
        (x) =>
          !ids.includes(x.id) ||
          !Number.isSafeInteger(x.version) ||
          x.version < 1,
      )
    )
      throw new Error("incomplete_checkout");
  }
  return body;
}
function validReceipt(receipt, commit, applied = true) {
  if (
    !record(receipt) ||
    receipt.id !== commit.id ||
    receipt.applied !== applied ||
    !record(receipt.refs) ||
    !Array.isArray(receipt.items) ||
    receipt.items.length !== commit.operations.length
  )
    return false;
  return commit.operations.every((op, i) => {
    const x = receipt.items[i];
    return (
      x.target === op.target &&
      x.id === (op.action === "create" ? receipt.refs[op.ref] : op.id) &&
      typeof x.id === "string" &&
      /^[0-9a-f-]{36}$/.test(x.id) &&
      Number.isSafeInteger(x.version) &&
      x.version > 0 &&
      typeof x.changed === "boolean" &&
      typeof x.merged === "boolean"
    );
  });
}

// One workspace per editor. A local exclusive lock prevents two processes from
// publishing or changing its receipt at once; server concurrency stays independent.
export async function runWorkspace(
  command,
  {
    dir,
    origin,
    entityIDs = [],
    relationIDs = [],
    target = "entity",
    ref,
    file,
    language,
    translationTitle,
    review,
    note,
    sources,
    commitID,
    resolutions = {},
    reviews = {},
    removals = [],
    blockedHosts = [],
    apply = false,
    requestFn = request,
  } = {},
) {
  if (!dir || !origin) throw new Error("workspace_and_origin_required");
  const root = path.resolve(dir),
    stateFile = safeFile(root, ".mf/state.json");
  if (command === "init") {
    if (fs.existsSync(root)) throw new Error("workspace_directory_exists");
    const checkout = validateCheckout(
      requireResponse(
        await requestFn(`${API}/checkout`, {
          method: "POST",
          body: { entity_ids: [], relation_ids: [] },
        }),
      ),
    );
    fs.mkdirSync(path.dirname(root), { recursive: true });
    fs.mkdirSync(root);
    fs.mkdirSync(path.join(root, ".mf"));
    for (const d of [
      "entities",
      "relations",
      ".mf/commits",
      ".mf/receipts",
      ".mf/refresh",
    ])
      fs.mkdirSync(path.join(root, d));
    save(
      stateFile,
      {
        format: 1,
        origin,
        actor_id: checkout.actor_id,
        definitions_etag: checkout.definitions_etag,
        entries: [],
        pending: null,
      },
      true,
    );
    return { ok: true, dir: root, definitions_etag: checkout.definitions_etag };
  }
  if (!fs.existsSync(stateFile)) throw new Error("workspace_not_initialized");
  const lockFile = safeFile(root, ".mf/lock");
  const lock = fs.openSync(lockFile, "wx", 0o600);
  fs.writeFileSync(
    lock,
    JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }),
  );
  try {
    const state = read(stateFile);
    if (state.format !== 1 || state.origin !== origin)
      throw new Error("workspace_origin_mismatch");
    const fileFor = (e) => safeFile(root, e.file);
    const removalsFor = (e) => removals
      .filter((p) => p.startsWith(`${e.target}:${e.id ?? e.ref}:`))
      .map((p) => p.slice(`${e.target}:${e.id ?? e.ref}:`.length));
    const status = () =>
      state.entries
        .map((e) => {
          const working = read(fileFor(e));
          return {
            target: e.target, id: e.id ?? null, ref: e.ref ?? null, file: e.file,
            patch: e.base ? diffDocument(e.base, working, e.target, removalsFor(e)) : null,
            ignored_omissions: e.base ? omittedPaths(e.base, working, e.target, removalsFor(e)) : [],
          };
        })
        .filter((e) => e.patch === null || e.patch.length || e.ignored_omissions.length);
    if (command === "status")
      return { ok: true, pending: state.pending, changes: status() };
    if (command === "article") {
      if (state.pending) throw new Error("pending_commit");
      if (!file || !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(language || ""))
        throw new Error("article_file_and_language_required");
      if (entityIDs.length + (ref ? 1 : 0) !== 1) throw new Error("one_entity_or_ref_required");
      const entry = state.entries.find((item) => item.target === "entity" && (ref ? item.ref === ref : item.id === entityIDs[0]));
      if (!entry) throw new Error("entity_not_checked_out");
      if (fs.statSync(file).size > 400000) throw new Error("article_too_long");
      const body = new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(file));
      if (body.includes("\0")) throw new Error("invalid_article_body");
      if (Array.from(body).length > 100000) throw new Error("article_too_long");
      const document = read(fileFor(entry));
      const translations = document.translations || {};
      const previous = translations[language] || {};
      const title = translationTitle ?? previous.title;
      if (typeof title !== "string" || !title.trim()) throw new Error("translation_title_required");
      document.translations = { ...translations, [language]: { ...previous, title, body } };
      save(fileFor(entry), document);
      return { ok: true, language, file: entry.file, code_points: Array.from(body).length, applied: false };
    }
    if (command === "checkout") {
      if (state.pending)
        throw new Error("pending_commit_requires_receipt_or_rebase");
      if (status().length) throw new Error("working_tree_dirty");
      const allEntities = [
        ...new Set([
          ...state.entries
            .filter((e) => e.target === "entity")
            .map((e) => e.id),
          ...entityIDs,
        ]),
      ];
      const allRelations = [
        ...new Set([
          ...state.entries
            .filter((e) => e.target === "relation")
            .map((e) => e.id),
          ...relationIDs,
        ]),
      ];
      if (allEntities.length + allRelations.length > 100)
        throw new Error("workspace_entity_limit");
      const co = validateCheckout(
        requireResponse(
          await requestFn(`${API}/checkout`, {
            method: "POST",
            body: { entity_ids: allEntities, relation_ids: allRelations },
          }),
        ),
        allEntities,
        allRelations,
      );
      if (co.actor_id !== state.actor_id)
        throw new Error("workspace_actor_mismatch");
      state.entries = [];
      state.definitions_etag = co.definitions_etag;
      for (const [target, items] of [
        ["entity", co.entities],
        ["relation", co.relations],
      ])
        for (const doc of items) {
          const rel = `${target === "entity" ? "entities" : "relations"}/${doc.id}.json`;
          save(safeFile(root, rel), doc);
          state.entries.push({ target, id: doc.id, file: rel, base: doc });
        }
      save(stateFile, state);
      return { ok: true, checked_out: state.entries.length };
    }
    if (command === "create") {
      if (state.pending) throw new Error("pending_commit");
      if (
        !fields[target] ||
        !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(ref ?? "") ||
        !file
      )
        throw new Error("invalid_create_arguments");
      if (
        state.entries.length >= 100 ||
        state.entries.some((e) => e.ref === ref)
      )
        throw new Error("duplicate_or_excessive_ref");
      const doc = read(file);
      if (
        !record(doc) ||
        doc.id ||
        doc.version ||
        doc.created_by ||
        doc.redirect_id ||
        doc.updated_at ||
        doc.via
      )
        throw new Error("server_fields_forbidden");
      if (
        target === "entity" &&
        (!record(review) ||
          !Array.isArray(review.reviewed_candidate_ids) ||
          review.reviewed_candidate_ids.some((x) => typeof x !== "string"))
      )
        throw new Error("identity_review_required");
      if (target === "entity") validateReview(review.reviewed_candidate_ids, true);
      const rel = `${target === "entity" ? "entities" : "relations"}/new-${ref}.json`;
      save(safeFile(root, rel), doc, true);
      state.entries.push({
        target,
        ref,
        file: rel,
        ...(target === "entity" ? { review } : {}),
      });
      save(stateFile, state);
      return { ok: true, file: rel };
    }
    const loadCommit = (id) => {
      if (!/^[0-9a-f-]{36}$/.test(id ?? ""))
        throw new Error("commit_id_required");
      const sealed = read(safeFile(root, `.mf/commits/${id}.json`));
      if (
        sealed.origin !== origin ||
        sealed.hash !== digest(sealed.request) ||
        sealed.request.id !== id
      )
        throw new Error("commit_integrity_failure");
      return sealed;
    };
    const seal = (operations, editNote, evidence, snapshots) => {
      if (!operations.length || operations.length > 100)
        throw new Error("empty_or_excessive_commit");
      if (!editNote?.trim() || !Array.isArray(evidence) || !evidence.length)
        throw new Error("commit_evidence_required");
      evidenceEligible(evidence, origin, blockedHosts);
      const normalized = normalizeCommitEvidence(evidence, operations);
      const request = {
        id: randomUUID(),
        definitions_etag: state.definitions_etag,
        edit_note: editNote,
        sources: normalized.sources,
        operations: normalized.operations,
      };
      save(
        safeFile(root, `.mf/commits/${request.id}.json`),
        { origin, hash: digest(request), request, snapshots },
        true,
      );
      state.pending = { id: request.id, outcome: "local" };
      save(stateFile, state);
      return { ok: true, commit_id: request.id, operations: operations.length };
    };
    if (command === "commit") {
      if (state.pending) throw new Error("pending_commit");
      const operations = [],
        snapshots = {}, ignored_omissions = [];
      if (!Array.isArray(removals) || removals.some((p) => typeof p !== "string" ||
          !state.entries.some((e) => e.id && p.startsWith(`${e.target}:${e.id}:/`))))
        throw new Error("invalid_explicit_removal_target");
      for (const e of state.entries) {
        const doc = read(fileFor(e));
        snapshots[e.file] = doc;
        if (!e.id)
          operations.push({
            target: e.target,
            action: "create",
            ref: e.ref,
            document: doc,
            ...(e.target === "entity"
              ? { reviewed_candidate_ids: e.review.reviewed_candidate_ids }
              : {}),
          });
        else {
          const explicit = removalsFor(e),
            patch = diffDocument(e.base, doc, e.target, explicit),
            ignored = omittedPaths(e.base, doc, e.target, explicit);
          if (ignored.length) ignored_omissions.push({ target: e.target, id: e.id, paths: ignored });
          const reviewed = reviews[`${e.target}:${e.id}`];
          if (e.target === "entity" && identityPatch(patch)) {
            if (reviewed === undefined) throw new Error("identity_review_required");
            validateReview(reviewed);
          } else if (reviewed !== undefined) throw new Error("invalid_identity_review");
          if (patch.length)
            operations.push({
              target: e.target,
              action: "update",
              id: e.id,
              base_version: e.base.version,
              patch,
              ...(reviewed !== undefined ? { reviewed_candidate_ids: reviewed } : {}),
            });
        }
      }
      if (!operations.length && ignored_omissions.length)
        return { ok: false, applied: false, reason: "omitted_keys_preserved_use_explicit_remove", ignored_omissions };
      return { ...seal(operations, note, sources, snapshots), ignored_omissions };
    }
    const id = commitID ?? state.pending?.id,
      sealed = loadCommit(id),
      commit = sealed.request;
    if (!state.pending || state.pending.id !== id)
      throw new Error("commit_not_pending");
    async function finalize(receipt) {
      if (receipt?.applied === false && ["pending_review","reviewed"].includes(receipt.review_status) &&
          ["pending","rejected"].includes(receipt.review_decision) && validReceipt(receipt,commit,false)) {
        save(safeFile(root, `.mf/receipts/${id}.json`), receipt);
        state.pending.outcome = receipt.review_decision === "rejected" ? "rejected" : "pending_review";
        save(stateFile,state);
        return {ok:true,applied:false,queued:receipt.review_status==="pending_review",reason:receipt.review_decision==="rejected"?"review_rejected":"pending_review",receipt};
      }
      if (!validReceipt(receipt, commit)) {
        state.pending.outcome = "unknown";
        save(stateFile, state);
        return {
          ok: false,
          applied: null,
          reason: "invalid_receipt",
          commit_id: id,
        };
      }
      save(safeFile(root, `.mf/receipts/${id}.json`), receipt);
      state.pending.outcome = "applied";
      save(stateFile, state);
      const journalFile = safeFile(root, `.mf/refresh/${id}.json`);
      const journal = fs.existsSync(journalFile) ? read(journalFile) : {};
      const entityIDs = state.entries
        .filter((e) => e.target === "entity")
        .map((e) => e.id ?? receipt.refs[e.ref]);
      const relationIDs = state.entries
        .filter((e) => e.target === "relation")
        .map((e) => e.id ?? receipt.refs[e.ref]);
      let co;
      try {
        co = validateCheckout(
          requireResponse(
            await requestFn(`${API}/checkout`, {
              method: "POST",
              body: { entity_ids: entityIDs, relation_ids: relationIDs },
            }),
          ),
          entityIDs,
          relationIDs,
        );
      } catch (error) {
        state.pending.outcome = "applied";
        save(stateFile, state);
        return {
          ok: false,
          applied: true,
          reason: "receipt_confirmed_checkout_pending",
          detail: String(error),
          receipt,
        };
      }
      if (co.actor_id !== state.actor_id)
        throw new Error("workspace_actor_mismatch");
      for (const item of receipt.items) {
        const doc = (
          item.target === "entity" ? co.entities : co.relations
        ).find((e) => e.id === item.id);
        if (doc.version < item.version)
          throw new Error("stale_checkout_after_push");
      }
      const refresh = {}, conflicts = [], ignored_omissions = [];
      for (const e of state.entries) {
        const entityID = e.id ?? receipt.refs[e.ref];
        const doc = (e.target === "entity" ? co.entities : co.relations).find(
          (x) => x.id === entityID,
        );
        const working = read(fileFor(e)),
          prior = journal.format === 2 ? journal.files?.[e.file]?.base : journal[e.file],
          // A previous refresh may have written only some files before failing.
          // Their server fields identify the durable journal's newer baseline.
          base = prior && working.id === prior.id && working.version === prior.version
            ? prior : sealed.snapshots[e.file],
          patch = diffDocument(base, working, e.target),
          result = rebasePatch(base, doc, patch, resolutions[`${e.target}:${entityID}`] ?? {}),
          ignored = omittedPaths(base, working, e.target);
        if (ignored.length) ignored_omissions.push({ target: e.target, id: entityID, paths: ignored });
        if (result.conflicts.length)
          conflicts.push({ target: e.target, id: entityID, paths: result.conflicts });
        refresh[e.file] = { base: doc, working: result.working };
      }
      if (conflicts.length)
        return { ok: false, applied: true, reason: "receipt_refresh_conflict", conflicts, receipt, ignored_omissions };
      // Persist both baselines and preserved local edits before touching files.
      // Retrying receipt after any write failure never loses or repeats a push.
      save(journalFile, { format: 2, files: refresh });
      for (const e of state.entries) {
        e.id = e.id ?? receipt.refs[e.ref];
        e.base = refresh[e.file].base;
        delete e.ref;
        delete e.review;
        save(fileFor(e), refresh[e.file].working);
      }
      state.definitions_etag = co.definitions_etag;
      state.pending = null;
      save(stateFile, state);
      return { ok: true, applied: true, receipt, ignored_omissions };
    }
    if (command === "rebase") {
      if (!["conflict", "rejected"].includes(state.pending.outcome))
        throw new Error("unknown_push_requires_receipt_same_id");
      const receipt = await requestFn(`${API}/commits/${id}`);
      if (receipt.status === 200 && receipt.body?.review_decision !== "rejected") return finalize(receipt.body);
      if (receipt.status !== 404 && !(receipt.status===200 && receipt.body?.review_decision==="rejected")) throw new Error("receipt_unavailable");
      evidenceEligible(commit.sources, origin, blockedHosts);
      for (const e of state.entries)
        if (!same(read(fileFor(e)), sealed.snapshots[e.file]))
          throw new Error("working_tree_changed_after_commit");
      const entityIDs = state.entries
          .filter((e) => e.id && e.target === "entity")
          .map((e) => e.id),
        relationIDs = state.entries
          .filter((e) => e.id && e.target === "relation")
          .map((e) => e.id);
      const co = validateCheckout(
        requireResponse(
          await requestFn(`${API}/checkout`, {
            method: "POST",
            body: { entity_ids: entityIDs, relation_ids: relationIDs },
          }),
        ),
        entityIDs,
        relationIDs,
      );
      if (co.actor_id !== state.actor_id)
        throw new Error("workspace_actor_mismatch");
      const rebased = [],
        conflicts = [],
        snapshots = {},
        pendingWrites = [];
      for (const op of commit.operations) {
        if (op.action === "create") {
          const refreshed = reviews[op.ref];
          if (refreshed !== undefined) validateReview(refreshed, true);
          rebased.push({
            ...op,
            ...(refreshed !== undefined
              ? { reviewed_candidate_ids: refreshed }
              : {}),
          });
          continue;
        }
        const entry = state.entries.find(
            (e) => e.target === op.target && e.id === op.id,
          ),
          current = (op.target === "entity" ? co.entities : co.relations).find(
            (e) => e.id === op.id,
          );
        const result = rebasePatch(
          entry.base,
          current,
          op.patch,
          resolutions[`${op.target}:${op.id}`] ?? {},
        );
        if (result.conflicts.length)
          conflicts.push({
            target: op.target,
            id: op.id,
            paths: result.conflicts,
          });
        const patch = diffDocument(current, result.working, op.target,
          op.patch.filter((p) => p.remove && getAt(current, p.path).exists && !getAt(result.working, p.path).exists).map((p) => p.path));
        const refreshed = reviews[`${op.target}:${op.id}`];
        if (refreshed !== undefined) validateReview(refreshed);
        if (patch.length) {
          const updated = { ...op, base_version: current.version, patch };
          if (op.target === "entity" && identityPatch(patch)) {
            if (refreshed !== undefined) updated.reviewed_candidate_ids = refreshed;
            if (updated.reviewed_candidate_ids === undefined) throw new Error("identity_review_required");
          } else {
            if (refreshed !== undefined) throw new Error("invalid_identity_review");
            delete updated.reviewed_candidate_ids;
          }
          rebased.push(updated);
        }
        pendingWrites.push({ entry, current, working: result.working });
      }
      if (conflicts.length)
        return {
          ok: false,
          applied: false,
          reason: "rebase_conflict",
          conflicts,
        };
      for (const entry of state.entries.filter((e) => e.id)) {
        const edit = pendingWrites.find((x) => x.entry === entry),
          current = (
            entry.target === "entity" ? co.entities : co.relations
          ).find((x) => x.id === entry.id);
        entry.base = current;
        save(fileFor(entry), edit ? edit.working : current);
      }
      for (const entry of state.entries.filter((e) => !e.id)) {
        const op = rebased.find((x) => x.action === "create" && x.ref === entry.ref);
        if (entry.target === "entity") entry.review = { reviewed_candidate_ids: op.reviewed_candidate_ids };
      }
      state.definitions_etag = co.definitions_etag;
      state.pending = null;
      for (const e of state.entries) snapshots[e.file] = read(fileFor(e));
      if (!rebased.length) {
        save(stateFile, state);
        return { ok: true, applied: false, reason: "changes_already_present" };
      }
      return {
        ...seal(rebased, commit.edit_note, commit.sources, snapshots),
        supersedes: id,
      };
    }
    if (!["preview", "push", "receipt"].includes(command))
      throw new Error("unknown_workspace_command");
    if (command === "preview") {
      if (["unknown", "applied"].includes(state.pending.outcome))
        throw new Error("unknown_push_requires_receipt_same_id");
      const r = await requestFn(`${API}/commits/preview`, {
        method: "POST",
        body: commit,
      });
      if (r.status === 409) {
        state.pending.outcome = "conflict";
        save(stateFile, state);
      }
      return {
        ok: r.status === 200 && validReceipt(r.body, commit, false),
        applied: false,
        commit_id: id,
        status: r.status,
        result: r.status === 200 ? r.body : publicFailure(r),
      };
    }
    const prior = await requestFn(`${API}/commits/${id}`);
    if (prior.status === 200) return finalize(prior.body);
    if (prior.status !== 404)
      return {
        ok: false,
        applied: null,
        reason: "receipt_unavailable",
        status: prior.status,
        commit_id: id,
      };
    if (command === "receipt")
      return {
        ok: false,
        applied: null,
        reason: "receipt_not_found_may_be_in_flight",
        commit_id: id,
      };
    if (!apply) throw new Error("push_requires_apply_and_task_authorization");
    const identity = validateCheckout(
      requireResponse(
        await requestFn(`${API}/checkout`, {
          method: "POST",
          body: { entity_ids: [], relation_ids: [] },
        }),
      ),
    );
    if (identity.actor_id !== state.actor_id)
      throw new Error("workspace_actor_mismatch");
    for (const e of state.entries)
      if (!same(read(fileFor(e)), sealed.snapshots[e.file]))
        throw new Error("working_tree_changed_after_commit");
    // Persist uncertainty before sending. A killed process cannot leave a local
    // state which allows rebasing or giving the same work a new request ID.
    const previouslyUnknown = ["unknown", "applied"].includes(
      state.pending.outcome,
    );
    state.pending.outcome = "unknown";
    save(stateFile, state);
    const pushed = await requestFn(`${API}/commits`, {
      method: "POST",
      body: commit,
      tries: 1,
    });
    if (pushed.status === 200 || pushed.status === 202) return finalize(pushed.body);
    // This specific 503 certifies rollback of this request. It cannot resolve
    // an earlier lost response: another same-ID request may still be in flight.
    if (!previouslyUnknown && pushed.status === 503 &&
        pushed.body?.error === "transaction_busy" && pushed.body?.applied === false) {
      state.pending.outcome = "rejected";
      save(stateFile, state);
      return {
        ok: false, applied: false, reason: "push_busy_keep_same_commit",
        commit_id: id, status: pushed.status, result: publicFailure(pushed),
      };
    }
    if (pushed.status === 0 || pushed.status >= 500) {
      const recovered = await requestFn(`${API}/commits/${id}`);
      if (recovered.status === 200) return finalize(recovered.body);
      return {
        ok: false,
        applied: null,
        reason: "push_unknown_keep_same_commit",
        commit_id: id,
        status: pushed.status,
      };
    }
    if (previouslyUnknown)
      return {
        ok: false,
        applied: null,
        reason: "previous_push_still_unknown_keep_same_commit",
        status: pushed.status,
        commit_id: id,
        result: publicFailure(pushed),
      };
    state.pending.outcome = pushed.status === 409 ? "conflict" : "rejected";
    save(stateFile, state);
    return {
      ok: false,
      applied: false,
      status: pushed.status,
      result: publicFailure(pushed),
      commit_id: id,
    };
  } finally {
    fs.closeSync(lock);
    fs.unlinkSync(lockFile);
  }
}

export async function runCli(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  if (!command || command === "help") {
    console.log(
      "mf-workspace init|checkout|create|article|status|commit|preview|push|receipt|rebase --dir DIR\ncheckout: --entity UUID / --relation UUID (repeatable)\narticle: --entity UUID (or --ref NAME) --lang LOCALE --file article.md [--title TITLE] (local edit only)\ncreate: --target entity|relation --ref NAME --file document.json --review identity-review.json (entities)\ncommit: --note TEXT --sources sources.json [--reviews identity-reviews.json] [--remove entity:UUID:/path] (repeatable)\nMissing keys are preserved and reported as ignored_omissions; deletion requires --remove.\npush: --apply [--commit UUID]; preview/receipt: [--commit UUID]\nreceipt/rebase: [--resolutions resolutions.json]; rebase: [--reviews identity-reviews.json]\n--blocked-host HOST (repeatable): additional local evidence host blacklist",
    );
    return;
  }
  const options = { entityIDs: [], relationIDs: [], removals: [], blockedHosts: [] };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--apply") {
      options.apply = true;
      continue;
    }
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error("missing_argument");
    switch (flag) {
      case "--dir":
        options.dir = value;
        break;
      case "--entity":
        options.entityIDs.push(value);
        break;
      case "--relation":
        options.relationIDs.push(value);
        break;
      case "--target":
        options.target = value;
        break;
      case "--ref":
        options.ref = value;
        break;
      case "--file":
        options.file = value;
        break;
      case "--lang":
        options.language = value;
        break;
      case "--title":
        options.translationTitle = value;
        break;
      case "--note":
        options.note = value;
        break;
      case "--sources":
        options.sources = read(value);
        break;
      case "--review":
        options.review = read(value);
        break;
      case "--reviews":
        options.reviews = read(value);
        break;
      case "--remove":
        options.removals.push(value);
        break;
      case "--blocked-host":
        options.blockedHosts.push(value);
        break;
      case "--commit":
        options.commitID = value;
        break;
      case "--resolutions":
        options.resolutions = read(value);
        break;
      default:
        throw new Error(`unknown_argument:${flag}`);
    }
  }
  const result = await runWorkspace(command, {
    ...options,
    origin: configuredOrigin(),
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  runCli().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: String(error) }));
    process.exitCode = 1;
  });
