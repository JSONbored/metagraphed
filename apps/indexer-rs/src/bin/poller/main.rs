// poller -- consolidated chain-state polling service (metagraphed-infra#136/
// #137). A SIBLING binary to ../main.rs (backfill-rs's historical backfill +
// live-follow, INDEX_MODE=live) in this SAME crate/monorepo location
// (apps/indexer-rs/) -- its own process, its own systemd unit, so a slow or
// misbehaving poll job can never affect the live-follow hot path. Shares the
// subxt#2050-mitigated ChainClient + connect_pg with ../main.rs via
// src/lib.rs rather than forking that connection logic.
//
// Replaces the growing pile of one-off Python systemd jobs under
// roles/data-refresh-cron (metagraph, account-identity, subnet-hyperparams,
// validator-nominators, self-stake, account-balances) with one binary, one
// systemd unit, and an internal async scheduler -- each job runs on its own
// independent tokio interval via run_job_loop() below, which provides
// shared logging + treats a job that mostly failed to scan (mirrors
// scripts/fetch-account-balances.py's MAX_ERROR_RATE convention) as a
// failed tick rather than a partial write.
//
// `subnet-ownership` (jobs::subnet_ownership) is the first job, per
// metagraphed-infra#138 -- closes the JSONbored/metagraphed#6644 gap (no
// clean provider<->owner mapping existed anywhere). Future jobs
// (metagraph/account-identity/subnet-hyperparams/validator-nominators/
// self-stake/account-balances, metagraphed-infra#139-141) each become a
// small config/decode delta added to the `jobs` module + one more line in
// main(), not a whole new script+Dockerfile+systemd-pair.
//
// Env:
//   DATABASE_URL                postgres connection (the same sink ../main.rs writes)
//   EVENTS_RPC_URL               chain RPC ws(s) url (default: the public archive)
//   SUBNET_OWNERSHIP_POLL_SECS   how often to re-poll subnet ownership (default 300)

mod jobs;

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use backfill_rs::{connect_pg, redact_rpc_url, ChainClient};

/// What a single job tick reports back to run_job_loop -- lets the scheduler
/// apply one shared logging convention across every job instead of each job
/// reimplementing it. A job that decides its own error rate was too high to
/// trust (mirrors scripts/fetch-account-balances.py's MAX_ERROR_RATE) should
/// return `Err`, not a low `written` count -- see jobs::subnet_ownership::run.
pub struct JobOutcome {
    pub scanned: u64,
    pub written: u64,
    pub errors: u64,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let rpc_url = std::env::var("EVENTS_RPC_URL")
        .unwrap_or_else(|_| "wss://archive.chain.opentensor.ai:443".to_string());
    eprintln!("poller: connecting to {}", redact_rpc_url(&rpc_url));
    let chain = Arc::new(ChainClient::connect(rpc_url).await?);
    eprintln!("poller: chain connection ready");

    let db_url = std::env::var("DATABASE_URL").context("DATABASE_URL required")?;
    let pg = Arc::new(connect_pg(&db_url).await?);
    eprintln!("poller: postgres connection ready, starting jobs");

    let subnet_ownership_interval =
        Duration::from_secs(env_u64("SUBNET_OWNERSHIP_POLL_SECS").unwrap_or(300));

    let subnet_ownership = {
        let chain = chain.clone();
        let pg = pg.clone();
        tokio::spawn(async move {
            run_job_loop(
                "subnet-ownership",
                subnet_ownership_interval,
                chain,
                pg,
                jobs::subnet_ownership::run,
            )
            .await;
        })
    };

    // Each job loop above runs forever (see run_job_loop) -- if one panics,
    // that's a real bug and should take the process down (systemd's
    // restart_policy: unless-stopped brings it back), rather than silently
    // leaving a job dead while the process looks alive.
    subnet_ownership
        .await
        .context("subnet-ownership job task panicked")?;
    Ok(())
}

fn env_u64(k: &str) -> Option<u64> {
    std::env::var(k).ok().and_then(|v| v.parse().ok())
}

/// Runs `job` on a fixed interval forever, applying one shared logging
/// policy: scan/write/error counts on success, failure reason (including a
/// job's own "error rate too high, refusing to write" Err) on failure. A
/// single bad tick never brings down the process or other jobs -- this loop
/// always continues to the next tick.
async fn run_job_loop<F, Fut>(
    name: &'static str,
    interval: Duration,
    chain: Arc<ChainClient>,
    pg: Arc<tokio_postgres::Client>,
    job: F,
) where
    F: Fn(Arc<ChainClient>, Arc<tokio_postgres::Client>) -> Fut,
    Fut: Future<Output = Result<JobOutcome>>,
{
    let mut ticker = tokio::time::interval(interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        ticker.tick().await;
        let t0 = std::time::Instant::now();
        match job(chain.clone(), pg.clone()).await {
            Ok(outcome) => {
                eprintln!(
                    "{name}: ok -- {} scanned, {} written, {} error(s) ({:?} elapsed)",
                    outcome.scanned,
                    outcome.written,
                    outcome.errors,
                    t0.elapsed()
                );
            }
            Err(e) => {
                eprintln!(
                    "{name}: tick failed ({e:#}) -- retrying in {interval:?} ({:?} elapsed)",
                    t0.elapsed()
                );
            }
        }
    }
}
