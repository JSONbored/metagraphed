// D1's compound-SELECT ceiling, and how to sweep a table list without hitting it.
//
// ## The ceiling
//
// Upstream SQLite defaults `SQLITE_MAX_COMPOUND_SELECT` to 500. D1 builds it at
// FIVE. Probed directly against the production database on 2026-08-07 and again
// on 2026-08-08, both times by generating the statement with the SAME builder
// the watchdog uses rather than a hand-written approximation of it:
//
//     n=3   ok        n=6   too many terms in compound SELECT: SQLITE_ERROR
//     n=5   ok        n=7+  the same, all the way up
//
// ## Why this lives in its own module
//
// It is a property of D1, not of whichever caller discovered it, and it has now
// been discovered twice. `neon-parity` shipped in #9850 sweeping ten tables in
// one UNION ALL and recorded `unknown: counts unreadable` every hour from the
// moment it deployed; #9881 found the ceiling and batched that lane, but left
// the constant private to that watchdog. `neon-mirror-lag` then walked into the
// identical failure (#10081) the moment #10053 took it from five watched tables
// to seven -- a second literal `5` would have been a second thing to keep in
// step with the first.
//
// ## Why the failure mode deserves the emphasis
//
// Exceeding the ceiling does not truncate the sweep, it throws before a single
// row is read. So a watchdog over the limit reports the truth about ITSELF
// ("I could not read") and nothing whatsoever about the thing it watches -- and
// both times, the lane went on being green-adjacent enough that nobody looked.
// Batching is therefore not an optimisation; it is the difference between a
// check that works and a check that cannot run.

/** D1's hard limit on `UNION ALL` terms in one statement. Measured, not
 * documented upstream -- see this module's header for the probe. */
export const D1_MAX_COMPOUND_TERMS = 5;

/**
 * Split a table sweep into statements no wider than D1 will parse.
 *
 * `build` renders one statement from a slice of the list, so each caller keeps
 * its own projection (`COUNT(*)`, `MAX(captured_at)`, …) and only the splitting
 * is shared.
 *
 * Postgres has no comparable limit, but callers that run the same sweep against
 * both stores should run the SAME batches on each: identical row shapes on both
 * sides means one reader serves both halves of a comparison.
 */
export function compoundBatches(
  tables: readonly string[],
  build: (batch: readonly string[]) => string,
  perBatch: number = D1_MAX_COMPOUND_TERMS,
): string[] {
  const batches: string[] = [];
  for (let i = 0; i < tables.length; i += perBatch) {
    batches.push(build(tables.slice(i, i + perBatch)));
  }
  return batches;
}
