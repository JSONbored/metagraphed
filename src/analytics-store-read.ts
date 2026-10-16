import { createRequestCounter } from "./request-counters.ts";

// --- store read tier (box decommission, the read half of #9036's dual-write) ----
//
// store reads resurrected 2026-08-02: the 2026-07-17 elimination that emptied
// these loaders assumed the self-hosted Postgres would keep serving; that box
// is now gone, and the observation tables live in D1 again (backfilled to
// exact parity + dual-written since #9036). Each health loader takes an
// optional `db` — the METAGRAPH_HEALTH_DB binding — and runs the exact
// pre-elimination SQL against it; with no binding (tests, self-hosters) the
// loader keeps its schema-stable empty behavior, byte-identical to before
// this change. The Postgres tier stays first in every route for now; when
// it misses (or its flag is off), the store read replaces what used to be a
// guaranteed-empty payload.
//
// The read slice these loaders use -- the owned query() verb (#10909),
// structural so tests can hand in plain fakes and the real store both.
export interface ObservationsReadDb {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<Row[]>;
}

// A failed store read degrades to zero rows, and the payload built from those
// zero rows must never be edge-cached as fresh — the same contract the
// Postgres tier enforces via its own fallback generation
// (workers/data-api-tier.ts). Handlers snapshot this before a loader call
// and treat a changed generation as a fallback.
const storeReadFailureGeneration = createRequestCounter(
  "src/analytics-live.ts",
);

export function currentStoreReadFailureGeneration(): number {
  return storeReadFailureGeneration.current();
}

// Contained store read: any failure (no binding, bad SQL against a drifted
// schema, a D1 outage) degrades to zero rows — these are serving paths, and
// the schema-stable empty payload has been their floor since 2026-07-17.
// console.error keeps the failure diagnosable in the tail without making a
// read failure a route failure.
export async function storeAll(
  db: ObservationsReadDb | null | undefined,
  sql: string,
  params: unknown[],
): Promise<Record<string, unknown>[]> {
  if (!db?.query) return [];
  try {
    // The dual-envelope acceptance (D1's { results } vs a bare array) retired
    // with the emulators (#10909): query() answers rows, full stop.
    return await db.query(sql, params);
  } catch (error) {
    storeReadFailureGeneration.increment();
    console.error("[analytics-store]", String((error as Error)?.message));
    return [];
  }
}
