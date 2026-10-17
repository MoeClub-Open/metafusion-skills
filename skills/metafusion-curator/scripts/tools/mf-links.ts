import { request } from "../metafusion-api.ts";

/** The unified relationship read follows has_more and keeps endpoint summaries. */
export async function readEntityLinks(id: string, { requestFn = request }: Record<string, any> = {}) {
  const items = new Map<string, Record<string, any>>();
  const entities: Record<string, any> = {};
  for (let offset = 0; ; ) {
    const result = await requestFn(`/api/catalog/entities/${encodeURIComponent(id)}/links?limit=100&offset=${offset}`, { tries: 4 });
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
