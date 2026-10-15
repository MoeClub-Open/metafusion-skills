import assert from "node:assert/strict";
import test from "node:test";
import { publicFailure } from "../metafusion-api.mjs";
import { runPlan } from "./mf-platform.mjs";
for (const [status, code] of [
  [401, "invalid_token"],
  [401, "authentication_required"],
  [403, "forbidden"],
  [503, "auth_unavailable"],
]) {
  test(`read HTTP ${status} preserves ${code}`, async () => {
    let calls = 0;
    const result = await runPlan(
      { action: "entity.get", id: "example" },
      {
        requestFn: async () => {
          calls++;
          return { status, body: { error: code } };
        },
      },
    );
    assert.equal(result.reason, code);
    assert.equal(result.ok, false);
    assert.equal(calls, 1);
  });
}
test("unexpected auth bodies and mismatched status codes are suppressed", () => {
  for (const [status, body] of [
    [401, { error: "mfp_secret_from_body" }],
    [401, { error: "forbidden" }],
    [403, { error: "invalid_token" }],
    [500, { error: "auth_unavailable" }],
    [401, { error: { token: "secret" } }],
  ]) {
    const result = publicFailure({ status, body });
    assert.equal(result.error, `http_${status}`);
    assert.equal(JSON.stringify(result).includes("secret"), false);
  }
});
