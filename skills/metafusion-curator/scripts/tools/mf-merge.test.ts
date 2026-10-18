import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
const tool = fileURLToPath(new URL("./mf-merge.ts", import.meta.url));
test("merge help explains the server copy and independent lifecycle action without credentials", () => {
  const result = spawnSync(process.execPath, [tool, "--help"], { encoding: "utf8", env: { ...process.env, MF_PAT: "", MF_BASE: "" } });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /副本.*push/);
  assert.match(result.stdout, /管理员身份合并/);
});
test("removed identity review argument is rejected instead of silently ignored", () => {
  const result = spawnSync(process.execPath, [tool, "--merge", "keep,lose", "--reviews", "reviews.json"], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown_argument:--reviews/);
});
test("merge arguments are validated before any network request", () => {
  for (const args of [["--merge"], ["--pairs", "pairs.json", "--merge", "keep,lose"]]) {
    const result = spawnSync(process.execPath, [tool, ...args], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /argument_required|choose_one_merge_mode/);
  }
});
