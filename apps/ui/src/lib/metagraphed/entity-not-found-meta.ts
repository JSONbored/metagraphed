import { ApiError } from "./client";

/**
 * `head()` metadata for a detail route whose entity isn't there (#6429, #8624).
 *
 * There are two ways to land here, and until #8624 only the first was handled:
 *
 *  1. **The identifier is malformed.** The router's `parseParams` rejects it so
 *     the not-found boundary renders — but it does **not** stop `head()` running
 *     with the raw param, so the boundary rendered under a title asserting the
 *     junk id was a real entity ("Subnet not-a-number — Metagraphed").
 *  2. **The identifier is well-formed but names nothing.** `/subnets/99999` is a
 *     perfectly valid netuid that does not exist; `/validators/<any valid ss58>`
 *     likewise. These returned HTTP 200, a confident title, no `robots` tag and
 *     a canonical pointing at themselves — a textbook soft 404, on a URL space
 *     that is effectively infinite.
 *
 * `noindex` is the point of the robots tag, and it is why this must cover case 2
 * as well: a crawler that can mint unlimited indexable thin pages by varying an
 * integer will do exactly that.
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

/**
 * Does this loader failure mean the entity DOESN'T EXIST, or just that we
 * couldn't reach the API?
 *
 * The distinction is the whole safety property of #8624. Every detail loader
 * already swallows failures and returns null so the page still renders and the
 * component's own `useSuspenseQuery` drives the error/retry path — that
 * behaviour must survive, because marking a page `noindex` on a transient blip
 * would quietly de-index real entities during an outage. A 404 from our own API
 * is the only signal that actually means "there is no such thing", so it is the
 * only one that flips a route to not-found.
 *
 * Anything that isn't an `ApiError` (a network throw, an abort, a parse error)
 * is deliberately treated as "unknown, keep rendering".
 */
export function isMissingEntityError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

/**
 * Is THIS route's not-found boundary the thing that rendered (#11204)?
 *
 * A loader that throws `notFound()` gets two things at once: router-core's
 * `applyFailure` answers the SSR request `404` instead of `200`, and the
 * route's `notFoundComponent` renders in place of the page. `head()` still
 * runs for that match, and it must not title the boundary as though the entity
 * resolved — which is exactly what `/blocks/not-a-block` did, serving a real
 * 404 under the confident title "Block not-a-block — Metagraphed".
 *
 * Reading the match covers BOTH ways to reach the boundary — `parseParams`
 * rejecting a malformed id, and a loader confirming a well-formed id names
 * nothing — so a route no longer needs a separate `head()` branch per cause.
 */
export function isNotFoundMatch(match: unknown): boolean {
  return (
    typeof match === "object" &&
    match !== null &&
    (match as { status?: unknown }).status === "notFound"
  );
}
