// PRODUCTION DEGRADATION CONTRACT (#13146, #13159 — declared 2026-11-15).
//
// The raw-capture lane has landed nothing since metagraphed-state D1 hit its
// 10 GB cap (2026-10-12) and was formally killed in phase-0 (#13187);
// decode-r2's cron is paused by owner decision (metagraphed-infra#870), so
// the lakehouse history tier is starving and these routes answer 503 in
// production. The owner accepted that until the fleet producer serves them
// from PostgreSQL — resuming metered legacy ingestion would contradict the
// migration (#13146).
//
// THIS LIST IS A CONTRACT, NOT A SKIP. smoke:live enforces it exactly:
// a declared route MUST answer 503 with precisely the declared error code —
// a 200 fails the publish as a STALE DECLARATION (remove the row), any other
// status/code fails as a new defect, and every route NOT listed here still
// fails the publish on any non-200. The list expires at cutover: the fleet
// serving path turns every row stale at once, and deleting this file is part
// of the #13143/#13146 cutover checklist. Expiry began 2026-11-16: the fleet
// backfill reached extrinsics first and its row came off when the route
// answered 200 again (the stale-declaration tripwire in the 02:11Z publish).
export const DECLARED_LIVE_DEGRADATIONS: ReadonlyMap<string, string> = new Map([
  ["/api/v1/accounts/{ss58}", "account_summary_unavailable"],
  // Declared 2026-11-16T04:3xZ: backfill-era load broke this route's heavy
  // windowed D1 read consistently; it answers the classified 503 the #13211
  // structured path gives it. Expires like every row: a 200 fails the
  // publish as stale and the row comes off.
  ["/api/v1/chain/axon-removals", "data_tier_unavailable"],
  ...[
    "/api/v1/accounts/{ss58}/counterparties",
    "/api/v1/accounts/{ss58}/events",
    "/api/v1/accounts/{ss58}/extrinsics",
    "/api/v1/accounts/{ss58}/history",
    "/api/v1/accounts/{ss58}/prometheus",
    "/api/v1/accounts/{ss58}/registrations",
    "/api/v1/accounts/{ss58}/serving",
    "/api/v1/accounts/{ss58}/stake-flow",
    "/api/v1/accounts/{ss58}/stake-moves",
    "/api/v1/accounts/{ss58}/transfers",
    "/api/v1/blocks",
    "/api/v1/blocks/{ref}/chain-events",
    "/api/v1/blocks/{ref}/events",
    "/api/v1/blocks/{ref}/extrinsics",
    "/api/v1/governance/config-changes",
    "/api/v1/subnets/{netuid}/event-summary",
    "/api/v1/subnets/{netuid}/events",
    "/api/v1/subnets/{netuid}/owner-cut",
    "/api/v1/sudo",
    "/api/v1/validators/{hotkey}/nominators",
  ].map((route): [string, string] => [route, "history_unavailable"]),
]);

// Routes the fleet backfill is ACTIVELY converging: they oscillate between
// recovered (200) and their declared degradation as backfill waves land --
// observed on /api/v1/extrinsics across the 02:4xZ-05:1xZ publishes
// (200, then 503, then 200 within single runs). Neither a plain-200 pin nor
// a declared-503 row can hold an oscillating truth, so these pass on EITHER
// exactly -- any other status or error code still fails the publish. Rows
// here are removed when the route holds 200 across a full day of publishes,
// and the whole file dies at cutover.
export const CONVERGING_LIVE_ROUTES: ReadonlyMap<string, string> = new Map([
  ["/api/v1/extrinsics", "history_unavailable"],
]);
