// account-identity (metagraphed-infra#141) -- migrates
// scripts/fetch-account-identity.py. Like metagraph.rs, POSTs to the
// EXISTING `POST /api/v1/internal/account-identity-sync` route rather than
// writing Postgres directly (see metagraph.rs's own module doc comment for
// the shared reasoning -- this route's handler has no prune step, but still
// isn't worth bit-for-bit reimplementing for a job this infrequent).
//
// A DELIBERATELY SEPARATE job/tick from metagraph.rs, not folded into it,
// even though both call the SAME get_all_metagraphs() runtime API: matches
// this poller's own established precedent (validator-nominators/self-stake
// are two separate jobs writing the SAME nominator_positions table on two
// very different cadences, see roles/data-refresh-cron/vars/main.yml) and
// the retired Python script's own explicit reasoning for staying a separate
// script from fetch-metagraph-native.py despite the redundant RPC cost --
// this repo's one-job-per-capture-concern convention, preserved here as
// one-`run_loop`-per-concern. account-identity data changes far less often
// than neuron state (an account rarely touches its own on-chain identity),
// so it runs on its own, much slower interval.
//
// Ground truth (live decode against the real chain, 2026-07-20, confirming
// fetch-account-identity.py's own documented shape exactly):
// SubnetInfoRuntimeApi::get_all_metagraphs() (see metagraph.rs's own module
// doc comment for why this is the bulk call to use, not 129x per-netuid
// get_metagraph(netuid) -- same ~60x measured cost difference applies here)
// -> Vec<Option<MetagraphInfo>>, whose `identities` field is a per-UID-
// aligned Vec<Option<{name, url, github_repo, image, discord, description,
// additional}>> (all Vec<u8> bounded strings) -- None when an account never
// called set_identity, Some(_) with individual fields "" (not None) for any
// field that identity call left unset. `coldkeys` is the SAME per-UID array
// metagraph.rs already reads. Deduped by coldkey, first occurrence across
// netuids in ascending netuid order wins -- matches fetch-account-
// identity.py's own `if ... account in identities_by_account: continue`
// (an identity belongs to the coldkey, not to any one subnet membership).

use std::collections::BTreeSet;
use std::time::Duration;

use anyhow::{Context, Result};
use backfill_rs::{now_ms, ChainClient};
use scale_decode::DecodeAsType;
use serde_json::{json, Value as Json};
use subxt::dynamic;
use subxt::utils::AccountId32;

use crate::JobOutcome;

const RETRY_ATTEMPTS: u32 = 3;
const SYNC_URL_ENV: &str = "ACCOUNT_IDENTITY_SYNC_URL";
const DEFAULT_SYNC_URL: &str = "https://api.metagraph.sh/api/v1/internal/account-identity-sync";
const SYNC_SECRET_ENV: &str = "ACCOUNT_IDENTITY_SYNC_SECRET";
const SYNC_TOKEN_HEADER: &str = "x-account-identity-sync-token";
/// See metagraph.rs's own DRY_RUN_ENV for why this is a permanent
/// operational feature, not a throwaway debug flag.
const DRY_RUN_ENV: &str = "ACCOUNT_IDENTITY_DRY_RUN";
/// The sync route accepts up to 20,000 rows/request
/// (ACCOUNT_IDENTITY_SYNC_MAX_ROWS, workers/data-api.mjs) -- ~460 rows
/// live-observed, generous headroom for one un-chunked POST per tick.
const SYNC_MAX_ROWS: usize = 20_000;

#[derive(DecodeAsType, Default)]
struct ChainIdentity {
    name: Vec<u8>,
    url: Vec<u8>,
    github_repo: Vec<u8>,
    image: Vec<u8>,
    discord: Vec<u8>,
    description: Vec<u8>,
    additional: Vec<u8>,
}

#[derive(DecodeAsType)]
struct MetagraphInfo {
    netuid: u16,
    coldkeys: Vec<AccountId32>,
    identities: Vec<Option<ChainIdentity>>,
}

/// Connects its own chain client and ticks `run` on `interval` forever --
/// see subnet_ownership::run_loop's doc comment for why every job owns its
/// chain connection. No Postgres client here (see the module doc comment).
pub async fn run_loop(rpc_url: String, interval: Duration) {
    let sync_url = std::env::var(SYNC_URL_ENV).unwrap_or_else(|_| DEFAULT_SYNC_URL.to_string());
    let sync_secret = match std::env::var(SYNC_SECRET_ENV) {
        Ok(s) if !s.is_empty() => s,
        _ => {
            eprintln!("account-identity: {SYNC_SECRET_ENV} unset, job will not run");
            return;
        }
    };
    let chain = backfill_rs::connect_chain_retrying("account-identity", rpc_url).await;

    let mut ticker = tokio::time::interval(interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        ticker.tick().await;
        let t0 = std::time::Instant::now();
        let result = run(&chain, &sync_url, &sync_secret).await;
        crate::log_job_outcome("account-identity", &result, t0.elapsed(), interval);
    }
}

async fn run(chain: &ChainClient, sync_url: &str, sync_secret: &str) -> Result<JobOutcome> {
    let at = chain
        .call(|api| async move { Ok(api.at_current_block().await?) })
        .await
        .context("at_current_block")?;

    let mut infos: Vec<MetagraphInfo> = backfill_rs::retry_transient(RETRY_ATTEMPTS, || async {
        let payload = dynamic::runtime_api_call::<_, Vec<Option<MetagraphInfo>>>(
            "SubnetInfoRuntimeApi",
            "get_all_metagraphs",
            (),
        );
        let raw = at.runtime_apis().call(payload).await?;
        Ok(raw.into_iter().flatten().collect())
    })
    .await
    .context("get_all_metagraphs")?;
    // Explicit sort, not an assumption that the chain returns entries in
    // netuid order -- matches discover_netuids' own explicit
    // .sort_unstable() (backfill_rs::discover_netuids) rather than trusting
    // incidental storage-iteration order. Correctness-relevant here (unlike
    // metagraph.rs's own use of this same call): the dedup below keeps the
    // FIRST occurrence of each coldkey, which must mean "lowest netuid" to
    // match fetch-account-identity.py's own `for netuid in sorted(...)`.
    infos.sort_by_key(|i| i.netuid);
    let scanned = infos.len() as u64;
    let captured_at = now_ms();

    // Deduped by coldkey, first occurrence in ascending netuid order wins --
    // matches fetch-account-identity.py's own `for netuid in sorted(...)`
    // iteration.
    let mut seen = BTreeSet::new();
    let mut rows = Vec::new();
    for info in infos {
        for (account, identity) in resolve_subnet_identities(info) {
            if !seen.insert(account.clone()) {
                continue; // already captured at an earlier (lower) netuid
            }
            rows.push(identity_row_json(&account, &identity, captured_at));
        }
    }
    eprintln!(
        "account-identity: resolved {scanned} subnet(s), {} identities",
        rows.len()
    );

    if rows.len() > SYNC_MAX_ROWS {
        anyhow::bail!(
            "{} rows exceeds the sync route's {SYNC_MAX_ROWS}-row limit -- refusing to truncate a partial snapshot",
            rows.len()
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
        errors: 0,
    })
}

/// One subnet's (account, identity) pairs from an already-fetched
/// MetagraphInfo (see `run`'s single get_all_metagraphs() call) -- every
/// UID with BOTH an owning account and a set identity, in UID order (ascending,
/// matching fetch-account-identity.py's own `for uid in range(n)`
/// iteration order). Pure/sync: all the I/O already happened in `run`.
fn resolve_subnet_identities(info: MetagraphInfo) -> Vec<(String, ChainIdentity)> {
    // zip stops at the shorter of the two arrays -- behaviorally equivalent
    // to fetch-account-identity.py's own bounds-safe `_at(identities, uid)`
    // (out-of-range -> None -> skipped) over `range(len(coldkeys))`.
    info.coldkeys
        .into_iter()
        .zip(info.identities)
        .filter_map(|(coldkey, identity)| identity.map(|id| (coldkey.to_string(), id)))
        .collect()
}

/// The SDK decodes an unset identity string field as "" (not absent) --
/// normalize blank/whitespace-only to null, matching fetch-account-
/// identity.py's own blank_to_null exactly (this codebase's usual
/// null-never-fabricated convention for chain-encoded emptiness).
fn blank_to_null(bytes: &[u8]) -> Option<String> {
    let s = String::from_utf8_lossy(bytes);
    let trimmed = s.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Shapes one row to EXACTLY ACCOUNT_IDENTITY_INSERT_COLUMNS's key set
/// (src/account-identity.mjs) -- handleAccountIdentitySync's
/// validAccountIdentitySyncRow rejects any row with a key outside that
/// allowlist. Note `github_repo` -> `github`: the only field whose chain
/// name differs from its output column (matches fetch-account-identity.py's
/// own IDENTITY_FIELD_MAP).
fn identity_row_json(account: &str, identity: &ChainIdentity, captured_at: i64) -> Json {
    json!({
        "account": account,
        "name": blank_to_null(&identity.name),
        "url": blank_to_null(&identity.url),
        "github": blank_to_null(&identity.github_repo),
        "image": blank_to_null(&identity.image),
        "discord": blank_to_null(&identity.discord),
        "description": blank_to_null(&identity.description),
        "additional": blank_to_null(&identity.additional),
        "captured_at": captured_at,
    })
}

/// POSTs the whole batch (one request per tick) to the existing sync route
/// -- see backfill_rs::post_sync_json for the shared implementation and why
/// this pipes the body through curl's stdin rather than argv.
async fn post_sync(sync_url: &str, sync_secret: &str, rows: &[Json]) -> Result<()> {
    let body = serde_json::to_string(&json!({ "rows": rows }))?;
    backfill_rs::post_sync_json(sync_url, SYNC_TOKEN_HEADER, sync_secret, &body, "30").await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blank_to_null_normalizes_empty_string() {
        assert_eq!(blank_to_null(b""), None);
    }

    #[test]
    fn blank_to_null_normalizes_whitespace_only() {
        assert_eq!(blank_to_null(b"   "), None);
    }

    #[test]
    fn blank_to_null_passes_through_real_values() {
        assert_eq!(blank_to_null(b"tao.bot"), Some("tao.bot".to_string()));
    }

    #[test]
    fn blank_to_null_trims_surrounding_whitespace() {
        assert_eq!(blank_to_null(b"  Kraken  "), Some("Kraken".to_string()));
    }

    #[test]
    fn identity_row_json_maps_github_repo_to_github() {
        let identity = ChainIdentity {
            name: b"tao.bot".to_vec(),
            github_repo: b"https://github.com/taobot".to_vec(),
            ..ChainIdentity::default()
        };
        let v = identity_row_json("5Account", &identity, 1_700_000_000_000);
        assert_eq!(v["github"], json!("https://github.com/taobot"));
        assert!(v.get("github_repo").is_none());
    }

    #[test]
    fn identity_row_json_only_has_account_identity_insert_columns_keys() {
        // Mirrors ACCOUNT_IDENTITY_INSERT_COLUMNS (src/account-identity.mjs)
        // exactly -- validAccountIdentitySyncRow rejects any other key.
        const ACCOUNT_IDENTITY_INSERT_COLUMNS: &[&str] = &[
            "account",
            "name",
            "url",
            "github",
            "image",
            "discord",
            "description",
            "additional",
            "captured_at",
        ];
        let v = identity_row_json("5Account", &ChainIdentity::default(), 1);
        let obj = v.as_object().unwrap();
        assert_eq!(obj.len(), ACCOUNT_IDENTITY_INSERT_COLUMNS.len());
        for key in obj.keys() {
            assert!(
                ACCOUNT_IDENTITY_INSERT_COLUMNS.contains(&key.as_str()),
                "unexpected key {key}"
            );
        }
    }
}
