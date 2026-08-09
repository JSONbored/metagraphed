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
  /**
   * ACCOUNT_IDENTITY_POLL_SECS. Twenty-four hours, and its absence from this
   * table is what let `TABLE_FRESHNESS` bound the table it writes at TWELVE --
   * half a tick, so a healthy lane read `stale` for the back half of every
   * cycle (#10329). Measured 2026-08-09: `account_identity` 21.6h old, the
   * lane's own verdict for that pass `ok | 129 scanned, 456 written`.
   */
  account_identity: 86_400,
  /** SUBNET_HYPERPARAMS_POLL_SECS. Hourly, the fastest of the poller's
   * non-firehose lanes; observed writing at :05 every hour. */
  subnet_hyperparams: 3_600,
} as const;

export type ProducerLane = keyof typeof PRODUCER_CADENCE_SECS;

/**
 * Which `lane_health` lane names are written by a producer we know the cadence
 * of (#10333).
 *
 * EXPLICIT, not derived by string surgery. The obvious rule -- strip a `neon:`
 * prefix and a `-pass` suffix, swap dashes for underscores -- gets four of
 * these right and `neon:nominator-positions-pass` wrong, because that lane's
 * producer is `validator_nominators`: ONE poller writes both the counts and the
 * positions, which is why PRODUCER_CADENCE_SECS is keyed by producer rather
 * than by watchdog. A rule that is right most of the time here fails silently,
 * in the direction of a bound that is too tight.
 *
 * The declared cadence is a FLOOR under the observed one, never a replacement.
 * Observation is what catches a lane whose real interval has drifted from the
 * configured one; the floor is what stops a sample that is a burst followed by
 * silence -- which is what a `-pass` mirror's seven days look like -- from
 * producing a bound tighter than a single tick.
 */
export const LANE_PRODUCER: Readonly<Record<string, ProducerLane>> = {
  "account-balances": "account_balances",
  "neon:account-balances": "account_balances",
  "neon:account-balances-pass": "account_balances",
  "hotkey-alpha": "hotkey_alpha",
  "neon:hotkey-alpha": "hotkey_alpha",
  "neon:hotkey-alpha-pass": "hotkey_alpha",
  "validator-nominators": "validator_nominators",
  "neon:validator-nominator-counts": "validator_nominators",
  "neon:validator-nominator-counts-pass": "validator_nominators",
  "neon:nominator-positions": "validator_nominators",
  "neon:nominator-positions-pass": "validator_nominators",
  "neon:nominator-positions-prune": "validator_nominators",
  "account-identity": "account_identity",
  "neon:account-identity": "account_identity",
  "subnet-hyperparams": "subnet_hyperparams",
  "neon:subnet-hyperparams": "subnet_hyperparams",
  metagraph: "metagraph",
  "neon:neurons": "metagraph",
  "neon:neurons-pass": "metagraph",
  "neon:neuron_daily": "metagraph",
  "neon:account_position_daily": "metagraph",
} as const;

/**
 * The cadence to judge one lane's silence by: its own observed maximum gap,
 * floored by its producer's declared cadence where we have one.
 *
 * `null` in means null out -- no sample and no declaration is no bound, and
 * withLaneHealth then leaves the verdict alone rather than guessing.
 */
export function laneSilenceCadenceMs(
  lane: string,
  observedMaxGapMs: number | null | undefined,
): number | null {
  const declared = LANE_PRODUCER[lane];
  const floor = declared ? cadenceMs(declared) : null;
  const observed =
    typeof observedMaxGapMs === "number" && observedMaxGapMs > 0
      ? observedMaxGapMs
      : null;
  if (observed === null) return floor;
  return floor === null ? observed : Math.max(observed, floor);
}

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
