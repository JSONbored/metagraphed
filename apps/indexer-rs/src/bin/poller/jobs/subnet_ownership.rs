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
    let chain = match ChainClient::connect(rpc_url).await {
        Ok(c) => c,
        Err(e) => {
            eprintln!("subnet-ownership: chain connect failed, job will not run: {e:#}");
            return;
        }
    };
    let mut pg = match backfill_rs::connect_pg(&db_url).await {
        Ok(c) => c,
        Err(e) => {
            eprintln!("subnet-ownership: postgres connect failed, job will not run: {e:#}");
            return;
        }
    };
    let mut ticker = tokio::time::interval(interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        ticker.tick().await;
        let t0 = std::time::Instant::now();
        let result = run(&chain, &mut pg).await;
        crate::log_job_outcome("subnet-ownership", &result, t0.elapsed(), interval);
    }
}

async fn run(chain: &ChainClient, pg: &mut tokio_postgres::Client) -> Result<JobOutcome> {
    let at = chain
        .call(|api| async move { Ok(api.at_current_block().await?) })
        .await
        .context("at_current_block")?;

    let netuids = discover_netuids(&at).await.context("discover netuids")?;
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
    let written = upsert(pg, &rows, captured_at)
        .await
        .context("upsert subnet_ownership")?;

    Ok(JobOutcome {
        scanned,
        written,
        errors,
    })
}

/// Every currently-registered netuid, per SubtensorModule::NetworksAdded
/// (the runtime's own subnet-existence flag) -- not a hardcoded upper bound,
/// so newly-registered/deregistered subnets need no code change here.
async fn discover_netuids(at: &AtBlock) -> Result<Vec<u16>> {
    let addr = dynamic::storage::<(u16,), bool>("SubtensorModule", "NetworksAdded");
    let mut iter = at.storage().iter(addr, ()).await?;
    let mut netuids = Vec::new();
    while let Some(entry) = iter.next().await {
        let (netuid,) = entry?.key()?.decode()?;
        netuids.push(netuid);
    }
    netuids.sort_unstable();
    Ok(netuids)
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

/// Upserts every resolved row, then prunes rows for netuids no longer in
/// this tick's active/resolved set (deregistered subnets, or ones whose
/// owner hotkey/coldkey resolved to the zero account) -- upsert-before-prune
/// so an active subnet is never even transiently missing from the table.
async fn upsert(
    pg: &tokio_postgres::Client,
    rows: &[OwnershipRow],
    captured_at: i64,
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
}
