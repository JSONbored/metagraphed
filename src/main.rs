// backfill-rs — fast historical Bittensor chain backfill (Rust / subxt 0.50).
//
// Replicates the EXACT semantics of the verified Python decoder
// (scripts/fetch-events.py + stream-events.decode_head + index-chain.rows_from_decoded)
// but with Rust-speed SCALE decode + tokio concurrency, so 12+ months of history
// backfills in hours instead of months. subxt 0.50's block-first API fetches the
// correct metadata per historical block automatically (cross-runtime safe).
//
// Output: blocks / extrinsics / account_events rows, idempotent COPY-to-staging +
// INSERT ... ON CONFLICT DO NOTHING into the same Postgres the live indexer writes.
//
// Env:
//   DATABASE_URL        postgres connection (the live sink; use the PUBLIC url locally)
//   EVENTS_RPC_URL      archive wss (default archive.chain.opentensor.ai)
//   BACKFILL_FROM       first block (default: BACKFILL_TO - 365*7200)
//   BACKFILL_TO         last block  (default: finalized head)
//   BACKFILL_CONCURRENCY in-flight block decodes (default 24)
//   BACKFILL_CHUNK      blocks per commit/progress step (default 2000)
//   BACKFILL_PROGRESS   local resume file (default ./progress.json)
//   VERIFY_BLOCKS       comma list: decode these blocks, print canonical JSON, exit
//                       (no DB writes) — used to diff against the python ground-truth.
//
// KNOWN ISSUE (2026-07-03, MITIGATED by ChainClient below): against our own
// metagraphed subtensor node while it is still catching up from genesis (rapidly
// importing many blocks/sec, as opposed to steady-state ~1 block/12s), both
// connect_chain()'s initial api.at_current_block() call and later
// at.at_block()-per-block metadata fetches can hang indefinitely (0% CPU, zero
// further websocket traffic, no error — NOT a slow response, a true stall).
// Root-caused via RUST_LOG=trace (this binary didn't wire up tracing_subscriber
// before this date, so RUST_LOG previously had zero effect — see main()): subxt
// 0.50's metadata-version probe falls back from archive_v1_call ("method not
// found") to chainHead_v1_call, which depends on a chainHead_v1_follow
// subscription, observed to receive an immediate {"event": "stop"} and require
// re-subscribing under heavy concurrent block import churn. Confirmed NOT a
// network/Tailscale/firewall issue: a raw (non-subxt) WebSocket client against
// the exact same node successfully completes state_getMetadata,
// chain_subscribeNewHeads, and chain_subscribeFinalizedHeads every time.
// Confirmed NOT specific to the reconnecting-rpc-client feature either (a plain
// OnlineClient::from_insecure_url client hangs identically). This is a known,
// still-open upstream gap (paritytech/subxt#2050) with no built-in fix; ChainClient
// (below) adds the app-level timeout + reconnect the subxt maintainers themselves
// recommend as the workaround.
//
// "MITIGATED", not "resolved": verified live 2026-07-03 that ChainClient's
// timeout+reconnect turns the silent indefinite hang into a bounded, clearly
// logged failure, and does recover once the underlying node calms down — but
// while our own node is CONTINUOUSLY under heavy import churn (as it was during
// this test, ~20% through its own historical catch-up), every reconnect attempt
// can also stall, since the root condition (the node itself) hasn't changed.
// EVENTS_RPC_URL should still point at a node already caught up to the chain tip
// (e.g. the public archive.chain.opentensor.ai) until our own node reaches
// steady-state; re-test against it then — ChainClient makes that eventual
// repoint safe against occasional stalls, it doesn't make repointing while
// still mid-sync viable.

use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use blake2::digest::consts::U32;
use blake2::{Blake2b, Digest};
use futures::stream::{self, StreamExt};
use scale_value::{Composite, Primitive, Value, ValueDef};
use subxt::config::substrate::DigestItem;
use subxt::config::PolkadotConfig;
use subxt::utils::AccountId32;
use subxt::OnlineClient;
use tokio::sync::{RwLock, Semaphore};

const BLOCKS_PER_DAY: u64 = 7200;
// finney ~12s block time; observed_at derived from height when a block's own
// Timestamp.set can't be decoded (see decode_block's fallback). Matches the
// same clock scripts/fetch-events.py already uses.
const BLOCK_MS: i64 = 12_000;

type Api = OnlineClient<PolkadotConfig>;

// KNOWN ISSUE fix (was "unresolved" above, 2026-07-03): subxt 0.50's per-block
// metadata fetch depends on a chainHead_v1_follow subscription that can silently
// stop emitting events (0% CPU, zero further websocket traffic, no error) --
// this is a known, still-open upstream gap (paritytech/subxt#2050), whose own
// maintainers' recommended fix is exactly this: an app-level timeout that
// recreates the subscription when nothing comes back in time, since subxt
// doesn't do this internally. `OnlineClient` is `Clone` (cheap, Arc-backed
// internally), so ChainClient holds one behind an RwLock and swaps in a fresh
// connection when a call stalls past RPC_STALL_TIMEOUT.
//
// A generation counter guards against a reconnect storm: if several concurrent
// callers (BACKFILL_CONCURRENCY > 1) all stall around the same time, only the
// first to notice actually reconnects -- everyone else sees the generation has
// already moved and just retries against the fresh client. In the currently
// DEPLOYED configuration (entrypoint.sh's sharding launcher pins each shard to
// BACKFILL_CONCURRENCY=1), there is at most one caller at a time, so this is
// pure defense-in-depth rather than a scenario this process actually hits.
//
// Verified live 2026-07-03 against our own archive node while it was rapidly
// importing blocks during its own historical catch-up (the exact reproducing
// condition): api.at_current_block() stalled with zero further websocket
// traffic, the 90s timeout fired, and reconnect_if_stale rebuilt a working
// connection -- confirming this is the real failure mode described below, and
// that a reconnect actually clears it. It also showed the stall isn't
// necessarily a one-off: a single reconnect-and-retry can still land on a
// second stall while the node is continuously under heavy import churn, so
// `call` retries a bounded number of times internally rather than reconnecting
// only once and handing a single failure back to the caller.
const RPC_STALL_TIMEOUT: Duration = Duration::from_secs(90);
const RPC_CALL_ATTEMPTS: u32 = 3;

struct ChainClient {
    url: String,
    api: RwLock<Api>,
    generation: AtomicU64,
}

impl ChainClient {
    async fn connect(url: String) -> Result<Self> {
        let api = connect_chain(&url).await?;
        Ok(Self {
            url,
            api: RwLock::new(api),
            generation: AtomicU64::new(0),
        })
    }

    /// The current client handle + the generation it was read at (cheap: Api
    /// clones are Arc-based internally, so this is a brief read-lock, not a
    /// hold-for-the-duration-of-an-RPC-call lock).
    async fn current(&self) -> (Api, u64) {
        let api = self.api.read().await.clone();
        (api, self.generation.load(Ordering::SeqCst))
    }

    /// Rebuild the connection, unless someone else already did since
    /// `seen_generation` was observed (checked again after acquiring the write
    /// lock, since another caller may have raced ahead while we were waiting).
    async fn reconnect_if_stale(&self, seen_generation: u64) -> Result<()> {
        if self.generation.load(Ordering::SeqCst) != seen_generation {
            return Ok(());
        }
        let mut guard = self.api.write().await;
        if self.generation.load(Ordering::SeqCst) != seen_generation {
            return Ok(());
        }
        eprintln!("chain client: reconnecting after a stalled RPC call ({RPC_STALL_TIMEOUT:?})");
        let fresh = connect_chain(&self.url).await?;
        *guard = fresh;
        self.generation.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    /// Run `f` against the current client, bounded by RPC_STALL_TIMEOUT, and
    /// RETRY internally (up to RPC_CALL_ATTEMPTS, with a short backoff) against
    /// a freshly reconnected client whenever a stall is detected — a single
    /// reconnect isn't guaranteed to land on a working attempt (verified live:
    /// a heavily-importing node can stall the very next call too), so this is
    /// a self-contained "call reliably through a stall" primitive rather than
    /// relying on every call site to also wrap it in its own retry loop. The
    /// existing per-block retry loops (backfill's inner 3-attempt + outer
    /// round-based retry) still apply on top of this for OTHER failure classes
    /// (e.g. rate-limit 429s from the public RPC) — the two compose fine.
    async fn call<T, F, Fut>(&self, mut f: F) -> Result<T>
    where
        F: FnMut(Api) -> Fut,
        Fut: Future<Output = Result<T>>,
    {
        let mut last_err: Option<anyhow::Error> = None;
        for attempt in 0..RPC_CALL_ATTEMPTS {
            let (api, generation) = self.current().await;
            match tokio::time::timeout(RPC_STALL_TIMEOUT, f(api)).await {
                Ok(Ok(value)) => return Ok(value),
                Ok(Err(e)) => last_err = Some(e),
                Err(_) => {
                    last_err = Some(anyhow::anyhow!(
                        "rpc call stalled past {RPC_STALL_TIMEOUT:?} (no response, chainHead \
                         subscription likely stopped emitting -- see paritytech/subxt#2050)"
                    ));
                    if let Err(reconnect_err) = self.reconnect_if_stale(generation).await {
                        return Err(reconnect_err.context("reconnect after a stalled rpc call"));
                    }
                }
            }
            if attempt + 1 < RPC_CALL_ATTEMPTS {
                tokio::time::sleep(Duration::from_millis(500 * (attempt as u64 + 1))).await;
            }
        }
        Err(last_err.unwrap_or_else(|| anyhow::anyhow!("rpc call failed with no error recorded")))
    }
}

// ---------------------------------------------------------------------------
// Row types (column order matches deploy/postgres/schema.sql exactly).
// Every field is pre-rendered to an Option<String> for COPY text format.
// ---------------------------------------------------------------------------
#[derive(Clone)]
struct BlockRow {
    block_number: i64,
    block_hash: String,
    parent_hash: Option<String>,
    author: Option<String>,
    extrinsic_count: i64,
    event_count: i64,
    spec_version: i64,
    observed_at: i64,
}

#[derive(Clone)]
struct ExtrinsicRow {
    block_number: i64,
    extrinsic_index: i64,
    extrinsic_hash: Option<String>,
    signer: Option<String>,
    call_module: Option<String>,
    call_function: Option<String>,
    success: Option<bool>,
    fee_tao: Option<String>,
    tip_tao: Option<String>,
    call_args: Option<String>, // compact JSON (display-only; differs from py format)
    observed_at: i64,
}

#[derive(Clone)]
struct EventRow {
    block_number: i64,
    event_index: i64,
    extrinsic_index: Option<i64>,
    event_kind: String,
    hotkey: Option<String>,
    coldkey: Option<String>,
    netuid: Option<i64>,
    uid: Option<i64>,
    amount_tao: Option<String>,
    alpha_amount: Option<String>,
    observed_at: i64,
}

// Generic all-events tier (schema `chain_events`): EVERY decoded event, all pallets/
// methods — the complete block-explorer record, not just the curated account_events.
#[derive(Clone)]
struct ChainEventRow {
    block_number: i64,
    event_index: i64,
    pallet: String,
    method: String,
    args: Option<String>, // compact JSON of the event fields (display; format differs from py)
    phase: String,
    extrinsic_index: Option<i64>,
    observed_at: i64,
}

#[derive(Default, Clone)]
struct DecodedBlock {
    block: Option<BlockRow>,
    extrinsics: Vec<ExtrinsicRow>,
    events: Vec<EventRow>,
    chain_events: Vec<ChainEventRow>,
}

// ---------------------------------------------------------------------------
// scale_value::Value helpers
// ---------------------------------------------------------------------------

/// The fields of a composite/event in declared (SCALE) order — matches how the
/// python extractors read positional `a[0], a[1], ...`. A non-composite is one field.
fn ordered_fields(v: &Value<()>) -> Vec<&Value<()>> {
    match &v.value {
        ValueDef::Composite(Composite::Named(kvs)) => kvs.iter().map(|(_, val)| val).collect(),
        ValueDef::Composite(Composite::Unnamed(vals)) => vals.iter().collect(),
        _ => vec![v],
    }
}

/// Recursively gather a byte string from nested composites of u8 primitives
/// (AccountId32 = newtype over [u8;32] → Unnamed([ Unnamed([u8;32]) ])).
fn collect_bytes(v: &Value<()>) -> Option<Vec<u8>> {
    match &v.value {
        ValueDef::Primitive(Primitive::U128(n)) if *n < 256 => Some(vec![*n as u8]),
        ValueDef::Primitive(Primitive::U256(b)) => Some(b.to_vec()),
        ValueDef::Composite(Composite::Named(kvs)) => {
            let mut out = Vec::new();
            for (_, val) in kvs {
                out.extend(collect_bytes(val)?);
            }
            Some(out)
        }
        ValueDef::Composite(Composite::Unnamed(vals)) => {
            let mut out = Vec::new();
            for val in vals {
                out.extend(collect_bytes(val)?);
            }
            Some(out)
        }
        _ => None,
    }
}

/// ss58 (Bittensor prefix 42) of a 32-byte account field, else None (py `_ss58`).
fn acct(v: &Value<()>) -> Option<String> {
    let b = collect_bytes(v)?;
    if b.len() == 32 {
        let mut a = [0u8; 32];
        a.copy_from_slice(&b);
        Some(AccountId32(a).to_string())
    } else {
        None
    }
}

/// The ss58 authority accounts from a decoded Aura.Authorities value (a Vec, possibly
/// wrapped in a BoundedVec/newtype). Each authority is an sr25519 32-byte public key.
fn authority_accounts(v: &Value<()>) -> Vec<String> {
    let top = ordered_fields(v);
    // Descend one level through a BoundedVec/newtype wrapper if the single child
    // isn't itself a 32-byte account.
    let list: Vec<&Value<()>> = if top.len() == 1 && acct(top[0]).is_none() {
        ordered_fields(top[0])
    } else {
        top
    };
    list.iter().filter_map(|a| acct(a)).collect()
}

/// Postgres `jsonb` cannot store ` ` (null). EVM/Ethereum event `data` (and
/// some call args) are raw bytes that serialize to a string full of ` `
/// escapes — one such row fails the WHOLE multi-row chain_events insert, silently
/// dropping every event in the chunk. Strip them so the event is still stored
/// (this is the verbatim display tier; exact EVM bytes come from the extrinsic).
fn strip_nul(s: String) -> String {
    if s.contains("\\u0000") {
        s.replace("\\u0000", "")
    } else {
        s
    }
}

/// Unwrap an unsigned integer primitive (peeling single-field newtype composites).
fn int_of(v: &Value<()>) -> Option<u128> {
    match &v.value {
        ValueDef::Primitive(Primitive::U128(n)) => Some(*n),
        ValueDef::Composite(Composite::Unnamed(vals)) if vals.len() == 1 => int_of(&vals[0]),
        ValueDef::Composite(Composite::Named(kvs)) if kvs.len() == 1 => int_of(&kvs[0].1),
        _ => None,
    }
}

/// py `_idx`: int in [0, 65535] else None.
fn idx_of(v: &Value<()>) -> Option<i64> {
    int_of(v).filter(|n| *n <= 65535).map(|n| n as i64)
}

/// py `_tao`: rao rendered as an EXACT TAO decimal string for Postgres NUMERIC.
/// Never routes through f64 (the old `n as f64 / RAO` here was the same precision-
/// loss shape as metagraphed#2588's "Mechanism B" -- an exact rao integer discarded
/// to a lossy double one line before rendering -- just for this Rust indexer's
/// Postgres sink, which #2588's D1/SQLite-REAL framing never covered). Postgres
/// NUMERIC is exact-precision, so an exact decimal string here is exact forever,
/// with no ~9M-TAO ceiling at all.
fn tao_str(v: &Value<()>) -> Option<String> {
    let rao = int_of(v)?;
    let whole = rao / 1_000_000_000;
    let frac = rao % 1_000_000_000;
    if frac == 0 {
        return Some(whole.to_string());
    }
    let mut frac_str = format!("{frac:09}");
    while frac_str.ends_with('0') {
        frac_str.pop();
    }
    Some(format!("{whole}.{frac_str}"))
}

fn nth<'a>(fields: &'a [&'a Value<()>], i: usize) -> Option<&'a Value<()>> {
    fields.get(i).copied()
}

// ---------------------------------------------------------------------------
// Event extraction — 1:1 port of fetch-events.py EXTRACTORS (read by position).
// Returns (hotkey, coldkey, netuid, uid, amount_tao, alpha_amount) or None when
// the python extractor would raise (too few positional fields) / kind unknown.
// ---------------------------------------------------------------------------
struct Ext {
    hotkey: Option<String>,
    coldkey: Option<String>,
    netuid: Option<i64>,
    uid: Option<i64>,
    amount_tao: Option<String>,
    alpha_amount: Option<String>,
}

fn extract(kind: &str, f: &[&Value<()>]) -> Option<Ext> {
    let none = Ext {
        hotkey: None,
        coldkey: None,
        netuid: None,
        uid: None,
        amount_tao: None,
        alpha_amount: None,
    };
    match kind {
        // _registered: [netuid, uid, hotkey] — a[0..2] required
        "NeuronRegistered" => {
            if f.len() < 3 {
                return None;
            }
            Some(Ext {
                netuid: idx_of(f[0]),
                uid: idx_of(f[1]),
                hotkey: acct(f[2]),
                ..none
            })
        }
        // _stake: [coldkey, hotkey, tao, alpha, netuid] — a[0..2] required
        "StakeAdded" | "StakeRemoved" => {
            if f.len() < 3 {
                return None;
            }
            Some(Ext {
                coldkey: acct(f[0]),
                hotkey: acct(f[1]),
                amount_tao: tao_str(f[2]),
                alpha_amount: nth(f, 3).and_then(tao_str),
                netuid: nth(f, 4).and_then(idx_of),
                uid: None,
            })
        }
        // _moved: [coldkey, hotkey, netuid] — a[0..1] required
        "StakeMoved" => {
            if f.len() < 2 {
                return None;
            }
            Some(Ext {
                coldkey: acct(f[0]),
                hotkey: acct(f[1]),
                netuid: nth(f, 2).and_then(idx_of),
                ..none
            })
        }
        // _axon: [netuid, hotkey] — a[0..1] required
        "AxonServed" => {
            if f.len() < 2 {
                return None;
            }
            Some(Ext {
                netuid: idx_of(f[0]),
                hotkey: acct(f[1]),
                ..none
            })
        }
        // _weights: [netuid, uid] — a[0..1] required
        "WeightsSet" => {
            if f.len() < 2 {
                return None;
            }
            Some(Ext {
                netuid: idx_of(f[0]),
                uid: idx_of(f[1]),
                ..none
            })
        }
        // _root: [coldkey] (guarded → always Some)
        "RootClaimed" => Some(Ext {
            coldkey: nth(f, 0).and_then(acct),
            ..none
        }),
        // _net: [netuid] (guarded)
        "NetworkAdded" | "NetworkRemoved" => Some(Ext {
            netuid: nth(f, 0).and_then(idx_of),
            ..none
        }),
        // _delegate_added: [coldkey, hotkey] (guarded)
        "DelegateAdded" => Some(Ext {
            coldkey: nth(f, 0).and_then(acct),
            hotkey: nth(f, 1).and_then(acct),
            ..none
        }),
        // _take_changed: [coldkey, hotkey, take] → hotkey=a1, coldkey=a0 (guarded)
        "TakeDecreased" | "TakeIncreased" => Some(Ext {
            coldkey: nth(f, 0).and_then(acct),
            hotkey: nth(f, 1).and_then(acct),
            ..none
        }),
        // _hotkey_swapped: [coldkey, old_hotkey, new_hotkey] → coldkey=a0, hotkey=a2 (guarded)
        "HotkeySwapped" => Some(Ext {
            coldkey: nth(f, 0).and_then(acct),
            hotkey: nth(f, 2).and_then(acct),
            ..none
        }),
        // _coldkey_swap: [old_coldkey, new_coldkey] → coldkey=a0, hotkey=a1 (guarded)
        "ColdkeySwapped" => Some(Ext {
            coldkey: nth(f, 0).and_then(acct),
            hotkey: nth(f, 1).and_then(acct),
            ..none
        }),
        // --- additional high-signal SubtensorModule events (per opentensor/subtensor
        // pallets/subtensor/src/macros/events.rs). Field order read by position, mirroring
        // the EXTRACTORS above; the curating account goes in hotkey/coldkey per the doc names.

        // CRV3WeightsCommitted(who, netuid, commit_hash) — commit by a hotkey signer.
        //   a0=who (hotkey), a1=netuid; commit_hash (a2) not curated.
        "CRV3WeightsCommitted" => {
            if f.len() < 2 {
                return None;
            }
            Some(Ext {
                hotkey: acct(f[0]),
                netuid: idx_of(f[1]),
                ..none
            })
        }
        // CRV3WeightsRevealed(netuid, who) — NOTE netuid-first (reverse of *Committed).
        //   a0=netuid, a1=who (hotkey).
        "CRV3WeightsRevealed" => {
            if f.len() < 2 {
                return None;
            }
            Some(Ext {
                netuid: idx_of(f[0]),
                hotkey: acct(f[1]),
                ..none
            })
        }
        // TimelockedWeightsCommitted(who, netuid, commit_hash, reveal_round) —
        //   a0=who (hotkey), a1=netuid; commit_hash (a2) and reveal_round (a3, a u64
        //   round number, NOT a balance) not curated.
        "TimelockedWeightsCommitted" => {
            if f.len() < 2 {
                return None;
            }
            Some(Ext {
                hotkey: acct(f[0]),
                netuid: idx_of(f[1]),
                ..none
            })
        }
        // TimelockedWeightsRevealed(netuid, who) — netuid-first like CRV3WeightsRevealed.
        //   a0=netuid, a1=who (hotkey).
        "TimelockedWeightsRevealed" => {
            if f.len() < 2 {
                return None;
            }
            Some(Ext {
                netuid: idx_of(f[0]),
                hotkey: acct(f[1]),
                ..none
            })
        }
        // AutoStakeAdded { netuid, destination, hotkey, owner, incentive } (named struct;
        // read positionally) — a0=netuid, a1=destination(acct, not curated), a2=hotkey,
        // a3=owner(coldkey), a4=incentive(alpha). The auto-staked alpha goes in alpha_amount.
        "AutoStakeAdded" => {
            if f.len() < 4 {
                return None;
            }
            Some(Ext {
                netuid: idx_of(f[0]),
                hotkey: acct(f[2]),
                coldkey: acct(f[3]),
                alpha_amount: nth(f, 4).and_then(tao_str),
                amount_tao: None,
                uid: None,
            })
        }
        // StakeSwapped(coldkey, hotkey, origin_netuid, destination_netuid, amount) —
        //   a0=coldkey, a1=hotkey, a2=origin_netuid (curated as netuid), a4=amount (TAO).
        //   destination_netuid (a3) not curated (single netuid column).
        "StakeSwapped" => {
            if f.len() < 2 {
                return None;
            }
            Some(Ext {
                coldkey: acct(f[0]),
                hotkey: acct(f[1]),
                netuid: nth(f, 2).and_then(idx_of),
                amount_tao: nth(f, 4).and_then(tao_str),
                uid: None,
                alpha_amount: None,
            })
        }
        // StakeTransferred(origin_coldkey, destination_coldkey, hotkey, origin_netuid,
        //   destination_netuid, amount) — a0=origin_coldkey (coldkey), a2=hotkey,
        //   a3=origin_netuid (netuid), a5=amount (TAO). destination_coldkey (a1) and
        //   destination_netuid (a4) not curated (single coldkey/netuid columns).
        "StakeTransferred" => {
            if f.len() < 3 {
                return None;
            }
            Some(Ext {
                coldkey: acct(f[0]),
                hotkey: acct(f[2]),
                netuid: nth(f, 3).and_then(idx_of),
                amount_tao: nth(f, 5).and_then(tao_str),
                uid: None,
                alpha_amount: None,
            })
        }
        // _transfer (Balances): [from, to, amount] → hotkey=from, coldkey=to (guarded)
        "Transfer" => Some(Ext {
            hotkey: nth(f, 0).and_then(acct),
            coldkey: nth(f, 1).and_then(acct),
            amount_tao: nth(f, 2).and_then(tao_str),
            ..none
        }),
        // --- additional Balances pallet events (substrate frame/balances Event enum).
        // Single-account balance movements: the account is stored in coldkey (the
        // wallet-level identity slot, as RootClaimed does), amount in amount_tao. These
        // carry no netuid. Names are Balances-pallet-unique (no SubtensorModule collision).

        // Deposit  { who, amount }      → coldkey=who,     amount=a1
        // Withdraw { who, amount }      → coldkey=who,     amount=a1
        // Reserved { who, amount }      → coldkey=who,     amount=a1
        // Unreserved { who, amount }    → coldkey=who,     amount=a1
        "Deposit" | "Withdraw" | "Reserved" | "Unreserved" => {
            if f.is_empty() {
                return None;
            }
            Some(Ext {
                coldkey: acct(f[0]),
                amount_tao: nth(f, 1).and_then(tao_str),
                ..none
            })
        }
        // Endowed  { account, free_balance } → coldkey=account, amount=free_balance(a1)
        // DustLost { account, amount }       → coldkey=account, amount=a1
        "Endowed" | "DustLost" => {
            if f.is_empty() {
                return None;
            }
            Some(Ext {
                coldkey: acct(f[0]),
                amount_tao: nth(f, 1).and_then(tao_str),
                ..none
            })
        }
        // Issued { amount } — no account; total-issuance change. amount=a0.
        "Issued" => Some(Ext {
            amount_tao: nth(f, 0).and_then(tao_str),
            ..none
        }),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Per-block decode
// ---------------------------------------------------------------------------
struct DecEvent {
    index: u32,
    pallet: String,
    variant: String,
    phase: String,
    extr_idx: Option<u32>,
    fields: Value<()>,
}

fn blake2_256(bytes: &[u8]) -> String {
    let mut h = Blake2b::<U32>::new();
    h.update(bytes);
    format!("0x{}", hex::encode(h.finalize()))
}

fn h256_hex<T: std::fmt::Debug>(h: &T) -> String {
    // subxt H256 Debug renders as 0x… ; normalize via Debug then trim.
    let s = format!("{:?}", h);
    s
}

/// Extracts just a block's own Timestamp.set value, without the rest of
/// decode_block's row-building — used only as the lazy fallback anchor below,
/// so it costs nothing on the normal (Timestamp.set present) path.
async fn block_timestamp(api: &Api, height: u64) -> Result<i64> {
    let at = api.at_block(height).await.context("at_block (timestamp lookup)")?;
    let extrinsics = at
        .extrinsics()
        .fetch()
        .await
        .context("extrinsics.fetch (timestamp lookup)")?;
    for ext in extrinsics.iter() {
        let ext = ext.context("extrinsic iter (timestamp lookup)")?;
        if ext.pallet_name() == "Timestamp" && ext.call_name() == "set" {
            if let Some(v) = ext.decode_call_data_fields_unchecked_as::<Value<()>>().ok() {
                let f = ordered_fields(&v);
                if let Some(ms) = nth(&f, 0).and_then(int_of) {
                    return Ok(ms as i64);
                }
            }
        }
    }
    anyhow::bail!("no Timestamp.set found in block #{height}")
}

async fn decode_block(api: &Api, height: u64, head: u64) -> Result<DecodedBlock> {
    let at = api.at_block(height).await.context("at_block")?;
    let block_hash = at.block_hash();
    let spec_version = at.spec_version() as i64;
    let header = at.block_header().await.context("header")?;

    // --- events: decode all into DecEvent (index, pallet, variant, phase, fields)
    let events = at.events().fetch().await.context("events.fetch")?;
    let mut decoded_events: Vec<DecEvent> = Vec::new();
    for ev in events.iter() {
        let ev = ev.context("event iter")?;
        let (phase, extr_idx) = match ev.phase() {
            subxt::events::Phase::ApplyExtrinsic(i) => ("ApplyExtrinsic".to_string(), Some(i)),
            subxt::events::Phase::Finalization => ("Finalization".to_string(), None),
            subxt::events::Phase::Initialization => ("Initialization".to_string(), None),
        };
        let fields: Value<()> = ev
            .decode_fields_unchecked_as::<Value<()>>()
            .unwrap_or_else(|_| Value::unnamed_composite(Vec::<Value<()>>::new()));
        decoded_events.push(DecEvent {
            index: ev.index(),
            pallet: ev.pallet_name().to_string(),
            variant: ev.event_name().to_string(),
            phase,
            extr_idx,
            fields,
        });
    }
    let event_count = decoded_events.len() as i64;

    // --- correlation maps from events (py _extrinsic_success_map / _fee_map / _tip_map)
    let mut success_map: HashMap<u32, bool> = HashMap::new();
    let mut fee_map: HashMap<u32, String> = HashMap::new();
    let mut tip_map: HashMap<u32, String> = HashMap::new();
    for e in &decoded_events {
        let Some(xi) = e.extr_idx else { continue };
        if e.pallet == "System" && (e.variant == "ExtrinsicSuccess" || e.variant == "ExtrinsicFailed")
        {
            success_map.insert(xi, e.variant == "ExtrinsicSuccess");
        }
        if e.pallet == "TransactionPayment" && e.variant == "TransactionFeePaid" {
            let f = ordered_fields(&e.fields); // [who, actual_fee, tip]
            if let Some(v) = nth(&f, 1).and_then(tao_str) {
                fee_map.insert(xi, v);
            }
            if let Some(v) = nth(&f, 2).and_then(tao_str) {
                tip_map.insert(xi, v);
            }
        }
    }

    // --- extrinsics: decode, find block timestamp from Timestamp.set inherent
    let extrinsics = at.extrinsics().fetch().await.context("extrinsics.fetch")?;
    let mut decoded_extr: Vec<(usize, String, String, Option<String>, Option<String>, Option<String>)> =
        Vec::new(); // (index, module, function, hash, signer, call_args_json)
    let mut observed_at: Option<i64> = None;
    for ext in extrinsics.iter() {
        let ext = ext.context("extrinsic iter")?;
        let index = ext.index() as usize;
        let module = ext.pallet_name().to_string();
        let function = ext.call_name().to_string();
        let xhash = blake2_256(ext.bytes());
        let signer = ext.address_bytes().and_then(|b| {
            // MultiAddress::Id(AccountId32) = [0x00, 32 bytes]
            if b.len() >= 33 && b[0] == 0 {
                let mut a = [0u8; 32];
                a.copy_from_slice(&b[1..33]);
                Some(AccountId32(a).to_string())
            } else {
                None
            }
        });
        let call_args_value = ext.decode_call_data_fields_unchecked_as::<Value<()>>().ok();
        if module == "Timestamp" && function == "set" {
            if let Some(v) = &call_args_value {
                let f = ordered_fields(v);
                if let Some(ms) = nth(&f, 0).and_then(int_of) {
                    observed_at = Some(ms as i64);
                }
            }
        }
        let call_args_json = call_args_value
            .as_ref()
            .and_then(|v| serde_json::to_string(v).ok())
            .map(strip_nul);
        decoded_extr.push((index, module, function, Some(xhash), signer, call_args_json));
    }
    let extrinsic_count = decoded_extr.len() as i64;

    // observed_at is BIGINT NOT NULL. A missing Timestamp.set decode is rare
    // (RPC/decode miss), but silently dropping the row (the old Python
    // behavior) permanently loses a backfill-range block that falls outside
    // any overlap/re-scan window (2026-07-04, closes the #1 gap class in
    // #2118). Fall back to a height-derived estimate anchored on `head`'s
    // real timestamp instead — same clock scripts/fetch-events.py uses.
    let ts = match observed_at {
        Some(t) => t,
        None => {
            let head_ts = block_timestamp(api, head)
                .await
                .context("head timestamp fallback")?;
            head_ts - (head as i64 - height as i64) * BLOCK_MS
        }
    };

    // --- account_events rows (py event_rows_for_events / decode_head)
    let mut event_rows = Vec::new();
    for e in &decoded_events {
        if e.pallet != "SubtensorModule" && e.pallet != "Balances" {
            continue;
        }
        let f = ordered_fields(&e.fields);
        let Some(x) = extract(&e.variant, &f) else {
            continue;
        };
        event_rows.push(EventRow {
            block_number: height as i64,
            event_index: e.index as i64,
            extrinsic_index: e.extr_idx.map(|i| i as i64),
            event_kind: e.variant.clone(),
            hotkey: x.hotkey,
            coldkey: x.coldkey,
            netuid: x.netuid,
            uid: x.uid,
            amount_tao: x.amount_tao,
            alpha_amount: x.alpha_amount,
            observed_at: ts,
        });
    }

    // --- chain_events rows: EVERY decoded event (all pallets/methods), the complete
    // all-events tier. args is a compact JSON of the event fields (display-only).
    let chain_event_rows: Vec<ChainEventRow> = decoded_events
        .iter()
        .map(|e| ChainEventRow {
            block_number: height as i64,
            event_index: e.index as i64,
            pallet: e.pallet.clone(),
            method: e.variant.clone(),
            args: serde_json::to_string(&e.fields).ok().map(strip_nul),
            phase: e.phase.clone(),
            extrinsic_index: e.extr_idx.map(|i| i as i64),
            observed_at: ts,
        })
        .collect();

    // --- extrinsic rows
    let extrinsic_rows = decoded_extr
        .into_iter()
        .map(|(index, module, function, xhash, signer, call_args)| ExtrinsicRow {
            block_number: height as i64,
            extrinsic_index: index as i64,
            extrinsic_hash: xhash,
            signer,
            call_module: if module.is_empty() { None } else { Some(module) },
            call_function: if function.is_empty() { None } else { Some(function) },
            success: success_map.get(&(index as u32)).copied(),
            fee_tao: fee_map.get(&(index as u32)).cloned(),
            tip_tao: tip_map.get(&(index as u32)).cloned(),
            call_args,
            observed_at: ts,
        })
        .collect();

    // --- block row.
    // author (Aura): PreRuntime digest slot -> Aura.Authorities[slot % n], ss58 —
    // matches the live indexer's _block_author exactly (a core block-explorer field).
    let mut slot: Option<u64> = None;
    for log in &header.digest.logs {
        if let DigestItem::PreRuntime(engine, data) = log {
            if engine == b"aura" && data.len() >= 8 {
                let mut s = [0u8; 8];
                s.copy_from_slice(&data[0..8]);
                slot = Some(u64::from_le_bytes(s));
                break;
            }
        }
    }
    // The authorities storage call is the 5th per-block RPC; under rate-limiting it can
    // transiently 429. Retry it internally so an Aura block NEVER silently loses its
    // author; escalate to the chunk round-retry only if it stays unavailable.
    let author: Option<String> = if let Some(slot) = slot {
        let mut auths_val = None;
        for t in 0..8u32 {
            let addr = subxt::dynamic::storage::<(), Value<()>>("Aura", "Authorities");
            if let Some(v) = at
                .storage()
                .fetch(addr, ())
                .await
                .ok()
                .and_then(|sv| sv.decode().ok())
            {
                auths_val = Some(v);
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(250 * (t as u64 + 1))).await;
        }
        let val = auths_val.context("aura authorities unavailable after retries")?;
        let auths = authority_accounts(&val);
        if auths.is_empty() {
            None
        } else {
            Some(auths[(slot as usize) % auths.len()].clone())
        }
    } else {
        None
    };
    let parent_hash = h256_hex(&header.parent_hash);
    let block = BlockRow {
        block_number: height as i64,
        block_hash: h256_hex(&block_hash),
        parent_hash: Some(parent_hash),
        author,
        extrinsic_count,
        event_count,
        spec_version,
        observed_at: ts,
    };

    Ok(DecodedBlock {
        block: Some(block),
        extrinsics: extrinsic_rows,
        events: event_rows,
        chain_events: chain_event_rows,
    })
}

// ---------------------------------------------------------------------------
// Postgres: COPY into TEMP staging, then INSERT ... ON CONFLICT DO NOTHING.
// ---------------------------------------------------------------------------
fn copy_escape(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('\t', "\\t")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
}
fn cell(v: &Option<String>) -> String {
    match v {
        None => "\\N".to_string(),
        Some(s) => copy_escape(s),
    }
}
fn cell_i(v: i64) -> String {
    v.to_string()
}
fn cell_oi(v: &Option<i64>) -> String {
    match v {
        None => "\\N".to_string(),
        Some(n) => n.to_string(),
    }
}
fn cell_ob(v: &Option<bool>) -> String {
    match v {
        None => "\\N".to_string(),
        Some(b) => if *b { "t" } else { "f" }.to_string(),
    }
}

async fn flush(
    client: &mut tokio_postgres::Client,
    blocks: &[BlockRow],
    extrinsics: &[ExtrinsicRow],
    events: &[EventRow],
    chain_events: &[ChainEventRow],
) -> Result<()> {
    let tx = client.transaction().await?;
    tx.batch_execute(
        "CREATE TEMP TABLE s_blocks (LIKE blocks) ON COMMIT DROP;
         CREATE TEMP TABLE s_extrinsics (LIKE extrinsics) ON COMMIT DROP;
         CREATE TEMP TABLE s_events (LIKE account_events) ON COMMIT DROP;
         CREATE TEMP TABLE s_chain_events (LIKE chain_events) ON COMMIT DROP;",
    )
    .await?;

    // blocks
    {
        let sink = tx
            .copy_in("COPY s_blocks (block_number,block_hash,parent_hash,author,extrinsic_count,event_count,spec_version,observed_at) FROM STDIN")
            .await?;
        let mut buf = String::new();
        for b in blocks {
            buf.push_str(&format!(
                "{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\n",
                cell_i(b.block_number),
                copy_escape(&b.block_hash),
                cell(&b.parent_hash),
                cell(&b.author),
                cell_i(b.extrinsic_count),
                cell_i(b.event_count),
                cell_i(b.spec_version),
                cell_i(b.observed_at),
            ));
        }
        copy_send(sink, buf).await?;
    }
    // extrinsics
    {
        let sink = tx
            .copy_in("COPY s_extrinsics (block_number,extrinsic_index,extrinsic_hash,signer,call_module,call_function,success,fee_tao,tip_tao,call_args,observed_at) FROM STDIN")
            .await?;
        let mut buf = String::new();
        for x in extrinsics {
            buf.push_str(&format!(
                "{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\n",
                cell_i(x.block_number),
                cell_i(x.extrinsic_index),
                cell(&x.extrinsic_hash),
                cell(&x.signer),
                cell(&x.call_module),
                cell(&x.call_function),
                cell_ob(&x.success),
                cell(&x.fee_tao),
                cell(&x.tip_tao),
                cell(&x.call_args),
                cell_i(x.observed_at),
            ));
        }
        copy_send(sink, buf).await?;
    }
    // account_events
    {
        let sink = tx
            .copy_in("COPY s_events (block_number,event_index,extrinsic_index,event_kind,hotkey,coldkey,netuid,uid,amount_tao,alpha_amount,observed_at) FROM STDIN")
            .await?;
        let mut buf = String::new();
        for e in events {
            buf.push_str(&format!(
                "{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\n",
                cell_i(e.block_number),
                cell_i(e.event_index),
                cell_oi(&e.extrinsic_index),
                copy_escape(&e.event_kind),
                cell(&e.hotkey),
                cell(&e.coldkey),
                cell_oi(&e.netuid),
                cell_oi(&e.uid),
                cell(&e.amount_tao),
                cell(&e.alpha_amount),
                cell_i(e.observed_at),
            ));
        }
        copy_send(sink, buf).await?;
    }
    // chain_events (ALL events)
    {
        let sink = tx
            .copy_in("COPY s_chain_events (block_number,event_index,pallet,method,args,phase,extrinsic_index,observed_at) FROM STDIN")
            .await?;
        let mut buf = String::new();
        for e in chain_events {
            buf.push_str(&format!(
                "{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\n",
                cell_i(e.block_number),
                cell_i(e.event_index),
                copy_escape(&e.pallet),
                copy_escape(&e.method),
                cell(&e.args),
                copy_escape(&e.phase),
                cell_oi(&e.extrinsic_index),
                cell_i(e.observed_at),
            ));
        }
        copy_send(sink, buf).await?;
    }

    // blocks: DO UPDATE so a re-pass backfills author/parent_hash onto rows written
    // by an earlier author-less run (values are identical to the live indexer's).
    // extrinsics/events: DO NOTHING — their data is complete on first write.
    //
    // Conflict targets include observed_at (2026-07-03 fix) to match
    // deploy/postgres/schema.sql's composite PKs — required because a
    // TimescaleDB hypertable partitioned on observed_at rejects any unique
    // constraint that doesn't include the partition column. observed_at is
    // already determined by block_number (one timestamp per block), so this
    // doesn't change real-world uniqueness, just the constraint shape.
    tx.batch_execute(
        "INSERT INTO blocks SELECT * FROM s_blocks ON CONFLICT (block_number, observed_at) DO UPDATE SET
            block_hash = EXCLUDED.block_hash, parent_hash = EXCLUDED.parent_hash,
            author = EXCLUDED.author, extrinsic_count = EXCLUDED.extrinsic_count,
            event_count = EXCLUDED.event_count, spec_version = EXCLUDED.spec_version;
         INSERT INTO extrinsics SELECT * FROM s_extrinsics ON CONFLICT (block_number, extrinsic_index, observed_at) DO NOTHING;
         INSERT INTO account_events SELECT * FROM s_events ON CONFLICT (block_number, event_index, observed_at) DO NOTHING;
         INSERT INTO chain_events SELECT * FROM s_chain_events ON CONFLICT (block_number, event_index, observed_at) DO NOTHING;",
    )
    .await?;
    tx.commit().await?;
    Ok(())
}

async fn copy_send(
    sink: tokio_postgres::CopyInSink<bytes::Bytes>,
    buf: String,
) -> Result<()> {
    use futures::SinkExt;
    futures::pin_mut!(sink);
    sink.send(bytes::Bytes::from(buf)).await?;
    sink.close().await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------
async fn connect_chain(url: &str) -> Result<Api> {
    // Reconnecting client: a multi-hour backfill WILL see the archive drop the WSS
    // socket; without auto-reconnect every call after the first drop fails (verified).
    // request_timeout is the critical one: a throttled/wedged upstream that drops a
    // request on the floor (no error, no close) would otherwise leave the in-flight
    // decode futures awaiting forever — the whole run wedges alive-but-frozen with no
    // log line (the exact failure mode that silently stalled the metered run). A
    // bounded timeout turns that into an Err the retry loop recovers from (a dead/
    // half-open socket surfaces as a timed-out request within 60s rather than never).
    use subxt::rpcs::client::{ReconnectingRpcClient, RpcClient};
    eprintln!("connect_chain: building reconnecting rpc client -> {url}");
    let inner = ReconnectingRpcClient::builder()
        .request_timeout(Duration::from_secs(60))
        .connection_timeout(Duration::from_secs(20))
        .build(url.to_string())
        .await
        .map_err(|e| anyhow::anyhow!("reconnecting rpc build: {e}"))?;
    eprintln!("connect_chain: reconnecting rpc client built, wrapping RpcClient");
    let rpc_client = RpcClient::new(inner);
    eprintln!("connect_chain: calling OnlineClient::from_rpc_client");
    let api = OnlineClient::<PolkadotConfig>::from_rpc_client(rpc_client)
        .await
        .context("online client")?;
    eprintln!("connect_chain: OnlineClient ready");
    Ok(api)
}

async fn connect_pg(url: &str) -> Result<tokio_postgres::Client> {
    let (client, conn) = tokio_postgres::connect(url, tokio_postgres::NoTls)
        .await
        .context("pg connect")?;
    tokio::spawn(async move {
        if let Err(e) = conn.await {
            eprintln!("pg connection error: {e}");
        }
    });
    Ok(client)
}

// ---------------------------------------------------------------------------
// Verify mode: decode blocks, print canonical JSON, no DB.
// ---------------------------------------------------------------------------
fn jstr(v: &Option<String>) -> serde_json::Value {
    match v {
        None => serde_json::Value::Null,
        Some(s) => serde_json::Value::String(s.clone()),
    }
}
fn ji(v: i64) -> serde_json::Value {
    serde_json::Value::Number(v.into())
}
fn joi(v: &Option<i64>) -> serde_json::Value {
    match v {
        None => serde_json::Value::Null,
        Some(n) => serde_json::Value::Number((*n).into()),
    }
}
// amount stored as NUMERIC text; for the diff emit it as a JSON number (matches
// python json of a float) when it parses, else string.
fn jnum(v: &Option<String>) -> serde_json::Value {
    match v {
        None => serde_json::Value::Null,
        Some(s) => s
            .parse::<f64>()
            .ok()
            .and_then(serde_json::Number::from_f64)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::String(s.clone())),
    }
}

fn block_to_json(d: &DecodedBlock, height: u64) -> serde_json::Value {
    use serde_json::json;
    let blocks: Vec<_> = d
        .block
        .iter()
        .map(|b| {
            json!({
                "block_number": ji(b.block_number),
                "block_hash": b.block_hash,
                "parent_hash": jstr(&b.parent_hash),
                "author": jstr(&b.author),
                "extrinsic_count": ji(b.extrinsic_count),
                "event_count": ji(b.event_count),
                "spec_version": ji(b.spec_version),
                "observed_at": ji(b.observed_at),
            })
        })
        .collect();
    let extrinsics: Vec<_> = d
        .extrinsics
        .iter()
        .map(|x| {
            json!({
                "block_number": ji(x.block_number),
                "extrinsic_index": ji(x.extrinsic_index),
                "extrinsic_hash": jstr(&x.extrinsic_hash),
                "signer": jstr(&x.signer),
                "call_module": jstr(&x.call_module),
                "call_function": jstr(&x.call_function),
                "success": match x.success { None => serde_json::Value::Null, Some(b) => serde_json::Value::Bool(b) },
                "fee_tao": jnum(&x.fee_tao),
                "tip_tao": jnum(&x.tip_tao),
                "observed_at": ji(x.observed_at),
            })
        })
        .collect();
    let events: Vec<_> = d
        .events
        .iter()
        .map(|e| {
            json!({
                "block_number": ji(e.block_number),
                "event_index": ji(e.event_index),
                "extrinsic_index": joi(&e.extrinsic_index),
                "event_kind": e.event_kind,
                "hotkey": jstr(&e.hotkey),
                "coldkey": jstr(&e.coldkey),
                "netuid": joi(&e.netuid),
                "uid": joi(&e.uid),
                "amount_tao": jnum(&e.amount_tao),
                "alpha_amount": jnum(&e.alpha_amount),
                "observed_at": ji(e.observed_at),
            })
        })
        .collect();
    let chain_events: Vec<_> = d
        .chain_events
        .iter()
        .map(|e| {
            json!({
                "block_number": ji(e.block_number),
                "event_index": ji(e.event_index),
                "pallet": e.pallet,
                "method": e.method,
                "phase": e.phase,
                "extrinsic_index": joi(&e.extrinsic_index),
                "observed_at": ji(e.observed_at),
            })
        })
        .collect();
    json!({"block": height, "rows": {"blocks": blocks, "extrinsics": extrinsics, "account_events": events, "chain_events": chain_events}})
}

fn env_u64(k: &str) -> Option<u64> {
    std::env::var(k).ok().and_then(|v| v.parse().ok())
}

/// Highest block already in Postgres = the live frontier (the backfill only writes
/// the historical range *below* it), so it doubles as the live indexer's cursor.
async fn db_max_block(pg: &tokio_postgres::Client) -> Result<u64> {
    let row = pg
        .query_one("SELECT coalesce(max(block_number), 0) FROM blocks", &[])
        .await?;
    let m: i64 = row.get(0);
    Ok(m as u64)
}

/// LIVE mode (INDEX_MODE=live): follow the head forward at conc=1 — sequential, so
/// the subxt metadata-cache concurrency deadlock cannot occur — decoding + flushing
/// each new block. Replaces the Python index-chain.py. Resumes from the live
/// frontier; idempotent upserts make overlap with the backfill (and restarts) free.
///
/// Re: #2118's other two gap classes (written against the retired Python
/// indexer) — neither applies here, by design, not by omission:
///   - "silent gap fast-forward past EVENTS_MAX_LOOKBACK": this loop has no
///     lookback bound at all. A long outage just means a longer sequential
///     catch-up from `cursor` to `head` next tick, never a skip.
///   - "idle connection across a blocking subscribe": there is no blocking
///     subscribe — this polls `api.at_current_block()` once per `poll`
///     interval, so the pg connection is never idle for an extended stretch.
async fn run_live(client: &ChainClient, pg: &mut tokio_postgres::Client) -> Result<()> {
    let poll = env_u64("LIVE_POLL_SECS").unwrap_or(6);
    let head0 = client
        .call(|api| async move { Ok(api.at_current_block().await?.block_number()) })
        .await?;
    let mut cursor = db_max_block(pg).await?;
    if cursor == 0 {
        cursor = head0.saturating_sub(1);
    }
    eprintln!(
        "live indexer: head=#{head0}, resume@#{} (poll {poll}s, conc=1)",
        cursor + 1
    );
    let mut n: u64 = 0;
    loop {
        let head = client
            .call(|api| async move { Ok(api.at_current_block().await?.block_number()) })
            .await?;
        while cursor < head {
            let h = cursor + 1;
            let d = match client.call(|api| async move { decode_block(&api, h, head).await }).await {
                Ok(d) => d,
                Err(e) => {
                    eprintln!("live: #{h} decode failed ({e:#}) — retry next tick");
                    break;
                }
            };
            let blocks: Vec<_> = d.block.into_iter().collect();
            flush(pg, &blocks, &d.extrinsics, &d.events, &d.chain_events)
                .await
                .with_context(|| format!("live flush #{h}"))?;
            cursor = h;
            n += 1;
            if n % 20 == 0 {
                eprintln!(
                    "live: #{h} · {} extr · {} ce",
                    d.extrinsics.len(),
                    d.chain_events.len()
                );
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(poll)).await;
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let rpc_url = std::env::var("EVENTS_RPC_URL")
        .unwrap_or_else(|_| "wss://archive.chain.opentensor.ai:443".to_string());
    let client = Arc::new(ChainClient::connect(rpc_url.clone()).await?);
    eprintln!("main: connect_chain returned, api ready");

    // VERIFY mode: decode the given blocks, print canonical JSON, exit (no DB).
    if let Ok(list) = std::env::var("VERIFY_BLOCKS") {
        let head = client
            .call(|api| async move { Ok(api.at_current_block().await?.block_number()) })
            .await?;
        for tok in list.split(',').filter(|s| !s.trim().is_empty()) {
            let h: u64 = tok.trim().parse()?;
            match client.call(|api| async move { decode_block(&api, h, head).await }).await {
                Ok(d) => println!("{}", block_to_json(&d, h)),
                Err(e) => println!("{}", serde_json::json!({"block": h, "error": format!("{e:#}")})),
            }
        }
        return Ok(());
    }

    let db_url = std::env::var("DATABASE_URL").context("DATABASE_URL required")?;
    let mut pg = connect_pg(&db_url).await?;

    // LIVE mode: follow the head forward (replaces the Python index-chain.py).
    if std::env::var("INDEX_MODE").as_deref() == Ok("live") {
        eprintln!("main: entering run_live");
        return run_live(&client, &mut pg).await;
    }

    eprintln!("main: calling api.at_current_block()");
    let head = client
        .call(|api| async move { Ok(api.at_current_block().await?.block_number()) })
        .await?;
    eprintln!("main: at_current_block returned head={head}");
    let to = env_u64("BACKFILL_TO").unwrap_or(head);
    let from = env_u64("BACKFILL_FROM").unwrap_or_else(|| to.saturating_sub(365 * BLOCKS_PER_DAY));
    let concurrency = env_u64("BACKFILL_CONCURRENCY").unwrap_or(12) as usize;
    let chunk = env_u64("BACKFILL_CHUNK").unwrap_or(2000);
    let progress_path =
        std::env::var("BACKFILL_PROGRESS").unwrap_or_else(|_| "progress.json".to_string());

    let resume = std::fs::read_to_string(&progress_path)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| {
            let pf = v.get("from")?.as_u64()?;
            let pt = v.get("to")?.as_u64()?;
            if pf == from && pt == to {
                v.get("completed_through")?.as_u64()
            } else {
                None
            }
        });
    let start = match resume {
        Some(done) => done + 1,
        None => from,
    };

    eprintln!(
        "backfill #{from}..#{to} (head={head}, resume@#{start}, conc={concurrency}, chunk={chunk}, rpc={rpc_url})"
    );
    let total = to.saturating_sub(from) + 1;
    let mut next = start;
    let t0 = std::time::Instant::now();
    let mut done_blocks: u64 = start.saturating_sub(from);

    while next <= to {
        let chunk_end = (next + chunk - 1).min(to);
        // Decode the whole chunk; RETRY failed blocks (rate-limit 429s) in rounds so
        // a chunk only commits when EVERY block decoded — no silent gaps.
        let mut pending: Vec<u64> = (next..=chunk_end).collect();
        let mut decoded_all: Vec<DecodedBlock> = Vec::new();
        let mut round = 0u32;
        while !pending.is_empty() {
            round += 1;
            let sem = Arc::new(Semaphore::new(concurrency));
            let results: Vec<(u64, std::result::Result<DecodedBlock, anyhow::Error>)> =
                stream::iter(pending.clone())
                    .map(|h| {
                        let client = client.clone();
                        let sem = sem.clone();
                        async move {
                            let _p = sem.acquire_owned().await.unwrap();
                            let mut last: Option<anyhow::Error> = None;
                            for t in 0..3u32 {
                                match client.call(|api| async move { decode_block(&api, h, head).await }).await {
                                    Ok(d) => return (h, Ok(d)),
                                    Err(e) => {
                                        last = Some(e);
                                        tokio::time::sleep(std::time::Duration::from_millis(
                                            200 * (t as u64 + 1),
                                        ))
                                        .await;
                                    }
                                }
                            }
                            (h, Err(last.unwrap()))
                        }
                    })
                    .buffer_unordered(concurrency)
                    .collect()
                    .await;
            let mut failed = Vec::new();
            for (h, r) in results {
                match r {
                    Ok(d) => decoded_all.push(d),
                    Err(_) => failed.push(h),
                }
            }
            pending = failed;
            if !pending.is_empty() {
                let backoff = 2u64.pow(round.min(5)).min(30);
                eprintln!(
                    "  chunk #{next}..#{chunk_end}: {} blocks failed (round {round}) — backoff {backoff}s",
                    pending.len()
                );
                tokio::time::sleep(std::time::Duration::from_secs(backoff)).await;
                if round > 40 {
                    anyhow::bail!(
                        "chunk #{next}..#{chunk_end} stuck: {} blocks still failing",
                        pending.len()
                    );
                }
            }
        }

        let mut blocks = Vec::new();
        let mut extr = Vec::new();
        let mut evs = Vec::new();
        let mut chain_evs = Vec::new();
        for d in decoded_all {
            if let Some(b) = d.block {
                blocks.push(b);
            }
            extr.extend(d.extrinsics);
            evs.extend(d.events);
            chain_evs.extend(d.chain_events);
        }
        flush(&mut pg, &blocks, &extr, &evs, &chain_evs)
            .await
            .with_context(|| format!("flush chunk #{next}..#{chunk_end}"))?;

        std::fs::write(
            &progress_path,
            serde_json::to_string(&serde_json::json!({
                "from": from, "to": to, "completed_through": chunk_end
            }))?,
        )?;
        done_blocks += chunk_end - next + 1;
        let rate = done_blocks as f64 / t0.elapsed().as_secs_f64().max(0.001);
        let remaining = (to - chunk_end) as f64 / rate.max(0.001);
        eprintln!(
            "#{chunk_end} done · {done_blocks}/{total} · {rate:.1} blk/s · ~{:.1}h left · b={} x={} e={} ce={}",
            remaining / 3600.0,
            blocks.len(),
            extr.len(),
            evs.len(),
            chain_evs.len()
        );
        next = chunk_end + 1;
    }
    eprintln!("backfill complete #{from}..#{to}");
    Ok(())
}
