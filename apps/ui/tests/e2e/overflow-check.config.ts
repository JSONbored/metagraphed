// Shared between responsive-overflow.spec.ts and generate-overflow-baseline.ts
// so the two can't silently drift apart.
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
  "/endpoints",
  "/status",
  "/settings",
  "/explorer",
  // #8357: the three templates the 2026-07-27 instrumented audit found
  // escaping the viewport (extrinsic signer row, schemas drift chip,
  // validators table header) -- a real hash/no-param route each so the
  // fixed elements actually render, not an empty/not-found fallback.
  "/extrinsics/0x986f1f7da3d93882e8c19bbe3b303ef8ba5454062272446598d17aa599ca4428",
  "/apis/schemas",
  "/validators",
  // #8538: extend the matrix to the Chain hub and its six tab routes. A
  // measurement change, not a fix -- whatever violations these reveal get
  // recorded in the baseline (like the existing entries), never fixed here.
  "/chain",
  "/chain/blocks",
  "/chain/events",
  "/chain/extrinsics",
  "/chain/analytics",
  "/chain/governance",
  "/chain/runtime",
  // #8539: extend the matrix to the account, portfolio, leaderboard, provider
  // and APIs-index routes. A measurement change, not a fix. /accounts/$ss58 uses
  // a real, stable top-stake account so the detail page renders real content
  // rather than a not-found fallback (same reasoning #8433 gives for a real hash).
  "/accounts",
  "/accounts/5GsbTgfvgCH4xdqSkiPb7EaBBFLHjWH5vfEALhJaewSFpZX9",
  "/portfolio",
  "/leaderboards",
  "/providers",
  "/apis",
];

export const VIEWPORTS = [
  { name: "mobile", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop-md", width: 1024, height: 800 },
  { name: "desktop-lg", width: 1280, height: 800 },
];

// Routes allowed to render an error state, and why.
//
// The sweep asserts a route rendered real content rather than an error card,
// because "no new overflow violations" is also what a broken page looks like.
// This route is the documented exception: its SSR `useSuspenseQuery` fetches
// /api/v1/accounts/{ss58} on the SERVER, where `page.routeFromHAR` cannot
// intercept it, so the request reaches live production on every run. When that
// endpoint degrades (observed: 503 `account_summary_unavailable`) the page
// renders an error card and no fixture can prevent it.
//
// This is an allowlist, not a fix. Removing the entry requires making SSR
// fetches hermetic -- attempted via a loopback API stub and abandoned, because
// workerd's outbound fetch to localhost fails under the parallel sweep far
// more often than production does.
export const ERROR_STATE_ALLOWED = new Set([
  "/accounts/5GsbTgfvgCH4xdqSkiPb7EaBBFLHjWH5vfEALhJaewSFpZX9",
]);

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
  "/chain/governance@375",
  "/chain/governance@768",
  "/chain/governance@1024",
]);
