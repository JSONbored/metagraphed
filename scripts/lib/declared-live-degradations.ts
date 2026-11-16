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
// of the #13143/#13146 cutover checklist.
export const DECLARED_LIVE_DEGRADATIONS: ReadonlyMap<string, string> = new Map([
  ["/api/v1/accounts/{ss58}", "account_summary_unavailable"],
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
    "/api/v1/extrinsics",
    "/api/v1/governance/config-changes",
    "/api/v1/subnets/{netuid}/event-summary",
    "/api/v1/subnets/{netuid}/events",
    "/api/v1/subnets/{netuid}/owner-cut",
    "/api/v1/sudo",
    "/api/v1/validators/{hotkey}/nominators",
  ].map((route): [string, string] => [route, "history_unavailable"]),
]);
