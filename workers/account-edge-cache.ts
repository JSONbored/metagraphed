// The edge cache for the address-shaped account routes: eligibility, scope and
// stamp. PURE -- the lookup, the put and the degraded guards are
// `withEdgeCache`'s, which already owns every one of them.
//
// ## What was uncached, and what it cost
//
// `workers/request-handlers/entities.ts` holds 41 cold-tier call sites and uses
// `withEdgeCache` ZERO times, against 33 uses in analytics.ts. A Worker's own
// response is not stored by Cloudflare unless the Cache API is used explicitly,
// so `cache-control: public, max-age=60` on these bodies only ever reached
// browsers -- every request, first or repeat, paid a full lakehouse read.
//
// Measured 2026-08-16 on 5EEmaGFE...5oM3qDSC, three identical back-to-back GETs
// of `/accounts/{ss58}/events?limit=5`: 16.9s, 15.2s, 16.3s, with no
// `cf-cache-status` on any of them. The account page issues 28 such requests.
//
// The dispatch-level static cache could not reach them: this family is matched
// by anchored regexes that RETURN early, hundreds of lines before the
// `isStaticEdgeCacheEligible` block that caches the route-table families. And
// `dataRouteRateLimit`'s own docstring names the gap in passing -- "lakehouse-
// backed and billed per byte scanned, no edge cache".
//
// ## Why the stamp is the decode watermark, and why that makes it SAFE
//
// These routes read `chain.account_events` in the lakehouse. That table changes
// when the decode container publishes and at no other time, so an answer is a
// pure function of (contract version, decode watermark, path, query). Putting
// the watermark IN THE KEY means a new generation writes to a DIFFERENT key and
// the old entry is never consulted again -- correctness comes from the key, not
// from an expiry racing the data.
//
// The response's own `max-age` still bounds how long an entry survives, which
// is what keeps the USD-at-tx overlay honest: it prices each event against the
// newest index reading at-or-before that event's instant, and for an event
// seconds old that reading may not exist yet. The declared 60s is already the
// contract for that, so this changes no freshness promise -- it only stops the
// same answer being recomputed inside the window it was already allowed to be
// reused in.
//
// ## What this does NOT fix
//
// The FIRST view. A cache absorbs repeat and burst load; it cannot make a cold
// read fast. The bound pushed into these queries is what does that, and the two
// are complements rather than alternatives.
import { DEFAULT_CHAIN_NETWORK } from "../src/chain-network.ts";
import { resolveDecodeWatermark } from "../src/decode-watermark.ts";

/** The `keyParts` namespace segment for the family. */
export const ACCOUNT_EDGE_CACHE_LABEL = "accounts";

/**
 * Whether this request may be served from, or written to, the account cache.
 *
 * TWO NETWORK CONDITIONS, and they are not the same one twice.
 *
 * `storeBacked` is `isMainnetOnlyApiPath`, and it is what selects the routes
 * the decode watermark is a valid stamp FOR. Four members of this family --
 * `balance`, `children`, `parents`, `root-claim` -- are network-aware because
 * they read chain state through `state_getStorage` at request time. Their
 * answer changes every block and owes nothing to the decode lane, so stamping
 * them with a watermark that advances hourly would hold a balance across up to
 * an hour of blocks. They are excluded, not scoped.
 *
 * That the two sets coincide is not luck: a route is declared mainnet-only
 * precisely when it reads a store that carries no network column, and a route
 * is network-aware precisely when it reads the chain itself. "Answered from a
 * store" and "stamped by a producer" are the same property.
 *
 * `isDefaultNetwork` is the SEPARATE, mandatory guard. Without it a
 * `/testnet/api/v1/accounts/{ss58}/events` request -- whose resolved path IS
 * mainnet-only -- would look up the mainnet key and be served mainnet's body.
 * That the route then 404s is no protection: the lookup happens first. It also
 * covers both spellings of mainnet (`/api/v1/…` and `/finney/api/v1/…`), which
 * is what lets those two share one entry.
 *
 * Both are pinned by tests rather than by this comment: if a store-backed
 * account route becomes network-aware, or a live-chain one becomes
 * mainnet-only, the assertion fails and this gate is revisited BEFORE anything
 * can be served under the wrong key.
 *
 * `pathname` is the RESOLVED path -- the `/{network}/` prefix already stripped
 * -- so the two mainnet spellings do not compute the same body under two keys.
 *
 * CSV shares the route but not the body. `format=csv` rides in the search
 * string and so would key separately anyway; refusing it outright means the
 * question is settled here rather than resting on that -- and a one-shot
 * download is the traffic shape a cache helps least.
 *
 * HEAD is eligible: `withEdgeCache` normalizes it into the GET key and strips
 * the body on the way out, but ONLY when the builder takes the normalized
 * request. The call site passes it; see the wiring in `workers/api.ts`.
 *
 * `addressShaped` is passed IN rather than re-derived here, and the caller
 * passes `ACCOUNT_SS58_SEGMENT_PATH_PATTERN` -- the same predicate the rate
 * limiter uses. The two gates protect the same family for the same reason, and
 * a cache whose idea of "the account routes" could drift from the limiter's is
 * a cache that silently stops covering whatever drifted.
 */
export function accountEdgeCacheEligible(input: {
  method: string;
  isDefaultNetwork: boolean;
  addressShaped: boolean;
  storeBacked: boolean;
  search: URLSearchParams;
}): boolean {
  const { method, isDefaultNetwork, addressShaped, storeBacked, search } =
    input;
  if (method !== "GET" && method !== "HEAD") return false;
  if (!isDefaultNetwork) return false;
  if (!addressShaped || !storeBacked) return false;
  return search.get("format") !== "csv";
}

/**
 * The published decode height as a cache stamp, or null.
 *
 * NULL DISABLES CACHING rather than falling back to a constant, and
 * `withEdgeCache` already treats a null stamp that way -- it is the same guard
 * that keeps a cold health-meta read from seeding an analytics entry. An
 * unreadable watermark means we cannot say which generation an answer belongs
 * to, and a key that cannot express that would pin one generation's body across
 * the next publish: the exact failure the stamp exists to prevent, arrived at
 * by trying to be helpful.
 *
 * Memoized upstream (`resolveDecodeWatermark`, 5-minute TTL), so this is one R2
 * GET per isolate per TTL rather than one per request.
 */
export async function accountCacheStamp(env: unknown): Promise<string | null> {
  const watermark = await resolveDecodeWatermark(
    env,
    {},
    DEFAULT_CHAIN_NETWORK,
  );
  return watermark === null ? null : String(watermark.decodedThrough);
}
