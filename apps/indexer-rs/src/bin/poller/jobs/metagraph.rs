// metagraph (metagraphed-infra#140) -- migrates fetch-metagraph-native.py,
// the most central/highest-traffic data in the whole system (feeds nearly
// every leaderboard/route in the API). Migrated LAST and most carefully of
// all six jobs, matching that blast radius.
//
// Like subnet_hyperparams.rs (see that job's own module doc comment for the
// full reasoning), this job does NOT write Postgres directly -- it POSTs to
// the EXISTING `POST /api/v1/internal/neurons-sync` route instead (same
// URL/header/secret the retired Python script already posts to, see
// roles/data-refresh-cron/vars/main.yml). That route's handler
// (workers/data-api.mjs's handleNeuronsSync) does far more than a plain
// upsert in one atomic transaction: it upserts `neurons` (latest-only),
// rolls the SAME snapshot into `neuron_daily` (dated history) and
// `account_position_daily` (per-account rollup), AND prunes UIDs that no
// longer appear in a netuid's snapshot (deregistered/replaced). Bit-for-bit
// reimplementing a three-table, prune-aware atomic write in Rust is real,
// easy-to-get-subtly-wrong risk for the single highest-traffic table in the
// system -- a bug here doesn't just fail one leaderboard, it can silently
// corrupt history or wrongly prune live neurons. Only the chain-reading half
// moves to Rust; the write path stays exactly as-is in JS.
//
// Ground truth (live Runtime-API-metadata introspection + real decodes
// against the real chain, 2026-07-20, NOT guessed from the bittensor Python
// SDK's own attribute names): SubnetInfoRuntimeApi::get_all_metagraphs() ->
// Vec<Option<MetagraphInfo>>, ONE call returning every netuid's canonical
// (mechid 0) metagraph in a single round trip -- 129 entries, none null,
// live-verified. This is the bulk equivalent of per-netuid
// get_metagraph(netuid) that fetch-metagraph-native.py's own docstring
// points at (get_all_metagraphs_info(all_mechanisms=True) in the Python
// SDK), and the choice is NOT cosmetic: get_metagraph(netuid) was first
// measured at ~18-19s PER CALL (129 sequential calls -> ~40min/tick, would
// have made the 15min poll interval below meaningless), while
// get_all_metagraphs() decodes the ENTIRE network in ~30-38s total --
// roughly a 60x difference for the exact same data. MetagraphInfo is a
// large struct with parallel per-UID arrays (hotkeys, coldkeys, active,
// validator_permit, consensus, incentives, dividends, emission,
// total_stake, axons, block_at_registration) plus netuid-level scalars
// (netuid, block, immunity_period). Two things it does NOT carry that this
// job still needs a separate read for:
//   - SubtensorModule::ValidatorTrust(netuid) -> Vec<u16>, per-UID, indexed
//     the same way as MetagraphInfo's own arrays. Also scanned in ONE
//     iter() pass (2.1s live-measured for all 129 netuids) rather than
//     129 separate .fetch() calls, same reasoning as the bulk metagraph
//     call above.
//   - SubtensorModule::Delegates(hotkey) -> u16 ("take"), a flat global map
//     (not netuid-scoped) -- scanned ONCE up front, already a single iter()
//     pass.
// consensus/incentives/dividends/ValidatorTrust are raw U16 (0..65535, /
// 65535 for the true 0.0..1.0 ratio) -- confirmed live: Delegates' own take
// value of 11796 decodes to exactly 0.18, matching this codebase's
// previously-documented finding (Bittensor's default/floor take) via the
// SAME /65535 conversion. emission/total_stake are raw rao (u64,
// rao_to_tao_exact conversion, matching every other job's balance handling).
//
// `rank` and `trust` are DELIBERATELY NOT read from MetagraphInfo's own
// same-named fields, matching fetch-metagraph-native.py's own established
// finding: `trust` is dead in dTAO (hardcoded 0.0 here too), and there is no
// real chain rank-position storage -- `rank` is instead a 1-based ranking by
// incentive descending, computed here after the whole subnet's rows are
// built, same as the Python script.

use std::collections::HashMap;
use std::time::Duration;

use anyhow::{Context, Result};
use backfill_rs::{now_ms, rao_to_tao_exact, AtBlock, ChainClient};
use scale_decode::DecodeAsType;
use serde_json::{json, Value as Json};
use subxt::dynamic;
use subxt::utils::AccountId32;

use crate::JobOutcome;

const RETRY_ATTEMPTS: u32 = 3;
const RATIO_SCALE: f64 = 65535.0;
const ZERO_ACCOUNT: AccountId32 = AccountId32([0u8; 32]);
const SYNC_URL_ENV: &str = "NEURONS_SYNC_URL";
const DEFAULT_SYNC_URL: &str = "https://api.metagraph.sh/api/v1/internal/neurons-sync";
const SYNC_SECRET_ENV: &str = "NEURONS_SYNC_SECRET";
const SYNC_TOKEN_HEADER: &str = "x-neurons-sync-token";
/// If set (to anything), print up to 3 sample computed rows instead of
/// POSTing -- see subnet_hyperparams.rs's own DRY_RUN_ENV for why this is a
/// permanent operational feature, not a throwaway debug flag.
const DRY_RUN_ENV: &str = "NEURONS_DRY_RUN";
/// The sync route accepts up to 50,000 rows/request (NEURONS_SYNC_MAX_ROWS,
/// workers/data-api.mjs) -- ~33k rows/tick (129 subnets x <=256 UIDs,
/// live-observed) fits in one POST with real headroom, so this job never
/// needs to chunk across multiple requests the way it would need to if the
/// network grew past that ceiling.
const SYNC_MAX_ROWS: usize = 50_000;

#[derive(DecodeAsType)]
struct Axon {
    ip: u128,
    port: u16,
}

#[derive(DecodeAsType)]
struct MetagraphInfo {
    netuid: u16,
    hotkeys: Vec<AccountId32>,
    coldkeys: Vec<AccountId32>,
    active: Vec<bool>,
    validator_permit: Vec<bool>,
    consensus: Vec<(u16,)>,
    incentives: Vec<(u16,)>,
    dividends: Vec<(u16,)>,
    emission: Vec<(u64,)>,
    total_stake: Vec<(u64,)>,
    axons: Vec<Axon>,
    block_at_registration: Vec<u64>,
    block: u64,
    immunity_period: u16,
}

struct NeuronRow {
    netuid: u16,
    uid: u16,
    hotkey: String,
    coldkey: String,
    active: bool,
    validator_permit: bool,
    rank: Option<f64>,
    validator_trust: f64,
    consensus: f64,
    incentive: f64,
    dividends: f64,
    emission_tao: String,
    stake_tao: String,
    registered_at_block: u64,
    is_immunity_period: bool,
    axon: Option<String>,
    block_number: u64,
    take: Option<f64>,
}

/// Connects its own chain client and ticks `run` on `interval` forever --
/// see subnet_ownership::run_loop's doc comment for why every job owns its
/// chain connection. No Postgres client here (see the module doc comment
/// for why this job POSTs instead of writing directly).
pub async fn run_loop(rpc_url: String, interval: Duration) {
    // Check the secret BEFORE connecting to chain -- see
    // subnet_hyperparams::run_loop's identical early-return for why.
    let sync_url = std::env::var(SYNC_URL_ENV).unwrap_or_else(|_| DEFAULT_SYNC_URL.to_string());
    let sync_secret = match std::env::var(SYNC_SECRET_ENV) {
        Ok(s) if !s.is_empty() => s,
        _ => {
            eprintln!("metagraph: {SYNC_SECRET_ENV} unset, job will not run");
            return;
        }
    };
    let chain = backfill_rs::connect_chain_retrying("metagraph", rpc_url).await;

    let mut ticker = tokio::time::interval(interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        ticker.tick().await;
        let t0 = std::time::Instant::now();
        let result = run(&chain, &sync_url, &sync_secret).await;
        crate::log_job_outcome("metagraph", &result, t0.elapsed(), interval);
    }
}

async fn run(chain: &ChainClient, sync_url: &str, sync_secret: &str) -> Result<JobOutcome> {
    let at = chain
        .call(|api| async move { Ok(api.at_current_block().await?) })
        .await
        .context("at_current_block")?;

    // Both global/network-wide, not netuid-scoped -- one iter() pass each
    // rather than per-netuid calls (see the module doc comment for the
    // measured cost of the per-netuid alternative). A failure in either is
    // NOT recoverable per-netuid (every row's take/validator_trust would be
    // wrong network-wide), matching fetch-metagraph-native.py's own
    // deliberately-uncaught delegate_takes() -- propagate via `?`, not the
    // per-netuid error-rate accumulation below.
    let takes = scan_delegate_takes(&at).await.context("scan Delegates")?;
    let validator_trust = scan_validator_trust(&at)
        .await
        .context("scan ValidatorTrust")?;
    eprintln!(
        "metagraph: {} delegate take(s), {} netuid(s) of validator trust, fetching all metagraphs",
        takes.len(),
        validator_trust.len()
    );

    let infos: Vec<MetagraphInfo> = backfill_rs::retry_transient(RETRY_ATTEMPTS, || async {
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
    let scanned = infos.len() as u64;

    // No per-netuid error accumulation here (unlike this poller's other
    // jobs): resolve_subnet_neurons is pure data reshaping over an
    // already-fetched, already-decoded MetagraphInfo (the one fallible
    // step -- get_all_metagraphs() itself -- already propagated via `?`
    // above), so there's no partial-failure mode left to threshold against.
    let empty = Vec::new();
    let rows: Vec<NeuronRow> = infos
        .into_iter()
        .flat_map(|info| {
            let vt = validator_trust.get(&info.netuid).unwrap_or(&empty);
            resolve_subnet_neurons(info, vt, &takes)
        })
        .collect();
    eprintln!(
        "metagraph: resolved {scanned} subnet(s), {} rows",
        rows.len()
    );

    if rows.len() > SYNC_MAX_ROWS {
        anyhow::bail!(
            "{} rows exceeds the sync route's {SYNC_MAX_ROWS}-row limit -- refusing to truncate a partial snapshot",
            rows.len()
        );
    }

    let captured_at = now_ms();
    let payload: Vec<Json> = rows
        .iter()
        .map(|r| neuron_row_json(r, captured_at))
        .collect();
    let written = payload.len() as u64;
    if written > 0 {
        if std::env::var(DRY_RUN_ENV).is_ok() {
            eprintln!("DRY RUN, not posting. Sample rows:");
            for r in payload.iter().take(3) {
                eprintln!("{}", serde_json::to_string_pretty(r)?);
            }
        } else {
            post_sync(sync_url, sync_secret, &payload).await?;
        }
    }

    Ok(JobOutcome {
        scanned,
        written,
        errors: 0,
    })
}

/// SubtensorModule::Delegates: EVERY hotkey with a registered delegate take
/// -- a flat, netuid-independent map, scanned once for the whole run.
async fn scan_delegate_takes(at: &AtBlock) -> Result<HashMap<String, f64>> {
    let addr = dynamic::storage::<(AccountId32,), u16>("SubtensorModule", "Delegates");
    let mut iter = at.storage().iter(addr, ()).await?;
    let mut takes = HashMap::new();
    while let Some(entry) = iter.next().await {
        let entry = entry?;
        let (hotkey,) = entry.key()?.decode()?;
        let take: u16 = entry.value().decode()?;
        takes.insert(hotkey.to_string(), take as f64 / RATIO_SCALE);
    }
    Ok(takes)
}

/// SubtensorModule::ValidatorTrust: every netuid's per-UID trust vector --
/// scanned once for the whole run, same reasoning as scan_delegate_takes
/// (129 separate .fetch() calls measured far slower than one .iter() pass,
/// see the module doc comment).
async fn scan_validator_trust(at: &AtBlock) -> Result<HashMap<u16, Vec<u16>>> {
    let addr = dynamic::storage::<(u16,), Vec<u16>>("SubtensorModule", "ValidatorTrust");
    let mut iter = at.storage().iter(addr, ()).await?;
    let mut by_netuid = HashMap::new();
    while let Some(entry) = iter.next().await {
        let entry = entry?;
        let (netuid,) = entry.key()?.decode()?;
        let trust: Vec<u16> = entry.value().decode()?;
        by_netuid.insert(netuid, trust);
    }
    Ok(by_netuid)
}

/// One subnet's full neuron snapshot from an already-fetched MetagraphInfo
/// (see `run`'s single get_all_metagraphs() call) + its ValidatorTrust
/// vector, then rank derived by incentive descending (matches
/// fetch-metagraph-native.py's own Taostats-style 1-based ranking -- there
/// is no real chain rank-position storage to read instead). Pure/sync: all
/// the I/O already happened in `run`.
fn resolve_subnet_neurons(
    info: MetagraphInfo,
    validator_trust: &[u16],
    takes: &HashMap<String, f64>,
) -> Vec<NeuronRow> {
    let netuid = info.netuid;
    let n = info.hotkeys.len();
    let block = info.block;
    let mut rows = Vec::with_capacity(n);
    for uid in 0..n {
        let hotkey = info.hotkeys[uid];
        if hotkey == ZERO_ACCOUNT {
            continue;
        }
        let coldkey = info.coldkeys.get(uid).copied().unwrap_or(ZERO_ACCOUNT);
        let reg_at = info.block_at_registration.get(uid).copied().unwrap_or(0);
        let axon = info
            .axons
            .get(uid)
            .filter(|a| a.ip != 0)
            .map(|a| format_axon(a.ip, a.port));

        rows.push(NeuronRow {
            netuid,
            uid: uid as u16,
            hotkey: hotkey.to_string(),
            coldkey: coldkey.to_string(),
            active: info.active.get(uid).copied().unwrap_or(false),
            validator_permit: info.validator_permit.get(uid).copied().unwrap_or(false),
            rank: None, // filled in below, after every row in this subnet exists
            validator_trust: validator_trust.get(uid).copied().unwrap_or(0) as f64 / RATIO_SCALE,
            consensus: info.consensus.get(uid).map(|v| v.0).unwrap_or(0) as f64 / RATIO_SCALE,
            incentive: info.incentives.get(uid).map(|v| v.0).unwrap_or(0) as f64 / RATIO_SCALE,
            dividends: info.dividends.get(uid).map(|v| v.0).unwrap_or(0) as f64 / RATIO_SCALE,
            emission_tao: rao_to_tao_exact(
                info.emission.get(uid).map(|v| v.0 as u128).unwrap_or(0),
            ),
            stake_tao: rao_to_tao_exact(
                info.total_stake.get(uid).map(|v| v.0 as u128).unwrap_or(0),
            ),
            registered_at_block: reg_at,
            is_immunity_period: reg_at > 0
                && block.saturating_sub(reg_at) < info.immunity_period as u64,
            axon,
            block_number: block,
            take: takes.get(&hotkey.to_string()).copied(),
        });
    }

    // Taostats-style 1-based rank by incentive descending, among
    // incentivized neurons only -- matches fetch-metagraph-native.py's own
    // `sorted((r for r in subnet_rows if r["incentive"]), key=...)` exactly:
    // ties break by uid ascending, non-incentivized neurons keep rank=None.
    let mut ranked: Vec<usize> = (0..rows.len())
        .filter(|&i| rows[i].incentive > 0.0)
        .collect();
    ranked.sort_by(|&a, &b| {
        rows[b]
            .incentive
            .partial_cmp(&rows[a].incentive)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(rows[a].uid.cmp(&rows[b].uid))
    });
    for (pos, idx) in ranked.into_iter().enumerate() {
        rows[idx].rank = Some((pos + 1) as f64);
    }

    rows
}

/// axon.ip is a plain u128 (holds either an IPv4 or IPv6 address by
/// magnitude) + a separate port -- matches fetch-metagraph-native.py's own
/// fmt_axon (ipaddress.ip_address(int(ip))): IPv4 if it fits in 32 bits,
/// IPv6 otherwise.
fn format_axon(ip: u128, port: u16) -> String {
    let host = if ip <= u32::MAX as u128 {
        std::net::Ipv4Addr::from(ip as u32).to_string()
    } else {
        std::net::Ipv6Addr::from(ip.to_be_bytes()).to_string()
    };
    if port > 0 {
        format!("{host}:{port}")
    } else {
        host
    }
}

/// Shapes one row to EXACTLY NEURON_INSERT_COLUMNS's key set
/// (src/metagraph-neurons.mjs) -- handleNeuronsSync's validNeuronSyncRow
/// rejects any row with a key outside that allowlist, so this must never
/// drift from it. Boolean columns are sent as 0/1 (NEURONS_SYNC_BOOLEAN_COLUMNS
/// coerces via `Boolean(Number(value))`), matching the retired Python
/// script's own int(bool) convention -- a JSON `true`/`false` would also
/// decode correctly, but 0/1 keeps this payload byte-identical to what the
/// route has always received.
fn neuron_row_json(r: &NeuronRow, captured_at: i64) -> Json {
    json!({
        "netuid": r.netuid,
        "uid": r.uid,
        "hotkey": r.hotkey,
        "coldkey": r.coldkey,
        "active": r.active as u8,
        "validator_permit": r.validator_permit as u8,
        "rank": r.rank,
        "trust": 0.0,
        "validator_trust": r.validator_trust,
        "consensus": r.consensus,
        "incentive": r.incentive,
        "dividends": r.dividends,
        "emission_tao": r.emission_tao,
        "stake_tao": r.stake_tao,
        "registered_at_block": r.registered_at_block,
        "is_immunity_period": r.is_immunity_period as u8,
        "axon": r.axon,
        "block_number": r.block_number,
        "captured_at": captured_at,
        "take": r.take,
    })
}

/// POSTs the whole batch (one request per tick) to the existing sync route
/// via curl -- see subnet_hyperparams.rs's own post_sync for why curl
/// rather than a new HTTP client dependency.
async fn post_sync(sync_url: &str, sync_secret: &str, rows: &[Json]) -> Result<()> {
    let body = serde_json::to_string(&json!({ "rows": rows }))?;
    let header = format!("{SYNC_TOKEN_HEADER}: {sync_secret}");
    let output = tokio::process::Command::new("curl")
        .args([
            "-fsS",
            "-m",
            "60",
            "-X",
            "POST",
            sync_url,
            "-H",
            "content-type: application/json",
            "-H",
            &header,
            "-d",
            &body,
        ])
        .output()
        .await
        .context("spawn curl")?;
    if !output.status.success() {
        anyhow::bail!(
            "sync POST failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_axon_renders_ipv4_with_port() {
        assert_eq!(format_axon(0xC0A80001, 8091), "192.168.0.1:8091");
    }

    #[test]
    fn format_axon_omits_port_when_zero() {
        assert_eq!(format_axon(0x01020304, 0), "1.2.3.4");
    }

    #[test]
    fn format_axon_renders_ipv6_for_large_values() {
        let ip = 0x2001_0db8_0000_0000_0000_0000_0000_0001u128;
        assert_eq!(format_axon(ip, 80), "2001:db8::1:80");
    }

    fn sample_row() -> NeuronRow {
        NeuronRow {
            netuid: 1,
            uid: 5,
            hotkey: "5Hotkey".to_string(),
            coldkey: "5Coldkey".to_string(),
            active: true,
            validator_permit: false,
            rank: Some(3.0),
            validator_trust: 0.5,
            consensus: 0.25,
            incentive: 0.1,
            dividends: 0.2,
            emission_tao: "1.5".to_string(),
            stake_tao: "100".to_string(),
            registered_at_block: 12345,
            is_immunity_period: true,
            axon: Some("1.2.3.4:8091".to_string()),
            block_number: 99999,
            take: Some(0.18),
        }
    }

    #[test]
    fn neuron_row_json_only_has_neuron_insert_columns_keys() {
        // Mirrors NEURON_INSERT_COLUMNS (src/metagraph-neurons.mjs) exactly --
        // handleNeuronsSync's validNeuronSyncRow rejects any other key.
        const NEURON_INSERT_COLUMNS: &[&str] = &[
            "netuid",
            "uid",
            "hotkey",
            "coldkey",
            "active",
            "validator_permit",
            "rank",
            "trust",
            "validator_trust",
            "consensus",
            "incentive",
            "dividends",
            "emission_tao",
            "stake_tao",
            "registered_at_block",
            "is_immunity_period",
            "axon",
            "block_number",
            "captured_at",
            "take",
        ];
        let v = neuron_row_json(&sample_row(), 1_700_000_000_000);
        let obj = v.as_object().unwrap();
        assert_eq!(obj.len(), NEURON_INSERT_COLUMNS.len());
        for key in obj.keys() {
            assert!(
                NEURON_INSERT_COLUMNS.contains(&key.as_str()),
                "unexpected key {key}"
            );
        }
    }

    #[test]
    fn neuron_row_json_sends_booleans_as_zero_or_one() {
        let v = neuron_row_json(&sample_row(), 1);
        assert_eq!(v["active"], json!(1));
        assert_eq!(v["validator_permit"], json!(0));
        assert_eq!(v["is_immunity_period"], json!(1));
    }

    #[test]
    fn neuron_row_json_hardcodes_trust_zero() {
        let v = neuron_row_json(&sample_row(), 1);
        assert_eq!(v["trust"], json!(0.0));
    }
}
