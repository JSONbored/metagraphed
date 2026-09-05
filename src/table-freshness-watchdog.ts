// One watchdog over EVERY table, because per-lane watchdogs only cover the
// lanes somebody remembered (#9786).
//
// Every staleness watchdog in this repo is hand-written for one table:
// `neurons-staleness`, `chain-detail-staleness`, `account-balances-staleness`,
// and so on. Each knows one table, one threshold, one cron. The consequence is
// structural, not accidental -- a table nobody wrote a watchdog for is watched
// by nothing, forever, and adding a table adds no coverage until someone
// remembers to add a watchdog too.
//
// On 2026-08-07 a one-query sweep of all 46 tables found FOUR frozen for five
// days -- `subnets`, `surfaces`, `providers`, `surface_history`, the whole
// registry cluster, whose only writer was a retired GitHub Actions lane
// (#9779). Nothing reported it. It was found by hand.
//
// ## `null` is the point
//
// A table whose staleness is meaningless -- `api_keys` grows only when someone
// signs up, `d1_migrations` only on a migration -- is declared with
// `maxAgeMs: null` and a reason. That is deliberately not the same as being
// absent from the list: absent means nobody has thought about it, and the test
// beside this file fails on absent. Every table must be CLASSIFIED, and "this
// one cannot be stale" is a classification.
//
// ## What this does NOT replace
//
// The per-lane watchdogs check SEMANTICS -- row counts, netuid coverage, pass
// completeness. This checks only "did anything arrive". Both matter, and the
// difference is exactly the `MAX(captured_at)` blind spot that let the
// metagraph look recovered while 108 of 129 netuids were still missing: a
// fresh timestamp on a partial table passes here and fails there.

import { laneHealthStore } from "./lane-health-store.ts";
import { recordLaneVerdict, type LaneHealthDb } from "./lane-health.ts";
import { readStore } from "./read-store.ts";
import { missedTicksMs, type ProducerLane } from "./producer-cadence.ts";
// DERIVED, not quoted. This read "RAW_CAPTURE_CRON every 5 min" until #11402
// moved the lane to */1 and left the prose behind -- the drift
// project-derived-floors-go-stale-in-prose is about. Reading the cadence from
// the cron itself means the sentence cannot outlive the schedule it describes.
import { RAW_CAPTURE_CRON } from "../workers/config.ts";
import { cronStepMinutes } from "./raw-capture-sync.ts";

/** This watchdog's own lane. */
export const TABLE_FRESHNESS_LANE = "table-freshness";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

export interface FreshnessExpectation {
  /** The column carrying "when did a row last arrive". */
  column: string;
  /** `ms` = epoch milliseconds; `date` = a 'YYYY-MM-DD' text column. */
  kind: "ms" | "date";
  /** How old the newest row may be. `null` = staleness is meaningless here. */
  maxAgeMs: number | null;
  /** Why that number, or why null. Read by whoever gets the alarm. */
  reason: string;
  /**
   * The producer whose cadence this bound is derived from, when it is.
   *
   * DECLARED so the relationship can be CHECKED. `maxAgeMs` alone cannot be
   * audited -- 12 hours is either generous or guaranteed-to-alarm depending
   * entirely on a number that used to live only in prose, and #10329 is the
   * case where it was the second one. With the producer named,
   * tests/table-freshness-cadence.test.ts can assert every derived bound
   * clears one full tick, which is the rule this map's own header states.
   *
   * Absent for the crons and the measured bounds -- `chain-detail` is sized
   * against a DOWNSTREAM consumer's lag and `rpc-usage` against a traffic
   * floor, so naming a producer there would assert a derivation that does not
   * exist.
   */
  producer?: ProducerLane;
  /**
   * Read the stamp from a DIFFERENT table that carries the same value.
   *
   * WHY A TABLE WOULD NOT ANSWER ITS OWN QUESTION. `captured_at` is the
   * freshness stamp, so it changes on every upsert -- which means it can never
   * be indexed on an upsert-heavy table without cost. Postgres skips the HOT
   * path whenever an indexed column changes, and `account_position_daily`
   * takes ~10M updates per 3.5 days at a 33.6% HOT rate; an index on
   * `captured_at` would drive that toward zero and add ~10M index writes to
   * save the ~24 reads a day this sweep makes. So the choice is not
   * "index or scan", it is "scan a 497 MB table, or ask something smaller".
   *
   * Every lane in PASS_TABLES (src/pass-completeness.ts) already writes a
   * `*_passes` row per producer pass, carrying the same `captured_at`.
   * Measured 2026-08-11, `neurons_passes` is 88 kB against
   * `account_position_daily`'s 497 MB and reports the identical value.
   *
   * NOT A FREE SUBSTITUTION, which is why crossCheckSql exists below. A pass
   * row and the rows it describes are two different writes, so a stamp read
   * from the pass table asserts "a pass was recorded", not "its rows landed" --
   * and #9530 is this repo's own case of a freshness signal advancing over data
   * that had not arrived. The sweep takes the cheap read; the cross-check
   * proves the two agree and says so out loud when they do not.
   */
  stampFrom?: string;
  /** An open issue explaining a table that is ALREADY breaching, so the alarm
   * points somewhere instead of merely being loud. */
  knownIssue?: string;
  /**
   * The `lane_health` lane that carries this table's liveness instead of a time
   * bound. Only meaningful alongside `maxAgeMs: null`.
   *
   * A THIRD CLASSIFICATION, distinct from the two `null` already meant.
   * `api_keys` is null because staleness is *meaningless* — a quiet signup
   * table is not a fault in any sense. The registry cluster is different: it
   * has a producer that CAN die, and when it did, five days passed unnoticed
   * (#9779). Calling that "meaningless" would be the exemption this file's
   * header warns about.
   *
   * What makes null correct there now is that the producer reports itself. So
   * the classification is not "cannot be stale", it is "asked somewhere else",
   * and naming where turns an exemption into a redirection that a reader — and
   * the test beside this file — can follow and check.
   *
   * The bar for adding one: the named lane must alarm on BOTH the producer
   * failing and the producer stopping, or this is a blind spot with a citation.
   */
  coveredBy?: string;
}

/**
 * Every table this repo has committed to, and what its freshness means.
 *
 * Thresholds are set from MEASURED cadence (2026-08-07 sweep) with headroom,
 * not from what the producer claims. A threshold under one producer interval
 * alarms forever; one at ten times it never alarms at all.
 *
 * THE CENSUS IS db/schema.sql UNION migrations/neon -- the snapshot of the live
 * Neon schema, plus every table a committed migration declares. It has been
 * wrong in both directions:
 *
 *   Until #10817 it was tests/fixtures/sqlite-schema, the FROZEN D1-era
 *   migration set. That names 49 tables, which were exactly the 49 this map
 *   classified, so every Neon-era table added after the D1 cutover was
 *   structurally invisible: not classified, not exempted, indistinguishable
 *   from healthy. Fourteen had accumulated, including both halves of the
 *   ownership family and our own `self_health_*`.
 *
 *   Until #11042 it was the live snapshot alone. That only learns of a table
 *   AFTER its migration applies, so the PR adding one could neither classify it
 *   (the snapshot has never heard of it) nor leave it unclassified (the drift
 *   PR that follows carries the snapshot and fails on it) -- and in between,
 *   the table was live, written, and watched by nothing. It happened to both
 *   tables it could happen to.
 *
 * The migrations name a table from the commit that DECLARES it, which is where
 * its classification belongs. An exemption list is only worth anything if it
 * can see what it exempts.
 */
export const TABLE_FRESHNESS: Readonly<Record<string, FreshnessExpectation>> = {
  // --- live capture: minutes old in steady state -------------------------
  chain_detail_blocks: {
    column: "observed_at",
    kind: "ms",
    maxAgeMs: 2 * HOUR,
    reason: "firehose poller, continuous",
  },
  chain_detail_extrinsics: {
    column: "observed_at",
    kind: "ms",
    maxAgeMs: 2 * HOUR,
    reason: "firehose poller, continuous",
  },
  chain_detail_chain_events: {
    column: "observed_at",
    kind: "ms",
    maxAgeMs: 2 * HOUR,
    reason: "firehose poller, continuous",
  },
  chain_detail_account_events: {
    column: "observed_at",
    kind: "ms",
    maxAgeMs: 2 * HOUR,
    reason: "firehose poller, continuous",
  },
  blocks_head: {
    column: "observed_at",
    kind: "ms",
    maxAgeMs: 2 * HOUR,
    reason: "head tracker",
  },
  raw_capture_state: {
    column: "updated_at",
    kind: "ms",
    maxAgeMs: 2 * HOUR,
    reason: `RAW_CAPTURE_CRON every ${cronStepMinutes(RAW_CAPTURE_CRON)} min`,
  },
  // `raw_capture_state_v2` was declared here purely to satisfy the old
  // invariant -- "account for every table tests/fixtures/sqlite-schema names"
  // -- against a table that has never existed in production (#9867). With the
  // census taken from db/schema.sql it is not a table at all, so the entry has
  // nothing left to account for and is gone (#10817).
  tao_usd_index: {
    column: "observed_at",
    kind: "ms",
    maxAgeMs: 2 * HOUR,
    reason: "TAO_USD_INDEX_CRON every minute",
  },
  lane_health: {
    column: "checked_at",
    kind: "ms",
    maxAgeMs: 2 * HOUR,
    reason: "every watchdog writes here; silence means they all stopped",
  },

  // --- the metagraph family: 15-minute producer --------------------------
  //
  // TICKS, NOT HOURS, for every poller-backed bound below (#10329). The rule
  // this map states two paragraphs up -- "a threshold under one producer
  // interval alarms forever" -- can only be checked against the interval, and
  // the interval lived in `metagraphed-infra` and reached this file as prose.
  // `account_identity` is what that cost: bounded at 12h against an 86,400s
  // producer, so a working lane read `stale` for half of every cycle.
  //
  // `missedTicksMs` reads src/producer-cadence.ts, the same table the two
  // staleness watchdogs already derive from, so the multiple is arithmetic a
  // reader can verify and a cadence change moves every bound with it.
  neurons: {
    column: "captured_at",
    kind: "ms",
    maxAgeMs: missedTicksMs("metagraph", 8),
    reason: "8 ticks of METAGRAPH_POLL_SECS (15 min)",
    producer: "metagraph",
    // The lane this pass table is FOR (src/pass-completeness.ts:57). Redirected
    // with its two siblings so all three read one 88 kB table rather than three
    // scans of the same pass.
    stampFrom: "neurons_passes",
  },
  // Added by 0030 after this map was written -- the same coverage test that
  // caught 0029's two tables caught this one, which is what it is for.
  neurons_passes: {
    column: "captured_at",
    kind: "ms",
    maxAgeMs: missedTicksMs("metagraph", 8),
    reason: "written with neurons",
    producer: "metagraph",
  },
  neuron_daily: {
    column: "captured_at",
    kind: "ms",
    maxAgeMs: missedTicksMs("metagraph", 8),
    reason: "derived from the same sync",
    producer: "metagraph",
    // 486 MB, and MAX(captured_at) over it measured 850 ms / 40,344 buffers on
    // a parallel sequential scan. One metagraph pass writes neurons,
    // neuron_daily and account_position_daily from the same clock read, so
    // neurons_passes (88 kB) carries this exact stamp.
    stampFrom: "neurons_passes",
  },
  account_position_daily: {
    column: "captured_at",
    kind: "ms",
    maxAgeMs: missedTicksMs("metagraph", 8),
    reason: "derived from the same sync",
    producer: "metagraph",
    // 497 MB, 551 ms / 32,632 buffers. Same pass, same stamp.
    stampFrom: "neurons_passes",
  },
  subnet_snapshots: {
    column: "captured_at",
    kind: "ms",
    maxAgeMs: 4 * HOUR,
    reason: "health prober",
  },
  // Twelve ticks is LOOSE, and stays that way on purpose: loose is the safe
  // direction here, this lane carries its own `subnet-hyperparams` verdict,
  // and #10232 now catches a silent lane by its own cadence regardless.
  // Tightening it is a judgement about how fast a dead hyperparams lane must
  // be noticed -- a separate question from fixing a false alarm.
  subnet_hyperparams: {
    column: "captured_at",
    kind: "ms",
    maxAgeMs: missedTicksMs("subnet_hyperparams", 12),
    reason: "12 ticks of SUBNET_HYPERPARAMS_POLL_SECS (1h)",
    producer: "subnet_hyperparams",
  },
  // THE FIX. This read 12 hours against an 86,400s producer -- half a tick --
  // so `table-freshness` reported `stale` for the back half of every cycle on
  // a lane whose own verdict for the same pass was `ok | 129 scanned, 456
  // written, 0 error(s)`. 2.5 ticks is what its 24-hour sibling hotkey_alpha
  // already uses, so the two lanes on one cadence now share one ratio.
  account_identity: {
    column: "captured_at",
    kind: "ms",
    maxAgeMs: missedTicksMs("account_identity", 2.5),
    reason: "2.5 ticks of ACCOUNT_IDENTITY_POLL_SECS (24h)",
    producer: "account_identity",
  },

  // --- slow ledgers -------------------------------------------------------
  //
  // The header this replaced said "12h/30h/48h producers". NONE of those three
  // numbers is a cadence this poller has: account_balances is 21,600s (6h),
  // the nominator pair 86,400s (24h), hotkey_alpha 86,400s (24h). Every bound
  // still landed somewhere safe, but the stated basis for each was a producer
  // that does not exist -- and prose is what the next bound gets sized
  // against, which is exactly how account_identity got its.
  account_balances: {
    column: "captured_at",
    kind: "ms",
    maxAgeMs: missedTicksMs("account_balances", 4),
    reason: "4 ticks of ACCOUNT_BALANCES_POLL_SECS (6h)",
    producer: "account_balances",
    // 74 MB scanned for a stamp account_balances_passes holds in 80 kB.
    stampFrom: "account_balances_passes",
  },
  account_balances_passes: {
    column: "captured_at",
    kind: "ms",
    maxAgeMs: missedTicksMs("account_balances", 4),
    reason: "written with account_balances",
    producer: "account_balances",
  },
  hotkey_alpha: {
    column: "captured_at",
    kind: "ms",
    maxAgeMs: missedTicksMs("hotkey_alpha", 2.5),
    reason: "2.5 ticks of HOTKEY_ALPHA_POLL_SECS (24h)",
    producer: "hotkey_alpha",
  },
  hotkey_alpha_passes: {
    column: "captured_at",
    kind: "ms",
    maxAgeMs: missedTicksMs("hotkey_alpha", 2.5),
    reason: "written with hotkey_alpha",
    producer: "hotkey_alpha",
  },
  // Added by 0029 while this map was being written -- which is the coverage
  // test doing its job: a new table arrived and was unwatched until named.
  // Pass ledgers are written with their parent table, so they share its
  // cadence.
  nominator_positions_passes: {
    column: "captured_at",
    kind: "ms",
    maxAgeMs: missedTicksMs("validator_nominators", 1.5),
    reason: "written with nominator_positions",
    producer: "validator_nominators",
  },
  nominator_scan_receipts: {
    column: "captured_at",
    kind: "ms",
    maxAgeMs: missedTicksMs("validator_nominators", 1.5),
    reason: "full-scan delivery receipts, independent of self-stake refreshes",
    producer: "validator_nominators",
  },
  validator_nominator_counts_passes: {
    column: "captured_at",
    kind: "ms",
    maxAgeMs: missedTicksMs("validator_nominators", 1.5),
    reason: "written with validator_nominator_counts",
    producer: "validator_nominators",
  },
  nominator_positions: {
    column: "captured_at",
    kind: "ms",
    maxAgeMs: missedTicksMs("validator_nominators", 1.5),
    reason: "1.5 ticks of VALIDATOR_NOMINATORS_POLL_SECS (24h)",
    producer: "validator_nominators",
  },
  validator_nominator_counts: {
    column: "captured_at",
    kind: "ms",
    maxAgeMs: missedTicksMs("validator_nominators", 1.5),
    reason: "written with nominator_positions",
    producer: "validator_nominators",
  },

  // --- probe/rollup lanes -------------------------------------------------
  surface_checks: {
    column: "checked_at",
    kind: "ms",
    maxAgeMs: 4 * HOUR,
    reason: "surface prober",
  },
  surface_status: {
    column: "updated_at",
    kind: "ms",
    maxAgeMs: 4 * HOUR,
    reason: "written with surface_checks",
  },
  surface_uptime_daily: {
    column: "day",
    kind: "date",
    maxAgeMs: 48 * HOUR,
    reason: "daily rollup",
  },
  surface_failure_daily: {
    column: "day",
    kind: "date",
    maxAgeMs: 48 * HOUR,
    reason: "daily rollup",
  },
  api_usage_rollup: {
    column: "day",
    kind: "date",
    maxAgeMs: 48 * HOUR,
    reason: "daily rollup",
  },
  chain_concentration_daily: {
    column: "day",
    kind: "date",
    maxAgeMs: 72 * HOUR,
    reason: "daily rollup, and it can only cover days neuron_daily has (#9781)",
  },
  subnet_burn_history: {
    column: "observed_at",
    kind: "ms",
    maxAgeMs: 4 * HOUR,
    reason: "SUBNET_BURN_CAPTURE_CRON, 4x hourly",
  },
  emission_gate_param_history: {
    column: "observed_at",
    kind: "ms",
    maxAgeMs: 6 * HOUR,
    reason: "EMISSION_GATE_SAMPLE_CRON, 6x hourly",
  },

  // --- change-logs: they append only when something CHANGES ---------------
  account_identity_history: {
    column: "observed_at",
    kind: "ms",
    maxAgeMs: null,
    reason: "append-on-change; quiet means nobody renamed",
  },
  subnet_hyperparams_history: {
    column: "observed_at",
    kind: "ms",
    maxAgeMs: null,
    reason: "append-on-change",
  },
  subnet_emission_enabled_history: {
    column: "observed_at",
    kind: "ms",
    maxAgeMs: null,
    reason: "append-on-change",
  },

  // --- the registry cluster: CURRENTLY BROKEN, and alarmed on purpose -----
  // Not exempted. #9779 is a real outage -- the only writer was a retired
  // GitHub Actions lane -- and suppressing it here to keep the lane green
  // would be the exact thing a watchdog must never do.
  // THE REGISTRY CLUSTER, and why a time bound was the wrong instrument.
  //
  // All four are written by src/registry-sync-neon.ts, on merge, when registry
  // files change. A `MAX(updated_at)` bound on a change-driven producer measures
  // TIME SINCE THE LAST REGISTRY CHANGE, not producer health -- so two quiet days
  // breached the 48h cap with nothing wrong. Observed 2026-08-11: `providers`
  // 57.2h > 48h while the producer had run 6 minutes earlier and correctly
  // written nothing (`registry-sync` verdict `ok`, "no registry files changed").
  //
  // Widening the cap keeps the category error and buys quiet proportional to the
  // guess. What changed since #9779 is that the producer now reports itself --
  // its closing ask was "the cluster needs a lane_health lane so this cannot
  // recur unseen", and src/registry-sync-lane.ts is that lane. It alarms on the
  // producer failing (non-`ok` verdict) AND on the producer stopping (lane-alarm
  // silence), which is the pair `coveredBy` requires.
  //
  // NOT the same `null` as api_keys. See `coveredBy` above: this is "asked
  // somewhere else", not "cannot be stale". #9779 is dropped from all four
  // because it is CLOSED and completed, and a citation to a closed issue was
  // itself sending readers to a dead end (#10657).
  subnets: {
    column: "updated_at",
    kind: "ms",
    maxAgeMs: null,
    reason: "registry sync on merge; quiet means the registry did not change",
    coveredBy: "registry-sync",
  },
  surfaces: {
    column: "updated_at",
    kind: "ms",
    maxAgeMs: null,
    reason: "registry sync on merge; quiet means the registry did not change",
    coveredBy: "registry-sync",
  },
  providers: {
    column: "updated_at",
    kind: "ms",
    maxAgeMs: null,
    reason: "registry sync on merge; quiet means the registry did not change",
    coveredBy: "registry-sync",
  },
  surface_history: {
    column: "recorded_at",
    kind: "ms",
    maxAgeMs: null,
    // Was "append-on-change, but its writer is dead" -- the writer was re-homed
    // when #9779 was fixed, so that half had been false since 2026-08-08.
    reason: "append-on-change; quiet means no surface changed state",
    coveredBy: "registry-sync",
  },

  // --- user state and control: change only when a human acts --------------
  api_keys: {
    column: "created_at",
    kind: "ms",
    maxAgeMs: null,
    reason: "signup-driven",
  },
  api_key_usage_daily: {
    column: "day",
    kind: "date",
    maxAgeMs: null,
    reason: "only rows when a key is used",
  },
  api_key_blocks: {
    column: "",
    kind: "ms",
    maxAgeMs: null,
    reason: "no timestamp column",
  },
  api_quota_daily: {
    column: "day",
    kind: "date",
    maxAgeMs: null,
    reason: "only rows when a key is used",
  },
  rpc_accounts: {
    column: "created_at",
    kind: "ms",
    maxAgeMs: null,
    reason: "signup-driven",
  },
  github_accounts: {
    column: "created_at",
    kind: "ms",
    maxAgeMs: null,
    reason: "signup-driven",
  },
  chain_alert_triggers: {
    column: "created_at",
    kind: "ms",
    maxAgeMs: null,
    reason: "user-created; empty until ALERT_TRIGGER_CREATE_TOKEN is set",
  },
  chain_alert_deliveries: {
    column: "",
    kind: "ms",
    maxAgeMs: null,
    reason: "no timestamp column",
  },
  watch_push_subscriptions: {
    column: "",
    kind: "ms",
    maxAgeMs: null,
    reason: "no timestamp column",
  },
  emission_flow_watch: {
    column: "observed_at",
    kind: "ms",
    maxAgeMs: null,
    reason: "a watch list, edited by hand",
  },

  // --- the fourteen the fixture census could not see (#10817) -------------
  //
  // Every table below is in db/schema.sql and was absent from this map, because
  // the census this file was written against was tests/fixtures/sqlite-schema
  // -- the FROZEN D1-era set. Its 49 tables were exactly the 49 classified
  // here, so the coverage test passed while the map ignored every Neon-era
  // table added since. An exemption list that cannot see what it exempts.

  // The hourly LANE_HEARTBEAT_CRON enqueues all three queue producers. Four
  // ticks, so a single failed enqueue does not alarm but a dead heartbeat does.
  attribution_sweeps: {
    column: "swept_at",
    kind: "ms",
    maxAgeMs: 4 * HOUR,
    reason: "LANE_HEARTBEAT_CRON hourly -> attribution-sweeps queue",
  },
  origin_reachability: {
    column: "checked_at",
    kind: "ms",
    maxAgeMs: 4 * HOUR,
    reason: "LANE_HEARTBEAT_CRON hourly -> origin-reachability queue",
  },
  revenue_observations: {
    column: "observed_at",
    kind: "ms",
    maxAgeMs: 4 * HOUR,
    reason: "LANE_HEARTBEAT_CRON hourly -> revenue-probes queue",
  },
  // Both of these record an OUTCOME that may not happen: a sweep that finds no
  // candidate and a probe that does not fail each write nothing. Bounding them
  // would alarm on the healthy case. `attribution_candidates` is currently
  // empty (0 rows against 128 sweeps), which is either correct or a defect --
  // #10818 is where that gets decided, and a `null` here does not prejudge it.
  attribution_candidates: {
    column: "last_seen",
    kind: "ms",
    maxAgeMs: null,
    reason: "written only when a sweep yields a candidate",
    coveredBy: "attribution-sweep",
  },
  revenue_probe_failures: {
    column: "observed_at",
    kind: "ms",
    maxAgeMs: null,
    reason: "written only when a probe fails; quiet means nothing failed",
    coveredBy: "revenue-probe",
  },
  // NULL FOR A THIRD REASON AGAIN, and deliberately with NO `coveredBy`.
  //
  // Nothing in this repo writes treasury_readings (#10933): its extractor is a
  // maintainer-run promote path, on no schedule, so there is no cadence to
  // bound and no lane whose death would be the alarm. `coveredBy` here would
  // name a watcher that does not exist, which is exactly the "blind spot with a
  // citation" the field's own doc bars.
  //
  // Quiet is therefore the expected state, and it is not silence: a subnet
  // nobody has read has NO ROW, which the served card reports as
  // `repos_read: 0` rather than as an absence of findings. Give it a threshold
  // and it alarms every day until someone runs an extractor by hand.
  //
  // What would change the answer is a schedule. If the extractor ever gets
  // one, this becomes a bounded age against that interval.
  treasury_readings: {
    column: "observed_at",
    kind: "ms",
    maxAgeMs: null,
    reason: "maintainer-run extractor in metagraphed-infra, no schedule",
  },
  // ...and compute_declarations is no longer one of them (#10932 phase 1b). It
  // has a producer on the SAME hourly heartbeat as the three lanes above, so it
  // takes the same bound they do: four ticks, so one failed enqueue does not
  // alarm but a dead heartbeat does. The null-with-no-coveredBy above was
  // correct only while nothing wrote this table.
  compute_declarations: {
    column: "observed_at",
    kind: "ms",
    maxAgeMs: 4 * HOUR,
    reason: "LANE_HEARTBEAT_CRON hourly -> compute-declarations queue",
  },

  // Our own uptime record, written by the registry-sync-api Worker's cron
  // twelve times an hour. If this goes quiet we stop being able to say whether
  // we were up, which is the one outage nobody else will report for us.
  self_health_checks: {
    column: "checked_at_ms",
    kind: "ms",
    maxAgeMs: 2 * HOUR,
    reason: "SELF_HEALTH_PROBE_CRON, 12x/hour",
  },
  self_health_daily: {
    column: "day",
    kind: "date",
    maxAgeMs: 48 * HOUR,
    reason: "daily rollup of self_health_checks",
  },

  // Daily lane (`17 5 * * *`). Two days of slack so one missed run is not an
  // alarm, which matters more here than elsewhere: nothing READS this table
  // yet (#10818), so its verdict is the only thing that would notice it stop.
  subnet_deregistration_daily: {
    column: "captured_at",
    kind: "ms",
    maxAgeMs: 48 * HOUR,
    reason: "SUBNET_DEREGISTRATION_DAILY_CRON, once a day",
  },

  // The subnet-identity family, the same card+history shape as hyperparams.
  // Twelve ticks matches its sibling deliberately -- one hourly producer, one
  // ratio, so the two cannot drift apart.
  subnet_identity: {
    column: "captured_at",
    kind: "ms",
    maxAgeMs: missedTicksMs("subnet_identity", 12),
    reason: "12 ticks of SUBNET_IDENTITY_POLL_SECS (1h)",
    producer: "subnet_identity",
  },
  subnet_identity_history: {
    column: "observed_at",
    kind: "ms",
    maxAgeMs: null,
    reason: "append-on-change; quiet means nobody renamed a subnet",
    coveredBy: "subnet_identity",
  },

  // The ownership family (#10811). The card is upserted every pass; the
  // history appends only when `owner_changed` -- 7 rows across 128 subnets in
  // the whole seeded history, so quiet is its normal state.
  //
  // NOT CADENCE-DERIVED, and cannot be. Its producer runs every 300s, so the
  // ceiling this file's cadence test allows -- 12 ticks -- is ONE HOUR, and
  // the sweep's own floor is TWO (it runs hourly; anything tighter alarms on
  // its own sampling gap). The two rules have no overlap for a lane this fast,
  // so `producer` is deliberately omitted and the bound is the sweep's floor,
  // the same shape as `chain-detail` (sized against a downstream consumer) and
  // `rpc-usage` (sized against a traffic floor). What notices a single missed
  // 5-minute pass is the lane's own `subnet-ownership` verdict, not this.
  //
  // EXPECT THIS TO ALARM until metagraphed-infra#461 lands: the card carries
  // the 2026-08-02 lakehouse seed's stamp and the lane cannot write until its
  // container image ships #450's lane list. A `stale` verdict is CORRECT today
  // and must not be suppressed to quiet it.
  subnet_ownership: {
    column: "captured_at",
    kind: "ms",
    maxAgeMs: 2 * HOUR,
    reason:
      "the sweep's hourly floor; 12 ticks of its 300s producer would be 1h",
    knownIssue: "metagraphed-infra#461",
  },
  subnet_ownership_history: {
    column: "captured_at",
    kind: "ms",
    maxAgeMs: null,
    reason: "append-on-change; quiet means no subnet changed hands",
    coveredBy: "subnet_ownership",
  },

  // An event log: rows appear when a subnet is created or removed, and a chain
  // where neither happened for a week is not a fault.
  subnet_lifecycle: {
    column: "observed_at",
    kind: "ms",
    maxAgeMs: null,
    reason: "append-on-event; quiet means no subnet was added or removed",
    coveredBy: "subnet-lifecycle",
  },

  // Written by scripts/neon-migrate.ts, once per migration. The same "only
  // when a human acts" class as api_keys above.
  schema_migrations: {
    column: "applied_at",
    kind: "ms",
    maxAgeMs: null,
    reason: "one row per migration applied",
  },
};

/** The minimal store surface this needs, so a test can hand it a fake. */
export interface FreshnessDb {
  query(text: string, values?: unknown[]): Promise<Record<string, unknown>[]>;
}

/**
 * Tables asked about in one statement.
 *
 * D1 rejected a compound SELECT past roughly five terms
 * (`too many terms in compound SELECT`), so the sweep is batched rather than
 * issued as one 40-way UNION. Four keeps a margin under that.
 */
export const FRESHNESS_BATCH = 4;

/** The tables this sweep actually queries: those with a column to read. */
export function freshnessTables(): string[] {
  return Object.entries(TABLE_FRESHNESS)
    .filter(([, e]) => e.column !== "")
    .map(([table]) => table)
    .sort();
}

/** One batch's query. `date` columns are compared as text, which sorts. */
export function freshnessSql(
  tables: readonly string[],
  spec: Readonly<Record<string, FreshnessExpectation>> = TABLE_FRESHNESS,
): string {
  return tables
    .map(
      (t) =>
        // The label stays `t` -- the caller asked about THIS table and every
        // downstream map keys on it. Only the FROM moves, so a stampFrom entry
        // is invisible to staleTables, the verdict, and the alarm text.
        `SELECT '${t}' AS t, MAX(${spec[t].column}) AS mx FROM ${spec[t].stampFrom ?? t}`,
    )
    .join(" UNION ALL ");
}

/**
 * The other half of `stampFrom`: does the cheap stamp still equal the real one?
 *
 * One row per redirected table, carrying both values, so a divergence is
 * reported as the two numbers rather than as a boolean. Runs on its own cadence
 * (hourly, beside the sweep) rather than per tick -- the whole point of the
 * redirect is not to scan these tables every time, and a cross-check that ran
 * as often as the sweep would give the saving straight back.
 *
 * ORDER, NOT EQUALITY (#10656). The two sides carry the SAME quantity --
 * `passTallyFromRows` (workers/data-api.ts) takes the pass row's `captured_at`
 * from the posted rows' own, and refuses a request whose rows disagree -- but
 * not at the same TIME: the tally lands after the tables it counts, and only
 * once a pass declares its total, so the pass table trails between those
 * writes. Measured 2026-08-11: 75 minutes. Demanding equality made that
 * expected lag indistinguishable from a fault, and a divergence forces
 * `unknown`, so the lane could not publish a green for as long as the lag
 * persisted.
 *
 * What remains genuinely alarming is the OTHER direction. A cheap stamp NEWER
 * than the table's own would mean the pass row claims data the table does not
 * hold -- a freshness signal advancing over data that has not arrived, which
 * is #9530 exactly, and the failure the redirect could reintroduce. That is
 * what this now reports.
 *
 * The lag direction is not merely tolerated, it is CONFIRMED: a redirected
 * table that reads stale is re-asked of itself before it alarms
 * (`confirmRedirectedStale`), so an under-reporting stamp costs one scan on
 * the alarming path instead of a false alarm.
 */
export function crossCheckSql(
  spec: Readonly<Record<string, FreshnessExpectation>> = TABLE_FRESHNESS,
): string {
  return Object.entries(spec)
    .filter(([, e]) => e.stampFrom && e.column !== "")
    .map(
      ([t, e]) =>
        `SELECT '${t}' AS t, ` +
        `(SELECT MAX(${e.column}) FROM ${e.stampFrom}) AS cheap, ` +
        `(SELECT MAX(${e.column}) FROM ${t}) AS actual`,
    )
    .sort()
    .join(" UNION ALL ");
}

/** The entries that read someone else's stamp, and therefore need proving. */
export function redirectedTables(
  spec: Readonly<Record<string, FreshnessExpectation>> = TABLE_FRESHNESS,
): [string, FreshnessExpectation][] {
  return Object.entries(spec).filter(
    ([, e]) => e.stampFrom && e.column !== "",
  ) as [string, FreshnessExpectation][];
}

export interface StampDivergence {
  table: string;
  stampFrom: string;
  cheap: number | null;
  actual: number | null;
}

/**
 * Rows where the redirected stamp and the table's own disagree.
 *
 * A null on EITHER side counts as a divergence rather than being skipped: an
 * empty pass table beside a populated fact table is exactly the "the redirect
 * is reading nothing" failure, and skipping nulls would make it look healthy.
 * The one exception is both-null, which is a table nothing has written yet.
 */
export function stampDivergences(
  rows: readonly Record<string, unknown>[],
  spec: Readonly<Record<string, FreshnessExpectation>> = TABLE_FRESHNESS,
): StampDivergence[] {
  const out: StampDivergence[] = [];
  for (const row of rows) {
    const table = String(row.t ?? "");
    const entry = spec[table];
    if (!entry?.stampFrom) continue;
    const cheap = row.cheap == null ? null : Number(row.cheap);
    const actual = row.actual == null ? null : Number(row.actual);
    if (cheap == null && actual == null) continue;
    if (cheap === actual) continue;
    // THE LAG DIRECTION IS EXPECTED (#10656): the pass row lands after the
    // rows it counts, so `cheap < actual` is the writes being ordered, not a
    // fault -- and `confirmRedirectedStale` is what stops it costing a false
    // alarm. Only a cheap stamp that RUNS AHEAD is reported: that one claims
    // data the table does not hold.
    if (cheap != null && actual != null && cheap < actual) continue;
    out.push({ table, stampFrom: entry.stampFrom, cheap, actual });
  }
  return out;
}

export interface StaleTable {
  table: string;
  ageMs: number;
  maxAgeMs: number;
  reason: string;
  knownIssue?: string;
}

/** Which tables are older than their own expectation, worst first. */
export function staleTables(
  newest: ReadonlyMap<string, number>,
  nowMs: number,
  spec: Readonly<Record<string, FreshnessExpectation>> = TABLE_FRESHNESS,
): StaleTable[] {
  const out: StaleTable[] = [];
  for (const [table, e] of Object.entries(spec)) {
    if (e.maxAgeMs == null) continue;
    const at = newest.get(table);
    // A table that returned no timestamp is EMPTY, not stale. An empty table
    // has no arrival to be late -- reporting it would make every
    // not-yet-populated table permanently loud.
    if (at == null) continue;
    const ageMs = nowMs - at;
    if (ageMs <= e.maxAgeMs) continue;
    out.push({
      table,
      ageMs,
      maxAgeMs: e.maxAgeMs,
      reason: e.reason,
      knownIssue: e.knownIssue,
    });
  }
  return out.sort((a, b) => b.ageMs - a.ageMs);
}

/** One line for the verdict's detail column. */
export function describeStaleTables(stale: readonly StaleTable[]): string {
  if (stale.length === 0) return "every table is within its expected age";
  return stale
    .map((s) => {
      const h = (s.ageMs / HOUR).toFixed(1);
      const cap = (s.maxAgeMs / HOUR).toFixed(0);
      return `${s.table} ${h}h > ${cap}h${s.knownIssue ? ` (known: ${s.knownIssue})` : ""}`;
    })
    .join("; ");
}

/** Parse a batch's rows into table -> epoch ms. */
export function parseFreshnessRows(
  rows: readonly unknown[],
  spec: Readonly<Record<string, FreshnessExpectation>> = TABLE_FRESHNESS,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const raw of rows) {
    const row = raw as Record<string, unknown>;
    // NULL CHECKED BEFORE Number(): `Number(null)` is 0 and 0 passes
    // Number.isFinite, so MAX() over an empty table would read as 1970 and
    // report every empty table as decades stale.
    if (row?.t == null || row?.mx == null) continue;
    const table = String(row.t);
    const expectation = spec[table];
    if (!expectation) continue;
    const at =
      expectation.kind === "date"
        ? Date.parse(`${String(row.mx)}T00:00:00Z`)
        : Number(row.mx);
    if (Number.isFinite(at)) out.set(table, at);
  }
  return out;
}

export interface FreshnessDeps {
  db?: FreshnessDb | null;
  laneHealthDb?: LaneHealthDb | null;
  now?: () => number;
  spec?: Readonly<Record<string, FreshnessExpectation>>;
}

/**
 * Ask whether every redirected stamp still equals the table's own.
 *
 * ITS OWN FUNCTION, not inline in the sweep, because the sweep's early returns
 * make the failure paths here unreachable from outside — and these are exactly
 * the paths that matter. `failed` and `divergences.length > 0` are different
 * findings and both have to be provable in a test.
 *
 * Resolves its own store rather than taking a db, so an environment that cannot
 * reach one produces `failed` rather than a crash: no store means the redirect
 * went unverified this tick, which is a thing to report, not a thing to throw.
 */
/**
 * Re-ask the table itself before reporting a REDIRECTED table stale (#10656).
 *
 * Only redirected entries are re-asked, and only when they already read stale:
 * a direct entry measured itself, and a fresh redirected entry cannot be
 * hiding staleness (its real stamp is at least as new as the cheap one it
 * answered from). So the expensive scan this redirect exists to avoid happens
 * on the alarming path only.
 *
 * A FAILED CONFIRM KEEPS THE STALE. The cheap stamp said late and nothing
 * refuted it, so reporting it is the honest outcome -- dropping a stale
 * finding because the confirming read broke would be the one way this could
 * hide a real outage.
 */
export async function confirmRedirectedStale(
  stale: readonly StaleTable[],
  env: unknown,
  deps: FreshnessDeps = {},
  now: () => number = Date.now,
  spec: Readonly<Record<string, FreshnessExpectation>> = TABLE_FRESHNESS,
): Promise<StaleTable[]> {
  const redirected = new Set(redirectedTables(spec).map(([table]) => table));
  const suspect = stale.filter((s) => redirected.has(s.table));
  if (suspect.length === 0) return [...stale];
  const tables = suspect.map((s) => s.table);
  const db = deps.db ?? (readStore(env, tables) as FreshnessDb | undefined);
  let confirmed: Map<string, number>;
  try {
    // The tables' OWN stamps, which is what `freshnessSql` would have read had
    // these entries never been redirected -- so the confirm asks exactly the
    // question the redirect deferred.
    if (!db?.query) throw new Error("no store");
    const rows = await db.query(
      tables
        .map(
          (table) =>
            `SELECT '${table}' AS t, MAX(${spec[table].column}) AS mx FROM ${table}`,
        )
        .join(" UNION ALL "),
    );
    // The SPEC is passed: parseFreshnessRows drops any table its spec does
    // not know, and defaulting to TABLE_FRESHNESS would silently discard
    // every row when a caller (a test, another spec) asks about its own.
    confirmed = parseFreshnessRows(rows, spec);
  } catch {
    return [...stale];
  }
  const nowMs = now();
  return stale.filter((entry) => {
    if (!redirected.has(entry.table)) return true;
    const at = confirmed.get(entry.table);
    // No stamp of its own means the confirm established nothing -- keep the
    // finding rather than clearing it on an absence.
    if (at == null) return true;
    return nowMs - at > entry.maxAgeMs;
  });
}

export async function crossCheckStamps(
  env: unknown,
  deps: FreshnessDeps = {},
  spec: Readonly<Record<string, FreshnessExpectation>> = TABLE_FRESHNESS,
): Promise<{ divergences: StampDivergence[]; failed: boolean }> {
  const redirected = redirectedTables(spec);
  if (redirected.length === 0) return { divergences: [], failed: false };
  const involved = redirected.flatMap(([t, e]) => [t, e.stampFrom as string]);
  const db = deps.db ?? (readStore(env, involved) as FreshnessDb | undefined);
  try {
    if (!db?.query) throw new Error("no store");
    const rows = await db.query(crossCheckSql(spec));
    return {
      divergences: stampDivergences(rows, spec),
      failed: false,
    };
  } catch {
    return { divergences: [], failed: true };
  }
}

export interface FreshnessOutcome {
  attempted: boolean;
  stale?: StaleTable[];
  checked?: number;
  reason?: string;
  /** Redirected tables whose pass stamp no longer matches their own, empty when
   * they all agree. Surfaced on the outcome as well as in the lane detail so a
   * caller can act on the pair of numbers rather than parse the prose. */
  divergences?: StampDivergence[];
}

/**
 * Sweep every declared table. Never throws.
 *
 * A batch that fails does NOT fail the sweep: the other batches still carry
 * real information, and one unreadable table should not hide thirty healthy
 * ones. But if EVERY batch fails the verdict is `unknown` rather than `ok`,
 * because "nothing was measured" and "nothing is stale" must not look alike.
 */
export async function runTableFreshnessWatchdog(
  env: unknown,
  deps: FreshnessDeps = {},
): Promise<FreshnessOutcome> {
  const laneDb = laneHealthStore(env, deps.laneHealthDb);
  const now = deps.now ?? Date.now;
  const spec = deps.spec ?? TABLE_FRESHNESS;
  const tables = Object.entries(spec)
    .filter(([, e]) => e.column !== "")
    .map(([t]) => t)
    .sort();

  // PARTITIONED BY STORE, not batched across it (#10160).
  //
  // This is the one reader that spans the whole estate -- ~47 tables, and they
  // do not all live in the same place. readStore is all-or-nothing per call for
  // good reason, so a batch mixing an owned table with an unowned one falls
  // back to the store and every Neon-only table in it throws "relation does not
  // exist". That is not a small loss: the sweep is a single UNION per batch, so
  // one wrong store condemns the batch, and the retry below then walks it a
  // table at a time only to fail on each.
  //
  // So the tables are split by owner FIRST and batched inside each half. Both
  // halves keep the same batch size: D1 caps a compound SELECT at 5 terms, and
  // matching it on the Neon side keeps one number to reason about rather than
  // two that happen to differ.
  // The owned/unowned partition collapsed with the flag (#10051): every
  // table lives in the one store, so the census reads as one set -- which
  // also brings the two live-but-undeclared names (schema_migrations,
  // subnet_deregistration_daily) under the same read as everything else.
  const partitions: string[][] = [tables];

  const newest = new Map<string, number>();
  const readBatch = async (
    group: string[],
    db: FreshnessDb | undefined,
  ): Promise<boolean> => {
    try {
      if (!db?.query) throw new Error("no store");
      const rows = await db.query(freshnessSql(group, spec));
      for (const [table, at] of parseFreshnessRows(rows, spec)) {
        newest.set(table, at);
      }
      return true;
    } catch {
      return false;
    }
  };

  // Tables the sweep could not read, BY NAME. #9866 counted failed BATCHES,
  // which was both imprecise (one bad table condemned four) and unactionable
  // ("7 of 12 batches unreadable" names nothing to go and fix).
  const unreadable: string[] = [];
  for (const partition of partitions) {
    const db =
      deps.db ?? (readStore(env, partition) as FreshnessDb | undefined);
    for (let i = 0; i < partition.length; i += FRESHNESS_BATCH) {
      const batch = partition.slice(i, i + FRESHNESS_BATCH);
      if (await readBatch(batch, db)) continue;
      // ONE bad table used to cost its whole batch. The sweep is a single UNION
      // per batch, so a table that does not exist (or whose column does not)
      // makes the statement throw and takes its neighbours with it -- which is
      // how 12 bad entries blinded 7 of 12 batches, 58% of the estate. Retrying
      // the batch one table at a time costs at most FRESHNESS_BATCH extra round
      // trips on a path that should be empty, and localises the loss to the
      // table actually at fault.
      for (const table of batch) {
        if (!(await readBatch([table], db))) unreadable.push(table);
      }
    }
  }

  if (tables.length > 0 && unreadable.length === tables.length) {
    await recordLaneVerdict(laneDb, {
      lane: TABLE_FRESHNESS_LANE,
      verdict: "unknown",
      age_ms: null,
      detail: "no table could be read",
      checked_at: now(),
    });
    return { attempted: true, reason: "all batches failed" };
  }

  // THE CHEAP STAMP CAN ONLY BE OLDER, so it can only ever manufacture a FALSE
  // STALE -- never a false green (#10656). `neurons_passes.captured_at` is not
  // a different quantity from `neurons.captured_at`: `passTallyFromRows`
  // (workers/data-api.ts) derives it from the posted rows' own `captured_at`
  // and refuses a request whose rows disagree. What differs is WHEN the row
  // lands: the tally is written after the tables it counts, and only once a
  // pass declares its total, so `MAX(captured_at)` over the pass table trails
  // the data table between those writes. Measured 2026-08-11: 75 minutes,
  // against a 120-minute bound -- 62% of the budget spent before the data was
  // even late.
  //
  // So the redirect is confirmed only in the direction where being wrong
  // costs something. A cheap stamp that reads FRESH is fresh a fortiori
  // (`actual >= cheap`), and that is the 99% path the redirect exists to keep
  // cheap. A cheap stamp that reads STALE is re-asked of the table itself
  // before it alarms -- the one scan the saving can afford, because it happens
  // only when the alternative is a false alarm on the estate's largest tables.
  const stale = await confirmRedirectedStale(
    staleTables(newest, now(), spec),
    env,
    deps,
    now,
    spec,
  );

  // THE OTHER HALF OF `stampFrom`. Every redirected table above answered from
  // its pass companion instead of itself, which is only sound while the two
  // agree. This is the hour's proof that they do -- one UNION carrying both
  // numbers per redirected table, and the only place these tables are scanned
  // now.
  //
  // A DIVERGENCE IS AN `unknown`, NOT A `stale`. The data may be perfectly
  // fresh; what has failed is the measurement, and this watchdog's job is to
  // say what it actually established. Calling it `stale` would report a data
  // outage that may not exist, and calling it `ok` would publish an age read
  // off a stamp just proven wrong. #9530 is this repo's own case of a freshness
  // signal advancing over data that had not arrived -- the redirect is exactly
  // the shape that could reintroduce it, so it is watched rather than trusted.
  //
  // A cross-check that THROWS is also not a green: it means this hour proved
  // nothing about the redirect. Recorded separately from a divergence, because
  // "they disagree" and "we could not ask" are different findings.
  const redirected = redirectedTables(spec);
  const { divergences, failed: crossCheckFailed } = await crossCheckStamps(
    env,
    deps,
    spec,
  );
  const crossCheckDetail =
    divergences.length > 0
      ? ` | stampFrom DIVERGED: ${divergences
          .map(
            (d) =>
              `${d.table} reads ${d.cheap} from ${d.stampFrom} but holds ${d.actual}`,
          )
          .slice(0, 3)
          .join("; ")}`
      : crossCheckFailed
        ? ` | stampFrom cross-check unreadable (${redirected.length} redirected table(s) unverified this tick)`
        : "";

  // #9866: an unreadable table must reach the VERDICT, not just the detail
  // string. It used to reach only the prose, so a sweep that read 5 of 12
  // batches still published `ok` -- "every table is within its expected age |
  // 7 of 12 batches unreadable" -- and lane-alarm keys on the verdict, so
  // nothing fired. 58% of the estate was unchecked and the lane called it
  // healthy, including the frozen registry cluster this watchdog was built
  // (#9786) to catch.
  //
  // Three outcomes, in priority order:
  //   stale   - we found a real breach. That is a finding, and it outranks an
  //             incomplete sweep: something IS wrong and the detail says what.
  //   unknown - nothing measured looks stale, but the sweep did not establish
  //             that every table is fresh -- either because a table could not
  //             be read, or because NOTHING was read (D1 can answer without a
  //             `results` key at all, which the `?? []` absorbs without
  //             throwing; absorbing the crash must not also manufacture a
  //             green).
  //   ok      - a complete sweep, over at least one table, with nothing stale.
  //             The only state that has earned the word.
  const measuredNothing = tables.length > 0 && newest.size === 0;
  const verdict =
    stale.length > 0
      ? "stale"
      : unreadable.length > 0 ||
          measuredNothing ||
          divergences.length > 0 ||
          crossCheckFailed
        ? "unknown"
        : ("ok" as const);
  await recordLaneVerdict(laneDb, {
    lane: TABLE_FRESHNESS_LANE,
    verdict,
    age_ms: stale.length === 0 ? null : stale[0].ageMs,
    detail:
      describeStaleTables(stale) +
      (unreadable.length > 0
        ? ` | ${unreadable.length} unreadable: ${unreadable.slice(0, 6).join(", ")}`
        : "") +
      crossCheckDetail,
    checked_at: now(),
  });
  return { attempted: true, stale, checked: newest.size, divergences };
}
