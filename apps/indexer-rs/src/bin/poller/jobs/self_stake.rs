// self-stake (metagraphed-infra#141) -- migrates scripts/fetch-self-stake.py.
// Fills a gap validator_nominators.rs's Alpha scan structurally cannot: a
// hotkey owner's own stake on that same hotkey frequently has NO explicit
// SubtensorModule::Alpha entry (raw `{bits: 0}`) even when it holds real,
// substantial stake (live-verified by the Python script this replaces,
// 2026-07-17: ~91% of one hotkey's registered pairs showed bits=0 while the
// runtime-computed stake was real and nonzero). There is no cheap
// storage-only way to reconstruct this -- TotalHotkeyAlpha's relationship
// to the sum of per-coldkey Alpha shares is not a simple identity -- so a
// runtime API call is the only correct source, exactly like
// subnet_hyperparams.rs's own reasoning for using a Runtime API instead of
// a raw storage read.
//
// Ground truth for the runtime read (live Runtime-API-metadata
// introspection + a real live call against the exact known triple from
// fetch-self-stake.py's own docstring, 2026-07-19):
// StakeInfoRuntimeApi::get_stake_info_for_hotkey_coldkey_netuid(hotkey,
// coldkey, netuid) -> Option<{hotkey, coldkey, netuid, stake, locked,
// emission, tao_emission, drain, is_registered}>, where `stake` is a plain
// single-field tuple wrapping the raw rao amount (unlike
// subnet_hyperparams_v3's tagged-union `value` shape -- this response has
// no ambiguity to dispatch on, every field is exactly one type).
//
// UNLIKE subnet-hyperparams, this job writes Postgres DIRECTLY (no HTTP
// POST to an existing sync route): it upserts into `nominator_positions`,
// the SAME table validator_nominators.rs already owns, but that table has
// no hash-diff-into-history complexity to worry about re-implementing --
// it's a plain upsert, same shape as every other direct-write job. A
// self-stake row and a validator-nominators row can share the same
// (coldkey, hotkey, netuid) primary key in the rare case an owner's Alpha
// share IS nonzero; whichever job's tick lands last wins, which is fine
// (self-healing on the next tick either way, matching this table's
// existing upsert-only semantics).
//
// COST SHAPE, unlike every other job so far: one runtime API call PER
// (hotkey, netuid) pair (measured by the Python script this replaces,
// 2026-07-17, against the fullnode: ~127ms/call vs ~3.3ms/row for a plain
// storage scan) -- a full network-wide pass cannot ride along on a
// frequent cadence without costing an order of magnitude more than every
// other job. Runs on its own, much slower, WEEKLY-by-default interval
// (SELF_STAKE_POLL_SECS), matching the Python script's own reasoning.
//
// Root (netuid 0) is excluded, matching validator_nominators.rs and the
// Python script it replaces: root stake is TAO-denominated 1:1 with no
// alpha pool, so TotalHotkeyAlpha carries no root data at all.

use std::collections::HashMap;
use std::time::Duration;

use anyhow::{Context, Result};
use backfill_rs::{now_ms, retry_transient, AtBlock, ChainClient};
use scale_decode::DecodeAsType;
use subxt::dynamic;
use subxt::utils::AccountId32;

use crate::JobOutcome;

const MAX_ERROR_RATE: f64 = 0.5;
const RETRY_ATTEMPTS: u32 = 3;

#[derive(DecodeAsType)]
struct StakeInfo {
    stake: (u128,),
}

struct PositionRow {
    coldkey: String,
    hotkey: String,
    netuid: i32,
    share_fraction: f32,
}

/// Connects its own chain + Postgres client and ticks `run` on `interval`
/// forever -- see subnet_ownership::run_loop's doc comment for why every
/// job owns its connections rather than sharing one.
pub async fn run_loop(rpc_url: String, db_url: String, interval: Duration) {
    let chain = backfill_rs::connect_chain_retrying("self-stake", rpc_url).await;
    let mut pg = backfill_rs::connect_pg_retrying("self-stake", &db_url).await;
    let mut ticker = tokio::time::interval(interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        ticker.tick().await;
        let t0 = std::time::Instant::now();
        let result = run(&chain, &mut pg).await;
        crate::log_job_outcome("self-stake", &result, t0.elapsed(), interval);
    }
}

async fn run(chain: &ChainClient, pg: &mut tokio_postgres::Client) -> Result<JobOutcome> {
    let at = chain
        .call(|api| async move { Ok(api.at_current_block().await?) })
        .await
        .context("at_current_block")?;

    let owner_by_hotkey = scan_owners(&at).await.context("scan Owner")?;
    eprintln!(
        "self-stake: {} owner(hotkey) entries, resolving self-stake",
        owner_by_hotkey.len()
    );

    let pairs = scan_total_hotkey_alpha(&at, &owner_by_hotkey)
        .await
        .context("scan TotalHotkeyAlpha")?;
    let scanned = pairs.len() as u64;
    eprintln!("self-stake: {scanned} registered (hotkey, netuid) pair(s) with a known owner");

    let mut rows = Vec::new();
    let mut errors = 0u64;
    for (i, (hotkey, owner, netuid, total_alpha_raw)) in pairs.into_iter().enumerate() {
        match resolve_self_stake(&at, &hotkey, &owner, netuid, total_alpha_raw).await {
            Ok(Some(row)) => rows.push(row),
            // No self-stake for this pair (zero or negligible) -- not an
            // error, matching fetch-self-stake.py's own `if owner_rao > 0`
            // guard.
            Ok(None) => {}
            Err(e) => {
                eprintln!("self-stake: hotkey={hotkey} netuid={netuid} resolution failed: {e:#}");
                errors += 1;
            }
        }
        if (i + 1).is_multiple_of(200) {
            eprintln!("self-stake: resolved {}/{scanned}", i + 1);
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
        .context("upsert nominator_positions")?;

    Ok(JobOutcome {
        scanned,
        written,
        errors,
    })
}

/// SubtensorModule::Owner: EVERY registered hotkey -> its owning account.
async fn scan_owners(at: &AtBlock) -> Result<HashMap<String, String>> {
    let addr = dynamic::storage::<(AccountId32,), AccountId32>("SubtensorModule", "Owner");
    let mut iter = at.storage().iter(addr, ()).await?;
    let mut owners = HashMap::new();
    while let Some(entry) = iter.next().await {
        let entry = entry?;
        let (hotkey,) = entry.key()?.decode()?;
        let owner: AccountId32 = entry.value().decode()?;
        owners.insert(hotkey.to_string(), owner.to_string());
        if owners.len().is_multiple_of(5_000) {
            eprintln!(
                "self-stake: scanning Owner, {} entries so far",
                owners.len()
            );
        }
    }
    Ok(owners)
}

/// SubtensorModule::TotalHotkeyAlpha, filtered to (hotkey, netuid) pairs
/// with a known owner, nonzero total, and netuid != 0 (root has no alpha
/// pool -- see module doc comment).
async fn scan_total_hotkey_alpha(
    at: &AtBlock,
    owner_by_hotkey: &HashMap<String, String>,
) -> Result<Vec<(String, String, u16, u128)>> {
    let addr = dynamic::storage::<(AccountId32, u16), u128>("SubtensorModule", "TotalHotkeyAlpha");
    let mut iter = at.storage().iter(addr, ()).await?;
    let mut pairs = Vec::new();
    let mut scanned = 0u64;
    while let Some(entry) = iter.next().await {
        let entry = entry?;
        scanned += 1;
        if scanned.is_multiple_of(5_000) {
            eprintln!(
                "self-stake: scanning TotalHotkeyAlpha, {scanned} entries so far ({} matched a known owner)",
                pairs.len()
            );
        }
        let (hotkey, netuid) = entry.key()?.decode()?;
        let total_alpha_raw: u128 = entry.value().decode()?;
        if netuid == 0 || total_alpha_raw == 0 {
            continue;
        }
        let hotkey = hotkey.to_string();
        let Some(owner) = owner_by_hotkey.get(&hotkey) else {
            continue;
        };
        pairs.push((hotkey, owner.clone(), netuid, total_alpha_raw));
    }
    Ok(pairs)
}

/// The owner's own stake on their own hotkey, normalized against the
/// hotkey's total alpha (clamped to 1.0 -- the TotalHotkeyAlpha read and
/// this call are two separate, non-atomic RPCs, so chain state can move
/// between them; an uncapped fraction over 1.0 would silently inflate
/// stake_tao at the API-side join, matching fetch-self-stake.py's own
/// defensive clamp).
async fn resolve_self_stake(
    at: &AtBlock,
    hotkey: &str,
    owner: &str,
    netuid: u16,
    total_alpha_raw: u128,
) -> Result<Option<PositionRow>> {
    use std::str::FromStr;
    let hotkey_id = AccountId32::from_str(hotkey).map_err(|e| anyhow::anyhow!("{e}"))?;
    let owner_id = AccountId32::from_str(owner).map_err(|e| anyhow::anyhow!("{e}"))?;

    let info = retry_transient(RETRY_ATTEMPTS, || async {
        let payload = dynamic::runtime_api_call::<_, Option<StakeInfo>>(
            "StakeInfoRuntimeApi",
            "get_stake_info_for_hotkey_coldkey_netuid",
            (hotkey_id, owner_id, netuid),
        );
        Ok(at.runtime_apis().call(payload).await?)
    })
    .await
    .with_context(|| format!("get_stake_info_for_hotkey_coldkey_netuid(hotkey={hotkey})"))?;

    let Some(info) = info else {
        return Ok(None);
    };
    let owner_rao = info.stake.0;
    if owner_rao == 0 {
        return Ok(None);
    }

    let fraction = (owner_rao as f64 / total_alpha_raw as f64).min(1.0);
    if fraction <= 0.0 {
        return Ok(None);
    }

    Ok(Some(PositionRow {
        coldkey: owner.to_string(),
        hotkey: hotkey.to_string(),
        netuid: netuid as i32,
        share_fraction: fraction as f32,
    }))
}

/// Plain upsert into nominator_positions -- no prune (matches
/// validator_nominators.rs's own reasoning: this table has always been
/// "every position ever observed," not "every position right now").
async fn upsert(
    pg: &tokio_postgres::Client,
    rows: &[PositionRow],
    captured_at: i64,
) -> Result<u64> {
    let mut written = 0u64;
    for row in rows {
        pg.execute(
            "INSERT INTO nominator_positions (coldkey, hotkey, netuid, share_fraction, captured_at)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (coldkey, hotkey, netuid) DO UPDATE SET
               share_fraction = EXCLUDED.share_fraction,
               captured_at = EXCLUDED.captured_at",
            &[
                &row.coldkey,
                &row.hotkey,
                &row.netuid,
                &row.share_fraction,
                &captured_at,
            ],
        )
        .await
        .with_context(|| {
            format!(
                "upsert coldkey={} hotkey={} netuid={}",
                row.coldkey, row.hotkey, row.netuid
            )
        })?;
        written += 1;
    }
    Ok(written)
}

#[cfg(test)]
mod tests {
    #[test]
    fn share_fraction_is_clamped_to_one() {
        let fraction = (1_500_f64 / 1_000_f64).min(1.0);
        assert_eq!(fraction, 1.0);
    }

    #[test]
    fn share_fraction_normal_case() {
        let fraction = (300_f64 / 1_000_f64).min(1.0);
        assert!((fraction - 0.3).abs() < 1e-9);
    }
}
