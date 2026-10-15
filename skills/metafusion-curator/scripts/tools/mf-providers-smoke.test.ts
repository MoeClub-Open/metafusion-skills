import assert from "node:assert/strict";
import { test } from "node:test";
import { probeImageTransport } from "./mf-providers-smoke.ts";

test("image HTTP success reports only transport facts, with content, identity and rights unverified", async () => {
  let method;
  const out = await probeImageTransport("https://example.org/cover.jpg", {
    fetchImpl: async (_, init) => { method = init.method; return new Response(null, { headers: { "content-type": "image/jpeg" } }); },
  });
  assert.equal(method, "HEAD");
  assert.equal(out.http_success, true);
  assert.equal(out.declared_content_type, "image/jpeg");
  assert.equal(out.content_verified, false);
  assert.equal(out.identity_status, "unknown");
  assert.equal(out.rights_status, "unknown");
  assert.equal("ok" in out, false);
});

test("image transport failure remains unknown about image identity and rights", async () => {
  const out = await probeImageTransport("https://example.org/cover.jpg", { fetchImpl: async () => { throw new Error("offline"); } });
  assert.equal(out.responded, false);
  assert.equal(out.http_success, false);
  assert.equal(out.identity_status, "unknown");
  assert.equal(out.rights_status, "unknown");
});
