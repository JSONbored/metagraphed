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
   * The STORE-backed half of that same artifact, republished three-hourly by
   * TOP_HOLDERS_HOLDINGS_REFRESH_CRON (#9632).
   *
   * Two entries for one object, because it has two writers on two cadences and
   * a single number could only bound one of them. Faster than its own slowest
   * input on purpose -- `account_balances` is declared at 21,600 s above and
   * lands irregularly inside it, so a consumer on the producer's period is at
   * the mercy of the phase between them.
   */
  top_holders_holdings: 10_800,
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
  /** SUBNET_IDENTITY_POLL_SECS, and `SubnetIdentityWorkflow.intervalSeconds`.
   * Hourly, the same cadence as its hyperparams sibling and written by the
   * same shape of lane -- a card plus an append-on-change history. */
  subnet_identity: 3_600,
  /**
   * SUBNET_OWNERSHIP_POLL_SECS, and `SubnetOwnershipWorkflow.intervalSeconds`.
   * Five minutes -- the fastest non-firehose lane by an order of magnitude,
   * because an ownership flip is the one subnet fact a user acts on
   * immediately.
   *
   * DECLARED BEFORE IT IS OBSERVED, which is the opposite of every entry
   * above. The lane has never written to Neon -- its two tables did not exist
   * until #10811 -- so there is no measured gap to floor this against yet.
   * Revisit once it has run a full day (metagraphed-infra#454).
   */
  subnet_ownership: 300,
  /**
   * SELF_STAKE_POLL_SECS -- daily (`20 4 * * *`), one pass of ~64 minutes.
   *
   * ABSENT UNTIL NOW, which is the whole defect (alerted 2026-08-12: "lane
   * self-stake is stale: 20.2h (producer cadence 3.1h)"). With no declared
   * cadence the alarm fell back to the OBSERVED gap between lane_health
   * writes -- and this lane writes several verdicts per pass, so the gaps it
   * measured were intra-pass minutes rather than the day between passes. The
   * inferred ~187m bound is roughly an eighth of the real interval, so a
   * perfectly healthy daily lane read `stale` for most of every day.
   *
   * Exactly what the floor in this table exists for, and the same trap
   * `account_identity` hit in #10329 from the other direction.
   */
  self_stake: 86_400,
} as const;

export type ProducerLane = keyof typeof PRODUCER_CADENCE_SECS;

/**
 * Which of those cadences belong to a WORKER CRON in this repo, and to which
 * `workers/config.ts` constant (#10709).
 *
 * ## The drift this closes
 *
 * Most entries above are transcribed from metagraphed-infra's ansible defaults
 * — this repo cannot check those, and the header says so. But two of them are
 * OURS: the lane runs on a cron declared a few files away, so its interval is
 * stated TWICE, in two languages, with nothing comparing them.
 *
 * That is not hypothetical. #9632 added `top_holders_holdings: 10_800` beside
 * `TOP_HOLDERS_HOLDINGS_REFRESH_CRON = "49 *\/3 * * *"` in the same change, and
 * nothing would have failed if one had said three hours and the other six.
 *
 * ## Why the consequence is an alarm rather than a stale lane
 *
 * The number here is what every staleness watchdog sizes its bound from —
 * `missedTicksMs(lane, n)`. A cadence that disagrees with the cron does not
 * make the producer late; it makes the ALARM wrong, in whichever direction the
 * error points:
 *
 *   - declared too LONG  → the bound never fires, and a dead lane is silent.
 *     That is #10566's shape.
 *   - declared too SHORT → a healthy lane reads `stale` for most of every
 *     cycle. That is #10329 (`account_identity` bounded at half a tick) and
 *     #9301, both of which cost a real alarm and the trust in it.
 *
 * Both are invisible from either side, because each file is internally correct.
 *
 * ## Deliberately partial
 *
 * Only the lanes whose producer is a cron in THIS repo can be checked, so this
 * map names them explicitly rather than deriving the set. An infra-poller
 * cadence has no local expression to compare against, and inventing one would
 * be a second copy of the thing this exists to stop.
 * tests/producer-cadence.test.ts asserts the agreement.
 */
export const WORKER_CRON_LANES: Readonly<
  Partial<Record<ProducerLane, string>>
> = {
  top_holders_flow: "TOP_HOLDERS_FLOW_CRON",
  top_holders_holdings: "TOP_HOLDERS_HOLDINGS_REFRESH_CRON",
} as const;

/**
 * How often a cron expression fires, in seconds — or null where the shape is
 * not one this can reason about.
 *
 * NULL RATHER THAN A GUESS. A list expression (`3,13,23,...`) has no single
 * interval unless the values are evenly spaced, and `*\/n` inside an hour field
 * only divides evenly when n divides 24. Returning a number for a shape it
 * cannot actually measure would put a wrong bound under a watchdog, which is
 * the failure this whole module exists to prevent — so an unrecognised shape is
 * reported as unmeasurable and the caller decides.
 *
 * Handles the shapes this repo's lane crons actually use:
 *   `M H * * *`      once a day
 *   `M *\/N * * *`    every N hours
 *   `M * * * *`      hourly
 *   `M1,M2,... * * * *`  evenly-spaced minutes within an hour
 */
export function cronIntervalSecs(expression: string): number | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, dom, month, dow] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  // Anything narrowing the DAY is not a fixed interval in seconds.
  if (dom !== "*" || month !== "*" || dow !== "*") return null;

  const minutes = evenlySpaced(minute, 60);
  if (minutes === null) return null;

  if (hour === "*") return minutes * 60;
  const hourStep = /^\*\/(\d+)$/.exec(hour);
  if (hourStep) {
    const step = Number(hourStep[1]);
    // 24 % step !== 0 means the last window of the day is short, so the
    // interval is not constant.
    if (!Number.isInteger(step) || step <= 0 || 24 % step !== 0) return null;
    // A step within the hour AND across hours is two cadences, not one.
    if (minutes !== 60) return null;
    return step * 3_600;
  }
  // A single fixed hour: once a day, and only when the minute is fixed too.
  if (/^\d+$/.test(hour)) return minutes === 60 ? 86_400 : null;
  return null;
}

/** The interval a minute field describes, in minutes, or null when its values
 * are not evenly spaced. `*` and `*\/n` are spaced by construction; a list is
 * only if every gap matches, INCLUDING the wrap back to the first value. */
function evenlySpaced(field: string, period: number): number | null {
  if (field === "*") return 1;
  const step = /^\*\/(\d+)$/.exec(field);
  if (step) {
    const n = Number(step[1]);
    return Number.isInteger(n) && n > 0 && period % n === 0 ? n : null;
  }
  const values = field.split(",").map(Number);
  if (values.some((v) => !Number.isInteger(v) || v < 0 || v >= period)) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return period;
  const gap = sorted[1]! - sorted[0]!;
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i]! - sorted[i - 1]! !== gap) return null;
  }
  // The wrap: the last value back round to the first must be the same gap, or
  // the lane has a long window once a period.
  if (period - sorted[sorted.length - 1]! + sorted[0]! !== gap) return null;
  return gap;
}

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
 *
 * `chain-detail` is deliberately ABSENT: it follows the chain head continuously
 * rather than on a poll interval, so it has no tick to miss and its own alarm
 * measures a live-follow WINDOW instead. Inventing a cadence for it would put a
 * floor under a bound that is not measured in cadences.
 */
export const LANE_PRODUCER: Readonly<Record<string, ProducerLane>> = {
  "account-balances": "account_balances",
  "neon:account-balances": "account_balances",
  "neon:account-balances-pass": "account_balances",
  "hotkey-alpha": "hotkey_alpha",
  "neon:hotkey-alpha": "hotkey_alpha",
  "neon:hotkey-alpha-pass": "hotkey_alpha",
  "validator-nominators": "validator_nominators",
  // The SYNC lane names, unprefixed. Their `neon:` mirrors below were mapped
  // and these were not, so `lane nominator-positions is silent: 29.4h` shipped
  // to Discord with no cadence beside it -- 29.4h reads as a dead producer,
  // and it is one missed pass of a 24h poller. The same misreading #10809 added
  // the cadence suffix to prevent, reintroduced by a lane the map did not name.
  "nominator-positions": "validator_nominators",
  "validator-nominator-counts": "validator_nominators",
  "neon:validator-nominator-counts": "validator_nominators",
  "neon:validator-nominator-counts-pass": "validator_nominators",
  "neon:nominator-positions": "validator_nominators",
  "neon:nominator-positions-pass": "validator_nominators",
  "neon:nominator-positions-prune": "validator_nominators",
  // Its own staleness watchdog already declares this producer --
  // `missedTicksMs("metagraph", 3)` in neurons-staleness-watchdog.ts -- so the
  // lane had a STALENESS floor and no SILENCE floor, which is the asymmetry
  // `tests/lane-silence-cadence.test.ts` now forbids.
  neurons: "metagraph",
  "account-identity": "account_identity",
  "neon:account-identity": "account_identity",
  "subnet-hyperparams": "subnet_hyperparams",
  "neon:subnet-hyperparams": "subnet_hyperparams",
  "self-stake": "self_stake",
  "neon:self-stake": "self_stake",
  "subnet-identity": "subnet_identity",
  "neon:subnet-identity": "subnet_identity",
  // No `neon:` sibling: this lane writes Postgres directly rather than through
  // a sync route, so there is no per-write verdict to map -- only the poller's
  // own lane-health report.
  "subnet-ownership": "subnet_ownership",
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
