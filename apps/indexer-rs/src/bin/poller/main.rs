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
//   POLLER_ONLY                  comma-separated job names (e.g. "subnet-hyperparams")
//                                 to run in isolation -- unset runs every job (the
//                                 normal/production mode). Genuinely useful beyond
//                                 debugging, not just a throwaway test knob: live-tested
//                                 2026-07-19 that running every job concurrently against
//                                 a contended RPC endpoint makes it hard to tell "this
//                                 job has a real bug" from "every job is fighting the
//                                 same connection for bandwidth" -- isolating one job
//                                 removes that confound whenever it matters (this env,
//                                 or a fresh deploy of just one job's worth of changes).

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
    let subnet_hyperparams_interval =
        Duration::from_secs(env_u64("SUBNET_HYPERPARAMS_POLL_SECS").unwrap_or(3600));
    let self_stake_interval =
        Duration::from_secs(env_u64("SELF_STAKE_POLL_SECS").unwrap_or(7 * 24 * 3600));
    // 900s (15min): matches the retired metagraphed-refresh.timer's own
    // metagraph schedule (roles/data-refresh-cron/vars/main.yml,
    // "*-*-* *:0/15:00 UTC") -- a full 129-subnet/~30k-neuron tick (via the
    // bulk get_all_metagraphs() call, see metagraph.rs's own module doc
    // comment) measured live at ~30-130s end-to-end, nothing justifying a
    // wider window.
    let metagraph_interval = Duration::from_secs(env_u64("METAGRAPH_POLL_SECS").unwrap_or(900));
    // 86400s (24h): matches the retired job's own daily cadence -- an
    // account's on-chain identity changes far less often than neuron state.
    let account_identity_interval =
        Duration::from_secs(env_u64("ACCOUNT_IDENTITY_POLL_SECS").unwrap_or(24 * 3600));

    let only: Option<Vec<String>> = std::env::var("POLLER_ONLY")
        .ok()
        .map(|s| s.split(',').map(|j| j.trim().to_string()).collect());
    let enabled = |name: &str| {
        only.as_ref()
            .is_none_or(|list| list.iter().any(|j| j == name))
    };
    if let Some(list) = &only {
        eprintln!("poller: POLLER_ONLY set, running only: {}", list.join(", "));
    }

    // One tokio task per ENABLED job, each with its own name so a panic
    // reports which job died rather than an anonymous "a job panicked".
    // Add a new job here (name + spawn, gated by `enabled`) as each one
    // lands -- no other wiring needed, matching the "config/decode delta,
    // not a new scheduler" goal from main.rs's own module doc comment
    // above.
    let mut names = Vec::new();
    let mut handles = Vec::new();
    if enabled("subnet-ownership") {
        names.push("subnet-ownership");
        handles.push(tokio::spawn(jobs::subnet_ownership::run_loop(
            rpc_url.clone(),
            db_url.clone(),
            subnet_ownership_interval,
        )));
    }
    if enabled("account-balances") {
        names.push("account-balances");
        handles.push(tokio::spawn(jobs::account_balances::run_loop(
            rpc_url.clone(),
            db_url.clone(),
            account_balances_interval,
        )));
    }
    if enabled("validator-nominators") {
        names.push("validator-nominators");
        handles.push(tokio::spawn(jobs::validator_nominators::run_loop(
            rpc_url.clone(),
            db_url.clone(),
            validator_nominators_interval,
        )));
    }
    if enabled("subnet-hyperparams") {
        names.push("subnet-hyperparams");
        // No db_url -- subnet-hyperparams POSTs to the existing sync route
        // instead of writing Postgres directly (see the job's own module
        // doc comment for why).
        handles.push(tokio::spawn(jobs::subnet_hyperparams::run_loop(
            rpc_url.clone(),
            subnet_hyperparams_interval,
        )));
    }
    if enabled("self-stake") {
        names.push("self-stake");
        handles.push(tokio::spawn(jobs::self_stake::run_loop(
            rpc_url.clone(),
            db_url.clone(),
            self_stake_interval,
        )));
    }
    if enabled("metagraph") {
        names.push("metagraph");
        // No db_url -- POSTs to the existing sync route instead of writing
        // Postgres directly (see the job's own module doc comment for why).
        handles.push(tokio::spawn(jobs::metagraph::run_loop(
            rpc_url.clone(),
            metagraph_interval,
        )));
    }
    if enabled("account-identity") {
        names.push("account-identity");
        handles.push(tokio::spawn(jobs::account_identity::run_loop(
            rpc_url.clone(),
            account_identity_interval,
        )));
    }
    if handles.is_empty() {
        anyhow::bail!("POLLER_ONLY matched no known job -- nothing to run");
    }

    // Every job's `run_loop` runs forever UNLESS it's permanently
    // misconfigured (e.g. subnet-hyperparams with no sync secret set),
    // in which case it logs why and returns -- that's a "this one job is
    // disabled" state, not a process-wide failure, and must not take down
    // every OTHER healthy job. Transient connection failures don't count:
    // connect_chain_retrying/connect_pg_retrying (src/lib.rs) retry with
    // backoff forever rather than returning, precisely so a bad DB/RPC
    // blip doesn't masquerade as "permanently disabled" here.
    //
    // select_all resolves as soon as ANY ONE future completes (NOT a
    // sequential await, which would block on the first one forever and
    // never notice any other job finishing) -- live-tested 2026-07-19 and
    // confirmed the naive "exit on the first completion, panic or not"
    // version made the whole process exit as soon as one job's startup
    // failed, even with every other job still healthy. Loop instead: log
    // and drop each completed job (crashing the process on a genuine
    // panic, since that's an actual bug worth systemd restarting for), and
    // keep waiting on whatever's left. Each handle is wrapped so its name
    // travels with its own result -- select_all's own `index` is relative
    // to whatever's left in THIS call, not the original handles list, so
    // it can't be used to look a name back up in `names` once any earlier
    // handle has already been removed.
    let mut remaining: Vec<_> = names
        .into_iter()
        .zip(handles)
        .map(|(name, handle)| Box::pin(async move { (name, handle.await) }))
        .collect();
    while !remaining.is_empty() {
        let ((name, result), _index, rest) = futures::future::select_all(remaining).await;
        remaining = rest;
        match result {
            Ok(()) => {
                eprintln!(
                    "poller: {name} job stopped running (see its own log line above for why) -- other jobs continue"
                );
            }
            Err(panic) => {
                return Err(panic).with_context(|| format!("{name} job task panicked"));
            }
        }
    }
    eprintln!("poller: every job has stopped running, nothing left to do");
    Ok(())
}
