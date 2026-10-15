import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Reusable tools must not put execution artifacts into the installed skill.
// A caller can keep a reproducible chain in its task directory via MF_AUDIT_OUT.
export function auditOutputDirectory() {
  return process.env.MF_AUDIT_OUT
    ? path.resolve(process.env.MF_AUDIT_OUT)
    : fs.mkdtempSync(path.join(os.tmpdir(), "mf-curator-audit-"));
}
