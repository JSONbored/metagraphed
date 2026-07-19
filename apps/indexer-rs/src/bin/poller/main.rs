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
// independent tokio interval, in its own `run_loop` (see jobs::subnet_ownership
// for the pattern every job follows), reporting through the shared
// `log_job_outcome` below so every job's ok/failed logging reads the same
// way. A job that decided its own error rate was too high to trust (mirrors
// scripts/fetch-account-balances.py's MAX_ERROR_RATE) should return `Err`
// from its `run`, not a low `written` count.
//
// Each job owns its OWN Postgres connection AND its OWN chain (ChainClient)
// connection -- connected once, kept for the life of the job's loop --
// rather than sharing either across jobs.
//
// Postgres: some jobs (account-balances) need a real transaction
// (`&mut Client`) for a COPY-to-staging + upsert bulk load, matching
// ../main.rs's own `flush()` pattern at indexer scale -- a `&mut` borrow
// can't be shared across concurrently-running job tasks.
//
// Chain: live-verified 2026-07-19 that sharing one ChainClient (one
// underlying WebSocket) across two concurrently-running jobs is a real
// problem, not just a theoretical one -- running subnet-ownership and
// account-balances together, subnet-ownership's own simple single-key
// SubnetOwnerHotkey fetches started hitting the ReconnectingRpcClient's 60s
// request_timeout (each one individually took ~200ms-2.7s in isolation, see
// subnet_ownership.rs's own PERFORMANCE note) -- account-balances' heavy
// concurrent System::Account streaming was starving the shared connection.
// A dedicated WebSocket per job (cheap: each job polls infrequently, these
// are long-lived idle-most-of-the-time connections, not a connection-per-
// request pattern) fully isolates one job's chain-RPC load from another's,
// the same way the per-job Postgres connection isolates writes.
//
// There's deliberately no generic `run_job_loop<F>` scheduler taking an
// arbitrary job closure: stable Rust can't cleanly express "an FnMut that
// returns a future borrowing a per-job `&mut Postgres client`" without
// boxing every future, so each job gets a small (~15-line) `run_loop`
// instead. What's actually worth sharing -- the tick/log/never-crash-the-
// process policy -- lives in `log_job_outcome` below, which every job's
// `run_loop` calls after each tick.
//
// Env:
//   DATABASE_URL                postgres connection (the same sink ../main.rs writes)
//   EVENTS_RPC_URL               chain RPC ws(s) url (default: the public archive)
//   SUBNET_OWNERSHIP_POLL_SECS   how often to re-poll subnet ownership (default 300)

mod jobs;

use std::time::Duration;

use anyhow::{Context, Result};

/// What a single job tick reports back to its own `run_loop` -- lets every
/// job apply the same `log_job_outcome` logging convention instead of each
/// one reimplementing it.
pub struct JobOutcome {
    pub scanned: u64,
    pub written: u64,
    pub errors: u64,
}

/// Shared logging policy every job's own `run_loop` calls after each tick.
pub fn log_job_outcome(
    name: &str,
    result: &Result<JobOutcome>,
    elapsed: Duration,
    interval: Duration,
) {
    match result {
        Ok(outcome) => {
            eprintln!(
                "{name}: ok -- {} scanned, {} written, {} error(s) ({elapsed:?} elapsed)",
                outcome.scanned, outcome.written, outcome.errors
            );
        }
        Err(e) => {
            eprintln!(
                "{name}: tick failed ({e:#}) -- retrying in {interval:?} ({elapsed:?} elapsed)"
            );
        }
    }
}

fn env_u64(k: &str) -> Option<u64> {
    std::env::var(k).ok().and_then(|v| v.parse().ok())
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let rpc_url = std::env::var("EVENTS_RPC_URL")
        .unwrap_or_else(|_| "wss://archive.chain.opentensor.ai:443".to_string());
    // Fail fast on a missing DATABASE_URL instead of each job independently
    // discovering it's unset on its first tick.
    let db_url = std::env::var("DATABASE_URL").context("DATABASE_URL required")?;
    eprintln!("poller: starting jobs (each connects its own chain + postgres client)");

    let subnet_ownership_interval =
        Duration::from_secs(env_u64("SUBNET_OWNERSHIP_POLL_SECS").unwrap_or(300));
    let account_balances_interval =
        Duration::from_secs(env_u64("ACCOUNT_BALANCES_POLL_SECS").unwrap_or(6 * 3600));
    let validator_nominators_interval =
        Duration::from_secs(env_u64("VALIDATOR_NOMINATORS_POLL_SECS").unwrap_or(24 * 3600));

    // One tokio task per job, each with its own name so a panic reports
    // which job died rather than an anonymous "a job panicked". Add a new
    // job here (spawn + push) as each one lands -- no other wiring needed,
    // matching the "config/decode delta, not a new scheduler" goal from
    // main.rs's own module doc comment above.
    let names = [
        "subnet-ownership",
        "account-balances",
        "validator-nominators",
    ];
    let handles = vec![
        tokio::spawn(jobs::subnet_ownership::run_loop(
            rpc_url.clone(),
            db_url.clone(),
            subnet_ownership_interval,
        )),
        tokio::spawn(jobs::account_balances::run_loop(
            rpc_url.clone(),
            db_url.clone(),
            account_balances_interval,
        )),
        tokio::spawn(jobs::validator_nominators::run_loop(
            rpc_url.clone(),
            db_url.clone(),
            validator_nominators_interval,
        )),
    ];

    // Every job's `run_loop` runs forever -- select_all (NOT a sequential
    // await, which would block on handles[0] forever and never notice a
    // later job panicking) resolves as soon as ANY one of them returns,
    // which only happens on a panic. That's a real bug and should take the
    // process down (systemd's restart_policy: unless-stopped brings it
    // back), rather than silently leaving a job dead while the process
    // looks alive.
    let (result, index, _remaining) = futures::future::select_all(handles).await;
    result.with_context(|| format!("{} job task panicked", names[index]))?;
    Ok(())
}
