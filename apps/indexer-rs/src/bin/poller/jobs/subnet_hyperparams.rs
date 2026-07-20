// subnet-hyperparams (metagraphed-infra#141) -- migrates
// scripts/fetch-subnet-hyperparams.py. UNLIKE every other poller job so
// far, this one does NOT write Postgres directly -- it POSTs to the
// EXISTING `POST /api/v1/internal/subnet-hyperparams-sync` route instead
// (same URL/header/secret the retired Python script already posts to,
// see roles/data-refresh-cron/vars/main.yml), reusing that route's
// hash-diff-into-subnet_hyperparams_history logic (SHA-256 of a
// stable-JSON-stringify of the formatted row, workers/data-api.mjs +
// src/subnet-hyperparams-history.mjs) rather than re-implementing it
// bit-for-bit in Rust.
//
// That's a deliberate choice, not an oversight: bit-for-bit replicating
// that hash (exact same float rendering, key ordering, null handling as
// formatSubnetHyperparams + stableStringify) is real, easy-to-get-subtly-
// wrong risk -- a single formatting mismatch would make the poller think
// hyperparams changed on EVERY tick, silently flooding
// subnet_hyperparams_history forever with false "changes". Only the
// chain-reading half moves to Rust; the write path (upsert + prune +
// hash-diff-append) stays exactly as-is in JS. Shells out to curl rather
// than adding an HTTP client crate, matching main.rs's own
// alert_stuck_block() convention for the same reason (a single, rare,
// non-hot-path POST).
//
// Ground truth for the chain read (live Runtime-API-metadata introspection,
// 2026-07-19, NOT guessed from the bittensor Python SDK's own naming):
// SubnetInfoRuntimeApi::get_subnet_hyperparams_v3(netuid) ->
// Option<Vec<{name: bytes, value: <tagged union>}>> -- a clean,
// self-describing 33-entry list (live-verified against netuid 1). Each
// entry's `value` is itself a SCALE enum whose VARIANT NAME tells you how
// to interpret the payload (U16/U32/U64/Bool carry the raw number/flag
// directly; TaoBalance wraps a single rao amount; U64F64/I32F32 wrap a
// `{bits}` fixed-point integer) -- hyperparam_number() below dispatches on
// that variant name rather than assuming a fixed field order, so a
// hyperparam this runtime adds/removes/reorders doesn't silently
// misalign anything: an unrecognized value shape just decodes as None for
// that one field, not a wrong value for a different one.

use std::collections::HashMap;
use std::time::Duration;

use anyhow::{Context, Result};
use backfill_rs::{discover_netuids, now_ms, AtBlock, ChainClient};
use scale_decode::DecodeAsType;
use scale_value::{Primitive, Value, ValueDef};
use serde_json::{json, Value as Json};
use subxt::dynamic;

use crate::JobOutcome;

const MAX_ERROR_RATE: f64 = 0.5;
// See fetch_hyperparams_row's own comment for why individual calls retry.
const RETRY_ATTEMPTS: u32 = 3;
const SYNC_URL_ENV: &str = "SUBNET_HYPERPARAMS_SYNC_URL";
const DEFAULT_SYNC_URL: &str = "https://api.metagraph.sh/api/v1/internal/subnet-hyperparams-sync";
const SYNC_SECRET_ENV: &str = "SUBNET_HYPERPARAMS_SYNC_SECRET";
const SYNC_TOKEN_HEADER: &str = "x-subnet-hyperparams-sync-token";
// If set (to anything), print up to 3 sample computed rows instead of
// POSTing them -- lets an operator verify the chain-read + field-mapping
// half in isolation against the real chain without touching the real sync
// route/secret. Genuinely useful beyond this job's own initial development
// (any future field-mapping change here deserves the same dry check before
// it starts overwriting subnet_hyperparams_history), not a throwaway debug
// flag left behind by accident.
const DRY_RUN_ENV: &str = "SUBNET_HYPERPARAMS_DRY_RUN";

#[derive(DecodeAsType)]
struct HyperparamEntry {
    name: Vec<u8>,
    value: Value,
}

/// Connects its own chain client and ticks `run` on `interval` forever --
/// see subnet_ownership::run_loop's doc comment for why every job owns its
/// chain connection. No Postgres client here (see the module doc comment
/// for why this job POSTs instead of writing directly).
pub async fn run_loop(rpc_url: String, interval: Duration) {
    // Check the secret BEFORE connecting to chain: a permanently missing
    // env var means this job is disabled (no point retrying a chain
    // connection first just to then fail on something that will never
    // change without a process restart).
    let sync_url = std::env::var(SYNC_URL_ENV).unwrap_or_else(|_| DEFAULT_SYNC_URL.to_string());
    let sync_secret = match std::env::var(SYNC_SECRET_ENV) {
        Ok(s) if !s.is_empty() => s,
        _ => {
            eprintln!("subnet-hyperparams: {SYNC_SECRET_ENV} unset, job will not run");
            return;
        }
    };
    let chain = backfill_rs::connect_chain_retrying("subnet-hyperparams", rpc_url).await;

    let mut ticker = tokio::time::interval(interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        ticker.tick().await;
        let t0 = std::time::Instant::now();
        let result = run(&chain, &sync_url, &sync_secret).await;
        crate::log_job_outcome("subnet-hyperparams", &result, t0.elapsed(), interval);
    }
}

async fn run(chain: &ChainClient, sync_url: &str, sync_secret: &str) -> Result<JobOutcome> {
    let at = chain
        .call(|api| async move { Ok(api.at_current_block().await?) })
        .await
        .context("at_current_block")?;

    let netuids = discover_netuids(&at).await.context("discover netuids")?;
    let scanned = netuids.len() as u64;
    let block_number = at.block_number();
    let captured_at = now_ms();

    let mut rows = Vec::with_capacity(netuids.len());
    let mut errors = 0u64;
    for (i, netuid) in netuids.into_iter().enumerate() {
        match fetch_hyperparams_row(&at, netuid, block_number, captured_at).await {
            Ok(Some(row)) => rows.push(row),
            // None response means the runtime has no hyperparams for this
            // netuid (deregistered between discovery and this call) -- not
            // an error, just nothing to sync for it this tick.
            Ok(None) => {}
            Err(e) => {
                eprintln!("subnet-hyperparams: netuid={netuid} fetch failed: {e:#}");
                errors += 1;
            }
        }
        if (i + 1).is_multiple_of(20) {
            eprintln!("subnet-hyperparams: fetched {}/{scanned}", i + 1);
        }
    }

    let error_rate = if scanned > 0 {
        errors as f64 / scanned as f64
    } else {
        0.0
    };
    if error_rate > MAX_ERROR_RATE {
        anyhow::bail!(
            "error rate {errors}/{scanned} ({:.0}%) exceeds {:.0}% -- refusing to sync a mostly-broken snapshot",
            error_rate * 100.0,
            MAX_ERROR_RATE * 100.0
        );
    }

    let written = rows.len() as u64;
    if written > 0 {
        if std::env::var(DRY_RUN_ENV).is_ok() {
            eprintln!("DRY RUN, not posting. Sample rows:");
            for r in rows.iter().take(3) {
                eprintln!("{}", serde_json::to_string_pretty(r)?);
            }
        } else {
            post_sync(sync_url, sync_secret, &rows).await?;
        }
    }

    Ok(JobOutcome {
        scanned,
        written,
        errors,
    })
}

async fn fetch_hyperparams_row(
    at: &AtBlock,
    netuid: u16,
    block_number: u64,
    captured_at: i64,
) -> Result<Option<Json>> {
    // Retries transient failures (RETRY_ATTEMPTS) -- same reasoning as
    // subnet_ownership.rs's resolve_ownership: a runtime API call against
    // an already-resolved AtBlock can hit the ReconnectingRpcClient's 60s
    // request_timeout under concurrent multi-job load even though the same
    // call reliably completes in under a second moments later.
    let Some(entries) = backfill_rs::retry_transient(RETRY_ATTEMPTS, || async {
        let payload = dynamic::runtime_api_call::<_, Option<Vec<HyperparamEntry>>>(
            "SubnetInfoRuntimeApi",
            "get_subnet_hyperparams_v3",
            (netuid,),
        );
        Ok(at.runtime_apis().call(payload).await?)
    })
    .await
    .with_context(|| format!("get_subnet_hyperparams_v3(netuid={netuid})"))?
    else {
        return Ok(None);
    };

    let by_name: HashMap<String, f64> = entries
        .iter()
        .filter_map(|e| {
            let name = String::from_utf8_lossy(&e.name).into_owned();
            hyperparam_number(&e.value).map(|n| (name, n))
        })
        .collect();

    let ratio = |name: &str| by_name.get(name).map(|v| v / 65535.0);
    let flag = |name: &str| by_name.get(name).map(|v| *v != 0.0);
    let int = |name: &str| by_name.get(name).map(|v| *v as i64);
    let tao = |name: &str| by_name.get(name).map(|v| v / 1e9);
    let fixed64 = |name: &str| by_name.get(name).map(|v| v / 2f64.powi(64));
    let fixed32 = |name: &str| by_name.get(name).map(|v| v / 2f64.powi(32));

    Ok(Some(json!({
        "netuid": netuid,
        "kappa_ratio": ratio("kappa"),
        "immunity_period": int("immunity_period"),
        "min_allowed_weights": int("min_allowed_weights"),
        "max_weight_limit_ratio": ratio("max_weights_limit"),
        "tempo": int("tempo"),
        "weights_version": int("weights_version"),
        "weights_rate_limit": int("weights_rate_limit"),
        "activity_cutoff": int("activity_cutoff"),
        "activity_cutoff_factor": int("activity_cutoff_factor"),
        "registration_allowed": flag("registration_allowed").map(|b| b as i64),
        "target_regs_per_interval": int("target_regs_per_interval"),
        "min_burn_tao": tao("min_burn"),
        "max_burn_tao": tao("max_burn"),
        "burn_half_life": int("burn_half_life"),
        "burn_increase_mult": fixed64("burn_increase_mult"),
        "bonds_moving_avg_raw": int("bonds_moving_avg"),
        "max_regs_per_block": int("max_regs_per_block"),
        "serving_rate_limit": int("serving_rate_limit"),
        "max_validators": int("max_validators"),
        "commit_reveal_period": int("commit_reveal_period"),
        "commit_reveal_enabled": flag("commit_reveal_weights_enabled").map(|b| b as i64),
        "alpha_high_ratio": ratio("alpha_high"),
        "alpha_low_ratio": ratio("alpha_low"),
        "liquid_alpha_enabled": flag("liquid_alpha_enabled").map(|b| b as i64),
        "alpha_sigmoid_steepness": fixed32("alpha_sigmoid_steepness"),
        "yuma_version": int("yuma_version"),
        "subnet_is_active": flag("subnet_is_active").map(|b| b as i64),
        "transfers_enabled": flag("transfers_enabled").map(|b| b as i64),
        "bonds_reset_enabled": flag("bonds_reset_enabled").map(|b| b as i64),
        "user_liquidity_enabled": flag("user_liquidity_enabled").map(|b| b as i64),
        "owner_cut_enabled": flag("owner_cut_enabled").map(|b| b as i64),
        "owner_cut_auto_lock_enabled": flag("owner_cut_auto_lock_enabled").map(|b| b as i64),
        "min_childkey_take_ratio": ratio("min_childkey_take"),
        "block_number": block_number,
        "captured_at": captured_at,
    })))
}

/// Interprets one hyperparameter's `value` (a tagged-union SCALE enum) as a
/// plain f64, dispatching on the variant NAME rather than assuming a fixed
/// shape:
///   - U16/U32/U64/U128 -- the wrapped integer, as-is
///   - Bool -- 1.0/0.0
///   - TaoBalance -- the wrapped rao amount, as-is (caller divides by 1e9)
///   - U64F64/I32F32 -- the wrapped `{bits}` fixed-point integer, as-is
///     (caller divides by 2^64/2^32 respectively)
///
/// An unrecognized variant name (a future hyperparameter type this job
/// hasn't seen) decodes as None for that one field rather than guessing.
fn hyperparam_number(value: &Value) -> Option<f64> {
    let ValueDef::Variant(variant) = &value.value else {
        return None;
    };
    match variant.name.as_str() {
        "U16" | "U32" | "U64" | "U128" | "TaoBalance" | "U64F64" | "I32F32" => {
            let inner = variant.values.values().next()?;
            match &inner.value {
                ValueDef::Primitive(Primitive::U128(n)) => Some(*n as f64),
                ValueDef::Primitive(Primitive::I128(n)) => Some(*n as f64),
                // U64F64/I32F32 wrap a NAMED {bits} struct, not a bare
                // integer -- one more level to unwrap.
                ValueDef::Composite(composite) => {
                    let bits = composite.values().next()?;
                    match &bits.value {
                        ValueDef::Primitive(Primitive::U128(n)) => Some(*n as f64),
                        ValueDef::Primitive(Primitive::I128(n)) => Some(*n as f64),
                        _ => None,
                    }
                }
                _ => None,
            }
        }
        "Bool" => {
            let inner = variant.values.values().next()?;
            match &inner.value {
                ValueDef::Primitive(Primitive::Bool(b)) => Some(if *b { 1.0 } else { 0.0 }),
                _ => None,
            }
        }
        _ => None,
    }
}

/// POSTs the whole batch (one request per tick, well under
/// SUBNET_HYPERPARAMS_SYNC_MAX_ROWS/_BODY_BYTES for ~129 subnets) to the
/// existing sync route -- see backfill_rs::post_sync_json for the shared
/// implementation and why this pipes the body through curl's stdin rather
/// than argv.
async fn post_sync(sync_url: &str, sync_secret: &str, rows: &[Json]) -> Result<()> {
    let body = serde_json::to_string(&json!({ "rows": rows }))?;
    backfill_rs::post_sync_json(sync_url, SYNC_TOKEN_HEADER, sync_secret, &body, "30").await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u128_variant(name: &str, n: u128) -> Value {
        Value::from(scale_value::Variant::unnamed_fields(name, [Value::from(n)]))
    }

    fn bits_variant(name: &str, bits: u128) -> Value {
        let bits_struct = Value::from(scale_value::Composite::named([(
            "bits".to_string(),
            Value::from(bits),
        )]));
        Value::from(scale_value::Variant::unnamed_fields(name, [bits_struct]))
    }

    fn bool_variant(b: bool) -> Value {
        Value::from(scale_value::Variant::unnamed_fields(
            "Bool",
            [Value::from(b)],
        ))
    }

    #[test]
    fn hyperparam_number_reads_plain_integers() {
        assert_eq!(
            hyperparam_number(&u128_variant("U16", 32767)),
            Some(32767.0)
        );
    }

    #[test]
    fn hyperparam_number_reads_bool_as_one_or_zero() {
        assert_eq!(hyperparam_number(&bool_variant(true)), Some(1.0));
        assert_eq!(hyperparam_number(&bool_variant(false)), Some(0.0));
    }

    #[test]
    fn hyperparam_number_reads_tao_balance_raw_rao() {
        assert_eq!(
            hyperparam_number(&u128_variant("TaoBalance", 500_000)),
            Some(500_000.0)
        );
    }

    #[test]
    fn hyperparam_number_unwraps_fixed_point_bits() {
        // 4294967296000 bits / 2^32 = 1000.0 -- the real value live-verified
        // for alpha_sigmoid_steepness against netuid 1.
        let v = hyperparam_number(&bits_variant("I32F32", 4_294_967_296_000));
        assert_eq!(v, Some(4_294_967_296_000.0));
    }

    #[test]
    fn hyperparam_number_unrecognized_variant_is_none() {
        assert_eq!(hyperparam_number(&u128_variant("SomeFutureType", 1)), None);
    }
}
