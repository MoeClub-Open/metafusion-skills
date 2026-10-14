import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { diffDocument, identityPatch, rebasePatch, runWorkspace } from "./mf-workspace.mjs";

const clone = (x) => JSON.parse(JSON.stringify(x));
const evidence = [{ kind: "url", citation: "Fixture primary page", url: "https://source.test/item" }];
function fixture(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "mf-workspace-")),
    dir = path.join(parent, "working");
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const id = randomUUID(),
    docs = new Map([
      [
        id,
        {
          id,
          kind: "work",
          version: 1,
          title: "base",
          attributes: { language: "ja" },
          translations: { en: { title: "base" } },
          pictures: [],
          status: "draft",
        },
      ],
    ]),
    receipts = new Map(),
    calls = [];
  const fn = async (p, o = {}) => {
    calls.push({ p, o: clone(o) });
    if (p.endsWith("/checkout"))
      return {
        status: 200,
        body: {
          actor_id: "fixture",
          definitions_etag: "defs",
          entities: o.body.entity_ids.map((id) => clone(docs.get(id))),
          relations: [],
        },
      };
    if (p.includes("/commits/") && !p.endsWith("/preview"))
      return receipts.has(p.split("/").at(-1))
        ? { status: 200, body: clone(receipts.get(p.split("/").at(-1))) }
        : { status: 404, body: { error: "not_found" } };
    if (p.endsWith("/commits/preview"))
      return {
        status: 200,
        body: { id: o.body.id, applied: false, refs: {}, items: [] },
      };
    if (p.endsWith("/commits")) {
      const items = o.body.operations.map((op) => {
        const doc = docs.get(op.id),
          rebased = rebasePatch(doc, doc, op.patch);
        docs.set(op.id, { ...rebased.working, version: doc.version + 1 });
        return {
          target: op.target,
          id: op.id,
          version: doc.version + 1,
          changed: true,
          merged: false,
        };
      });
      const receipt = { id: o.body.id, applied: true, refs: {}, items };
      receipts.set(receipt.id, receipt);
      return { status: 200, body: clone(receipt) };
    }
    throw new Error(`unexpected ${p}`);
  };
  const opts = { dir, origin: "https://example.test", requestFn: fn };
  const read = (rel) =>
    JSON.parse(fs.readFileSync(path.join(dir, rel), "utf8"));
  const edit = (patch) => {
    const rel = `entities/${id}.json`,
      doc = read(rel);
    fs.writeFileSync(path.join(dir, rel), JSON.stringify({ ...doc, ...patch }));
  };
  const seal = async (extra = {}) => {
    await runWorkspace("init", opts);
    await runWorkspace("checkout", { ...opts, entityIDs: [id] });
    edit({ title: "mine" });
    return runWorkspace("commit", {
      ...opts,
      note: "verified edit",
      sources: evidence,
      reviews: { [`entity:${id}`]: [] },
      ...extra,
    });
  };
  return { dir, id, docs, receipts, calls, fn, opts, read, edit, seal };
}

test("granular diff preserves unrelated fields, arrays remain atomic, readonly mutation rejected", () => {
  const base = {
    id: "id",
    version: 1,
    title: "base",
    attributes: { language: "ja", duration: 3 },
    pictures: [{ url: "a" }],
  };
  assert.deepEqual(
    diffDocument(
      base,
      { ...base, attributes: { language: "ja", duration: 4 } },
      "entity",
    ),
    [{ path: "/attributes/duration", value: 4 }],
  );
  assert.deepEqual(
    diffDocument(base, { ...base, pictures: [{ url: "b" }] }, "entity"),
    [{ path: "/pictures", value: [{ url: "b" }] }],
  );
  assert.throws(
    () => diffDocument(base, { ...base, version: 2 }, "entity"),
    /immutable_field/,
  );
  assert.deepEqual(
    diffDocument(
      { attributes: null },
      { attributes: { language: "ja" } },
      "entity",
    ),
    [{ path: "/attributes/language", value: "ja" }],
  );
});
test("rebase merges disjoint fields and requires explicit overlap resolution", () => {
  const base = { title: "base", attributes: { language: "ja" } },
    current = { title: "theirs", attributes: { language: "ja" } },
    patch = [
      { path: "/title", value: "ours" },
      { path: "/attributes/language", value: "en" },
    ];
  assert.deepEqual(rebasePatch(base, current, patch).conflicts, ["/title"]);
  assert.equal(
    rebasePatch(base, current, patch, { "/title": "ours" }).working.title,
    "ours",
  );
  assert.equal(
    rebasePatch(base, current, patch, { "/title": "theirs" }).working.title,
    "theirs",
  );
  const special = JSON.parse('{"attributes":{"__proto__":{"polluted":false}}}');
  rebasePatch(special, special, [
    { path: "/attributes/__proto__/polluted", value: true },
  ]);
  assert.equal({}.polluted, undefined);
});
test("commit is local, push atomic receipt refreshes base, no entity PUT", async (t) => {
  const f = fixture(t),
    local = await f.seal();
  assert.equal(
    f.calls.some((c) => c.p.endsWith("/commits")),
    false,
  );
  const r = await runWorkspace("push", { ...f.opts, apply: true });
  assert.equal(r.ok, true);
  assert.equal(r.receipt.id, local.commit_id);
  assert.equal(f.read(".mf/state.json").pending, null);
  assert.equal(f.read(`entities/${f.id}.json`).version, 2);
  assert.equal(
    f.calls.some((c) => c.o.method === "PUT"),
    false,
  );
});
test("preview validates complete receipt and keeps sealed pending commit", async (t) => {
  const f = fixture(t),
    local = await f.seal();
  const malformed = await runWorkspace("preview", f.opts);
  assert.equal(malformed.ok, false);
  const requestFn = async (p, o) =>
    p.endsWith("/preview")
      ? {
          status: 200,
          body: {
            id: o.body.id,
            applied: false,
            refs: {},
            items: [
              {
                target: "entity",
                id: f.id,
                version: 2,
                changed: true,
                merged: false,
              },
            ],
          },
        }
      : f.fn(p, o);
  const result = await runWorkspace("preview", { ...f.opts, requestFn });
  assert.equal(result.ok, true);
  assert.equal(f.read(".mf/state.json").pending.id, local.commit_id);
  assert.equal(f.docs.get(f.id).version, 1);
  assert.equal(f.receipts.size, 0);
});
test("entity creation requires identity review and seals explicit local references", async (t) => {
  const f = fixture(t);
  await runWorkspace("init", f.opts);
  const file = path.join(f.dir, "source.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      kind: "expression",
      title: "Recording",
      work_id: { $ref: "work" },
    }),
  );
  await assert.rejects(
    runWorkspace("create", {
      ...f.opts,
      target: "entity",
      ref: "recording",
      file,
    }),
    /identity_review_required/,
  );
  const review = { reviewed_candidate_ids: [] };
  await runWorkspace("create", {
    ...f.opts,
    target: "entity",
    ref: "recording",
    file,
    review,
  });
  const local = await runWorkspace("commit", {
    ...f.opts,
    note: "fixture",
    sources: evidence,
  });
  const op = f.read(`.mf/commits/${local.commit_id}.json`).request
    .operations[0];
  assert.deepEqual(op.reviewed_candidate_ids, []);
  assert.deepEqual(op.document.work_id, { $ref: "work" });
  assert.equal(
    f.calls.some((c) => c.p.endsWith("/commits")),
    false,
  );
});
test("lost response recovers durable receipt without sending another mutation", async (t) => {
  const f = fixture(t);
  await f.seal();
  const requestFn = async (p, o) => {
    const r = await f.fn(p, o);
    return p.endsWith("/commits")
      ? { status: 0, body: { error: "network" } }
      : r;
  };
  const r = await runWorkspace("push", { ...f.opts, requestFn, apply: true });
  assert.equal(r.ok, true);
  assert.equal(f.calls.filter((c) => c.p.endsWith("/commits")).length, 1);
});
test("unknown push remains sealed; preview and rebase cannot turn uncertainty into a new ID", async (t) => {
  const f = fixture(t),
    sealed = await f.seal();
  const unknown = async (p, o) =>
    p.endsWith("/commits")
      ? { status: 0, body: { error: "network" } }
      : f.fn(p, o);
  const r = await runWorkspace("push", {
    ...f.opts,
    requestFn: unknown,
    apply: true,
  });
  assert.equal(r.applied, null);
  await assert.rejects(
    runWorkspace("preview", f.opts),
    /unknown_push_requires_receipt_same_id/,
  );
  await assert.rejects(
    runWorkspace("rebase", f.opts),
    /unknown_push_requires_receipt_same_id/,
  );
  await assert.rejects(
    runWorkspace("commit", { ...f.opts, note: "again", sources: [{}] }),
    /pending_commit/,
  );
  const rateLimited = async (p, o) =>
    p.endsWith("/commits")
      ? { status: 429, body: { error: "rate_limited" } }
      : f.fn(p, o);
  const again = await runWorkspace("push", {
    ...f.opts,
    requestFn: rateLimited,
    apply: true,
  });
  assert.equal(again.applied, null);
  assert.equal(f.read(".mf/state.json").pending.id, sealed.commit_id);
  assert.equal(f.read(".mf/state.json").pending.outcome, "unknown");
});
test("explicit conflict rebases with new ID, keeping old immutable commit", async (t) => {
  const f = fixture(t),
    local = await f.seal();
  f.docs.set(f.id, { ...f.docs.get(f.id), title: "theirs", version: 2 });
  const reject = async (p, o) =>
    p.endsWith("/commits")
      ? { status: 409, body: { error: "commit_conflict" } }
      : f.fn(p, o);
  await runWorkspace("push", { ...f.opts, requestFn: reject, apply: true });
  const conflict = await runWorkspace("rebase", f.opts);
  assert.equal(conflict.reason, "rebase_conflict");
  const newCommit = await runWorkspace("rebase", {
    ...f.opts,
    resolutions: { [`entity:${f.id}`]: { "/title": "ours" } },
  });
  assert.notEqual(newCommit.commit_id, local.commit_id);
  assert.equal(newCommit.supersedes, local.commit_id);
  assert.equal(
    f.read(`.mf/commits/${local.commit_id}.json`).request.operations[0]
      .base_version,
    1,
  );
  assert.equal(
    f.read(`.mf/commits/${newCommit.commit_id}.json`).request.operations[0]
      .base_version,
    2,
  );
});
test("known transaction busy preserves commit and permits explicit same-ID push", async (t) => {
  const f = fixture(t), sealed = await f.seal();
  const busy = async (p, o) => p.endsWith("/commits")
    ? { status: 503, body: { error: "transaction_busy", applied: false } } : f.fn(p, o);
  const result = await runWorkspace("push", { ...f.opts, requestFn: busy, apply: true });
  assert.equal(result.applied, false);
  assert.equal(result.reason, "push_busy_keep_same_commit");
  assert.equal(result.result.error, "transaction_busy");
  assert.equal(f.read(".mf/state.json").pending.id, sealed.commit_id);
  assert.equal(f.read(".mf/state.json").pending.outcome, "rejected");
  const retry = await runWorkspace("push", { ...f.opts, apply: true });
  assert.equal(retry.ok, true);
  assert.equal(retry.receipt.id, sealed.commit_id);
});
test("a busy response cannot clear uncertainty from a previous push", async (t) => {
  const f = fixture(t), sealed = await f.seal();
  const failed = async (p, o) => p.endsWith("/commits") ? { status: 0, body: {} } : f.fn(p,o);
  await runWorkspace("push", { ...f.opts, requestFn: failed, apply: true });
  const busy = async (p, o) => p.endsWith("/commits")
    ? { status: 503, body: { error: "transaction_busy", applied: false } } : f.fn(p, o);
  const result = await runWorkspace("push", { ...f.opts, requestFn: busy, apply: true });
  assert.equal(result.applied, null);
  assert.equal(f.read(".mf/state.json").pending.id, sealed.commit_id);
  assert.equal(f.read(".mf/state.json").pending.outcome, "unknown");
  await assert.rejects(runWorkspace("rebase", f.opts), /unknown_push_requires_receipt_same_id/);
});
test("dirty checkout, origin mismatch, tampered commit, stale local lock refuse", async (t) => {
  const f = fixture(t),
    local = await f.seal();
  await assert.rejects(
    runWorkspace("status", { ...f.opts, origin: "https://other.test" }),
    /origin_mismatch/,
  );
  const commitFile = path.join(f.dir, `.mf/commits/${local.commit_id}.json`),
    corrupt = f.read(`.mf/commits/${local.commit_id}.json`);
  corrupt.request.edit_note = "changed";
  fs.writeFileSync(commitFile, JSON.stringify(corrupt));
  await assert.rejects(
    runWorkspace("push", { ...f.opts, apply: true }),
    /integrity_failure/,
  );
  fs.writeFileSync(path.join(f.dir, ".mf/lock"), "");
  await assert.rejects(runWorkspace("status", f.opts), /EEXIST/);
});
test("edits after a successful push refresh the baseline and remain ready for another commit", async (t) => {
  const f = fixture(t);
  await f.seal();
  const requestFn = async (p, o) => {
    const r = await f.fn(p, o);
    if (p.endsWith("/commits")) f.edit({ title: "extra edit" });
    return r;
  };
  const r = await runWorkspace("push", { ...f.opts, requestFn, apply: true });
  assert.equal(r.ok, true);
  assert.equal(r.applied, true);
  assert.equal(f.read(`entities/${f.id}.json`).title, "extra edit");
  assert.equal(f.read(`entities/${f.id}.json`).version, 2);
  assert.equal(f.read(".mf/state.json").pending, null);
  assert.equal(f.read(".mf/state.json").entries[0].base.title, "mine");
  assert.deepEqual((await runWorkspace("status", f.opts)).changes[0].patch, [{ path: "/title", value: "extra edit" }]);
  const next = await runWorkspace("commit", { ...f.opts, note: "next", sources: evidence, reviews: { [`entity:${f.id}`]: [] } });
  assert.ok(next.commit_id);
});

test("omitted object keys are preserved; null and explicit deletion stay distinct", () => {
  const base = { title: "base", attributes: { language: "ja", duration: 3 } };
  const working = { attributes: { language: "en" } };
  assert.deepEqual(diffDocument(base, working, "entity"), [{ path: "/attributes/language", value: "en" }]);
  assert.deepEqual(diffDocument(base, { ...base, attributes: null }, "entity"), [{ path: "/attributes", value: null }]);
  assert.deepEqual(diffDocument(base, working, "entity", ["/attributes/duration"]), [
    { path: "/attributes/language", value: "en" }, { path: "/attributes/duration", remove: true },
  ]);
  for (const p of ["/attributes/missing", "/attributes/language", "/version", "/attributes/bad~escape"])
    assert.throws(() => diffDocument(base, working, "entity", [p]), /invalid_explicit_removal/);
});

test("status and an omission-only commit explicitly report preserved keys without sealing deletion", async (t) => {
  const f = fixture(t);
  await runWorkspace("init", f.opts);
  await runWorkspace("checkout", { ...f.opts, entityIDs: [f.id] });
  const doc = f.read(`entities/${f.id}.json`); delete doc.attributes.language;
  fs.writeFileSync(path.join(f.dir, `entities/${f.id}.json`), JSON.stringify(doc));
  const status = await runWorkspace("status", f.opts);
  assert.deepEqual(status.changes[0].patch, []);
  assert.deepEqual(status.changes[0].ignored_omissions, ["/attributes/language"]);
  const result = await runWorkspace("commit", { ...f.opts, note: "edit", sources: evidence });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "omitted_keys_preserved_use_explicit_remove");
  assert.deepEqual(result.ignored_omissions[0].paths, ["/attributes/language"]);
  assert.equal(f.read(".mf/state.json").pending, null);
});

test("explicit removal seals only the approved path and survives a disjoint rebase", async (t) => {
  const f = fixture(t);
  await runWorkspace("init", f.opts);
  await runWorkspace("checkout", { ...f.opts, entityIDs: [f.id] });
  f.edit({ attributes: {} });
  await assert.rejects(runWorkspace("commit", { ...f.opts, note: "remove", sources: evidence,
    removals: ["entity:missing:/attributes/language"] }), /invalid_explicit_removal_target/);
  const local = await runWorkspace("commit", { ...f.opts, note: "remove", sources: evidence,
    removals: [`entity:${f.id}:/attributes/language`] });
  assert.deepEqual(local.ignored_omissions, []);
  assert.deepEqual(f.read(`.mf/commits/${local.commit_id}.json`).request.operations[0].patch,
    [{ path: "/attributes/language", remove: true }]);
  f.docs.set(f.id, { ...f.docs.get(f.id), title: "theirs", version: 2 });
  await runWorkspace("push", { ...f.opts, apply: true, requestFn: async (p, o) => p.endsWith("/commits")
    ? { status: 409, body: { error: "commit_conflict" } } : f.fn(p, o) });
  const rebased = await runWorkspace("rebase", f.opts);
  assert.deepEqual(f.read(`.mf/commits/${rebased.commit_id}.json`).request.operations[0].patch,
    [{ path: "/attributes/language", remove: true }]);
  await runWorkspace("push", { ...f.opts, apply: true });
  assert.deepEqual(f.docs.get(f.id).attributes, {});
  assert.equal(f.docs.get(f.id).title, "theirs");
});

test("identity review follows server title, translation ancestor and external ID patch rules", () => {
  for (const p of ["/title", "/external_links", "/external_links/wikidata", "/translations", "/translations/ja", "/translations/ja/title"])
    assert.equal(identityPatch([{ path: p, value: null }]), true, p);
  for (const p of ["/attributes/language", "/translations/ja/summary", "/translations/ja/aliases"])
    assert.equal(identityPatch([{ path: p, value: null }]), false, p);
});

test("identity updates require explicit canonical reviews, nonidentity updates reject them", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.seal({ reviews: {} }), /identity_review_required/);
  await assert.rejects(runWorkspace("commit", { ...f.opts, note: "edit", sources: evidence,
    reviews: { [`entity:${f.id}`]: [f.id, f.id] } }), /invalid_identity_review/);
  await assert.rejects(runWorkspace("commit", { ...f.opts, note: "edit", sources: evidence,
    reviews: { [`entity:${f.id}`]: ["@local:another"] } }), /invalid_identity_review/);
  f.edit({ title: "base", attributes: { language: "en" } });
  await assert.rejects(runWorkspace("commit", { ...f.opts, note: "edit", sources: evidence,
    reviews: { [`entity:${f.id}`]: [] } }), /invalid_identity_review/);
  const local = await runWorkspace("commit", { ...f.opts, note: "edit", sources: evidence });
  assert.equal(Object.hasOwn(f.read(`.mf/commits/${local.commit_id}.json`).request.operations[0], "reviewed_candidate_ids"), false);
});

test("source eligibility rejects self, instance aliases and malformed URLs before sealing", async (t) => {
  for (const sources of [
    [{ kind: "self", citation: "internal" }],
    [{ kind: "url", citation: "internal", url: "https://example.test/catalog/item" }],
    [{ kind: "publication", citation: "internal", url: "https://WWW.FINDVERSE.CC./catalog/item" }],
    [{ kind: "url", citation: "internal", url: "https://blocked.test/item" }],
  ]) {
    const f = fixture(t);
    await assert.rejects(f.seal({ sources, blockedHosts: ["blocked.test"] }), /source_not_eligible/);
    assert.equal(f.read(".mf/state.json").pending, null);
    assert.deepEqual(fs.readdirSync(path.join(f.dir, ".mf/commits")), []);
  }
  for (const source of [
    { kind: "url", citation: "bad", url: "file:///tmp/source" },
    { kind: "url", citation: "bad", url: "https://secret@source.test/" },
    { kind: "url", citation: "bad" },
    { kind: "publication", citation: "book", url: "not a url" },
  ]) {
    const f = fixture(t);
    await assert.rejects(f.seal({ sources: [source] }), /invalid_source/);
  }
  const f = fixture(t);
  assert.ok((await f.seal({ sources: [{ kind: "publication", citation: "Printed title page, ISBN 978..." }] })).commit_id);
});

test("applied checkout failure recovers on receipt without another mutation", async (t) => {
  const f = fixture(t), local = await f.seal();
  const requestFn = async (p, o) => p.endsWith("/checkout") && f.receipts.size
    ? { status: 503, body: { error: "transaction_busy" } } : f.fn(p, o);
  const result = await runWorkspace("push", { ...f.opts, apply: true, requestFn });
  assert.equal(result.reason, "receipt_confirmed_checkout_pending");
  assert.equal(f.read(".mf/state.json").pending.outcome, "applied");
  const recovered = await runWorkspace("receipt", f.opts);
  assert.equal(recovered.ok, true);
  assert.equal(recovered.receipt.id, local.commit_id);
  assert.equal(f.read(".mf/state.json").pending, null);
  assert.equal(f.calls.filter((c) => c.p.endsWith("/commits")).length, 1);
});

test("receipt refresh conflict preserves local edits and accepts an explicit resolution", async (t) => {
  const f = fixture(t);
  await f.seal();
  const requestFn = async (p, o) => {
    const r = await f.fn(p, o);
    if (p.endsWith("/commits")) {
      f.edit({ title: "extra" });
      f.docs.set(f.id, { ...f.docs.get(f.id), title: "another editor", version: 3 });
    }
    return r;
  };
  const result = await runWorkspace("push", { ...f.opts, requestFn, apply: true });
  assert.equal(result.reason, "receipt_refresh_conflict");
  assert.deepEqual(result.conflicts[0].paths, ["/title"]);
  assert.equal(f.read(`entities/${f.id}.json`).title, "extra");
  assert.equal((await runWorkspace("receipt", f.opts)).reason, "receipt_refresh_conflict");
  const resolved = await runWorkspace("receipt", { ...f.opts, resolutions: { [`entity:${f.id}`]: { "/title": "ours" } } });
  assert.equal(resolved.ok, true);
  assert.equal(f.read(".mf/state.json").pending, null);
  assert.equal(f.read(".mf/state.json").entries[0].base.title, "another editor");
  assert.equal(f.read(`entities/${f.id}.json`).title, "extra");
  assert.equal(f.calls.filter((c) => c.p.endsWith("/commits")).length, 1);
});

test("transient locked rename retries atomically without copying over the target", async (t) => {
  const f = fixture(t);
  await f.seal();
  const rename = fs.renameSync, stateFile = path.join(f.dir, ".mf/state.json"), original = fs.readFileSync(stateFile, "utf8");
  let failures = 0;
  t.mock.method(fs, "copyFileSync", () => { throw new Error("non_atomic_copy_forbidden"); });
  t.mock.method(fs, "renameSync", (from, to) => {
    if (to === stateFile && failures++ < 2) {
      assert.equal(fs.readFileSync(stateFile, "utf8"), original);
      throw Object.assign(new Error("busy"), { code: "EBUSY" });
    }
    return rename(from, to);
  });
  const result = await runWorkspace("push", { ...f.opts, apply: true });
  assert.equal(result.ok, true);
  assert.ok(failures >= 3);
});

test("receipt file lock failure keeps the same commit and recovers without resending", async (t) => {
  const f = fixture(t), local = await f.seal();
  const rename = fs.renameSync;
  const mock = t.mock.method(fs, "renameSync", (from, to) => {
    if (to === path.join(f.dir, `.mf/receipts/${local.commit_id}.json`))
      throw Object.assign(new Error("locked"), { code: "EPERM" });
    return rename(from, to);
  });
  await assert.rejects(runWorkspace("push", { ...f.opts, apply: true }), /locked/);
  assert.equal(f.read(".mf/state.json").pending.id, local.commit_id);
  assert.equal(f.read(".mf/state.json").pending.outcome, "unknown");
  mock.mock.restore();
  assert.equal((await runWorkspace("receipt", f.opts)).ok, true);
  assert.equal(f.calls.filter((c) => c.p.endsWith("/commits")).length, 1);
});

test("durable refresh journal preserves extra edits after final state replacement fails", async (t) => {
  const f = fixture(t), local = await f.seal();
  const rename = fs.renameSync;
  const mock = t.mock.method(fs, "renameSync", (from, to) => {
    if (to === path.join(f.dir, ".mf/state.json") && JSON.parse(fs.readFileSync(from)).pending === null)
      throw Object.assign(new Error("state locked"), { code: "EBUSY" });
    return rename(from, to);
  });
  const requestFn = async (p, o) => { const r = await f.fn(p, o); if (p.endsWith("/commits")) f.edit({ title: "extra" }); return r; };
  await assert.rejects(runWorkspace("push", { ...f.opts, requestFn, apply: true }), /state locked/);
  assert.equal(f.read(`entities/${f.id}.json`).version, 2);
  assert.equal(f.read(`entities/${f.id}.json`).title, "extra");
  assert.equal(f.read(`.mf/refresh/${local.commit_id}.json`).format, 2);
  mock.mock.restore();
  f.edit({ attributes: { language: "en" } });
  assert.equal((await runWorkspace("receipt", f.opts)).ok, true);
  assert.equal(f.read(".mf/state.json").pending, null);
  assert.equal(f.read(`entities/${f.id}.json`).title, "extra");
  assert.equal(f.read(`entities/${f.id}.json`).attributes.language, "en");
  assert.equal(f.calls.filter((c) => c.p.endsWith("/commits")).length, 1);
});

test("partially refreshed files recover against their own journal baseline", async (t) => {
  const f = fixture(t), secondID = randomUUID();
  f.docs.set(secondID, { ...clone(f.docs.get(f.id)), id: secondID });
  await runWorkspace("init", f.opts);
  await runWorkspace("checkout", { ...f.opts, entityIDs: [f.id, secondID] });
  f.edit({ title: "mine" });
  const secondFile = path.join(f.dir, `entities/${secondID}.json`);
  fs.writeFileSync(secondFile, JSON.stringify({ ...f.read(`entities/${secondID}.json`), title: "mine2" }));
  await runWorkspace("commit", { ...f.opts, note: "two items", sources: evidence,
    reviews: { [`entity:${f.id}`]: [], [`entity:${secondID}`]: [] } });
  const rename = fs.renameSync;
  const mock = t.mock.method(fs, "renameSync", (from, to) => {
    if (to === secondFile) throw Object.assign(new Error("second locked"), { code: "EPERM" });
    return rename(from, to);
  });
  const requestFn = async (p, o) => {
    const r = await f.fn(p, o);
    if (p.endsWith("/commits")) {
      f.edit({ title: "extra" });
      fs.writeFileSync(secondFile, JSON.stringify({ ...f.read(`entities/${secondID}.json`), title: "extra2" }));
    }
    return r;
  };
  await assert.rejects(runWorkspace("push", { ...f.opts, requestFn, apply: true }), /second locked/);
  assert.equal(f.read(`entities/${f.id}.json`).version, 2);
  assert.equal(f.read(`entities/${secondID}.json`).version, 1);
  mock.mock.restore();
  assert.equal((await runWorkspace("receipt", f.opts)).ok, true);
  assert.equal(f.read(`entities/${f.id}.json`).title, "extra");
  assert.equal(f.read(`entities/${secondID}.json`).title, "extra2");
  assert.equal(f.read(`entities/${secondID}.json`).version, 2);
  assert.equal(f.read(".mf/state.json").pending, null);
  assert.equal(f.calls.filter((c) => c.p.endsWith("/commits")).length, 1);
});

test("creation receipt adopts server identity while preserving later edits", async (t) => {
  const f = fixture(t);
  await runWorkspace("init", f.opts);
  const source = path.join(f.dir, "source.json");
  fs.writeFileSync(source, JSON.stringify({ kind: "work", title: "new", attributes: {} }));
  await runWorkspace("create", { ...f.opts, target: "entity", ref: "new_work", file: source,
    review: { reviewed_candidate_ids: [] } });
  const local = await runWorkspace("commit", { ...f.opts, note: "create", sources: evidence });
  const requestFn = async (p, o) => {
    if (!p.endsWith("/commits")) return f.fn(p, o);
    const doc = { id: f.id, kind: "work", version: 1, title: "new", attributes: {} };
    f.docs.set(f.id, doc);
    const receipt = { id: o.body.id, applied: true, refs: { new_work: f.id },
      items: [{ target: "entity", id: f.id, version: 1, changed: true, merged: false }] };
    f.receipts.set(receipt.id, receipt);
    fs.writeFileSync(path.join(f.dir, "entities/new-new_work.json"), JSON.stringify({ kind: "work", title: "extra", attributes: {} }));
    return { status: 200, body: receipt };
  };
  const pushed = await runWorkspace("push", { ...f.opts, requestFn, apply: true });
  assert.equal(pushed.ok, true);
  assert.equal(pushed.receipt.id, local.commit_id);
  const state = f.read(".mf/state.json");
  assert.equal(state.pending, null);
  assert.equal(state.entries[0].id, f.id);
  assert.equal(state.entries[0].base.title, "new");
  assert.equal(f.read("entities/new-new_work.json").title, "extra");
  assert.equal(f.read("entities/new-new_work.json").version, 1);
});

test("unknown dynamic paths remain in the sealed patch and preview reports rejection", async (t) => {
  const f = fixture(t);
  await runWorkspace("init", f.opts);
  await runWorkspace("checkout", { ...f.opts, entityIDs: [f.id] });
  f.edit({ attributes: { language: "ja", unknown_key: "unexpected" } });
  const local = await runWorkspace("commit", { ...f.opts, note: "edit", sources: evidence });
  assert.deepEqual(f.read(`.mf/commits/${local.commit_id}.json`).request.operations[0].patch,
    [{ path: "/attributes/unknown_key", value: "unexpected" }]);
  const result = await runWorkspace("preview", { ...f.opts, requestFn: async () =>
    ({ status: 400, body: { error: "unknown_path" } }) });
  assert.equal(result.ok, false);
  assert.equal(result.result.error, "unknown_path");
  assert.equal(f.read(".mf/state.json").pending.id, local.commit_id);
});
