// What an attribution sweep can conclude, declared ONCE.
//
// ## Why this file exists rather than a union in the lane
//
// The verdict list had THREE mirrors and they drifted. `listings-only` was
// added by #11227 to `src/attribution-sweep.ts`'s `SweepVerdict` union and to
// `migrations/neon/0031`'s CHECK constraint — and not to the published Zod
// enum in `schemas-src/routes/subnet-wallets.ts`.
//
// Nothing failed at build time, because a route's published enum and a lane's
// TypeScript union are not compared anywhere. It failed in PRODUCTION, on the
// six subnets that carry the new verdict:
//
//   McpResponseSchemaDriftError: get_subnet_wallets result drifted from its
//   published outputSchema — invalid_value, expected one of
//   ["none-published","candidates-found","unreachable","no-sources"]
//
// The REST route served it too; only the MCP mirror validates its own response,
// which is the only reason it was visible at all.
//
// ## A CONSTANTS MODULE, with no imports, deliberately
//
// `schemas-src/` is the contract's source and must stay cheap to import: the
// lane it would otherwise have to reach into pulls in the queue runner, the
// probe-job client and the store. A route schema importing that would drag the
// whole producer into the contract build, which is the shape
// #11061 records as breaking the data-api bundle.
//
// So the shared thing is the LIST, and it has no dependencies at all. Both the
// lane and the schema import it, and the type is derived from the array rather
// than written beside it — a union that can disagree with the runtime value is
// the same defect one level down.
//
// ## The third mirror is a database CHECK, and it is pinned by a test
//
// `attribution_sweeps_verdict_is_known` cannot import anything. Its values are
// asserted against this list in tests/attribution-sweep.test.ts by reading the
// migration file, so the constraint and the contract cannot drift either — the
// gap that let this one through.

/**
 * Every verdict a sweep may record, in the order they are documented.
 *
 * `as const` because the array IS the contract: `SweepVerdict` is derived from
 * it, `z.enum()` publishes it, and the CHECK constraint is tested against it.
 */
export const SWEEP_VERDICTS = [
  /** We read at least one source and found no address. A FINDING, and the
   * expected majority answer. */
  "none-published",
  /** We read at least one source and found addresses worth a human's look. */
  "candidates-found",
  /** We could not read the sources. A statement about US, never about the
   * subnet — collapsing it into `none-published` would turn our own outage
   * into a finding about somebody else. */
  "unreachable",
  /** There was nothing to look at. Also a statement about us. */
  "no-sources",
  /** Every source that answered was a LISTING — a metagraph or holder dump
   * whose addresses belong to other people. Distinct from `none-published`,
   * which would claim we found no address when we found twelve hundred, and
   * from `candidates-found`, which would put strangers' keys in a review
   * queue (#11227). */
  "listings-only",
] as const;

/** Verdicts, matching the CHECK constraint on `attribution_sweeps`. Derived
 * from the array above so the two cannot disagree. */
export type SweepVerdict = (typeof SWEEP_VERDICTS)[number];
