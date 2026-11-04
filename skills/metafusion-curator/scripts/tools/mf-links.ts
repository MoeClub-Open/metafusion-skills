import { request } from "../metafusion-api.ts";

const LINK_DIRECTIONS = new Set(["both", "outgoing", "incoming"]);
const LINK_CLASSES = new Set(["ownership", "placement", "inclusion", "semantic", "reference"]);
const LINK_KINDS = new Set(["agent", "collection", "work", "content_unit", "expression", "release", "medium", "track"]);

function normalizeListParam(value: unknown, allowed?: Set<string>): string[] | null {
  const raw = typeof value === "string" ? value.split(",").map((s) => s.trim()).filter(Boolean) : Array.isArray(value) ? value : null;
  if (!raw || raw.length === 0) return null;
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !item.trim()) return null;
    const trimmed = item.trim();
    if (allowed && !allowed.has(trimmed)) return null;
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

export function validateLinkParams(params: unknown): string | null {
  if (params === undefined) return null;
  if (!params || typeof params !== "object" || Array.isArray(params)) return "invalid_link_params";
  const allowedKeys = new Set(["direction", "classes", "rule_codes", "peer_kinds"]);
  for (const [key, val] of Object.entries(params as Record<string, unknown>)) {
    if (!allowedKeys.has(key) || val === undefined) return "invalid_link_params";
    if (key === "direction" && (typeof val !== "string" || !LINK_DIRECTIONS.has(val))) return "invalid_link_params";
    if (key === "classes" && !normalizeListParam(val, LINK_CLASSES)) return "invalid_link_params";
    if (key === "peer_kinds" && !normalizeListParam(val, LINK_KINDS)) return "invalid_link_params";
    if (key === "rule_codes" && !normalizeListParam(val)) return "invalid_link_params";
  }
  return null;
}

function buildLinksQuery(params: Record<string, unknown> | undefined, offset: number): string {
  const sp = new URLSearchParams();
  if (params) {
    if (typeof params.direction === "string") sp.set("direction", params.direction);
    for (const key of ["classes", "rule_codes", "peer_kinds"] as const) {
      if (params[key] !== undefined) {
        const list = normalizeListParam(params[key]);
        if (list?.length) sp.set(key, list.join(","));
      }
    }
  }
  sp.set("limit", "100");
  sp.set("offset", String(offset));
  return sp.toString();
}

/** The unified relationship read follows has_more and keeps endpoint summaries. */
export async function readEntityLinks(id: string, { params, requestFn = request }: Record<string, any> = {}) {
  const invalid = validateLinkParams(params);
  if (invalid) throw new Error(invalid);
  const items = new Map<string, Record<string, any>>();
  const entities: Record<string, any> = {};
  for (let offset = 0; ; ) {
    const query = buildLinksQuery(params, offset);
    const result = await requestFn(`/api/catalog/entities/${encodeURIComponent(id)}/links?${query}`, { tries: 4 });
    if (result.status !== 200) throw new Error(`读取关联 ${id} 失败：HTTP ${result.status}`);
    const page = result.body;
    if (!Array.isArray(page?.items) || typeof page.has_more !== "boolean"
      || !Number.isSafeInteger(page.limit) || page.limit < 1 || !page.entities
      || page.subject_id !== id) throw new Error("invalid_response: catalog.links");
    Object.assign(entities, page.entities);
    for (const link of page.items) {
      if (typeof link.key !== "string" || !link.key) throw new Error("invalid_response: catalog.links.key");
      if (link.class === "semantic" && (!Number.isSafeInteger(link.version) || link.version < 1)) throw new Error("invalid_response: catalog.links.version");
      items.set(link.key, link);
    }
    if (!page.has_more) return { subject_id: id, items: [...items.values()], entities };
    offset += page.limit;
  }
}
