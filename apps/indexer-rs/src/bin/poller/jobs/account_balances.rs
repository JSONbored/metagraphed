// account-balances (metagraphed-infra#139) -- the second job migrated into
// the poller, replacing scripts/fetch-account-balances.py's systemd
// timer + `POST /api/v1/internal/account-balances-sync` HTTP round-trip
// (metagraphed#6742) with a direct chain-to-Postgres write. Reads
// System::Account directly via a raw storage-map scan for the exact same
// reason the Python script does (its own header comment, reproduced here):
// a direct state read is ground-truth by construction (whatever the chain
// has stored right now), whereas reconstructing free/reserved from
// transfer/stake/fee event-replay requires catching every possible
// mutation path with zero misses.
//
// Covers EVERY account that has ever held a balance on-chain -- System is
// the ground truth for existence itself, not just registered neurons or
// addresses already seen in account_events.
//
// SCALE (measured by the Python script this replaces, 2026-07-19, against
// our own fullnode): 542,618 total System::Account entries. Unlike
// subnet-ownership's ~129-row "gather everything in memory, then write
// once" shape, that's too large to buffer wholesale and still call this a
// periodic poll -- this job streams System::Account page by page and COPYs
// each CHUNK to Postgres as its own transaction (same COPY-to-staging +
// upsert shape as ../../main.rs's own `flush()`, at indexer scale) rather
// than accumulating one giant Vec. The tradeoff: a systemic failure (e.g. a
// metadata mismatch after a runtime upgrade) is caught by the same
// MAX_ERROR_RATE circuit breaker as subnet-ownership and stops the scan
// immediately, but chunks already committed before that point stay
// committed -- there is no whole-scan atomicity the way a "buffer
// everything, write once" design would give. In practice this bounds the
// blast radius to at most one CHUNK_SIZE of rows: a genuine systemic
// decode failure fails from the very first entries, not sporadically
// partway through a 542k-row stream.
//
// No prune step, matching handleAccountBalancesSync's own upsert-only
// semantics (workers/data-api.mjs) exactly: an account whose balance drops
// to zero is skipped (not written), same as the Python script -- it goes
// stale in the table rather than being deleted. This table has always been
// "every account that has EVER held a balance," not "every account with a
// balance right now."

use std::time::Duration;

use anyhow::{Context, Result};
use backfill_rs::{now_ms, rao_to_tao_exact, ChainClient};
use scale_decode::DecodeAsType;
use subxt::dynamic;
use subxt::utils::AccountId32;

use crate::JobOutcome;

// Mirrors scripts/fetch-account-balances.py's own MAX_ERROR_RATE exactly
// (same constant, same reasoning): above this fraction of scanned entries
// erroring out, treat the run as systemically broken rather than
// continuing to publish an increasingly-unreliable partial scan.
const MAX_ERROR_RATE: f64 = 0.5;

// Rows buffered before each COPY-to-staging + upsert transaction. Chosen to
// bound per-chunk memory (a BalanceRow is two short strings + an i64) while
// keeping the number of round-trip transactions for a full ~540k-row scan
// reasonable (~110 chunks at this size).
const CHUNK_SIZE: usize = 5_000;

/// AccountInfo.data's two balance fields -- the only ones this job needs.
/// Mirrors the dynamic-decode pattern subxt's own docs use for exactly this
/// storage item (`examples/dynamic.rs`'s System.Account section): ignoring
/// every other AccountInfo field (nonce, consumers, frozen, flags) is fine,
/// DecodeAsType only requires the fields you name.
#[derive(DecodeAsType)]
struct AccountInfo {
    data: AccountInfoData,
}

#[derive(DecodeAsType)]
struct AccountInfoData {
    free: u128,
    reserved: u128,
}

struct BalanceRow {
    ss58: String,
    free_tao: String,
    reserved_tao: String,
}

/// Connects its own chain + Postgres client and ticks `run` on `interval`
/// forever -- see subnet_ownership::run_loop's doc comment for why every
/// job owns its connections rather than sharing one.
pub async fn run_loop(rpc_url: String, db_url: String, interval: Duration) {
    let chain = backfill_rs::connect_chain_retrying("account-balances", rpc_url).await;
    let mut pg = backfill_rs::connect_pg_retrying("account-balances", &db_url).await;
    let mut ticker = tokio::time::interval(interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        ticker.tick().await;
        let t0 = std::time::Instant::now();
        let result = run(&chain, &mut pg).await;
        crate::log_job_outcome("account-balances", &result, t0.elapsed(), interval);
    }
}

async fn run(chain: &ChainClient, pg: &mut tokio_postgres::Client) -> Result<JobOutcome> {
    let at = chain
        .call(|api| async move { Ok(api.at_current_block().await?) })
        .await
        .context("at_current_block")?;

    let addr = dynamic::storage::<(AccountId32,), AccountInfo>("System", "Account");
    let mut iter = at
        .storage()
        .iter(addr, ())
        .await
        .context("System::Account iter")?;

    let captured_at = now_ms();
    let mut chunk = Vec::with_capacity(CHUNK_SIZE);
    let mut scanned = 0u64;
    let mut written = 0u64;
    let mut errors = 0u64;

    loop {
        let Some(entry) = iter.next().await else {
            break;
        };
        scanned += 1;

        let decoded = (|| -> Result<Option<BalanceRow>> {
            let entry = entry?;
            let (account,) = entry.key()?.decode()?;
            let info: AccountInfo = entry.value().decode()?;
            if info.data.free == 0 && info.data.reserved == 0 {
                // Existential-deposit-only/reaped accounts carry a real
                // System::Account entry with zero free and zero reserved --
                // skip rather than write a meaningless all-zero row (matches
                // fetch-account-balances.py exactly).
                return Ok(None);
            }
            Ok(Some(BalanceRow {
                ss58: account.to_string(),
                free_tao: rao_to_tao_exact(info.data.free),
                reserved_tao: rao_to_tao_exact(info.data.reserved),
            }))
        })();

        match decoded {
            Ok(None) => {}
            Ok(Some(row)) => chunk.push(row),
            Err(e) => {
                errors += 1;
                if scanned <= 20 || errors.is_multiple_of(1000) {
                    eprintln!("account-balances: entry #{scanned} decode failed: {e:#}");
                }
            }
        }

        let error_rate = errors as f64 / scanned as f64;
        if error_rate > MAX_ERROR_RATE {
            anyhow::bail!(
                "error rate {errors}/{scanned} ({:.0}%) exceeds {:.0}% -- aborting scan \
                 ({written} row(s) already committed in earlier chunks stay committed)",
                error_rate * 100.0,
                MAX_ERROR_RATE * 100.0
            );
        }

        if chunk.len() >= CHUNK_SIZE {
            written += upsert_chunk(pg, &chunk, captured_at).await?;
            eprintln!("account-balances: {scanned} scanned, {written} written so far");
            chunk.clear();
        }
    }

    if !chunk.is_empty() {
        written += upsert_chunk(pg, &chunk, captured_at).await?;
    }

    Ok(JobOutcome {
        scanned,
        written,
        errors,
    })
}

/// COPY-to-staging + upsert, matching ../../main.rs's `flush()` shape at
/// indexer scale: a plain `INSERT ... ON CONFLICT` per row would be far
/// slower for chunk-sized batches than one COPY + one merge statement.
/// `WHERE account_balances.captured_at <= EXCLUDED.captured_at` matches
/// handleAccountBalancesSync's own guard (workers/data-api.mjs) -- a
/// slower/retried tick can never overwrite a newer captured_at with a
/// stale one.
async fn upsert_chunk(
    pg: &mut tokio_postgres::Client,
    rows: &[BalanceRow],
    captured_at: i64,
) -> Result<u64> {
    let tx = pg.transaction().await?;
    tx.batch_execute(
        "CREATE TEMP TABLE s_account_balances (LIKE account_balances) ON COMMIT DROP;",
    )
    .await?;

    {
        let sink = tx
            .copy_in(
                "COPY s_account_balances (ss58, free_tao, reserved_tao, captured_at) FROM STDIN",
            )
            .await?;
        let mut buf = String::new();
        for r in rows {
            buf.push_str(&format!(
                "{}\t{}\t{}\t{}\n",
                copy_escape(&r.ss58),
                r.free_tao,
                r.reserved_tao,
                captured_at
            ));
        }
        copy_send(sink, buf).await?;
    }

    let written = tx
        .execute(
            "INSERT INTO account_balances (ss58, free_tao, reserved_tao, captured_at)
             SELECT ss58, free_tao, reserved_tao, captured_at FROM s_account_balances
             ON CONFLICT (ss58) DO UPDATE SET
               free_tao = EXCLUDED.free_tao,
               reserved_tao = EXCLUDED.reserved_tao,
               captured_at = EXCLUDED.captured_at
             WHERE account_balances.captured_at <= EXCLUDED.captured_at",
            &[],
        )
        .await
        .context("upsert account_balances chunk")?;

    tx.commit().await?;
    Ok(written as u64)
}

/// Tab/newline/backslash-escapes a value for Postgres COPY text format.
/// ss58 addresses never legitimately contain these bytes, but escaping
/// defensively costs nothing and matches ../../main.rs's own `copy_escape`.
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
    fn copy_escape_handles_tabs_and_newlines() {
        assert_eq!(copy_escape("a\tb\nc"), "a\\tb\\nc");
    }

    #[test]
    fn copy_escape_leaves_plain_ss58_untouched() {
        let ss58 = "5C4hrfjw9DjXZTzV3MwzrrAr9P1MJhSrvWGWqi1eSuyUpnhM";
        assert_eq!(copy_escape(ss58), ss58);
    }
}
