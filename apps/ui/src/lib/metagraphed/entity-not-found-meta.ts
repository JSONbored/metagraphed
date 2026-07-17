/**
 * `head()` metadata for a detail route whose identifier is malformed (#6429).
 *
 * The router's `parseParams` rejects a bad identifier so the not-found boundary
 * renders — but it does **not** stop `head()` running with the raw param. That's
 * observable on the routes that already validate: `/blocks/not-a-ref` titles the
 * page "Block not-a-ref — Metagraphed", and `/subnets/not-a-netuid` titles it
 * "Subnet not-a-netuid — Metagraphed". Without this, the not-found boundary
 * renders under a title asserting the junk id is a real entity, and crawlers are
 * invited to index one page per malformed URL.
 *
 * `noindex` is the point of the robots tag: these URLs are unbounded (any string
 * is one), so they must never enter an index.
 */
export function entityNotFoundMeta(entity: string, description: string) {
  const title = `${entity} not found — Metagraphed`;
  return {
    meta: [
      { title },
      { name: "description", content: description },
      { property: "og:title", content: title },
      { property: "og:description", content: description },
      { name: "robots", content: "noindex" },
    ],
  };
}
