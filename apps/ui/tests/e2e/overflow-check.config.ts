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
