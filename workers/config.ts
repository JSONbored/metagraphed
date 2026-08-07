// Module-scope configuration constants for the API Worker — pure literals,
// regexes, and lookup sets with no runtime dependencies. Extracted from
// workers/api.ts (issue #510, de-monolith) so handlers can share them without
// the entry file owning every constant. Import-free by design: this module must
// stay a leaf so api.ts and any future request-handler module can depend on it
// without cycles.

// Cron schedule strings (must match wrangler.jsonc `triggers.crons`). The hourly
// trigger prunes the D1 time-series; every other trigger runs the 15-minute
// probe. The former fast (*/3) staged-batch-drain trigger (#1346 Option A,
// EVENTS_LOAD_CRON) is retired: its last consumer (loadStagedAccountIdentity)
// was removed once refresh-account-identity moved to a direct-to-Postgres sync.
export const HEALTH_PRUNE_CRON = "0 * * * *";
// Daily embedding-sync trigger (Worker-runtime, since CI has no AI bindings).
// Distinct minute (odd) so it never collides with the 15-minute probe or the
// top-of-hour prune. Must match a wrangler.jsonc `triggers.crons` entry.
export const EMBEDDING_SYNC_CRON = "37 3 * * *";
// #8611: daily per-key abuse scan. Daily rather than hourly because every
// signal is an aggregate over whole days -- sustained ceiling-riding needs a
// multi-day run to fire at all -- so a tighter cadence would re-report the same
// standing set of accounts and train whoever watches the ops channel to ignore
// it. Offset from the other daily crons so they do not contend for the same
// Postgres pool.
export const ABUSE_SCAN_CRON = "53 4 * * *";
// #8702: runtime upgrade radar. Twice hourly, on odd minutes that collide with
// nothing else above. The cadence is set by the GitHub side, not the chain
// side: the Worker holds no GITHUB_TOKEN, so its API calls are unauthenticated
// against a 60/hour per-IP limit on Cloudflare's shared egress. Capturing on a
// fixed schedule pins us at 4 calls/hour no matter how much traffic the radar
// route sees, which a request-path fetch could never guarantee. Two ticks an
// hour is still far inside the upstream's 2-3 day release cadence and the
// days-scale testnet soak this exists to catch.
export const UPGRADE_RADAR_CRON = "7,37 * * * *";
// Hourly account_events_daily rollup (#4832 gap-closure), moved off the
// former rollup-account-events-daily.yml GitHub Actions workflow onto this
// Worker-native cron -- offset from the top-of-hour prune (0) so the two
// don't tick on the same minute. Must match a wrangler.jsonc cron entry.
export const ACCOUNT_EVENTS_ROLLUP_CRON = "17 * * * *";
// Daily github-signals capture (#233 pattern), moved off the retired
// sync-github-signals.yml GitHub Actions workflow (which regenerated the
// committed registry/generated/github-signals.json via an auto-merged bot PR)
// onto this Worker-native cron writing the R2 store directly -- see
// src/github-signals-sync.ts's header for the full lane provenance. Keeps the
// workflow's historical 06:20 UTC cadence (daily: releases are a day-scale
// signal; subnet repos publish a few a week at most), on a minute/hour pair
// that collides with none of the crons above. Must match a wrangler.jsonc
// `triggers.crons` entry.
export const GITHUB_SIGNALS_SYNC_CRON = "20 6 * * *";
// Raw chain capture (extrinsics/events bytes -> R2), every 5 minutes. The
// chain produces ~5 blocks/minute and a tick captures up to 150, so this
// out-runs head by ~6x -- a backlog DRAINS rather than merely holding, which
// is what lets the lane heal an outage instead of just surviving one. See
// src/raw-chain-capture.ts for the no-gap guarantee itself.
export const RAW_CAPTURE_CRON = "*/5 * * * *";

/**
 * The registration-cost capture lane (#9402).
 *
 * Minutes 1/16/31/46 -- the ONLY 15-minute grid left that collides with none of the
 * crons in this file and stays off the 5-minute raw-capture and 15-minute probe grids
 * (computed from the trigger list, not guessed).
 *
 * One tick is a single state_queryStorageAt covering every subnet plus one batched D1
 * write, so it is cheap. The cadence is chosen for RESOLUTION rather than cost: burn
 * moves within minutes during a registration burst -- which is why the live route
 * caches for only 120s -- so an hourly sample would miss exactly the events the
 * series exists to show.
 */
export const SUBNET_BURN_CAPTURE_CRON = "1,16,31,46 * * * *";

// The remaining three machine-data lanes (#9096), moved off their retired
// GitHub Actions sync workflows onto Worker-native crons writing their R2
// stores directly. Each keeps the cadence its workflow ran on, offset onto a
// minute that collides with no other trigger here (taken: 0/15/30/45 from the
// */15 prober, 0, 7, 17, 23, 37, plus 3:37, 4:53 and 6:20).

// Hourly operational-surfaces derivation, replacing sync-operational-surfaces.yml
// (`0 * * * *`). Hourly is kept because this file backs LIVE health probing:
// a surface added to the registry should enter the probe set within the hour,
// not the day. Moved off :00 -- the top-of-hour minute already carries the
// prune and a prober tick -- to :47. See src/operational-surfaces-sync.ts.
export const OPERATIONAL_SURFACES_SYNC_CRON = "47 * * * *";

// Daily surface-verification evidence sweep, replacing
// sync-surface-verification.yml (`40 4 * * *`) -- same cadence, same minute,
// which collides with nothing. Daily is right for the same reason it always
// was: the underlying signal is a 90-day uptime window whose day_count and
// uptime_ratio move slowly, so a tighter cadence would recompute a near
// identical answer. Freshness of the health data itself is the 15-minute
// prober's job. See src/surface-verification-sync.ts.
export const SURFACE_VERIFICATION_SYNC_CRON = "40 4 * * *";

// Daily schema-index baseline promotion, replacing sync-schema-snapshots.yml
// (`0 5 * * *`). Same daily cadence and hour -- third-party OpenAPI documents
// change on the order of days-to-weeks -- shifted off :00 to :05 so it never
// shares a minute with the top-of-hour prune or a prober tick. It runs AFTER
// the 04:40 verification sweep, keeping this repo's scheduled lanes in a
// fixed, non-overlapping order. See src/schema-snapshots-sync.ts.
export const SCHEMA_SNAPSHOTS_SYNC_CRON = "5 5 * * *";

// Freshness watchdog (src/freshness-watchdog.ts) -- the alarm that replaces the
// box-side Prometheus/Alertmanager pair and the cross-box dead-man's-switch,
// neither of which survives the boxes (that design was peers watching peers,
// and there are no peers left).
//
// Hourly, offset to :23 so it does not share a minute with the top-of-hour
// prune (0), the rollup (17), or the radar (7,37). Hourly is the right cadence
// because the TIGHTEST limit any source declares for itself is 12 hours -- a
// finer tick would re-ask a question whose answer cannot have changed, and the
// watchdog's own de-dup (shouldReport) means a standing stall stays quiet after
// the first tick regardless. Must match a wrangler.jsonc cron entry.
export const FRESHNESS_WATCHDOG_CRON = "23 * * * *";

// #9161: the lakehouse seam watchdog. HOURLY at :48, raised from daily (23 7)
// when the seam stopped being a constant and started following the decoder's
// published watermark. Daily was right for a number only a deploy could move;
// it is useless against a watermark whose staleness threshold is three hours,
// because a once-a-day sample cannot tell a three-hour stall from a
// twenty-hour one. :48 is 31 minutes after the decode lane's own `17 * * * *`
// cron, so a tick reads the result of that hour's run rather than racing it.
// A Worker cron rather than an Actions job because this Worker already holds
// R2_SQL_TOKEN, METAGRAPH_ARCHIVE and the D1 binding; the workflow form needed
// all three duplicated repo-side. Must match a wrangler.jsonc cron entry.
export const LAKEHOUSE_SEAM_CRON = "48 * * * *";

// #8696: hourly SafeMode watchdog. SafeMode is the emergency chain pause, and
// an emergency pause is not something to learn about a day late -- the job is
// two reads. Worker-native rather than an Actions job for the same reason as
// LAKEHOUSE_SEAM_CRON above: no repository secret and no third-party trigger
// hop to ask a question this Worker can ask itself. It watches the CHAIN, not
// this Worker, so it is not the circular case a deploy-drift check would be.
// Must match a wrangler.jsonc cron entry.
export const SAFE_MODE_WATCHDOG_CRON = "41 * * * *";

// The emission-gate sampler (#8748/#8750), moved off its GitHub Actions
// schedule onto this Worker: the persistence route, the D1 state, and the
// differs already live here, so the Actions hop bought a third-party trigger
// dependency and 144 runner spins a day for a job this Worker can run
// itself. Same 10-minute cadence the box timer and the Actions schedule
// used. Must match a wrangler.jsonc cron entry.
export const EMISSION_GATE_SAMPLE_CRON = "3,13,23,33,43,53 * * * *";
// #8749: the live emission-drift check, formerly the 30-minute Actions
// schedule -- the same reconstruction CI pins against a fixture, held against
// live chain state. Reads and alerts, writes nothing; a divergence throws so
// the scheduled-run scaffolding records the exception. Offset to :9/:39 --
// dispatch keys on the LITERAL cron string, so this must be unique across
// workers/config.ts (":7,37" already belongs to the upgrade radar) as well as
// matching a wrangler.jsonc cron entry.
export const EMISSION_DRIFT_CHECK_CRON = "9,39 * * * *";
// The neurons LIVE lane's alarm: the poller Container feeds D1 on a
// 15-minute tick, and its first stall (a zombie instance, 2026-08-03) ran
// three silent hours because no watchdog reads that table. Same cadence as
// the lane it watches; a 45-minute threshold (three missed ticks) separates
// a routine restart from a stall. Unique string, matching a wrangler.jsonc
// entry -- dispatch keys on the LITERAL cron string.
export const NEURONS_STALENESS_WATCHDOG_CRON = "6,21,36,51 * * * *";
// #9273: the nominator-positions lane's alarm. That lane had NO watchdog and
// no writer at all -- its box-side job died with the box and the route over it
// kept serving a frozen 153k-row export, so the gap was found by a caller
// noticing a stale `captured_at`, not by us. Twice hourly against a six-hour
// threshold (src/nominator-positions-staleness-watchdog.ts explains why this
// lane's threshold is hours where the neurons lane's is minutes): the tick is
// one MAX() read, so a cheap cadence costs nothing and bounds detection well
// inside the threshold. Minutes 8/38 tick on none of the crons in this file
// and stay off the */5 raw-capture and */15 probe grids -- dispatch keys on
// the LITERAL cron string, so this must be unique here as well as matching a
// wrangler.jsonc `triggers.crons` entry.
export const NOMINATOR_POSITIONS_STALENESS_WATCHDOG_CRON = "8,38 * * * *";
// #9423: the projection lanes' alarm. Two lanes stopped writing on
// 2026-08-03 and nothing noticed for 31 hours -- the read path degrades by
// serving the previous card, so the routes kept answering 200 off numbers 44
// hours old under a `7d` label. Twice hourly against a four-hour threshold
// (src/projection-staleness-watchdog.ts explains the sizing): the tick is 26
// R2 HEADs, so a cheap cadence costs nothing and bounds detection well inside
// the threshold. Minutes 2/32 are 21 minutes after each PROJECTION_LANES_CRON
// tick, so a run has finished before it is judged, and they tick on none of
// the crons in this file while staying off the */5 raw-capture and */15 probe
// grids -- dispatch keys on the LITERAL cron string, so this must be unique
// here as well as matching a wrangler.jsonc `triggers.crons` entry.
export const PROJECTION_STALENESS_WATCHDOG_CRON = "2,32 * * * *";
// #9301: the validator-nominator-counts lane's alarm -- the SIBLING of the
// watchdog above, watching the other output of the same Alpha scan. It had the
// same gap for the same reason: its writer targeted a Postgres that went away,
// and `nominator_count` degraded to null (or to a frozen lakehouse mirror)
// without anything going red. Twice hourly against the same 30-hour threshold,
// since the one producer tick writes both tables. Minutes 19/49 tick on none
// of the crons in this file and stay off the */5 raw-capture and */15 probe
// grids -- dispatch keys on the LITERAL cron string, so this must be unique
// here as well as matching a wrangler.jsonc `triggers.crons` entry.
export const VALIDATOR_NOMINATOR_COUNTS_STALENESS_WATCHDOG_CRON =
  "19,49 * * * *";
// #9208 retention for the chain-detail hot tier. The window only has to cover
// the gap between chain tip and the decoded seam, so everything the lakehouse
// has already absorbed is dropped -- see src/chain-detail-prune.ts for the
// measured sizing and for why the retained depth follows the seam instead of
// being a fixed number of hours. Four times an hour against the chain's ~300
// blocks/hour, with a per-run block cap, so no single run tries to delete a
// whole backlog in one D1 transaction. Minutes 12/27/42/57 tick on none of the
// crons in this file and stay off the */5 raw-capture and */15 probe grids.
export const CHAIN_DETAIL_PRUNE_CRON = "12,27,42,57 * * * *";
// #9208's alarm for the same lane. Separate from the prune above, and
// deliberately so: a prune failure must not swallow the staleness verdict, and
// this is the ONLY signal that the lane has stopped -- a stalled chain-detail
// lane keeps the block list live and merely starts declining drill-down, which
// is silent in aggregate. Minutes 14/29/44/59 are likewise unused elsewhere.
export const CHAIN_DETAIL_STALENESS_WATCHDOG_CRON = "14,29,44,59 * * * *";
// #9464: the top-holders leaderboard's alarm. That lane had NO watchdog and no
// producer -- `account_balances` died with the box and is not in the poller
// Container's job set -- so the route served a one-shot pre-decommission
// materialization for three days at 200 OK and the gap was found by a caller
// reading `captured_at`, not by us. Twice hourly: the tick is one R2 get, so a
// cheap cadence costs nothing and bounds detection well inside the twelve-hour
// threshold (src/top-holders-staleness-watchdog.ts explains that sizing, and
// why a lane with no producer reports stale on every tick). Minutes
// 22/52 tick on none of the crons in this file and stay off the */5 raw-capture
// and */15 probe grids -- dispatch keys on the LITERAL cron string, so this
// must be unique here as well as matching a wrangler.jsonc `triggers.crons`
// entry.
export const TOP_HOLDERS_STALENESS_WATCHDOG_CRON = "22,52 * * * *";
// #9478: the account-balances lane's alarm -- the SOURCE side of the watchdog
// above, not a replacement for it. That one watches the served artifact; this
// one watches the D1 table the artifact is supposed to be composed from, and
// the two fail independently (a fresh table behind a stale artifact is a
// publish problem; a stale table behind either is the producer). Twice hourly
// against the same twelve-hour threshold, since one producer tick is what
// refreshes it -- src/account-balances-staleness-watchdog.ts explains that
// sizing against the poller's six-hour ACCOUNT_BALANCES_POLL_SECS. Minutes 4/34
// tick on none of the crons in this file and stay off the */5 raw-capture and
// */15 probe grids -- dispatch keys on the LITERAL cron string, so this must be
// unique here as well as matching a wrangler.jsonc `triggers.crons` entry.
export const ACCOUNT_BALANCES_STALENESS_WATCHDOG_CRON = "4,34 * * * *";
// #9576: the same alarm for the OTHER ledger the top-holders holdings columns
// are composed from. `hotkey_alpha` shipped in #9512 without one, so an empty
// pool ledger was invisible -- every reader declines correctly and quietly, and
// a correct decline looks exactly like a producer that died a month ago.
// HOURLY rather than twice-hourly, and against a 48-hour threshold: the poller's
// HOTKEY_ALPHA_POLL_SECS defaults to 86400 against account_balances' 21600, so a
// finer cadence would only re-report the same 24-hour-old pass. Minute 54 ticks
// on none of the crons in this file and stays off the */5 and */15 grids --
// dispatch keys on the LITERAL cron string, so it must be unique here as well as
// matching a wrangler.jsonc `triggers.crons` entry.
export const HOTKEY_ALPHA_STALENESS_WATCHDOG_CRON = "54 * * * *";
/**
 * #9628: the network-wide concentration rollup.
 *
 * :18 is the only free minute on the hourly grid that collides with none of
 * the crons above and sits on neither the five- nor the fifteen-minute
 * grid. HOURLY rather than
 * daily even though it only rolls up COMPLETE days: the pass is a single
 * anti-join when there is nothing pending, and the frequency is what drains
 * the self-backfill of the days already in neuron_daily within one working day
 * instead of a month.
 */
export const CHAIN_CONCENTRATION_ROLLUP_CRON = "18 * * * *";
// #9146: scheduled projections -- recompute the windowed-aggregate artifacts
// (every lane in src/projection-lanes.ts's PROJECTION_LANES) from the
// lakehouse. These routes cannot
// be one-shot materialized (their windows anchor to the current date, so a
// stored answer rots) and cannot query R2 SQL at request time (second-scale,
// no indexes), so a cron recomputes and the readers serve R2. Twice-hourly:
// the artifacts sit behind the same short edge-cache TTL the live tier used,
// so a finer cadence would recompute answers nothing could serve yet.
// Minutes 11/41 tick on none of the crons above and stay off the */5
// raw-capture and */15 probe grids. Must match a wrangler.jsonc
// `triggers.crons` entry.
export const PROJECTION_LANES_CRON = "11,41 * * * *";
// #9469: the top-holders net_flow_* lane -- the one column of that leaderboard
// with a live source. Its own cron rather than a slot in PROJECTION_LANES
// because its scan is priced very differently from theirs: `GROUP BY coldkey`
// over the 90-day account_events window scans 1.65 GB (measured against
// production, 2026-08-05), which is 1.65 GB/day here and would be 79 GB/day on
// the twice-hourly lane tick. Nothing it feeds moves faster than that: the
// windows are 7/30/90 days, and the sibling holdings columns it sits beside
// are a fixed 2026-08-02 snapshot. 01:34 UTC puts it ~2.5 h after the
// nominator-positions producer's nightly pass (last two writes 22:27 and
// 23:10 UTC) and on a minute no other cron in this file uses -- dispatch keys
// on the LITERAL cron string, so this must be unique here as well as matching
// a wrangler.jsonc `triggers.crons` entry.
export const TOP_HOLDERS_FLOW_CRON = "34 1 * * *";
// The live-economics refresh, moved off .github/workflows/refresh-economics.yml
// -- the last GitHub Actions data lane. Same 3-hourly cadence that workflow
// ran (it was `41 */3 * * *`), on minute :26, which is the nearest free minute:
// :41 already belongs to BOTH the SafeMode watchdog and the projection lanes,
// and dispatch keys on the LITERAL cron string, so a shared string would route
// this lane into another branch entirely. :26 collides with no trigger in this
// file and stays off the */5 raw-capture and */15 probe grids.
//
// Worker-native rather than an Actions job for the reason the sampler and the
// drift check moved: the KV tier this writes, the D1 tables it aggregates and
// the R2 artifact it reads all live in this Worker, so the Actions hop bought
// a third-party trigger dependency and a credential (the repo
// CLOUDFLARE_API_TOKEN, which has no D1 read permission and silently nulled
// every alpha_price_change_* field, #9189) for work the Worker can do with
// bindings it already holds. See src/live-economics-refresh.ts's header.
// Must match a wrangler.jsonc `triggers.crons` entry.
export const LIVE_ECONOMICS_REFRESH_CRON = "26 */3 * * *";
// KV key holding the last-reported staleness signature, so a standing outage is
// announced when it starts and when it changes rather than every hour forever.
export const FRESHNESS_WATCHDOG_STATE_KEY = "watchdog:freshness:signature";

// #8600: TAO/USD index tick. Every minute, which is ADR 0025 decision 5's
// cadence and also Cloudflare's finest cron granularity -- the 300s staleness
// threshold in the same decision assumes it, giving a reading four ticks of
// headroom before it is served as stale. It lives on the data-api Worker
// rather than the api Worker because that is where the Hyperdrive binding is,
// and a cross-Worker hop for a write the same Worker could do is the shape
// #4832 spent a PR removing.
export const TAO_USD_INDEX_CRON = "* * * * *";

/**
 * The D1 -> Neon reconciler tick (metagraphed-infra#336).
 *
 * On the data-api Worker for the same reason as the line above -- it is the
 * only Worker holding BOTH the D1 binding the rows come from and the Hyperdrive
 * binding they go to, so anywhere else this would be a copy over HTTP.
 *
 * EVERY THREE MINUTES, which is a backfill cadence rather than a watchdog one.
 * The first run has ~817,000 rows of `neuron_daily` history to move at up to
 * four dates a tick, and at this cadence that converges in well under an hour;
 * an hourly cron would take a day. It does not stay expensive once it lands:
 * the lane skips its comparison entirely for an hour after a clean verdict
 * (IDLE_RECHECK_MS), so the steady state is one grouped count per store per
 * hour and every tick in between is a single read of `lane_health`.
 *
 * Distinct from TAO_USD_INDEX_CRON's `* * * * *` rather than folded into it:
 * two expressions deliver two events with two `controller.cron` values, which
 * is what lets the handler dispatch without a minute-of-the-hour test that
 * would drift the moment either cadence changed.
 */
export const NEON_BACKFILL_CRON = "*/3 * * * *";

/**
 * The mirror-lag watchdog tick (metagraphed#9770).
 *
 * HOURLY, and deliberately far slower than the mirrors it watches. It reads
 * `MAX(captured_at)` per mirrored table, which is a scan of each -- 364,935
 * rows for `account_balances` alone -- so a 3-minute cadence would spend
 * millions of D1 row reads an hour to re-learn a fact that changes at most
 * every 15 minutes and, for the ledger lanes, every 12 to 48 HOURS.
 *
 * The threshold it enforces (MIRROR_LAG_THRESHOLD_MS) is an hour, so checking
 * hourly cannot miss a fault it would otherwise report -- it can only report it
 * one tick later.
 *
 * Minute 26 is free of every other lane on this Worker.
 */
export const NEON_MIRROR_LAG_CRON = "26 * * * *";

/**
 * The webhook fan-out tick (metagraphed-infra#354).
 *
 * TWICE HOURLY on two free minutes. The cadence is a cost decision rather than a
 * correctness one: the event id is content-addressed, so a tick over an
 * unchanged snapshot is one KV read and a comparison, and a MISSED tick is
 * self-healing because the next one still sees the change.
 *
 * It is deliberately not wired to the publish. Delivery used to be a step
 * inside the publish workflow, which made it hostage to every earlier step --
 * when the live-API smoke check broke on 2026-08-02, subscribers heard nothing
 * for four days (#9650).
 */
export const WEBHOOK_DISPATCH_CRON = "29,59 * * * *";

/**
 * The lane-health READER's tick (#9330/#9340's missing half).
 *
 * TWICE HOURLY at :28 and :58, which are two of the four minutes left free on
 * this Worker's hourly grid. Both sit near the end of a half hour, after the
 * watchdogs that write at :02/:04/:06/:08/:14/:21/:22/:23 and their
 * second-half twins -- so a tick reads verdicts written minutes ago rather
 * than a half-hour-old picture.
 *
 * The cadence is not a latency decision. An alarm needs LANE_ALARM_MIN_STALE_MS
 * (one hour) of continuous staleness before it fires at all, so reading twice
 * an hour costs nothing against the threshold and halves the requests.
 */
export const LANE_ALARM_CRON = "28,58 * * * *";
// Trend windows for /api/v1/subnets/{netuid}/health/trends and
// /api/v1/health/trends.
export const RETIRED_CURRENT_HEALTH_ARTIFACT_PATTERN =
  /^\/metagraph\/health\/(?:latest\.json|summary\.json|subnets\/\d+\.json)$/;
export const HEALTH_TREND_WINDOWS: Record<string, number> = {
  "7d": 7,
  "30d": 30,
};
export const BULK_TRENDS_PATH_PATTERN = /^\/api\/v1\/health\/trends$/;
export const TRENDS_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/health\/trends$/;
export const PERCENTILES_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/health\/percentiles$/;
export const INCIDENTS_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/health\/incidents$/;
export const TRAJECTORY_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/trajectory$/;
// Subnet hyperparameters (#4303/1.4): one row per netuid, computed live from
// the subnet_hyperparams D1 tier, no static file.
export const SUBNET_HYPERPARAMS_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/hyperparameters$/;
// Historical hyperparameter change tracking (#4309/1.6): append-only timeline
// read from the subnet_hyperparams_history D1 tier, no static file. Detail
// (more specific) before the base pattern above — both are anchored.
export const SUBNET_HYPERPARAMS_HISTORY_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/hyperparameters\/history$/;
// Stake/emission concentration metrics (#2106): computed live from the neurons
// D1 tier, no static file.
export const SUBNET_CONCENTRATION_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/concentration$/;
// Per-day concentration history (decentralization trend) from the neuron_daily
// rollup, no static file.
export const SUBNET_CONCENTRATION_HISTORY_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/concentration\/history$/;
// Per-day performance history (reward-flow & trust trend) from the neuron_daily
// rollup, no static file.
export const SUBNET_PERFORMANCE_HISTORY_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/performance\/history$/;
// Validator-set & registration turnover (churn) from the neuron_daily rollup,
// no static file.
export const SUBNET_TURNOVER_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/turnover$/;
// Net stake flow (StakeAdded vs StakeRemoved) for one subnet, summed live from the
// account_events tier, no static file.
export const SUBNET_STAKE_FLOW_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/stake-flow$/;
// Rolling 24h buy/sell alpha volume (#4339/8.1) — unsigned, distinct from
// stake-flow's netted capital-flow framing — summed live from the same
// account_events tier, no static file.
export const SUBNET_ALPHA_VOLUME_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/volume$/;
// OHLC price/volume candlesticks (#5655, Phase 1 of #5304) — open/high/low/
// close/volume bucketed by ?interval=, computed live from the same
// account_events tier as /volume and /stake-flow, no static file.
export const SUBNET_OHLC_PATH_PATTERN = /^\/api\/v1\/subnets\/(\d+)\/ohlc$/;
// Read-only constant-product stake/unstake slippage quote (#5235) — pure math
// over the subnet's live economics-artifact pool reserves, no chain write.
export const SUBNET_STAKE_QUOTE_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/stake-quote$/;
// What a validator permit costs on one subnet and whether holding one earns
// (#9323, #9327) — derived from the neurons tier against the live pool reserves
// and the two sudo-settable governance parameters, never a cached floor.
export const SUBNET_VALIDATOR_ECONOMICS_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/validator-economics$/;
// Cross-subnet cost-to-validate ranking (#9324): the same derivation as the
// per-subnet route, run over one scan instead of 128 round trips.
export const VALIDATOR_ECONOMICS_RANKING_PATH = "/api/v1/validators/economics";
// Observed floors and set composition over time (#9326). Declared and matched
// BEFORE the plain per-subnet pattern, which would otherwise never see it — the
// same ordering the concentration/performance history routes rely on.
export const SUBNET_VALIDATOR_ECONOMICS_HISTORY_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/validator-economics\/history$/;
// Live cumulative TAO recycled for registration on one subnet (#4339/8.4),
// queried from the chain's own RAORecycledForRegistration storage map at
// request time — not a D1/account_events tier, no static file.
export const SUBNET_RECYCLED_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/recycled$/;
// Live current registration/burn cost for one subnet (#6321) — the dynamic
// price between min_burn_tao/max_burn_tao's static bounds, queried from the
// chain's own Burn storage map at request time — not a D1/account_events
// tier, no static file. Dispatched separately from SUBNET_RECYCLED (a
// different storage item, different route).
export const SUBNET_BURN_PATH_PATTERN = /^\/api\/v1\/subnets\/(\d+)\/burn$/;
// Live subnet-lease state (#6719) — whether a subnet is currently under a
// lease and, if so, its terms, queried from the chain's own SubnetUidTo-
// LeaseId/SubnetLeases/AccumulatedLeaseDividends storage maps at request
// time — not a D1/account_events tier, no static file. The companion
// /lease/history route (lease-lifecycle events, Postgres-tier via the
// DATA_API service binding) is dispatched separately in api.ts's
// handleRequest, matching ownership-history/conviction's own inline-regex
// convention rather than a config.ts pattern constant.
export const SUBNET_LEASE_PATH_PATTERN = /^\/api\/v1\/subnets\/(\d+)\/lease$/;
// Live Crowdloan-pallet state (#8696) — every crowdloan the chain has opened,
// and one crowdloan's detail, read from the pallet's own NextCrowdloanId/
// Crowdloans storage at request time. Not a Postgres/lakehouse tier and no
// static file; see src/crowdloans.ts's header for why this is a storage read
// rather than the extrinsics feed the issue originally scoped.
export const CROWDLOANS_PATH_PATTERN = /^\/api\/v1\/crowdloans$/;
export const CROWDLOAN_DETAIL_PATH_PATTERN = /^\/api\/v1\/crowdloans\/(\d+)$/;
// Validator weight-setting activity over the window, live from account_events, no static file.
export const SUBNET_WEIGHTS_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/weights$/;
// Per-subnet weight-setter leaderboard (the individual validators behind /weights) over the
// window, live from account_events, no static file. Dispatched BEFORE SUBNET_WEIGHTS.
export const SUBNET_WEIGHT_SETTERS_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/weights\/setters$/;
// Axon-serving announcement activity over the window, live from account_events, no static file.
export const SUBNET_SERVING_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/serving$/;
// Prometheus-endpoint serving activity over the window, live from account_events, no static file.
export const SUBNET_PROMETHEUS_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/prometheus$/;
// Stake-movement (re-delegation) activity over the window, live from account_events, no static file.
export const SUBNET_STAKE_MOVES_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/stake-moves$/;
// Stake-transfer (between-coldkeys) activity over the window, live from account_events, no static file.
export const SUBNET_STAKE_TRANSFERS_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/stake-transfers$/;
// Neuron-registration activity over the window, live from account_events, no static file.
export const SUBNET_REGISTRATIONS_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/registrations$/;
// Axon-removal activity over the window, live from account_events, no static file.
export const SUBNET_AXON_REMOVALS_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/axon-removals$/;
// Neuron-deregistration activity over the window, live from account_events, no static file.
export const SUBNET_DEREGISTRATIONS_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/deregistrations$/;
// Per-UID emission yield distribution over the current neurons snapshot, no static file.
export const SUBNET_YIELD_PATH_PATTERN = /^\/api\/v1\/subnets\/(\d+)\/yield$/;
// Per-day yield-distribution history (return-rate trend) from the neuron_daily
// rollup, no static file.
export const SUBNET_YIELD_HISTORY_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/yield\/history$/;
// Reward-distribution + score-spread metrics over the current neurons snapshot
// (reward concentration + trust/consensus percentiles), no static file.
export const SUBNET_PERFORMANCE_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/performance$/;
// Stake sitting on a currently-zero-dividends hotkey (#6789), computed live
// from the neurons D1/Postgres tier, no static file.
export const SUBNET_IDLE_STAKE_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/idle-stake$/;
export const UPTIME_PATH_PATTERN = /^\/api\/v1\/subnets\/(\d+)\/uptime$/;
// Per-UID metagraph routes (#1304/#1305): computed live from the neurons D1 tier.
export const SUBNET_METAGRAPH_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/metagraph$/;
export const SUBNET_NEURON_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/neurons\/(\d+)$/;
export const SUBNET_VALIDATORS_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/validators$/;
// Cross-subnet validator detail route (#4334/7.1): a single validator's
// validator_permit=1 rows aggregated across every subnet it operates in —
// the single-entity drill-in of the bare /api/v1/validators leaderboard.
export const VALIDATOR_DETAIL_PATH_PATTERN =
  /^\/api\/v1\/validators\/([1-9A-HJ-NP-Za-km-z]{47,48})$/;
// Nominator list for one validator (#4334/7.2): StakeAdded/StakeRemoved
// account_events grouped by coldkey, no static file. Dispatched separately
// from VALIDATOR_DETAIL_PATH_PATTERN above (disjoint — that one is $-anchored
// right after the hotkey, this one requires the /nominators suffix).
export const VALIDATOR_NOMINATORS_PATH_PATTERN =
  /^\/api\/v1\/validators\/([1-9A-HJ-NP-Za-km-z]{47,48})\/nominators$/;
// Cross-subnet staked-over-time + rewards-per-1000-TAO history for one
// validator (#4334/7.3), rolled up from the neuron_daily tier.
export const VALIDATOR_HISTORY_PATH_PATTERN =
  /^\/api\/v1\/validators\/([1-9A-HJ-NP-Za-km-z]{47,48})\/history$/;
// Per-subnet chain-event stream (#1345 block explorer): account_events filtered
// by netuid, served live from the event tier.
export const SUBNET_EVENT_SUMMARY_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/event-summary$/;
export const SUBNET_EVENTS_PATH_PATTERN = /^\/api\/v1\/subnets\/(\d+)\/events$/;
// Per-UID + per-subnet metagraph HISTORY (block-explorer Tier-1, #1345): time
// series read from the neuron_daily rollup tier.
export const SUBNET_NEURON_HISTORY_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/neurons\/(\d+)\/history$/;
/** GET /api/v1/subnets/{netuid}/burn/history (#9402). Declared beside its siblings
 * so the router's patterns stay in one place. */
export const SUBNET_BURN_HISTORY_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/burn\/history$/;
/** GET /api/v1/subnets/{netuid}/holders (#9557) -- the per-subnet alpha holder
 * leaderboard, read from the D1 positions ledger x the proven pool totals. */
export const SUBNET_HOLDERS_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/holders$/;
/** GET /api/v1/subnets/{netuid}/surface-history (#9612) -- when this subnet's
 * public surfaces were added, changed or removed, and in which commit. */
export const SUBNET_SURFACE_HISTORY_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/surface-history$/;
/** GET /api/v1/subnets/{netuid}/emission-pipeline/history (#9625) -- one
 * subnet's pipeline decomposition over time, each point pinned to the block it
 * was captured at. */
export const SUBNET_PIPELINE_HISTORY_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/emission-pipeline\/history$/;

export const SUBNET_HISTORY_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/history$/;
export const SUBNET_IDENTITY_HISTORY_PATH_PATTERN =
  /^\/api\/v1\/subnets\/(\d+)\/identity-history$/;
// Account entity routes (#1347): computed live from the account_events + neurons
// D1 tiers. SS58 addresses are base58 (no 0/O/I/l), 47-48 chars.
// A bare, anchored SS58 address — the same shape the route patterns capture,
// reused by the MCP account tools so REST and MCP validate the address identically.
export const SS58_ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{47,48}$/;
export const ACCOUNT_PATH_PATTERN =
  /^\/api\/v1\/accounts\/([1-9A-HJ-NP-Za-km-z]{47,48})$/;
export const ACCOUNT_EVENTS_PATH_PATTERN =
  /^\/api\/v1\/accounts\/([1-9A-HJ-NP-Za-km-z]{47,48})\/events$/;
// Per-account daily-history series (#1854): the durable per-day activity from the
// account_events_daily rollup. Dispatched BEFORE the bare ACCOUNT_PATH_PATTERN.
export const ACCOUNT_HISTORY_PATH_PATTERN =
  /^\/api\/v1\/accounts\/([1-9A-HJ-NP-Za-km-z]{47,48})\/history$/;
// Reverse entity-label lookup (#6740): one address's own community-
// contributed entity labels plus its subnet-ownership ties, computed live
// from the entities.json artifact + chain_events SubnetOwnerChanged stream,
// no static file. Dispatched BEFORE the bare ACCOUNT_PATH_PATTERN.
export const ACCOUNT_ENTITIES_PATH_PATTERN =
  /^\/api\/v1\/accounts\/([1-9A-HJ-NP-Za-km-z]{47,48})\/entities$/;
// Account entity routes (#1347):
export const ACCOUNT_SUBNETS_PATH_PATTERN =
  /^\/api\/v1\/accounts\/([1-9A-HJ-NP-Za-km-z]{47,48})\/subnets$/;
// Cross-subnet neuron portfolio for one wallet (full position economics + yield
// + aggregates), richer than the bare /subnets registration footprint.
export const ACCOUNT_PORTFOLIO_PATH_PATTERN =
  /^\/api\/v1\/accounts\/([1-9A-HJ-NP-Za-km-z]{47,48})\/portfolio$/;
// Nominator-side (coldkey) position reconstruction (#5233): what this
// account holds delegated across every hotkey/subnet, distinct from
// /portfolio above (hotkey-scoped).
export const ACCOUNT_POSITIONS_PATH_PATTERN =
  /^\/api\/v1\/accounts\/([1-9A-HJ-NP-Za-km-z]{47,48})\/positions$/;
// Per-account, per-subnet position HISTORY (block-explorer Tier-1, #4329/6.2):
// time series read from the account_position_daily rollup tier — the "Alpha
// Holdings chart" for one wallet's position on one subnet.
export const ACCOUNT_SUBNET_POSITION_HISTORY_PATH_PATTERN =
  /^\/api\/v1\/accounts\/([1-9A-HJ-NP-Za-km-z]{47,48})\/subnets\/(\d+)\/history$/;
// Per-account signed extrinsics (#1844): the extrinsics this account signed,
// matched by extrinsics.signer (a single column, not the hotkey or coldkey union).
export const ACCOUNT_EXTRINSICS_PATH_PATTERN =
  /^\/api\/v1\/accounts\/([1-9A-HJ-NP-Za-km-z]{47,48})\/extrinsics$/;
// Per-account native-TAO transfers (#1850): the Balances.Transfer feed for this
// account, from account_events (event_kind='Transfer'); ?direction=all|sent|received.
export const ACCOUNT_TRANSFERS_PATH_PATTERN =
  /^\/api\/v1\/accounts\/([1-9A-HJ-NP-Za-km-z]{47,48})\/transfers$/;
// Per-account counterparty / fund-flow rollup: aggregates the account's
// account_events Transfers into per-counterparty sent/received/net.
export const ACCOUNT_COUNTERPARTIES_PATH_PATTERN =
  /^\/api\/v1\/accounts\/([1-9A-HJ-NP-Za-km-z]{47,48})\/counterparties$/;
// Per-account stake flow: aggregates the account's account_events StakeAdded/StakeRemoved
// per subnet into a net/gross flow + concentration scorecard over a 7d/30d/90d window.
export const ACCOUNT_STAKE_FLOW_PATH_PATTERN =
  /^\/api\/v1\/accounts\/([1-9A-HJ-NP-Za-km-z]{47,48})\/stake-flow$/;
// Per-account stake-movement footprint: aggregates the account's account_events StakeMoved
// per subnet into a count + concentration scorecard over a 7d/30d/90d window.
export const ACCOUNT_STAKE_MOVES_PATH_PATTERN =
  /^\/api\/v1\/accounts\/([1-9A-HJ-NP-Za-km-z]{47,48})\/stake-moves$/;
// Per-account weight-setting footprint: aggregates the account's (hotkey/validator's)
// account_events WeightsSet per subnet into a count + concentration scorecard over a 7d/30d window.
export const ACCOUNT_WEIGHT_SETTERS_PATH_PATTERN =
  /^\/api\/v1\/accounts\/([1-9A-HJ-NP-Za-km-z]{47,48})\/weight-setters$/;
// Per-account registration footprint: aggregates the account's account_events NeuronRegistered
// per subnet into a count + concentration scorecard over a 7d/30d/90d window.
export const ACCOUNT_REGISTRATIONS_PATH_PATTERN =
  /^\/api\/v1\/accounts\/([1-9A-HJ-NP-Za-km-z]{47,48})\/registrations$/;
// Per-account serving footprint: aggregates the account's account_events AxonServed
// per subnet into a count + concentration scorecard over a 7d/30d/90d window.
export const ACCOUNT_SERVING_PATH_PATTERN =
  /^\/api\/v1\/accounts\/([1-9A-HJ-NP-Za-km-z]{47,48})\/serving$/;
// Per-account axon-removal footprint: aggregates the account's account_events AxonInfoRemoved
// per subnet into a count + concentration scorecard over a 7d/30d/90d window.
export const ACCOUNT_AXON_REMOVALS_PATH_PATTERN =
  /^\/api\/v1\/accounts\/([1-9A-HJ-NP-Za-km-z]{47,48})\/axon-removals$/;
// Per-account Prometheus-serving footprint: aggregates the account's account_events PrometheusServed
// per subnet into a count + concentration scorecard over a 7d/30d/90d window.
export const ACCOUNT_PROMETHEUS_PATH_PATTERN =
  /^\/api\/v1\/accounts\/([1-9A-HJ-NP-Za-km-z]{47,48})\/prometheus$/;
// Per-account deregistration footprint: aggregates the account's account_events NeuronDeregistered
// per subnet into a count + concentration scorecard over a 7d/30d/90d window.
export const ACCOUNT_DEREGISTRATIONS_PATH_PATTERN =
  /^\/api\/v1\/accounts\/([1-9A-HJ-NP-Za-km-z]{47,48})\/deregistrations$/;
// Live TAO balance query (#1818): captures any non-slash segment; the handler
// applies a stricter ^5[a-zA-Z0-9]{46,47}$ guard before making the RPC call.
export const ACCOUNT_BALANCE_PATH_PATTERN =
  /^\/api\/v1\/accounts\/([^/]+)\/balance$/;
// Live root-claim current state (#7229): claim type + claimable rates +
// cumulative claimed for one Finney ss58 account. Same loose capture as
// balance; the handler applies isFinneySs58Address before RPC.
export const ACCOUNT_ROOT_CLAIM_PATH_PATTERN =
  /^\/api\/v1\/accounts\/([^/]+)\/root-claim$/;
// Personal chain identity (epic #4301/5.4): the latest-only
// account_identity row for one account, and its append-only diff-tracking
// timeline. Mirrors SUBNET_IDENTITY_HISTORY_PATH_PATTERN's shape, keyed by
// ss58 instead of netuid.
export const ACCOUNT_IDENTITY_PATH_PATTERN =
  /^\/api\/v1\/accounts\/([1-9A-HJ-NP-Za-km-z]{47,48})\/identity$/;
export const ACCOUNT_IDENTITY_HISTORY_PATH_PATTERN =
  /^\/api\/v1\/accounts\/([1-9A-HJ-NP-Za-km-z]{47,48})\/identity-history$/;
// Live child-hotkey delegation graph (#6723, part of epic #6721): who this
// hotkey delegates stake-weight to (children) / who delegates to it
// (parents), per subnet — queried from the chain's own ChildKeys/ParentKeys
// storage maps at request time, not a D1/account_events tier, no static
// file. Mirrors ACCOUNT_IDENTITY_PATH_PATTERN's ss58-keyed shape.
export const ACCOUNT_CHILDREN_PATH_PATTERN =
  /^\/api\/v1\/accounts\/([1-9A-HJ-NP-Za-km-z]{47,48})\/children$/;
export const ACCOUNT_PARENTS_PATH_PATTERN =
  /^\/api\/v1\/accounts\/([1-9A-HJ-NP-Za-km-z]{47,48})\/parents$/;
// Block-explorer routes (#1345): recent feed + per-block detail, computed live
// from the `blocks` D1 tier. {ref} is a numeric block_number OR a 0x block_hash
// (32-byte hex = 64 chars).
export const BLOCKS_FEED_PATH_PATTERN = /^\/api\/v1\/blocks$/;
export const BLOCK_DETAIL_PATH_PATTERN =
  /^\/api\/v1\/blocks\/(\d+|0x[0-9a-fA-F]{64})$/;
// Per-block extrinsics sub-resource (#1845): the extrinsics in one block, by the
// same {ref} (numeric block_number or 0x block_hash). Dispatched BEFORE the
// detail pattern (which is $-anchored, so it won't swallow the sub-path).
export const BLOCK_EXTRINSICS_PATH_PATTERN =
  /^\/api\/v1\/blocks\/(\d+|0x[0-9a-fA-F]{64})\/extrinsics$/;
// Per-block events sub-resource (#1852): the decoded chain events in one block,
// by the same {ref} (numeric block_number or 0x block_hash). Dispatched BEFORE
// the detail pattern (which is $-anchored, so it won't swallow the sub-path).
export const BLOCK_EVENTS_PATH_PATTERN =
  /^\/api\/v1\/blocks\/(\d+|0x[0-9a-fA-F]{64})\/events$/;
// Per-block RAW pallet events (#1620), the all-events tier's sibling to
// /events above. Accepts the hash form, matching every other {ref} route.
//
// This pattern's width used to be justified by "a hash-form request is a 404
// either way". It was not: it routed the request into handleChainEventsFamily,
// whose tier matcher was numeric-only, so a hash asked no store and fell out as
// a 503 `data_tier_unavailable`. The tier matcher now admits the same shape
// this does (BLOCK_CHAIN_EVENTS_REF in src/chain-events-degraded.ts), so the
// two agree and a hash is served -- or declines with the typed
// `block_detail_unavailable` 503 the contract documents.
export const BLOCK_CHAIN_EVENTS_PATH_PATTERN =
  /^\/api\/v1\/blocks\/(\d+|0x[0-9a-fA-F]{64})\/chain-events$/;
// Block-explorer extrinsic routes (#1345 second slice): recent feed + per-extrinsic
// detail, computed live from the `extrinsics` D1 tier. {hash} is a 0x extrinsic_hash
// (32-byte blake2b = 64 hex chars).
export const EXTRINSICS_FEED_PATH_PATTERN = /^\/api\/v1\/extrinsics$/;
// Sudo-call feed (#4310/2.2): the extrinsics feed hardcoded to call_module='Sudo'
// (subtensor has no Council/Senate — see #4310's audit). Same D1 tier as
// EXTRINSICS_FEED_PATH_PATTERN, just a dedicated, discoverable path.
export const SUDO_CALLS_PATH_PATTERN = /^\/api\/v1\/sudo$/;
// Current Sudo::Key holder (#4310/2.4, re-scoped from the original Senate/
// Council membership framing — see #4310's audit): a live finney RPC read,
// not a D1 tier — distinct from SUDO_CALLS_PATH_PATTERN's extrinsic feed.
export const SUDO_KEY_PATH_PATTERN = /^\/api\/v1\/sudo\/key$/;
// Live global Subtensor protocol/governance parameters (#6343) -- TaoWeight,
// StakeThreshold, PendingChildKeyCooldown -- a live finney RPC read, same
// shape as SUDO_KEY_PATH_PATTERN just above (no path params, no D1 tier).
export const NETWORK_PARAMETERS_PATH_PATTERN =
  /^\/api\/v1\/network\/parameters$/;
// Live drand randomness-beacon status (#6731) -- LastStoredRound/
// OldestStoredRound -- a live finney RPC read, same shape as
// NETWORK_PARAMETERS_PATH_PATTERN just above (no path params, no D1 tier).
export const RANDOMNESS_PATH_PATTERN = /^\/api\/v1\/network\/randomness$/;
// Live H160 -> SS58 address mapping (#6725/#6728), via the AddressMapping EVM
// precompile -- a live finney RPC read keyed by h160. Captures any non-slash
// segment (same looseness as ACCOUNT_BALANCE_PATH_PATTERN above); the handler
// applies the stricter H160_PATTERN guard before making the RPC call, so a
// malformed value gets a clear 400 rather than a generic 404.
export const EVM_ADDRESS_MAPPING_PATH_PATTERN =
  /^\/api\/v1\/evm\/address\/([^/]+)$/;
// AdminUtils config-change feed (#4310/2.3, re-scoped from the original
// Council/Senate framing — see #4310's audit): the extrinsics feed hardcoded
// to call_module='AdminUtils', subtensor's own root-origin hyperparameter/
// network-config change pathway. Same D1 tier as EXTRINSICS_FEED_PATH_PATTERN.
export const GOVERNANCE_CONFIG_CHANGES_PATH_PATTERN =
  /^\/api\/v1\/governance\/config-changes$/;
// Runtime spec-version transition timeline (#4316/3.1): the earliest known
// block at each distinct spec_version seen on the blocks D1 tier. Same D1
// tier as BLOCKS_FEED_PATH_PATTERN, a site-wide aggregate, not per-block.
export const RUNTIME_VERSIONS_PATH_PATTERN = /^\/api\/v1\/runtime$/;
// Per-extrinsic detail (#1345/#1848): ref is a 0x extrinsic_hash OR the canonical
// composite id "<block_number>-<extrinsic_index>" (the guaranteed-present id, since
// the hash is best-effort/nullable). Single capture group; the handler branches.
export const EXTRINSIC_DETAIL_PATH_PATTERN =
  /^\/api\/v1\/extrinsics\/(0x[0-9a-fA-F]{64}|\d+-\d+)$/;
// Per-domain rollup (#6749/#6750): total stake/emission-share/concentration
// across one domain/capability tag's member subnets. `tag` is captured loosely
// (any lowercase-hyphen token) -- the handler validates it against the real
// fixed DOMAIN_TAGS enum, matching how other enum-shaped path segments in this
// file defer their real validation to the handler rather than the regex.
export const DOMAIN_SUMMARY_PATH_PATTERN =
  /^\/api\/v1\/domains\/([a-z-]+)\/summary$/;
export const UPTIME_WINDOWS: Record<string, number> = { "90d": 90, "1y": 365 };
export const MAX_UPTIME_ROWS = 10000;
export const MAX_BULK_TREND_ROWS = 10000;
export const ANALYTICS_WINDOWS: Record<string, number> = { "7d": 7, "30d": 30 };
export const DEFAULT_ANALYTICS_WINDOW = "7d";
export const ANALYTICS_WINDOW_PARAM = "window";
export const RPC_USAGE_BUCKETS = {
  "7d": { granularity: "1h", bucketMs: 60 * 60 * 1000, maxBuckets: 7 * 24 },
  "30d": {
    granularity: "6h",
    bucketMs: 6 * 60 * 60 * 1000,
    maxBuckets: 30 * 4,
  },
};
export const MAX_INCIDENT_ROWS = 1000;
export const MAX_GLOBAL_INCIDENT_SOURCE_ROWS = 5000;
export const DAY_MS = 24 * 60 * 60 * 1000;

export const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

// Fixed bucket used as the rate-limit key (and request-scoped client id) when no
// trustworthy client IP is available.
export const ANONYMOUS_CLIENT_KEY = "anonymous";

// Resolve the client IP for rate-limiting / per-client keys. On Cloudflare,
// `CF-Connecting-IP` is set by the edge and cannot be spoofed by the client.
// `X-Forwarded-For` is fully client-controlled and MUST NOT be trusted here: an
// attacker could rotate it to mint a fresh rate-limit bucket per request and
// evade the limiter. So we read `cf-connecting-ip` ONLY; when it is absent
// (non-CF / local / the test harness) we collapse to a single fixed bucket
// rather than honoring any client-supplied header. A shared fixed bucket is the
// safe failure mode — worst case all such callers share one limit.
export function resolveClientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") || ANONYMOUS_CLIENT_KEY;
}

// Clamp a raw limit/offset (a query-param string or a tool-arg number) into
// [min, max], falling back to `def` when absent/blank/non-finite. Shared by every
// paginated route + tool so they bound page size identically.
export function clampInt(
  raw: string | number | null | undefined,
  def: number,
  min: number,
  max: number,
): number {
  if (raw == null || raw === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

// Read-only, bounded Substrate/Subtensor methods safe to expose through the
// public proxy. Deliberately excludes heavy/abusable reads (state_getMetadata,
// state_getStorage) and anything mutating — those stay blocked by the allowlist
// plus DENIED_RPC_PREFIXES.
export const SAFE_RPC_METHODS = new Set([
  "chain_getBlock",
  "chain_getBlockHash",
  "chain_getFinalizedHead",
  "chain_getHeader",
  "rpc_methods",
  "state_getRuntimeVersion",
  "system_chain",
  "system_health",
  "system_name",
  "system_properties",
  "system_version",
]);
// Read-only WebSocket subscriptions — WSS-ONLY. The HTTP proxy uses SAFE_RPC_METHODS
// alone (subscriptions need a persistent connection, so they make no sense over HTTP);
// the wss-lb additionally allows these. Their notifications stream upstream→client.
// Deliberately excludes persistent storage subscriptions, which can create
// unbounded upstream watcher state for arbitrary keys.
// All allowed entries are read-only; author_submitAndWatchExtrinsic stays blocked
// by the author_ prefix.
export const SAFE_RPC_SUBSCRIPTIONS = new Set([
  "chain_subscribeNewHeads",
  "chain_subscribeNewHead",
  "chain_unsubscribeNewHeads",
  "chain_subscribeFinalizedHeads",
  "chain_subscribeFinalisedHeads",
  "chain_unsubscribeFinalizedHeads",
  "chain_unsubscribeFinalisedHeads",
  "chain_subscribeAllHeads",
  "chain_unsubscribeAllHeads",
  "state_subscribeRuntimeVersion",
  "state_unsubscribeRuntimeVersion",
]);
export const DENIED_RPC_PREFIXES = [
  "author_",
  "state_call",
  "sudo_",
  "payment_",
  "contracts_",
];
// The WSS proxy's policy, deliberately WIDER than the HTTP proxy's allowlist above.
//
// The two endpoints answer different questions. `/rpc/v1/{network}` serves single
// JSON-RPC calls to callers who picked a method by name, so an 11-entry allowlist is
// a reasonable contract. `wss.metagraph.sh` is a WebSocket URL people point a whole
// Substrate CLIENT at — and every such client opens by fetching metadata and calling
// runtime APIs through `state_call`, then reads storage. Under SAFE_RPC_METHODS none
// of that is possible, so the allowlist would not narrow the WSS endpoint, it would
// end it.
//
// So the WSS side enforces a DENY list instead: nothing that mutates chain state or
// costs an upstream a signature. Everything else — storage reads, runtime calls,
// metadata — is a read, which is what this endpoint advertises itself as.
//
// `state_call` is absent here ON PURPOSE and it is the one real judgement call: it
// executes a runtime API, which is read-only but not free. It is also load-bearing
// for every real client, and the per-IP connect limits plus the pool's own upstream
// rate limits are the controls that bound it — not a method name.
//
// This is enforced in workers/wss-lb.ts. It was NOT enforced at all between the
// Railway retirement and this change: the Worker imported only MAX_RPC_BODY_BYTES,
// so `author_submitExtrinsic` and `sudo_*` were proxied to five upstream providers
// under our IP reputation. The migration note in that file lists what deliberately
// changed and does not mention the policy, which is how a silent drop reads.
export const WSS_DENIED_RPC_PREFIXES = [
  "author_",
  "sudo_",
  "payment_",
  "contracts_",
];
// A second, narrower allowlist for the public RPC proxy (#4344/9.2, design
// spike in docs/block-explorer-data-model.md): storage-key reads take a
// caller-supplied key/prefix with no natural bound, unlike every SAFE_RPC_METHODS
// entry. Membership here is NOT sufficient on its own -- the handler additionally
// requires param-shape validation and a separate, stricter rate-limit budget
// (STATE_QUERY_RATE_LIMITER) before forwarding. state_getPairs is deliberately
// excluded: it has no caller-side pagination at all and can return an entire
// pallet's storage (keys AND values) under a shallow prefix in one response --
// state_getKeysPaged already covers the legitimate "enumerate a prefix" use case
// with a bounded page size.
export const SAFE_RPC_STATE_QUERY_METHODS = new Set([
  "state_getStorage",
  "state_getKeysPaged",
]);
// A real storage key is at most two twox128 hashes (16 bytes each) plus one
// hashed map key -- even a Blake2_128Concat key on a 32-byte AccountId stays
// well under 128 bytes decoded. 256 bytes decoded (512 hex chars + "0x") is a
// generous ceiling above any real key/prefix, not a bound anyone legitimate
// would hit.
export const MAX_STATE_QUERY_KEY_HEX_CHARS = 512;
// state_getKeysPaged's caller-supplied page-size `count` is clamped (not
// rejected) to this ceiling, mirroring how paginated REST routes in this repo
// clamp rather than error on an over-large `?limit` (clampInt above).
export const MAX_STATE_QUERY_KEYS_PAGE_SIZE = 250;
// Post-fetch response-size cap for state-query methods specifically (separate
// from any general proxy behavior): even with the page-size clamped, cap the
// decoded upstream body so a pathological prefix can't relay an oversized
// payload to the client. Same order of magnitude as the general proxy's 64 KB
// *request* cap.
export const MAX_STATE_QUERY_RESPONSE_BYTES = 262144; // 256 KB
export const MAX_RPC_BODY_BYTES = 65536;
export const METAGRAPH_LATEST_KEY = "metagraph:latest";
export const MAX_WEBHOOK_BODY_BYTES = 8192;
export const MAX_ASK_BODY_BYTES = 4096;
export const WEBHOOK_SUBSCRIPTION_TOKEN_HEADER =
  "x-metagraph-webhook-subscription-token";
// account_events_daily rollup trigger (#4832 gap-closure). Shared by
// data-api.ts's handler (validates it) and api.ts's Worker-native cron
// dispatch (sets it on the synthetic internal request — the former
// rollup-account-events-daily.yml GitHub Actions workflow used to set it on
// its public curl call instead).
export const ROLLUP_TOKEN_HEADER = "x-rollup-sync-token";
// Dormant subscriptions self-clean after 180 days; the publish-time dispatcher
// refreshes the TTL on each successful delivery.
export const WEBHOOK_TTL_SECONDS = 180 * 24 * 60 * 60;
export const TRUSTED_RPC_UPSTREAM_ORIGINS = new Set([
  "https://archive.chain.opentensor.ai",
  "https://bittensor-finney.api.onfinality.io",
  "https://bittensor-public.nodies.app",
  "https://entrypoint-finney.opentensor.ai",
  "https://lite.chain.opentensor.ai",
  // Bittensor testnet base-layer RPC + WSS (the /rpc/v1/test + test-wss pools);
  // verified testnet genesis 0x8f9cf8…, distinct from finney. WSS endpoints
  // confirmed (101 Switching Protocols). See registry/native/test-base-endpoints.json.
  "https://test.finney.opentensor.ai",
  "https://test.chain.opentensor.ai",
  "wss://test.finney.opentensor.ai",
  "wss://test.chain.opentensor.ai",
  "wss://archive.chain.opentensor.ai",
  "wss://bittensor-finney.api.onfinality.io",
  "wss://entrypoint-finney.opentensor.ai",
  "wss://lite.chain.opentensor.ai",
  // The first-party pruned RPC node (#4965) used to be listed here. The box was
  // decommissioned in metagraphed-infra#225 and the hostname now answers
  // Cloudflare error 1033 / HTTP 530 on every request -- the tunnel origin is
  // gone. Removed rather than left allowlisted: a dead entry here is one the
  // pool can still rank, which is exactly what happened (see the PR).
]);
