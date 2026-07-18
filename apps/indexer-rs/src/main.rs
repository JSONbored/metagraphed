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

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use blake2::digest::consts::U32;
use blake2::{Blake2b, Digest};
use futures::stream::{self, StreamExt};
use scale_info::{PortableRegistry, TypeDef, TypeDefPrimitive};
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

fn redact_rpc_url(url: &str) -> String {
    let scheme_end = url.find("://").map(|idx| idx + 3).unwrap_or(0);
    let after_scheme = &url[scheme_end..];
    let authority_len = after_scheme
        .find(|ch| matches!(ch, '/' | '?' | '#'))
        .unwrap_or(after_scheme.len());
    let (authority, rest) = after_scheme.split_at(authority_len);
    let safe_authority = authority
        .rsplit_once('@')
        .map(|(_, host)| host)
        .unwrap_or(authority);
    let path_len = rest
        .find(|ch| matches!(ch, '?' | '#'))
        .unwrap_or(rest.len());
    let safe_rest = &rest[..path_len];
    format!("{}{}{}", &url[..scheme_end], safe_authority, safe_rest)
}

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
// ---------------------------------------------------------------------------
// Call-arg type names (metagraphed#4724 D1/Postgres call_args parity)
// ---------------------------------------------------------------------------

/// Resolves a metadata type_id to a Rust-like display name, mirroring the
/// `type` string D1's Python poller (substrate-interface) already produces
/// for the same field via its own metadata walk -- e.g. "Vec<u16>",
/// "BTreeSet<NetUid>", "NetUid". Structural collection/compound kinds
/// (Sequence/Array/Tuple/Compact) are named from their SCALE shape directly,
/// regardless of any path-based alias, so a downstream consumer can key off a
/// reliable "Vec<"/"BTreeSet<"-style prefix even for a bounded/aliased
/// wrapper whose own path segment might otherwise be missing or differ from
/// D1's naming (see metagraphed's src/scale-normalize.mjs, which collapsed a
/// single-element Vec<u16>/BTreeSet<NetUid> to a bare scalar for exactly this
/// reason before that fix). Named types (structs, enums, chain type aliases
/// like NetUid/TaoBalance/MechId, and bounded collections like BoundedVec/
/// BTreeSet, which DO carry their own path) use the path's last segment, with
/// any generic type_params resolved recursively.
fn type_name(type_id: u32, registry: &PortableRegistry) -> String {
    type_name_inner(type_id, registry, &mut HashSet::new())
}

// Substrate/SCALE metadata is a runtime data structure, not compiler-checked
// Rust source -- nothing stops a type graph from being genuinely cyclic (the
// chain's own RuntimeCall is exactly this: Utility.batch's Vec<RuntimeCall>
// field references RuntimeCall's own type_id again). Recursing without
// tracking the current path would stack-overflow and crash the whole indexer
// process on any such type. `visited` is scoped to the CURRENT ancestor
// chain, not "every type_id ever seen" -- inserted on entry, removed on exit
// (backtracking), so a type appearing twice in SIBLING positions (e.g. a
// tuple of two Vec<u16> fields) is correctly resolved twice, not misreported
// as cyclic.
fn type_name_inner(
    type_id: u32,
    registry: &PortableRegistry,
    visited: &mut HashSet<u32>,
) -> String {
    if !visited.insert(type_id) {
        return format!("Cyclic<{type_id}>");
    }
    let name = type_name_uncycled(type_id, registry, visited);
    visited.remove(&type_id);
    name
}

fn type_name_uncycled(
    type_id: u32,
    registry: &PortableRegistry,
    visited: &mut HashSet<u32>,
) -> String {
    let Some(ty) = registry.resolve(type_id) else {
        return format!("Unknown<{type_id}>");
    };
    // Every UntrackedSymbol<TypeId> below (type_param/ty/tuple element) is an
    // opaque wrapper around the same u32 index resolve() takes -- .id()
    // unwraps it. Trips easily: PortableForm::Type is UntrackedSymbol<TypeId>,
    // NOT a bare u32, despite PortableRegistry::resolve()'s OWN argument
    // being a plain u32 (confirmed against scale-info 2.11.6's actual source,
    // not assumed).
    match &ty.type_def {
        TypeDef::Sequence(seq) => {
            return format!(
                "Vec<{}>",
                type_name_inner(seq.type_param.id, registry, visited)
            )
        }
        TypeDef::Array(arr) => {
            return format!(
                "[{}; {}]",
                type_name_inner(arr.type_param.id, registry, visited),
                arr.len
            )
        }
        TypeDef::Tuple(tup) => {
            let parts: Vec<String> = tup
                .fields
                .iter()
                .map(|id| type_name_inner(id.id, registry, visited))
                .collect();
            return format!("({})", parts.join(", "));
        }
        TypeDef::Compact(c) => {
            return format!(
                "Compact<{}>",
                type_name_inner(c.type_param.id, registry, visited)
            )
        }
        TypeDef::Primitive(p) => return primitive_name(p).to_string(),
        _ => {}
    }
    let ident = ty.path.ident().unwrap_or_else(|| "Unknown".to_string());
    if ty.type_params.is_empty() {
        ident
    } else {
        let parts: Vec<String> = ty
            .type_params
            .iter()
            .map(|p| {
                p.ty.map(|id| type_name_inner(id.id, registry, visited))
                    .unwrap_or_else(|| "_".to_string())
            })
            .collect();
        format!("{ident}<{}>", parts.join(", "))
    }
}

fn primitive_name(p: &TypeDefPrimitive) -> &'static str {
    match p {
        TypeDefPrimitive::Bool => "bool",
        TypeDefPrimitive::Char => "char",
        TypeDefPrimitive::Str => "str",
        TypeDefPrimitive::U8 => "u8",
        TypeDefPrimitive::U16 => "u16",
        TypeDefPrimitive::U32 => "u32",
        TypeDefPrimitive::U64 => "u64",
        TypeDefPrimitive::U128 => "u128",
        TypeDefPrimitive::U256 => "u256",
        TypeDefPrimitive::I8 => "i8",
        TypeDefPrimitive::I16 => "i16",
        TypeDefPrimitive::I32 => "i32",
        TypeDefPrimitive::I64 => "i64",
        TypeDefPrimitive::I128 => "i128",
        TypeDefPrimitive::I256 => "i256",
    }
}

/// Builds D1-shaped call_args JSON -- `[{name, type, value}, ...]` -- from an
/// extrinsic's already-decoded (name, type_id, value) field triples (see
/// `ExtrinsicCallDataField`/`iter_call_data_fields` at the call sites below,
/// which retain each field's type_id instead of decoding the whole call into
/// one type-erased `Value<()>` tree the way this used to work). This is the
/// #4724 fix: previously call_args was `serde_json::to_string()`-dumped
/// straight from a type-erased Value, giving indexer-rs's Postgres rows zero
/// type information for the Worker's serving layer to reconcile against.
fn call_args_json_from_fields(
    fields: Vec<(String, u32, Value<()>)>,
    registry: &PortableRegistry,
) -> serde_json::Value {
    serde_json::Value::Array(
        fields
            .into_iter()
            .map(|(name, type_id, value)| {
                serde_json::json!({
                    "name": name,
                    "type": type_name(type_id, registry),
                    "value": serde_json::to_value(&value).unwrap_or(serde_json::Value::Null),
                })
            })
            .collect(),
    )
}

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

/// metagraphed#5347: since block ~8460018, the chain's automatic weight-reveal
/// hook occasionally emits WeightsSet / TimelockedWeights{Committed,Revealed} /
/// CRV3Weights{Committed,Revealed} with a garbage `netuid` field (observed values
/// 4100-4200+, no such subnet has ever been registered -- confirmed via
/// NetworkAdded/NetworkRemoved history, max netuid ever 99, and via the event's
/// own hotkey/uid fields, which decode correctly and cross-reference to a real
/// neuron on a real, much lower netuid). hotkey (32 raw bytes, byte-perfect SS58)
/// decoding correctly while the preceding u16 netuid field is corrupted rules out
/// a byte-alignment/decode bug on our side -- this is upstream chain-side
/// corruption in that one field, isolated to the reveal-hook code path. Bound-check
/// and drop the field (NULL, not a guess) rather than write/serve it: 1024 is far
/// above today's ~129 active subnets and far below the observed garbage range.
const MAX_PLAUSIBLE_NETUID: i64 = 1024;

fn plausible_netuid(n: Option<i64>) -> Option<i64> {
    n.filter(|v| *v < MAX_PLAUSIBLE_NETUID)
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
                netuid: plausible_netuid(idx_of(f[0])),
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
                netuid: plausible_netuid(idx_of(f[1])),
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
                netuid: plausible_netuid(idx_of(f[0])),
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
                netuid: plausible_netuid(idx_of(f[1])),
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
                netuid: plausible_netuid(idx_of(f[0])),
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
        // --- subnet leasing (#6718, pallet_subtensor::subnets::leasing) + the standalone
        // Crowdloan pallet it's built on (per opentensor/subtensor's leasing.rs / crowdloan
        // pallet's lib.rs, verified against live source 2026-07-18). A crowdfunded,
        // time-boxed primary market for NEW subnets -- distinct from the
        // already-curated subnet-ownership-CONTEST events (an existing subnet changing
        // hands), which this doesn't touch.

        // SubnetLeaseCreated { beneficiary, lease_id, netuid, end_block } —
        //   a0=beneficiary (coldkey), a2=netuid. lease_id (a1) and end_block (a3,
        //   Option<BlockNumber>) not curated (no dedicated column).
        "SubnetLeaseCreated" => {
            if f.len() < 3 {
                return None;
            }
            Some(Ext {
                coldkey: acct(f[0]),
                netuid: nth(f, 2).and_then(idx_of),
                ..none
            })
        }
        // SubnetLeaseTerminated { beneficiary, netuid } — a0=beneficiary (coldkey), a1=netuid.
        "SubnetLeaseTerminated" => {
            if f.len() < 2 {
                return None;
            }
            Some(Ext {
                coldkey: acct(f[0]),
                netuid: nth(f, 1).and_then(idx_of),
                ..none
            })
        }
        // SubnetLeaseDividendsDistributed { lease_id, contributor, alpha } —
        //   a1=contributor (coldkey), a2=alpha (alpha_amount). lease_id (a0) not curated;
        //   no netuid on this event directly -- resolving lease_id -> netuid needs a live
        //   SubnetUidToLeaseId storage lookup, which this positional-only decoder
        //   deliberately never does (same reasoning StakeSwapped/StakeTransferred already
        //   apply to their own not-fully-curated fields).
        "SubnetLeaseDividendsDistributed" => {
            if f.len() < 3 {
                return None;
            }
            Some(Ext {
                coldkey: acct(f[1]),
                alpha_amount: tao_str(f[2]),
                ..none
            })
        }
        // Crowdloan.Contributed { crowdloan_id, contributor, amount } —
        //   a1=contributor (coldkey), a2=amount (TAO). crowdloan_id (a0) not curated (no
        //   netuid equivalent -- a crowdloan can target a not-yet-created subnet). Deliberately
        //   NOT curating Crowdloan.Created here: it declares a cap/end, no tao actually moves
        //   until a Contributed follows, so there's no amount to attribute to an account yet.
        "Contributed" => {
            if f.len() < 3 {
                return None;
            }
            Some(Ext {
                coldkey: acct(f[1]),
                amount_tao: tao_str(f[2]),
                ..none
            })
        }
        // Crowdloan.Withdrew { crowdloan_id, contributor, amount } — same shape as Contributed
        // (a contributor pulling their own funds back before finalization).
        "Withdrew" => {
            if f.len() < 3 {
                return None;
            }
            Some(Ext {
                coldkey: acct(f[1]),
                amount_tao: tao_str(f[2]),
                ..none
            })
        }
        // --- child-hotkey delegation graph (#6722, part of epic #6721,
        // pallet_subtensor::staking::set_children, verified against live
        // opentensor/subtensor source 2026-07-18). We already serve the
        // BOUNDS (take-ratio limits, cooldown as hyperparameters); this
        // captures the lifecycle events for the live graph itself
        // (#6723 reads the CURRENT state live from chain, not from this
        // history). The pallet's own `SetChildren` event (fired when a
        // scheduled change is actually APPLIED after cooldown, or applied
        // immediately) is deliberately NOT curated here -- it carries no
        // new information beyond what SetChildrenScheduled already
        // recorded (the children list was fixed at schedule time; cooldown
        // is a mechanical delay, not a new decision), so it would only be a
        // duplicate history row.

        // SetChildrenScheduled(hotkey, netuid, cooldown_block, children) —
        //   a plain tuple event (not a named struct): a0=hotkey, a1=netuid.
        //   cooldown_block (a2) and children (a3, Vec<(u64, AccountId)>) not
        //   curated -- no dedicated columns for a variable-length list; the
        //   live delegation graph itself is served by #6723, not derived
        //   from this history.
        "SetChildrenScheduled" => {
            if f.len() < 2 {
                return None;
            }
            Some(Ext {
                hotkey: acct(f[0]),
                netuid: nth(f, 1).and_then(idx_of),
                ..none
            })
        }
        // ChildKeyTakeSet(hotkey, take) — a plain tuple event: a0=hotkey.
        // No netuid on this event at all (a real chain-level omission, not
        // a decode gap -- the underlying storage write IS per-(hotkey,
        // netuid), per ChildkeyTake::<T>::insert(hotkey, netuid, take), but
        // the event itself only carries the hotkey). take (a1) not curated
        // (no dedicated column for a PerU16 ratio).
        "ChildKeyTakeSet" => {
            if f.is_empty() {
                return None;
            }
            Some(Ext {
                hotkey: acct(f[0]),
                ..none
            })
        }
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
    let at = api
        .at_block(height)
        .await
        .context("at_block (timestamp lookup)")?;
    let extrinsics = at
        .extrinsics()
        .fetch()
        .await
        .context("extrinsics.fetch (timestamp lookup)")?;
    for ext in extrinsics.iter() {
        let ext = ext.context("extrinsic iter (timestamp lookup)")?;
        if ext.pallet_name() == "Timestamp" && ext.call_name() == "set" {
            // Timestamp.set has exactly one field ("now") -- decode it
            // directly via the per-field iterator (metagraphed#4724) rather
            // than the whole-call Value<()> tree; int_of still unwraps a
            // single-field newtype composite the same way either path would.
            if let Some(ms) = ext
                .iter_call_data_fields()
                .next()
                .and_then(|f| f.decode_as::<Value<()>>().ok())
                .and_then(|v| int_of(&v))
            {
                return Ok(ms as i64);
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
    // Borrowed for the lifetime of `at` -- reused for every extrinsic's
    // call_args type resolution below (metagraphed#4724), no per-field or
    // per-extrinsic metadata re-fetch.
    let registry = at.metadata_ref().types();

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
        let fields: Value<()> = ev.decode_fields_unchecked_as::<Value<()>>().unwrap_or_else(|e| {
            // A genuinely undecodable event (metadata/type-resolution mismatch,
            // not the ordinary zero-field case -- Utility.ItemCompleted and
            // friends decode fine to an empty composite via the Ok path above,
            // never hitting this branch). Still write the chain_events row
            // (correct pallet/method/phase/index) rather than dropping it, but
            // log so a real gap in args is DISCOVERABLE instead of silently
            // indistinguishable from a legitimately unit-payload event.
            eprintln!(
                "decode_block #{height}: event #{} {}.{} fields decode failed ({e:#}) -- args will be empty",
                ev.index(),
                ev.pallet_name(),
                ev.event_name(),
            );
            Value::unnamed_composite(Vec::<Value<()>>::new())
        });
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
        if e.pallet == "System"
            && (e.variant == "ExtrinsicSuccess" || e.variant == "ExtrinsicFailed")
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
    let mut decoded_extr: Vec<(
        usize,
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
    )> = Vec::new(); // (index, module, function, hash, signer, call_args_json)
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
        // Per-field iterator (metagraphed#4724) -- retains each field's own
        // type_id (via ExtrinsicCallDataField) instead of decoding the whole
        // call into one type-erased Value<()> tree, so call_args_json below
        // can carry a {name, type, value} triple per field like D1's own
        // call_args shape, rather than zero type information.
        let call_args_fields: Vec<(String, u32, Value<()>)> = ext
            .iter_call_data_fields()
            .filter_map(|f| {
                let name = f.name().to_string();
                let type_id = f.type_id();
                match f.decode_as::<Value<()>>() {
                    Ok(v) => Some((name, type_id, v)),
                    Err(e) => {
                        // A single field silently missing from call_args is
                        // otherwise indistinguishable from a call whose type
                        // genuinely has fewer fields -- log so it's
                        // discoverable which extrinsic/field actually failed,
                        // rather than dropping it with zero trace (the other
                        // fields, and the row itself, are still written).
                        eprintln!(
                            "decode_block #{height}: extrinsic #{index} {module}.{function} field \
                             {name:?} decode failed ({e:#}) -- omitted from call_args"
                        );
                        None
                    }
                }
            })
            .collect();
        if module == "Timestamp" && function == "set" {
            if let Some(ms) = call_args_fields.first().and_then(|(_, _, v)| int_of(v)) {
                observed_at = Some(ms as i64);
            }
        }
        let call_args_json =
            serde_json::to_string(&call_args_json_from_fields(call_args_fields, registry))
                .ok()
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
        // Crowdloan (#6718): a standalone pallet (pallets/crowdloan/src/lib.rs), not a
        // SubtensorModule submodule like subnet leasing -- needs its own name here.
        if e.pallet != "SubtensorModule" && e.pallet != "Balances" && e.pallet != "Crowdloan" {
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
        .map(
            |(index, module, function, xhash, signer, call_args)| ExtrinsicRow {
                block_number: height as i64,
                extrinsic_index: index as i64,
                extrinsic_hash: xhash,
                signer,
                call_module: if module.is_empty() {
                    None
                } else {
                    Some(module)
                },
                call_function: if function.is_empty() {
                    None
                } else {
                    Some(function)
                },
                success: success_map.get(&(index as u32)).copied(),
                fee_tao: fee_map.get(&(index as u32)).cloned(),
                tip_tao: tip_map.get(&(index as u32)).cloned(),
                call_args,
                observed_at: ts,
            },
        )
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

    // ALL FOUR tables: DO UPDATE. Originally extrinsics/account_events/chain_events
    // were DO NOTHING on the assumption "their data is complete on first write" --
    // proven false by metagraphed#4687/#4724: pre-2026-07-10 rows were written by
    // an OLDER decoder (wrong/type-erased call_args shape, and an early run of this
    // very backfill against ad-hoc local RPC sources left sparse, partial coverage
    // -- see metagraphed's D1-retirement audit, 2026-07-11). A DO NOTHING backfill
    // re-pass over those existing rows would silently PRESERVE the stale/wrong data
    // forever instead of correcting it -- exactly the bug this fixes. Once the
    // archive node is ready and the real production backfill (entrypoint.sh's
    // sharded launcher) runs, every table must converge on the CURRENT decoder's
    // output regardless of what (if anything wrong) is already in Postgres.
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
         INSERT INTO extrinsics SELECT * FROM s_extrinsics ON CONFLICT (block_number, extrinsic_index, observed_at) DO UPDATE SET
            extrinsic_hash = EXCLUDED.extrinsic_hash, signer = EXCLUDED.signer,
            call_module = EXCLUDED.call_module, call_function = EXCLUDED.call_function,
            success = EXCLUDED.success, fee_tao = EXCLUDED.fee_tao, tip_tao = EXCLUDED.tip_tao,
            call_args = EXCLUDED.call_args;
         INSERT INTO account_events SELECT * FROM s_events ON CONFLICT (block_number, event_index, observed_at) DO UPDATE SET
            extrinsic_index = EXCLUDED.extrinsic_index, event_kind = EXCLUDED.event_kind,
            hotkey = EXCLUDED.hotkey, coldkey = EXCLUDED.coldkey, netuid = EXCLUDED.netuid,
            uid = EXCLUDED.uid, amount_tao = EXCLUDED.amount_tao, alpha_amount = EXCLUDED.alpha_amount;
         INSERT INTO chain_events SELECT * FROM s_chain_events ON CONFLICT (block_number, event_index, observed_at) DO UPDATE SET
            pallet = EXCLUDED.pallet, method = EXCLUDED.method, args = EXCLUDED.args,
            phase = EXCLUDED.phase, extrinsic_index = EXCLUDED.extrinsic_index;",
    )
    .await?;
    tx.commit().await?;
    Ok(())
}

async fn copy_send(sink: tokio_postgres::CopyInSink<bytes::Bytes>, buf: String) -> Result<()> {
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
    use subxt::backend::LegacyBackend;
    use subxt::rpcs::client::{ReconnectingRpcClient, RpcClient};
    eprintln!(
        "connect_chain: building reconnecting rpc client -> {}",
        redact_rpc_url(url)
    );
    let inner = ReconnectingRpcClient::builder()
        .request_timeout(Duration::from_secs(60))
        .connection_timeout(Duration::from_secs(20))
        .build(url.to_string())
        .await
        .map_err(|e| anyhow::anyhow!("reconnecting rpc build: {e}"))?;
    eprintln!("connect_chain: reconnecting rpc client built, wrapping RpcClient");
    let rpc_client = RpcClient::new(inner);
    // LegacyBackend, not OnlineClient::from_rpc_client's default (CombinedBackend,
    // which tries chainhead_* before legacy_* per call): this is the actual fix for
    // the KNOWN ISSUE documented at the top of this file, not just a mitigation.
    // paritytech/subxt#2050 is specifically the chainHead_v1_follow subscription
    // silently going idle under heavy concurrent block-import churn -- a failure
    // mode intrinsic to that stateful subscription protocol. LegacyBackend never
    // opens one; every call (state_getMetadata, chain_getBlock, state_getStorage,
    // Core_version via state_call, ...) is a stateless one-shot RPC request, so the
    // whole bug CLASS is structurally unreachable, not just recovered-from-faster.
    // ChainClient's timeout+reconnect above stays as defense-in-depth (a slow/dead
    // TCP connection is still possible under any backend), but is no longer the
    // primary defense against #2050 specifically.
    eprintln!("connect_chain: calling OnlineClient::from_backend (LegacyBackend)");
    let backend = LegacyBackend::builder().build(rpc_client);
    let api = OnlineClient::<PolkadotConfig>::from_backend(std::sync::Arc::new(backend))
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
                // Included despite diff.py's SKIP_EXTR (call_args is
                // display-only, its JSON shape isn't cross-checked against
                // the python ground truth) -- VERIFY_BLOCKS is the only way
                // to inspect a real decoded call_args shape without a DB
                // write, which matters for reviewing call_args-shape changes
                // like metagraphed#4724 specifically.
                "call_args": jstr(&x.call_args),
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

/// Result of one tick's stuck-block state update -- see `track_stuck_block`.
struct StuckBlockOutcome {
    stuck_block: Option<u64>,
    stuck_ticks: u64,
    should_alert: bool,
}

/// Pure state-transition for run_live's stuck-block tracking, extracted so
/// the counter/reset/re-alert-cadence logic is unit-testable without a live
/// chain connection (metagraphed-indexer-rs#4). Call this once per
/// decode-failure tick with the PREVIOUS (stuck_block, stuck_ticks) and the
/// block that just failed; a different failed_block than the tracked one
/// resets the counter to 1 (a new block, not a continuation of the old
/// stuck one). should_alert is true on the threshold tick and every
/// threshold-multiple after it, so a persistent wedge re-alerts periodically
/// instead of going silent after the first alert.
fn track_stuck_block(
    stuck_block: Option<u64>,
    stuck_ticks: u64,
    failed_block: u64,
    alert_threshold: u64,
) -> StuckBlockOutcome {
    let ticks = if stuck_block == Some(failed_block) {
        stuck_ticks + 1
    } else {
        1
    };
    StuckBlockOutcome {
        stuck_block: Some(failed_block),
        stuck_ticks: ticks,
        should_alert: ticks.is_multiple_of(alert_threshold),
    }
}

// Fires a Discord webhook alert (same shape as the alertmanager-discord relay
// already running on the archive/indexer boxes) when a single block has been
// stuck in run_live's decode-retry loop for too long -- see
// metagraphed-indexer-rs#4 (filed before the ADR 0016 consolidation, tracked
// here now): a permanent decode failure (e.g. an unsupported new
// pallet/type from a future runtime upgrade) previously retried forever
// with only an eprintln, no signal outside someone tailing logs.
//
// Shells out to curl via tokio::process::Command rather than adding an HTTP
// client crate (reqwest et al.) as a new dependency -- matches this repo's
// existing curl-based alerting convention (metagraphed-infra's
// send-alert.sh) for a single, rare, non-hot-path POST.
async fn alert_stuck_block(webhook_url: Option<&str>, block: u64, ticks: u64, poll_secs: u64) {
    let Some(url) = webhook_url else { return };
    let minutes = (ticks * poll_secs) / 60;
    let content = format!(
        "🔴 metagraphed-indexer-rs: live ingestion stuck on block #{block} for ~{minutes}min ({ticks} retries) — possible permanent decode failure, check logs."
    );
    let payload = serde_json::json!({ "content": content }).to_string();
    let result = tokio::process::Command::new("curl")
        .args([
            "-fsS",
            "-m",
            "15",
            "-X",
            "POST",
            url,
            "-H",
            "content-type: application/json",
            "-d",
            &payload,
        ])
        .output()
        .await;
    match result {
        Ok(out) if !out.status.success() => {
            eprintln!(
                "live: stuck-block alert webhook failed: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        }
        Err(e) => eprintln!("live: stuck-block alert webhook spawn failed: {e}"),
        _ => {}
    }
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
    // metagraphed-indexer-rs#4: a block that permanently fails to decode
    // (e.g. an unsupported new pallet/type from a future runtime upgrade)
    // retries forever by design -- correct, never silently skip -- but
    // previously had zero signal outside someone tailing logs. Alert once a
    // single block has been stuck this many consecutive polling ticks
    // (default 20 * 6s poll = ~2min), then re-alert every `alert_threshold`
    // ticks while it stays stuck, so a persistent wedge doesn't go silent
    // again after the first alert. Optional: LIVE_ALERT_WEBHOOK_URL unset
    // means alert_stuck_block is a no-op, matching this infra's existing
    // "webhook optional, no default" convention (metagraphed-infra's own
    // metagraph_alert_webhook_url).
    let alert_webhook_url = std::env::var("LIVE_ALERT_WEBHOOK_URL").ok();
    let alert_threshold = env_u64("LIVE_STUCK_ALERT_TICKS").unwrap_or(20).max(1);
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
    let mut stuck_block: Option<u64> = None;
    let mut stuck_ticks: u64 = 0;
    loop {
        let head = client
            .call(|api| async move { Ok(api.at_current_block().await?.block_number()) })
            .await?;
        while cursor < head {
            let h = cursor + 1;
            let d = match client
                .call(|api| async move { decode_block(&api, h, head).await })
                .await
            {
                Ok(d) => d,
                Err(e) => {
                    eprintln!("live: #{h} decode failed ({e:#}) — retry next tick");
                    let outcome = track_stuck_block(stuck_block, stuck_ticks, h, alert_threshold);
                    stuck_block = outcome.stuck_block;
                    stuck_ticks = outcome.stuck_ticks;
                    if outcome.should_alert {
                        alert_stuck_block(alert_webhook_url.as_deref(), h, stuck_ticks, poll).await;
                    }
                    break;
                }
            };
            // Decode succeeded -- clear any stuck-block tracking for it.
            if stuck_block == Some(h) {
                stuck_block = None;
                stuck_ticks = 0;
            }
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
    let rpc_url_log = redact_rpc_url(&rpc_url);
    let client = Arc::new(ChainClient::connect(rpc_url.clone()).await?);
    eprintln!("main: connect_chain returned, api ready");

    // VERIFY mode: decode the given blocks, print canonical JSON, exit (no DB).
    if let Ok(list) = std::env::var("VERIFY_BLOCKS") {
        let head = client
            .call(|api| async move { Ok(api.at_current_block().await?.block_number()) })
            .await?;
        for tok in list.split(',').filter(|s| !s.trim().is_empty()) {
            let h: u64 = tok.trim().parse()?;
            match client
                .call(|api| async move { decode_block(&api, h, head).await })
                .await
            {
                Ok(d) => println!("{}", block_to_json(&d, h)),
                Err(e) => println!(
                    "{}",
                    serde_json::json!({"block": h, "error": format!("{e:#}")})
                ),
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
        "backfill #{from}..#{to} (head={head}, resume@#{start}, conc={concurrency}, chunk={chunk}, rpc={rpc_url_log})"
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
                                match client
                                    .call(|api| async move { decode_block(&api, h, head).await })
                                    .await
                                {
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

#[cfg(test)]
mod type_name_tests {
    use super::*;
    use scale_info::{Path, PortableRegistryBuilder, Type, TypeDefSequence};

    // Hand-builds a genuinely self-referential type -- `struct Recursive {
    // items: Vec<Recursive> }` -- the exact "Vec<Self>" shape flagged as a
    // stack-overflow risk. Real-chain equivalent: RuntimeCall, whose
    // Utility.batch variant holds a Vec<RuntimeCall> referencing RuntimeCall's
    // own type_id. Registers only ONE type: a Sequence whose element type_id
    // is its OWN id, predicted via next_type_id() before registering.
    fn self_referential_registry() -> (u32, PortableRegistry) {
        let mut builder = PortableRegistryBuilder::new();
        let self_id = builder.next_type_id();
        let ty = Type::<scale_info::form::PortableForm>::new(
            Path::default(),
            vec![],
            TypeDefSequence {
                type_param: self_id.into(),
            },
            vec![],
        );
        let assigned_id = builder.register_type(ty);
        assert_eq!(
            assigned_id, self_id,
            "self-reference must target its own id"
        );
        (self_id, builder.finish())
    }

    #[test]
    fn type_name_terminates_on_a_direct_cycle() {
        let (id, registry) = self_referential_registry();
        // Must return promptly (no stack overflow) and mark the cycle.
        let name = type_name(id, &registry);
        assert_eq!(name, format!("Vec<Cyclic<{id}>>"));
    }

    #[test]
    fn type_name_still_resolves_a_non_cyclic_sequence() {
        let mut builder = PortableRegistryBuilder::new();
        let u16_id = builder.register_type(Type::<scale_info::form::PortableForm>::new(
            Path::default(),
            vec![],
            TypeDefPrimitive::U16,
            vec![],
        ));
        let vec_id = builder.register_type(Type::<scale_info::form::PortableForm>::new(
            Path::default(),
            vec![],
            TypeDefSequence {
                type_param: u16_id.into(),
            },
            vec![],
        ));
        let registry = builder.finish();
        assert_eq!(type_name(vec_id, &registry), "Vec<u16>");
    }

    #[test]
    fn type_name_resolves_the_same_type_twice_in_sibling_positions_without_reporting_a_cycle() {
        // (Vec<u16>, Vec<u16>) -- the SAME Vec<u16> type_id appears twice as
        // sibling tuple elements. Must NOT be misreported as cyclic (visited
        // is path-scoped, backtracked after each branch returns).
        let mut builder = PortableRegistryBuilder::new();
        let u16_id = builder.register_type(Type::<scale_info::form::PortableForm>::new(
            Path::default(),
            vec![],
            TypeDefPrimitive::U16,
            vec![],
        ));
        let vec_id = builder.register_type(Type::<scale_info::form::PortableForm>::new(
            Path::default(),
            vec![],
            TypeDefSequence {
                type_param: u16_id.into(),
            },
            vec![],
        ));
        let tuple_id = builder.register_type(Type::<scale_info::form::PortableForm>::new(
            Path::default(),
            vec![],
            scale_info::TypeDefTuple {
                fields: vec![vec_id.into(), vec_id.into()],
            },
            vec![],
        ));
        let registry = builder.finish();
        assert_eq!(type_name(tuple_id, &registry), "(Vec<u16>, Vec<u16>)");
    }
}

#[cfg(test)]
mod stuck_block_tracking_tests {
    use super::*;

    #[test]
    fn first_failure_on_a_new_block_starts_at_one_tick_no_alert() {
        let outcome = track_stuck_block(None, 0, 100, 20);
        assert_eq!(outcome.stuck_block, Some(100));
        assert_eq!(outcome.stuck_ticks, 1);
        assert!(!outcome.should_alert);
    }

    #[test]
    fn repeated_failures_on_the_same_block_accumulate_ticks() {
        let outcome = track_stuck_block(Some(100), 5, 100, 20);
        assert_eq!(outcome.stuck_block, Some(100));
        assert_eq!(outcome.stuck_ticks, 6);
        assert!(!outcome.should_alert);
    }

    #[test]
    fn reaching_the_threshold_fires_an_alert() {
        let outcome = track_stuck_block(Some(100), 19, 100, 20);
        assert_eq!(outcome.stuck_ticks, 20);
        assert!(outcome.should_alert);
    }

    #[test]
    fn a_different_block_failing_resets_the_counter_to_one() {
        // Block 100 was stuck for 19 ticks, but block 101 is the one that
        // failed THIS tick (100 must have succeeded in between) -- a fresh
        // counter for 101, not a continuation of 100's count.
        let outcome = track_stuck_block(Some(100), 19, 101, 20);
        assert_eq!(outcome.stuck_block, Some(101));
        assert_eq!(outcome.stuck_ticks, 1);
        assert!(!outcome.should_alert);
    }

    #[test]
    fn a_persistent_wedge_re_alerts_every_threshold_multiple() {
        let at_40 = track_stuck_block(Some(100), 39, 100, 20);
        assert_eq!(at_40.stuck_ticks, 40);
        assert!(at_40.should_alert);
        let at_41 = track_stuck_block(Some(100), 40, 100, 20);
        assert_eq!(at_41.stuck_ticks, 41);
        assert!(!at_41.should_alert);
    }
}

#[cfg(test)]
mod rpc_url_redaction_tests {
    use super::*;

    #[test]
    fn redact_rpc_url_removes_userinfo_query_and_fragment() {
        let redacted = redact_rpc_url(
            "wss://user:pass@example.com/v1?api_key=SECRET_TOKEN_123&project=metagraphed#frag",
        );

        assert_eq!(redacted, "wss://example.com/v1");
        assert!(!redacted.contains("user"));
        assert!(!redacted.contains("pass"));
        assert!(!redacted.contains("SECRET_TOKEN_123"));
        assert!(!redacted.contains("project="));
        assert!(!redacted.contains("frag"));
    }

    #[test]
    fn redact_rpc_url_preserves_non_secret_connection_target() {
        assert_eq!(
            redact_rpc_url("wss://archive.chain.opentensor.ai:443"),
            "wss://archive.chain.opentensor.ai:443"
        );
        assert_eq!(
            redact_rpc_url("ws://127.0.0.1:9944/path"),
            "ws://127.0.0.1:9944/path"
        );
    }
}

#[cfg(test)]
mod netuid_plausibility_tests {
    use super::*;

    fn prim_u128(n: u128) -> Value<()> {
        Value {
            value: ValueDef::Primitive(Primitive::U128(n)),
            context: (),
        }
    }

    // AccountId32 = newtype over [u8;32] -> Unnamed([ Unnamed([u8;32]) ]),
    // per collect_bytes' own doc comment.
    fn account_value(byte0: u8) -> Value<()> {
        let mut bytes = vec![prim_u128(byte0 as u128)];
        bytes.extend((1..32).map(|_| prim_u128(0)));
        Value {
            value: ValueDef::Composite(Composite::Unnamed(vec![Value {
                value: ValueDef::Composite(Composite::Unnamed(bytes)),
                context: (),
            }])),
            context: (),
        }
    }

    // metagraphed#5347: since block ~8460018, the chain's automatic weight-reveal
    // hook occasionally emits WeightsSet / TimelockedWeights{Committed,Revealed} /
    // CRV3Weights{Committed,Revealed} with a garbage netuid field (observed
    // 4100-4200+; confirmed via NetworkAdded/NetworkRemoved history that no
    // netuid above 99 has ever been registered, and via the event's own
    // hotkey/uid fields cross-referencing to a real, much lower netuid).
    // plausible_netuid() bound-checks and drops the field rather than
    // propagating the garbage value; these lock that behavior in.

    #[test]
    fn weights_set_drops_implausible_netuid_but_keeps_uid() {
        let netuid = prim_u128(4209);
        let uid = prim_u128(13);
        let fields: Vec<&Value<()>> = vec![&netuid, &uid];
        let ext = extract("WeightsSet", &fields).expect("WeightsSet always decodes with 2 fields");
        assert_eq!(ext.netuid, None);
        assert_eq!(ext.uid, Some(13));
    }

    #[test]
    fn weights_set_keeps_plausible_netuid() {
        let netuid = prim_u128(128);
        let uid = prim_u128(174);
        let fields: Vec<&Value<()>> = vec![&netuid, &uid];
        let ext = extract("WeightsSet", &fields).expect("WeightsSet always decodes with 2 fields");
        assert_eq!(ext.netuid, Some(128));
        assert_eq!(ext.uid, Some(174));
    }

    #[test]
    fn timelocked_weights_revealed_drops_implausible_netuid_but_keeps_hotkey() {
        let netuid = prim_u128(4209);
        let who = account_value(0xAB);
        let fields: Vec<&Value<()>> = vec![&netuid, &who];
        let ext = extract("TimelockedWeightsRevealed", &fields)
            .expect("TimelockedWeightsRevealed always decodes with 2 fields");
        assert_eq!(ext.netuid, None);
        assert!(ext.hotkey.is_some());
    }

    #[test]
    fn timelocked_weights_committed_drops_implausible_netuid_but_keeps_hotkey() {
        let who = account_value(0xCD);
        let netuid = prim_u128(4189);
        let fields: Vec<&Value<()>> = vec![&who, &netuid];
        let ext = extract("TimelockedWeightsCommitted", &fields)
            .expect("TimelockedWeightsCommitted always decodes with >= 2 fields");
        assert_eq!(ext.netuid, None);
        assert!(ext.hotkey.is_some());
    }

    #[test]
    fn crv3_weights_committed_and_revealed_drop_implausible_netuid() {
        let who = account_value(0xEF);
        let netuid = prim_u128(4183);
        let committed_fields: Vec<&Value<()>> = vec![&who, &netuid];
        let committed = extract("CRV3WeightsCommitted", &committed_fields)
            .expect("CRV3WeightsCommitted always decodes with >= 2 fields");
        assert_eq!(committed.netuid, None);

        let revealed_fields: Vec<&Value<()>> = vec![&netuid, &who];
        let revealed = extract("CRV3WeightsRevealed", &revealed_fields)
            .expect("CRV3WeightsRevealed always decodes with >= 2 fields");
        assert_eq!(revealed.netuid, None);
    }
}

#[cfg(test)]
mod subnet_leasing_and_crowdloan_tests {
    use super::*;

    fn prim_u128(n: u128) -> Value<()> {
        Value {
            value: ValueDef::Primitive(Primitive::U128(n)),
            context: (),
        }
    }

    // AccountId32 = newtype over [u8;32] -> Unnamed([ Unnamed([u8;32]) ]), matching
    // netuid_plausibility_tests' own account_value helper.
    fn account_value(byte0: u8) -> Value<()> {
        let mut bytes = vec![prim_u128(byte0 as u128)];
        bytes.extend((1..32).map(|_| prim_u128(0)));
        Value {
            value: ValueDef::Composite(Composite::Unnamed(vec![Value {
                value: ValueDef::Composite(Composite::Unnamed(bytes)),
                context: (),
            }])),
            context: (),
        }
    }

    #[test]
    fn subnet_lease_created_curates_beneficiary_and_netuid() {
        let beneficiary = account_value(0x11);
        let lease_id = prim_u128(7);
        let netuid = prim_u128(42);
        let fields: Vec<&Value<()>> = vec![&beneficiary, &lease_id, &netuid];
        let ext = extract("SubnetLeaseCreated", &fields)
            .expect("SubnetLeaseCreated always decodes with >= 3 fields");
        assert!(ext.coldkey.is_some());
        assert_eq!(ext.netuid, Some(42));
        assert_eq!(ext.amount_tao, None);
    }

    #[test]
    fn subnet_lease_terminated_curates_beneficiary_and_netuid() {
        let beneficiary = account_value(0x22);
        let netuid = prim_u128(9);
        let fields: Vec<&Value<()>> = vec![&beneficiary, &netuid];
        let ext = extract("SubnetLeaseTerminated", &fields)
            .expect("SubnetLeaseTerminated always decodes with >= 2 fields");
        assert!(ext.coldkey.is_some());
        assert_eq!(ext.netuid, Some(9));
    }

    #[test]
    fn subnet_lease_dividends_distributed_curates_contributor_and_alpha_not_netuid() {
        let lease_id = prim_u128(3);
        let contributor = account_value(0x33);
        // 1.5 alpha in rao-equivalent units, matching tao_str's fixed-point convention.
        let alpha = prim_u128(1_500_000_000);
        let fields: Vec<&Value<()>> = vec![&lease_id, &contributor, &alpha];
        let ext = extract("SubnetLeaseDividendsDistributed", &fields)
            .expect("SubnetLeaseDividendsDistributed always decodes with >= 3 fields");
        assert!(ext.coldkey.is_some());
        assert_eq!(ext.alpha_amount, Some("1.5".to_string()));
        assert_eq!(ext.netuid, None);
    }

    #[test]
    fn crowdloan_contributed_curates_contributor_and_amount_not_crowdloan_id() {
        let crowdloan_id = prim_u128(1);
        let contributor = account_value(0x44);
        let amount = prim_u128(10_000_000_000); // 10 TAO
        let fields: Vec<&Value<()>> = vec![&crowdloan_id, &contributor, &amount];
        let ext =
            extract("Contributed", &fields).expect("Contributed always decodes with >= 3 fields");
        assert!(ext.coldkey.is_some());
        assert_eq!(ext.amount_tao, Some("10".to_string()));
        assert_eq!(ext.netuid, None);
    }

    #[test]
    fn crowdloan_withdrew_curates_contributor_and_amount() {
        let crowdloan_id = prim_u128(1);
        let contributor = account_value(0x55);
        let amount = prim_u128(2_500_000_000); // 2.5 TAO
        let fields: Vec<&Value<()>> = vec![&crowdloan_id, &contributor, &amount];
        let ext = extract("Withdrew", &fields).expect("Withdrew always decodes with >= 3 fields");
        assert!(ext.coldkey.is_some());
        assert_eq!(ext.amount_tao, Some("2.5".to_string()));
    }

    #[test]
    fn crowdloan_created_is_not_curated_into_account_events() {
        // Created only declares a cap/end -- no tao has moved yet, so there's
        // nothing to attribute to an account. Confirms the deliberate omission
        // documented on extract()'s Crowdloan.Contributed arm.
        let crowdloan_id = prim_u128(1);
        let creator = account_value(0x66);
        let end = prim_u128(9_000_000);
        let cap = prim_u128(50_000_000_000);
        let fields: Vec<&Value<()>> = vec![&crowdloan_id, &creator, &end, &cap];
        assert!(extract("Created", &fields).is_none());
    }

    #[test]
    fn underfilled_fields_return_none_not_a_panic() {
        let only_one = account_value(0x77);
        let fields: Vec<&Value<()>> = vec![&only_one];
        assert!(extract("SubnetLeaseCreated", &fields).is_none());
        assert!(extract("SubnetLeaseDividendsDistributed", &fields).is_none());
        assert!(extract("Contributed", &fields).is_none());
        assert!(extract("Withdrew", &fields).is_none());
    }
}

#[cfg(test)]
mod child_hotkey_delegation_tests {
    use super::*;

    fn prim_u128(n: u128) -> Value<()> {
        Value {
            value: ValueDef::Primitive(Primitive::U128(n)),
            context: (),
        }
    }

    // AccountId32 = newtype over [u8;32] -> Unnamed([ Unnamed([u8;32]) ]),
    // matching subnet_leasing_and_crowdloan_tests' own account_value helper.
    fn account_value(byte0: u8) -> Value<()> {
        let mut bytes = vec![prim_u128(byte0 as u128)];
        bytes.extend((1..32).map(|_| prim_u128(0)));
        Value {
            value: ValueDef::Composite(Composite::Unnamed(vec![Value {
                value: ValueDef::Composite(Composite::Unnamed(bytes)),
                context: (),
            }])),
            context: (),
        }
    }

    #[test]
    fn set_children_scheduled_curates_hotkey_and_netuid_not_cooldown_or_children() {
        let hotkey = account_value(0x11);
        let netuid = prim_u128(9);
        let cooldown_block = prim_u128(1_234_567);
        // children: Vec<(u64, AccountId)> -- shape irrelevant, never read.
        let children = prim_u128(0);
        let fields: Vec<&Value<()>> = vec![&hotkey, &netuid, &cooldown_block, &children];
        let ext = extract("SetChildrenScheduled", &fields)
            .expect("SetChildrenScheduled always decodes with >= 2 fields");
        assert!(ext.hotkey.is_some());
        assert_eq!(ext.netuid, Some(9));
        assert_eq!(ext.coldkey, None);
        assert_eq!(ext.amount_tao, None);
    }

    #[test]
    fn child_key_take_set_curates_hotkey_only_no_netuid_on_the_event_itself() {
        // ChildKeyTakeSet(hotkey, take) genuinely has no netuid field, even
        // though the underlying storage write (ChildkeyTake::insert(hotkey,
        // netuid, take)) is per-subnet -- a real chain-level event omission,
        // not a decode gap. Confirms the extract() arm doesn't invent one.
        let hotkey = account_value(0x22);
        let take = prim_u128(6_553); // PerU16 take ratio
        let fields: Vec<&Value<()>> = vec![&hotkey, &take];
        let ext = extract("ChildKeyTakeSet", &fields)
            .expect("ChildKeyTakeSet always decodes with >= 1 field");
        assert!(ext.hotkey.is_some());
        assert_eq!(ext.netuid, None);
    }

    #[test]
    fn underfilled_fields_return_none_not_a_panic() {
        let empty: Vec<&Value<()>> = vec![];
        assert!(extract("SetChildrenScheduled", &empty).is_none());
        assert!(extract("ChildKeyTakeSet", &empty).is_none());
        let one = account_value(0x33);
        let one_field: Vec<&Value<()>> = vec![&one];
        assert!(extract("SetChildrenScheduled", &one_field).is_none());
        // ChildKeyTakeSet needs only 1 field, so a single hotkey IS enough.
        assert!(extract("ChildKeyTakeSet", &one_field).is_some());
    }
}
