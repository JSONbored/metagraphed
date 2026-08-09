// How often each producer lane actually runs (#10291).
//
// ## The fact this centralises
//
// Every staleness watchdog needs one number: its producer's cadence. That
// number is configured in metagraphed-infra (`*_POLL_SECS`, read by
// `services/indexer-rs/src/bin/poller/main.rs`) and reached this repo only as
// PROSE, restated in a doc comment beside each threshold:
//
//     * it runs four times less often: `HOTKEY_ALPHA_POLL_SECS` defaults to
//     * 86400 (24 h) against `account_balances`' 21600 (6 h). Two full
//     * cadences of slack…
//     export const HOTKEY_ALPHA_STALENESS_THRESHOLD_MS = 48 * 60 * 60 * 1000;
//
// `48h` IS `2 × 86400s`, and nothing in the codebase said so. The arithmetic
// lived in a sentence, so a reader could not check it and a change to the
// producer could not invalidate it.
//
// #10243 is what that costs: a report proposed cutting hotkey-alpha's bound
// from 48h to 1–2h, in good faith, because the 24h cadence was not visible
// anywhere near the constant. Against a 24h producer that alarms for ~22 of
// every 24 hours on a working lane -- the #9301 regression, re-derived.
//
// ## What this is NOT
//
// It is not a claim that every threshold should be a multiple of a cadence.
// Two deliberately are not, and forcing them would be a regression:
//
//   - `chain-detail` runs every ~24s but is bounded at 20 MINUTES, sized
//     against the hourly decode lane's ~1h lag that the hot tier exists to
//     cover. Its threshold is a statement about a DOWNSTREAM consumer, not
//     about its own tick.
//   - `rpc-usage` is bounded at 2h from a MEASURED traffic floor (103
//     consecutive hours, quietest hour 600 requests) plus one tick of the
//     hourly watchdog cron -- a different cron from its producer's.
//
// Both keep their constants. What changes is that they now say so explicitly,
// so "not cadence-derived" is a recorded decision rather than something
// indistinguishable from an oversight.
//
// ## Still a copy, and still worth it
//
// These seconds are transcribed from infra. That does not go away here -- the
// honest fix is the producer reporting its own cadence with each pass (#10291
// option b), which needs an infra change and a column. What this removes is
// the number being restated once per watchdog in prose that cannot be checked:
// one place to update, and the multiples become arithmetic a reader can verify.

/**
 * Producer cadences in SECONDS, transcribed from metagraphed-infra's
 * `roles/indexer-rust/tasks/main.yml` defaults and the binary's own fallbacks
 * in `services/indexer-rs/src/bin/poller/main.rs`.
 *
 * Keyed by producer, not by watchdog: `nominator-positions` and
 * `validator-nominator-counts` are two watchdogs over ONE producer, and giving
 * them one key is what stops them drifting apart.
 */
export const PRODUCER_CADENCE_SECS = {
  /** ACCOUNT_BALANCES_POLL_SECS. Measured 2026-08-09: p50 gap 5.79h, max 6.01h
   * across 19 passes -- the configured value, confirmed. */
  account_balances: 21_600,
  /** HOTKEY_ALPHA_POLL_SECS. Measured 2026-08-09: 13 passes, max gap 23.64h,
   * never exceeding the interval. The short gaps are container reboots, which
   * fire every lane's first tick immediately -- see #10243. */
  hotkey_alpha: 86_400,
  /** VALIDATOR_NOMINATORS_POLL_SECS. One producer, two watchdogs. */
  validator_nominators: 86_400,
  /** METAGRAPH_POLL_SECS. The one cadence buildEnvVars sets unconditionally. */
  metagraph: 900,
  /** The top-holders flow materialization, rebuilt daily. */
  top_holders_flow: 86_400,
} as const;

export type ProducerLane = keyof typeof PRODUCER_CADENCE_SECS;

/** One producer's cadence in milliseconds. */
export function cadenceMs(lane: ProducerLane): number {
  return PRODUCER_CADENCE_SECS[lane] * 1000;
}

/**
 * A staleness bound expressed as MISSED TICKS of the producer's own cadence.
 *
 * Ticks rather than hours, because ticks is the unit the judgement is actually
 * in: "two full cadences of slack" survives a change to the producer, "48
 * hours" does not. Fractional is allowed -- `nominator-positions` sits at 1.25
 * ticks and forcing it to an integer would change a threshold for the sake of
 * the abstraction.
 */
export function missedTicksMs(lane: ProducerLane, ticks: number): number {
  return Math.round(cadenceMs(lane) * ticks);
}

/**
 * How far back from the newest stamp still counts as "the newest pass".
 *
 * MUST stay strictly under the producer's cadence, or two consecutive passes
 * merge into one coverage count -- a truncated pass sitting on a complete one
 * then sums to full coverage and reports fine, which is the bug the coverage
 * clause exists to catch. `tests/producer-cadence.test.ts` asserts that
 * structurally for every lane rather than leaving it in a comment, which is
 * where it lived before:
 *
 *     "the window must stay under ACCOUNT_BALANCES_POLL_SECS (21600)"
 *
 * A string in a test cannot fail.
 */
export function passWindowMs(
  lane: ProducerLane,
  fractionOfCadence: number,
): number {
  return Math.round(cadenceMs(lane) * fractionOfCadence);
}
