// Shared between responsive-overflow.spec.ts and token-inventory.spec.ts so
// the two sweeps can't silently disagree about which routes exist.
//
export const ROUTES = [
  "/",
  // The subnets INDEX, distinct from /subnets/1 below. It was missing from
  // this matrix, which is why a sticky-header bug that put the column labels
  // a third of the way down the table sat here unnoticed -- the sweep covered
  // the detail page and never loaded the list. Its HAR also backs
  // sticky-table-header.spec.ts; that spec resolves fixtures through
  // harPathForRoute, so a route being listed here is what makes one exist.
  "/subnets",
  "/subnets/1",
  // #11612: a SECOND subnet detail page, because the rebuilt route renders
  // from data that differs per subnet in ways that change its layout -- SN19
  // has 37 surfaces and no registry domain, SN1 has few surfaces and sits in
  // a domain. One netuid cannot sweep both shapes.
  "/subnets/19",
  // #11611: the comparison is a route now, so it is swept like any other.
  "/compare?subnets=1,19",
  // #11628: the CANONICAL paths, not the retired aliases. /endpoints and
  // /providers are 301s now, so sweeping them measured the target after a hop
  // -- and named the fixture for a URL the app no longer serves.
  "/apis/endpoints",
  "/settings",
  // #8357: the three templates the 2026-07-27 instrumented audit found
  // escaping the viewport (extrinsic signer row, schemas drift chip,
  // validators table header) -- a real hash/no-param route each so the
  // fixed elements actually render, not an empty/not-found fallback.
  "/extrinsics/0x986f1f7da3d93882e8c19bbe3b303ef8ba5454062272446598d17aa599ca4428",
  // #11621: the block detail page, the last chain template outside the sweep.
  // A fixed, historical block rather than the head: a fixture recorded against
  // whatever block was current would be a different page on every re-record,
  // and the row counts that stress the layout would change with it. 8,713,384
  // is the block the swept extrinsic above was included in, so the two
  // fixtures describe the same moment of the chain and the block page's
  // contents table lists a call the extrinsic page also renders.
  "/blocks/8713384",
  "/apis/schemas",
  "/validators",
  // #11617: the validator detail page, the last entity template in the sweep.
  // A key with 116 memberships and 3,271 nominators, so the widths it stresses
  // are the ones a real operator page has.
  "/validators/5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ5u",
  // #8538: extend the matrix to the Chain hub and its six tab routes. A
  // measurement change, not a fix -- whatever violations these reveal get
  // recorded in the baseline (like the existing entries), never fixed here.
  "/chain",
  "/chain/blocks",
  "/chain/events",
  "/chain/extrinsics",
  // #8539: extend the matrix to the account, portfolio, provider and
  // APIs-index routes. A measurement change, not a fix. /accounts/$ss58 uses
  // a real, stable top-stake account so the detail page renders real content
  // rather than a not-found fallback (same reasoning #8433 gives for a real hash).
  //
  // /leaderboards was swept here until #11613 retired it into /subnets. A
  // redirect route renders nothing, so sweeping it would measure /subnets
  // twice — once through a fixture recorded against a page that no longer
  // exists.
  //
  // /explorer and /portfolio sat in this list doing exactly that until #11693.
  // Both are `statusCode: 301` route files; Playwright follows the hop, so the
  // sweep loaded /chain and /settings a second time each while replaying
  // explorer.har and portfolio.har — fixtures recorded against the pages those
  // redirects replaced, whose request sets no longer intersect the targets'.
  // `token-inventory-coverage.unit.ts` asserts the rule now, in both
  // directions: a redirect is exempt from being swept AND barred from it.
  "/accounts",
  "/accounts/5GsbTgfvgCH4xdqSkiPb7EaBBFLHjWH5vfEALhJaewSFpZX9",
  "/apis/providers",
  "/apis",
  // #11628: the three routes that read no API at all, so they need no HAR
  // fixture -- the sweep skips replay for a route with nothing to replay. They
  // were outside the design gate purely because the gate required a fixture,
  // which is the wrong reason for a page to go unmeasured.
  "/privacy",
  "/terms",
  "/design/primitives",
  // #11628: the five remaining pages the design gate had never loaded. Each is
  // a route a reader reaches from the header, the footer or a redirect, and
  // each was outside the sweep only because nobody had recorded its fixture.
  "/about",
  "/health",
  "/contribute",
  "/agents",
  // Content is a route family too. One docs index, one prose guide, one
  // generated API operation, the digest archive, and one digest detail cover
  // the distinct Fumadocs layouts that the product-route-only sweep omitted.
  "/docs",
  "/docs/mcp",
  "/docs/api-reference/subnets/subnets-by-network",
  "/news",
  "/news/sn19/2026-w17",
  // The remaining canonical interactive route. /graphql itself is a 301 and
  // is covered by the redirect suite; this is the page a reader receives.
  "/graphql/explorer",
  // The provider detail template. `lium` is a real provider with 156
  // endpoints, so the widths this stresses are a real operator page's rather
  // than a one-row stub's.
  "/providers/lium",
];

/**
 * Routes that issue no browser API request, so `harPathForRoute` has nothing
 * to point at. Most genuinely fetch nothing; the API-reference operation page
 * performs an SSR-only OpenAPI read that api-stub.ts seeds from the committed
 * generated artifact.
 */
export const NO_API_ROUTES = new Set([
  "/privacy",
  "/terms",
  "/design/primitives",
  "/docs",
  "/docs/mcp",
  // The operation page issues no browser request/HAR. Its SSR OpenAPI read is
  // served hermetically from the committed artifact by api-stub.ts.
  "/docs/api-reference/subnets/subnets-by-network",
  "/news",
  "/news/sn19/2026-w17",
]);

export const VIEWPORTS = [
  { name: "mobile", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop-md", width: 1024, height: 800 },
  { name: "desktop-lg", width: 1280, height: 800 },
];

// Routes allowed to render an error state. Kept as an explicit set so any
// future exception has to be documented beside the design sweep rather than
// silently weakening its "real content rendered" assertion.
//
// Empty today: account detail no longer suspends SSR on its slow lifetime
// history aggregate. It renders a truthful pending state while independent
// balance, identity and positions evidence remains usable, so a summary fault
// is no longer a reason to permit a route-wide error card.
export const ERROR_STATE_ALLOWED = new Set<string>();

// route@width combinations known to render an empty list, and why.
//
// #9433 added an "did this route actually render?" assertion, because an
// empty page has no overflow violations and therefore passed the sweep. It
// works -- it immediately found /chain/extrinsics and /chain/governance
// rendering nothing -- but it also turned main red, and the reason is the
// FIXTURES, not the routes.
//
// Every HAR was recorded at a single viewport (1280). A route does not
// request the same thing at every width: below `md` the list shells render
// cards instead of a table, and the card path fetches endpoints the table
// path never touches. So a fixture satisfies the width it was recorded at
// and leaves the others with nothing to render. Re-recording these two at
// 1280 (which #9433 did, and verified) fixes 1280 and nothing else.
//
// The real fix is in record-har.ts, which now records EVERY viewport into
// one HAR. These entries come out as each route is re-recorded with it --
// deliberately not done in this change, because re-recording all 23 fixtures
// is a large diff that deserves its own review, and main should not stay red
// while it happens.
export const EMPTY_LIST_ALLOWED = new Set([
  "/chain/extrinsics@375",
  "/chain/extrinsics@768",
  "/chain/extrinsics@1024",
]);
