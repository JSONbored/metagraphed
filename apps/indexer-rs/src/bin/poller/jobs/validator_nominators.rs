// validator-nominators (metagraphed-infra#139) -- migrates
// scripts/fetch-validator-nominator-counts.py's Alpha full scan, replacing
// its systemd timer + two HTTP sync routes
// (POST /api/v1/internal/validator-nominator-counts-sync,
// POST /api/v1/internal/nominator-positions-sync) with a direct
// chain-to-Postgres write. One scan answers two questions (this script's
// own doc comment, reproduced here): SubtensorModule::Alpha is a triple-key
// (hotkey, coldkey, netuid) -> shares map with no cheaper way to query "just
// this hotkey's nominators" or "just this account's positions" in bulk, and
// no network-wide aggregate RPC exists for either -- a single full scan is
// the only correct approach, so BOTH outputs are derived from that one pass
// rather than scanning twice.
//
// SCALE (measured by the Python script this replaces, 2026-07-14, against
// our own fullnode): 762,577 total Alpha rows, ~3,100 rows/sec sustained,
// 112,552 distinct hotkeys, max single-hotkey nominator count 7,266.
//
// UNLIKE account_balances.rs's streaming-chunk design, this job buffers the
// WHOLE scan in memory before writing anything: `share_fraction` (this
// account's shares / ALL delegators' shares for that hotkey+netuid) can't be
// computed for a row until every OTHER row sharing its (hotkey, netuid) has
// also been seen, so there is no way to stream-commit a chunk independently
// -- the group total is only known once the scan is complete. This mirrors
// the Python script's own shape exactly (accumulate two in-memory maps,
// derive both outputs, write once at the end).
//
// Units (#5233, carried over unchanged from the Python script this
// replaces): Alpha's stored value is a fixed-point U64F64 SHARE count (a
// `{bits: u64}` struct; true value is bits / 2**64), NOT a TAO/alpha
// amount -- these are pool-internal accounting shares, normalized here into
// a dimensionless share_fraction per (hotkey, coldkey, netuid) row. The
// API-side join (src/account-nominator-positions.mjs) multiplies that
// fraction by the already-ingested neurons.stake_tao at serve time.
//
// Root (netuid 0) is NOT covered: every Alpha entry at netuid 0 is always
// bits=0 (root stake is TAO-denominated 1:1 with no alpha pool, #2550) --
// skip rather than store a permanently-zero, useless ledger entry, same as
// the Python script.
//
// No prune step for either output table, matching
// handleValidatorNominatorCountsSync / handleNominatorPositionsSync's own
// upsert-only semantics (workers/data-api.mjs) exactly.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use anyhow::{Context, Result};
use backfill_rs::{now_ms, ChainClient};
use scale_decode::DecodeAsType;
use subxt::dynamic;
use subxt::utils::AccountId32;

use crate::JobOutcome;

// Mirrors scripts/fetch-account-balances.py's MAX_ERROR_RATE convention
// (same threshold, same reasoning), applied here to Alpha entries.
const MAX_ERROR_RATE: f64 = 0.5;

/// Alpha's stored value: a U64F64 fixed-point share count. "U64F64" is a
/// 64-integer-bit + 64-fractional-bit format -- 128 bits total, so `bits`
/// itself is a u128, NOT a u64 (live-verified 2026-07-19: decoding as u64
/// failed outright with NumberOutOfRange on real values like
/// 1844674407370955161600000000, which doesn't fit in 64 bits at all).
/// True value is `bits as f64 / 2f64.powi(64)`, but this job only ever
/// needs ratios of two `bits` values (share_fraction), so the raw integer
/// is kept as-is and never converted to a float until the final division.
#[derive(DecodeAsType)]
struct Shares {
    bits: u128,
}

struct NominatorPositionRow {
    coldkey: String,
    hotkey: String,
    netuid: i32,
    share_fraction: f32,
}

/// Connects its own chain + Postgres client and ticks `run` on `interval`
/// forever -- see subnet_ownership::run_loop's doc comment for why every
/// job owns its connections rather than sharing one.
pub async fn run_loop(rpc_url: String, db_url: String, interval: Duration) {
    let chain = backfill_rs::connect_chain_retrying("validator-nominators", rpc_url).await;
    let mut pg = backfill_rs::connect_pg_retrying("validator-nominators", &db_url).await;
    let mut ticker = tokio::time::interval(interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        ticker.tick().await;
        let t0 = std::time::Instant::now();
        let result = run(&chain, &mut pg).await;
        if result.is_err() {
            // See subnet_ownership::run_loop's own comment on this exact
            // pattern -- a dead single-lifetime connection (e.g. after a
            // Postgres restart) fails every query forever with no
            // self-healing otherwise.
            pg = backfill_rs::connect_pg_retrying("validator-nominators", &db_url).await;
        }
        crate::log_job_outcome("validator-nominators", &result, t0.elapsed(), interval);
    }
}

async fn run(chain: &ChainClient, pg: &mut tokio_postgres::Client) -> Result<JobOutcome> {
    let at = chain
        .call(|api| async move { Ok(api.at_current_block().await?) })
        .await
        .context("at_current_block")?;

    let addr =
        dynamic::storage::<(AccountId32, AccountId32, u16), Shares>("SubtensorModule", "Alpha");
    let mut iter = at
        .storage()
        .iter(addr, ())
        .await
        .context("SubtensorModule::Alpha iter")?;

    // hotkey -> distinct coldkeys holding any stake on it (every Alpha
    // entry counts, including netuid 0 and zero-share rows -- matches the
    // Python script's own `nominators.setdefault(hotkey, set()).add(coldkey)`
    // unconditional accumulation).
    let mut nominators: HashMap<String, HashSet<String>> = HashMap::new();
    // (hotkey, netuid) -> {coldkey: shares_bits} -- only netuid != 0 and
    // shares > 0 (root is never share-tracked; a zero-share entry has
    // nothing to normalize).
    let mut shares_by_hotkey_netuid: HashMap<(String, i32), HashMap<String, u128>> = HashMap::new();

    let mut scanned = 0u64;
    let mut errors = 0u64;

    loop {
        let Some(entry) = iter.next().await else {
            break;
        };
        scanned += 1;

        let decoded = (|| -> Result<()> {
            let entry = entry?;
            let (hotkey, coldkey, netuid) = entry.key()?.decode()?;
            let shares: Shares = entry.value().decode()?;

            let hotkey: String = AccountId32::to_string(&hotkey);
            let coldkey: String = AccountId32::to_string(&coldkey);

            nominators
                .entry(hotkey.clone())
                .or_default()
                .insert(coldkey.clone());

            if netuid != 0 && shares.bits > 0 {
                shares_by_hotkey_netuid
                    .entry((hotkey, netuid as i32))
                    .or_default()
                    .insert(coldkey, shares.bits);
            }
            Ok(())
        })();

        if let Err(e) = decoded {
            errors += 1;
            if scanned <= 20 || errors.is_multiple_of(1000) {
                eprintln!("validator-nominators: entry #{scanned} decode failed: {e:#}");
            }
        }

        let error_rate = errors as f64 / scanned as f64;
        if error_rate > MAX_ERROR_RATE {
            anyhow::bail!(
                "error rate {errors}/{scanned} ({:.0}%) exceeds {:.0}% -- aborting scan, nothing written",
                error_rate * 100.0,
                MAX_ERROR_RATE * 100.0
            );
        }

        if scanned.is_multiple_of(100_000) {
            eprintln!(
                "validator-nominators: {scanned} Alpha rows scanned, {} distinct hotkeys so far",
                nominators.len()
            );
        }
    }

    let captured_at = now_ms();

    let count_rows: Vec<(String, i32)> = nominators
        .iter()
        .map(|(hotkey, coldkeys)| (hotkey.clone(), coldkeys.len() as i32))
        .collect();

    let position_rows: Vec<NominatorPositionRow> = shares_by_hotkey_netuid
        .into_iter()
        .flat_map(|((hotkey, netuid), coldkey_shares)| {
            let total: u128 = coldkey_shares.values().sum();
            coldkey_shares
                .into_iter()
                .map(move |(coldkey, bits)| NominatorPositionRow {
                    coldkey,
                    hotkey: hotkey.clone(),
                    netuid,
                    share_fraction: (bits as f64 / total as f64) as f32,
                })
        })
        .collect();

    let written = upsert(pg, &count_rows, &position_rows, captured_at)
        .await
        .context("upsert validator_nominator_counts + nominator_positions")?;

    Ok(JobOutcome {
        scanned,
        written,
        errors,
    })
}

/// One transaction, two COPY-to-staging + upsert passes -- same shape as
/// ../../main.rs's own `flush()` for multiple related tables in one
/// atomic write.
async fn upsert(
    pg: &mut tokio_postgres::Client,
    count_rows: &[(String, i32)],
    position_rows: &[NominatorPositionRow],
    captured_at: i64,
) -> Result<u64> {
    let tx = pg.transaction().await?;
    tx.batch_execute(
        "CREATE TEMP TABLE s_validator_nominator_counts (LIKE validator_nominator_counts) ON COMMIT DROP;
         CREATE TEMP TABLE s_nominator_positions (LIKE nominator_positions) ON COMMIT DROP;",
    )
    .await?;

    {
        let sink = tx
            .copy_in("COPY s_validator_nominator_counts (hotkey, nominator_count, captured_at) FROM STDIN")
            .await?;
        let mut buf = String::new();
        for (hotkey, count) in count_rows {
            buf.push_str(&format!(
                "{}\t{count}\t{captured_at}\n",
                copy_escape(hotkey)
            ));
        }
        copy_send(sink, buf).await?;
    }

    {
        let sink = tx
            .copy_in("COPY s_nominator_positions (coldkey, hotkey, netuid, share_fraction, captured_at) FROM STDIN")
            .await?;
        let mut buf = String::new();
        for r in position_rows {
            buf.push_str(&format!(
                "{}\t{}\t{}\t{}\t{captured_at}\n",
                copy_escape(&r.coldkey),
                copy_escape(&r.hotkey),
                r.netuid,
                r.share_fraction,
            ));
        }
        copy_send(sink, buf).await?;
    }

    let counts_written = tx
        .execute(
            "INSERT INTO validator_nominator_counts (hotkey, nominator_count, captured_at)
             SELECT hotkey, nominator_count, captured_at FROM s_validator_nominator_counts
             ON CONFLICT (hotkey) DO UPDATE SET
               nominator_count = EXCLUDED.nominator_count,
               captured_at = EXCLUDED.captured_at",
            &[],
        )
        .await
        .context("upsert validator_nominator_counts")?;

    tx.execute(
        "INSERT INTO nominator_positions (coldkey, hotkey, netuid, share_fraction, captured_at)
         SELECT coldkey, hotkey, netuid, share_fraction, captured_at FROM s_nominator_positions
         ON CONFLICT (coldkey, hotkey, netuid) DO UPDATE SET
           share_fraction = EXCLUDED.share_fraction,
           captured_at = EXCLUDED.captured_at",
        &[],
    )
    .await
    .context("upsert nominator_positions")?;

    tx.commit().await?;
    Ok(counts_written as u64)
}

/// Tab/newline/backslash-escapes a value for Postgres COPY text format.
fn copy_escape(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('\t', "\\t")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
}

async fn copy_send(sink: tokio_postgres::CopyInSink<bytes::Bytes>, buf: String) -> Result<()> {
    use futures::SinkExt;
    let mut sink = std::pin::pin!(sink);
    sink.send(bytes::Bytes::from(buf)).await?;
    sink.close().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn share_fraction_normalizes_correctly_across_a_hotkey_netuid_group() {
        let mut coldkey_shares = HashMap::new();
        coldkey_shares.insert("alice".to_string(), 300u128);
        coldkey_shares.insert("bob".to_string(), 700u128);
        let total: u128 = coldkey_shares.values().sum();
        let alice_fraction = coldkey_shares["alice"] as f64 / total as f64;
        let bob_fraction = coldkey_shares["bob"] as f64 / total as f64;
        assert!((alice_fraction - 0.3).abs() < 1e-9);
        assert!((bob_fraction - 0.7).abs() < 1e-9);
        assert!((alice_fraction + bob_fraction - 1.0).abs() < 1e-9);
    }
}
