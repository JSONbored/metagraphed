/**
 * The one-shot ceiling for "every active subnet" reads.
 *
 * `/api/v1/subnets` has no server-side sort and the registry is ~129 subnets,
 * so a page fetches the whole set once and works over it client-side. This
 * constant is shared so the surfaces that do it cannot drift onto two
 * different limits and disagree about what "every subnet" means.
 *
 * It lives in its own module, not in queries.ts, because `server.ts` needs it
 * too: importing queries.ts would drag @tanstack/react-query into the server
 * bundle for one number.
 *
 * The drift this prevents is not hypothetical. The sitemap fetched
 * `?limit=500` while the hub fetched this constant, and the two agreed only by
 * accident -- both exceeded the ~128 subnets that exist. Under the hermetic
 * e2e stub they did NOT agree: the stub indexes recordings by exact URL with a
 * bare-pathname fallback, so two different query strings resolve to two
 * different recorded payloads, and the two surfaces listed different sets.
 *
 * Sharing the constant makes the two fetches the SAME URL. If it is ever too
 * small for the registry, both surfaces under-count together and visibly,
 * rather than disagreeing quietly -- which is the property worth having.
 *
 * This module was `subnet-categories.ts` until #11613 folded
 * `/subnets/category/*` into the hub's domain filter. Everything else it held
 * -- the hand-written per-category copy, the minimum-members gate, the URL
 * builder -- went with those routes; the domain taxonomy the hub renders now
 * comes from `/api/v1/domains`, which is computed, not written down.
 */
export const SUBNETS_ALL_LIMIT = 200;
