// subnet-ownership -- the first job built natively in the poller
// (metagraphed-infra#138). Closes the gap JSONbored/metagraphed#6644 found:
// no clean provider<->owner mapping exists on-chain anywhere in this
// codebase. Resolves the REAL owning account for every currently-registered
// subnet via the same two-step chain read scripts/fetch-subnet-locks.py
// already established for its own owner-lock rows:
//
//   1. SubtensorModule::SubnetOwnerHotkey(netuid) -> the owner's hotkey
//   2. SubtensorModule::Owner(hotkey)             -> the owning account
//
// (Owner is confirmed against the official bittensor Python SDK's own
// resolution, bittensor/core/subtensor.py -- both storage items are
// ValueQuery, defaulting to the zero account [0u8; 32] rather than erroring
// when unset. A hotkey with no registered owner resolves to that zero
// account, same as the SDK's own callers treat it: no owning account, not a
// literal owner.)
//
// The active netuid set is discovered by iterating
// SubtensorModule::NetworksAdded (a StorageMap<NetUid, bool> -- the runtime's
// own "does this subnet exist" flag) rather than a hardcoded upper bound, so
// a newly-registered or deregistered subnet is picked up automatically on
// the next tick with no code change.
//
// Gathers the whole snapshot in memory before writing (same shape as
// scripts/fetch-account-balances.py / scripts/fetch-subnet-hyperparams.py):
// a tick either upserts a complete, consistent snapshot, or -- if too many
// netuids failed to resolve -- returns Err and writes nothing at all, never
// a half-scanned partial snapshot silently overwriting a good one.
//
// PERFORMANCE (live-verified 2026-07-19 against the public archive RPC): one
// `ChainClient::call(api.at_current_block())` up front for the whole tick,
// then every storage read below goes directly through that single cached
// `AtBlock` -- NOT through another `ChainClient::call` per read. An earlier
// version called `at_current_block()` fresh inside every single storage
// fetch (~260 extra round-trips for 129 netuids x 2 lookups each); against
// a public endpoint that made a full tick take minutes instead of seconds.
// `backfill_rs::AtBlock`'s own doc comment carries this same warning for the
// next job added here. Losing ChainClient::call's stall-timeout/reconnect
// wrapper on these individual reads is an accepted tradeoff, not an
// oversight: connect_chain()'s LegacyBackend already structurally avoids the
// chainHead_v1_follow stall class (subxt#2050) these reads could otherwise
// hit, the ReconnectingRpcClient's own 60s request_timeout still bounds any
// single stateless call, and a whole-tick failure just retries on the next
// scheduled interval -- an acceptable cost for a periodic poller, unlike
// main.rs's live-follow hot path this same reasoning would NOT apply to.
//
// subnet_ownership_history (metagraphed#6970): subnet_ownership above is
// latest-only -- an ownership change just overwrites the previous row with
// no trace. Every tick now also fetches the CURRENT state of
// subnet_ownership before writing (one query, not per-netuid) and appends a
// subnet_ownership_history row only when a netuid's resolved owner differs
// from what's already stored, or has never been stored at all -- same
// diff-based-append convention as subnet_hyperparams_history/neuron_daily,
// so a subnet whose ownership never changes accumulates exactly one history
// row (its first observation), not one per poll tick forever.

use std::collections::HashMap;
use std::time::Duration;

use anyhow::{Context, Result};
use backfill_rs::{now_ms, retry_transient, AtBlock, ChainClient};
use subxt::dynamic;
use subxt::utils::AccountId32;

use crate::JobOutcome;

// Mirrors scripts/fetch-account-balances.py's MAX_ERROR_RATE: above this
// fraction of scanned netuids failing to resolve, treat the tick as
// systemically broken (e.g. a metadata/decode mismatch after a runtime
// upgrade) rather than upsert a mostly-empty snapshot over a good one.
const MAX_ERROR_RATE: f64 = 0.5;

// See resolve_ownership's own doc comment for why individual fetches retry.
const RETRY_ATTEMPTS: u32 = 3;

const ZERO_ACCOUNT: AccountId32 = AccountId32([0u8; 32]);

struct OwnershipRow {
    netuid: i32,
    owner_hotkey: String,
    owner_coldkey: String,
}

/// Connects its own chain + Postgres client (each kept alive for the loop's
/// lifetime, separate from every other job's connections -- see main.rs's
/// own doc comment for why) and ticks `run` on `interval` forever, reporting
/// through the shared `crate::log_job_outcome`.
pub async fn run_loop(rpc_url: String, db_url: String, interval: Duration) {
    let chain = backfill_rs::connect_chain_retrying("subnet-ownership", rpc_url).await;
    let mut pg = backfill_rs::connect_pg_retrying("subnet-ownership", &db_url).await;
    let mut ticker = tokio::time::interval(interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        ticker.tick().await;
        let t0 = std::time::Instant::now();
        let result = run(&chain, &mut pg).await;
        if result.is_err() {
            // This loop holds ONE Postgres connection for its entire
            // lifetime (see this function's own doc comment) -- if it dies
            // (e.g. a Postgres restart, confirmed live 2026-07-20 via
            // metagraphed-infra's own schema-ref-bump-triggered restarts:
            // every subsequent tick failed forever with "connection
            // closed", caught only once indexer-rs-poller-health-poll.sh's
            // per-job freshness metric existed to notice the silence), every
            // query on it fails forever with no self-healing. Reconnect on
            // ANY tick failure, not just ones that look connection-related
            // -- a fresh connect is cheap and harmless even when the error
            // was unrelated to connectivity, and distinguishing error kinds
            // here isn't worth the complexity for a 30s-backoff reconnect.
            pg = backfill_rs::connect_pg_retrying("subnet-ownership", &db_url).await;
        }
        crate::log_job_outcome("subnet-ownership", &result, t0.elapsed(), interval);
    }
}

async fn run(chain: &ChainClient, pg: &mut tokio_postgres::Client) -> Result<JobOutcome> {
    let at = chain
        .call(|api| async move { Ok(api.at_current_block().await?) })
        .await
        .context("at_current_block")?;

    let netuids = backfill_rs::discover_netuids(&at)
        .await
        .context("discover netuids")?;
    let scanned = netuids.len() as u64;
    eprintln!("subnet-ownership: discovered {scanned} netuid(s), resolving owners");

    let mut rows = Vec::with_capacity(netuids.len());
    let mut errors = 0u64;
    for (i, netuid) in netuids.into_iter().enumerate() {
        match resolve_ownership(&at, netuid).await {
            Ok(Some(row)) => rows.push(row),
            // No owner hotkey registered, or it resolves to the zero
            // account -- not an error, just nothing to record for this netuid.
            Ok(None) => {}
            Err(e) => {
                eprintln!("subnet-ownership: netuid={netuid} resolution failed: {e:#}");
                errors += 1;
            }
        }
        if (i + 1).is_multiple_of(20) {
            eprintln!("subnet-ownership: resolved {}/{scanned}", i + 1);
        }
    }

    let error_rate = if scanned > 0 {
        errors as f64 / scanned as f64
    } else {
        0.0
    };
    if error_rate > MAX_ERROR_RATE {
        anyhow::bail!(
            "error rate {errors}/{scanned} ({:.0}%) exceeds {:.0}% -- refusing to write a mostly-broken snapshot",
            error_rate * 100.0,
            MAX_ERROR_RATE * 100.0
        );
    }

    let captured_at = now_ms();
    let previous = fetch_current_owners(pg)
        .await
        .context("fetch current subnet_ownership")?;
    let written = upsert(pg, &rows, captured_at, &previous)
        .await
        .context("upsert subnet_ownership")?;

    Ok(JobOutcome {
        scanned,
        written,
        errors,
    })
}

/// The current (pre-this-tick) state of `subnet_ownership`, one query for
/// the whole table rather than a per-netuid lookup -- `upsert` below diffs
/// each resolved row against this map to decide whether a
/// `subnet_ownership_history` row is warranted.
async fn fetch_current_owners(
    pg: &tokio_postgres::Client,
) -> Result<HashMap<i32, (String, String)>> {
    let rows = pg
        .query(
            "SELECT netuid, owner_hotkey, owner_coldkey FROM subnet_ownership",
            &[],
        )
        .await
        .context("select current subnet_ownership")?;
    Ok(rows
        .into_iter()
        .map(|row| (row.get::<_, i32>(0), (row.get(1), row.get(2))))
        .collect())
}

/// True when `hotkey`/`coldkey` differ from `previous`'s stored values for
/// this netuid, or `previous` has no entry at all (first-ever observation).
/// Pure/sync so it's directly unit-testable without a database.
fn owner_changed(previous: Option<&(String, String)>, hotkey: &str, coldkey: &str) -> bool {
    match previous {
        Some((prev_hotkey, prev_coldkey)) => prev_hotkey != hotkey || prev_coldkey != coldkey,
        None => true,
    }
}

/// SubnetOwnerHotkey(netuid) -> Owner(hotkey) -> owning account. Returns `None`
/// (not an error) when either step resolves to the zero account -- that's a
/// real, valid "no owner" state per the bittensor SDK's own convention, not
/// a decode failure. Each fetch retries transient failures (RETRY_ATTEMPTS)
/// -- live-verified 2026-07-19 that a single unretried fetch can hit the
/// ReconnectingRpcClient's 60s request_timeout under concurrent multi-job
/// load even though the same call reliably completes in under a second
/// moments later (see `backfill_rs::retry_transient`'s own doc comment).
async fn resolve_ownership(at: &AtBlock, netuid: u16) -> Result<Option<OwnershipRow>> {
    let hotkey_addr =
        dynamic::storage::<(u16,), AccountId32>("SubtensorModule", "SubnetOwnerHotkey");
    let hotkey: AccountId32 = retry_transient(RETRY_ATTEMPTS, || async {
        Ok(at.storage().fetch(&hotkey_addr, (netuid,)).await?)
    })
    .await
    .with_context(|| format!("SubnetOwnerHotkey(netuid={netuid})"))?
    .decode()?;

    if hotkey == ZERO_ACCOUNT {
        return Ok(None);
    }

    let owner_addr = dynamic::storage::<(AccountId32,), AccountId32>("SubtensorModule", "Owner");
    let coldkey: AccountId32 = retry_transient(RETRY_ATTEMPTS, || async {
        Ok(at.storage().fetch(&owner_addr, (hotkey,)).await?)
    })
    .await
    .with_context(|| format!("Owner(hotkey={hotkey})"))?
    .decode()?;

    if coldkey == ZERO_ACCOUNT {
        return Ok(None);
    }

    Ok(Some(OwnershipRow {
        netuid: netuid as i32,
        owner_hotkey: hotkey.to_string(),
        owner_coldkey: coldkey.to_string(),
    }))
}

/// Upserts every resolved row (always -- `captured_at` bumps every tick
/// regardless of whether the owner changed, same freshness-signal contract
/// as before this table grew a history sibling), appends a
/// `subnet_ownership_history` row only for netuids whose owner actually
/// changed (`owner_changed`, checked against `previous`), then prunes rows
/// for netuids no longer in this tick's active/resolved set (deregistered
/// subnets, or ones whose owner hotkey/coldkey resolved to the zero
/// account) -- upsert-before-prune so an active subnet is never even
/// transiently missing from the table.
async fn upsert(
    pg: &tokio_postgres::Client,
    rows: &[OwnershipRow],
    captured_at: i64,
    previous: &HashMap<i32, (String, String)>,
) -> Result<u64> {
    let mut written = 0u64;
    for row in rows {
        pg.execute(
            "INSERT INTO subnet_ownership (netuid, owner_hotkey, owner_coldkey, captured_at)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (netuid) DO UPDATE SET
               owner_hotkey = EXCLUDED.owner_hotkey,
               owner_coldkey = EXCLUDED.owner_coldkey,
               captured_at = EXCLUDED.captured_at",
            &[
                &row.netuid,
                &row.owner_hotkey,
                &row.owner_coldkey,
                &captured_at,
            ],
        )
        .await
        .with_context(|| format!("upsert netuid={}", row.netuid))?;
        written += 1;

        if owner_changed(
            previous.get(&row.netuid),
            &row.owner_hotkey,
            &row.owner_coldkey,
        ) {
            pg.execute(
                "INSERT INTO subnet_ownership_history (netuid, owner_hotkey, owner_coldkey, captured_at)
                 VALUES ($1, $2, $3, $4)",
                &[
                    &row.netuid,
                    &row.owner_hotkey,
                    &row.owner_coldkey,
                    &captured_at,
                ],
            )
            .await
            .with_context(|| format!("insert subnet_ownership_history netuid={}", row.netuid))?;
            eprintln!(
                "subnet-ownership: netuid={} owner changed, recorded in history",
                row.netuid
            );
        }
    }

    let active: Vec<i32> = rows.iter().map(|r| r.netuid).collect();
    let pruned = pg
        .execute(
            "DELETE FROM subnet_ownership WHERE netuid <> ALL($1)",
            &[&active],
        )
        .await
        .context("prune deregistered subnet_ownership rows")?;
    if pruned > 0 {
        eprintln!("subnet-ownership: pruned {pruned} stale row(s)");
    }

    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_account_is_the_all_zero_bytes() {
        assert_eq!(ZERO_ACCOUNT.0, [0u8; 32]);
    }

    #[test]
    fn owner_changed_is_true_on_first_observation() {
        assert!(owner_changed(None, "hot", "cold"));
    }

    #[test]
    fn owner_changed_is_false_when_both_keys_match() {
        let previous = ("hot".to_string(), "cold".to_string());
        assert!(!owner_changed(Some(&previous), "hot", "cold"));
    }

    #[test]
    fn owner_changed_is_true_when_hotkey_differs() {
        let previous = ("old-hot".to_string(), "cold".to_string());
        assert!(owner_changed(Some(&previous), "new-hot", "cold"));
    }

    #[test]
    fn owner_changed_is_true_when_coldkey_differs() {
        let previous = ("hot".to_string(), "old-cold".to_string());
        assert!(owner_changed(Some(&previous), "hot", "new-cold"));
    }
}
