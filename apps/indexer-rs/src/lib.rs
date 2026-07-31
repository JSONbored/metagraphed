// Shared chain/Postgres connection primitives, used by both this crate's
// binaries: src/main.rs (historical backfill + live-follow, INDEX_MODE=live)
// and src/bin/poller.rs (the consolidated chain-state polling service,
// metagraphed-infra#136). Extracted from main.rs so the subxt#2050
// stall-mitigation logic (ChainClient below) has exactly one implementation
// shared by both, rather than a forked copy drifting out of sync.

use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use anyhow::{Context, Result};
use subxt::config::PolkadotConfig;
use subxt::OnlineClient;
use tokio::sync::RwLock;

pub mod observability;

pub type Api = OnlineClient<PolkadotConfig>;
/// A client snapshotted at one block -- what `api.at_current_block()` returns.
/// Fetch this ONCE per unit of work and reuse it for every storage call in
/// that unit: each individual `.storage().fetch()`/`.iter()` on an `Api`
/// value re-resolves the current block first, which is a real extra RPC
/// round-trip per call, not a cached/local operation (confirmed live,
/// metagraphed-infra#138 -- a poller job that called `at_current_block()`
/// once per netuid instead of once per tick was measurably, unnecessarily
/// slower against a public RPC).
pub type AtBlock = subxt::client::OnlineClientAtBlock<PolkadotConfig>;

/// Every currently-registered netuid, per SubtensorModule::NetworksAdded
/// (the runtime's own subnet-existence flag) -- not a hardcoded upper bound,
/// so newly-registered/deregistered subnets need no code change here. Shared
/// by every poller job that needs "the active subnet set" (subnet-ownership,
/// subnet-hyperparams, ...) rather than each reimplementing the same scan.
pub async fn discover_netuids(at: &AtBlock) -> Result<Vec<u16>> {
    let addr = subxt::dynamic::storage::<(u16,), bool>("SubtensorModule", "NetworksAdded");
    let mut iter = at.storage().iter(addr, ()).await?;
    let mut netuids = Vec::new();
    while let Some(entry) = iter.next().await {
        let (netuid,) = entry?.key()?.decode()?;
        netuids.push(netuid);
    }
    netuids.sort_unstable();
    Ok(netuids)
}

/// Retries `f` up to `attempts` times with a short linear backoff -- for
/// transient failures on a single stateless call against an already-
/// resolved `AtBlock` snapshot. Lighter weight than `ChainClient::call`
/// (no reconnect, no fresh `at_current_block()` -- see `AtBlock`'s own doc
/// comment for why repeating that per call is a real cost to avoid), but
/// still tolerant of the transient failures live-tested against the public
/// archive RPC under concurrent multi-job load (metagraphed-infra#138): a
/// bare, unretried storage fetch failed outright on the ReconnectingRpcClient's
/// 60s request_timeout under contention, even though the SAME call reliably
/// succeeded in under a second once that contention cleared moments later.
pub async fn retry_transient<T, F, Fut>(attempts: u32, mut f: F) -> Result<T>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T>>,
{
    let mut last_err: Option<anyhow::Error> = None;
    for attempt in 0..attempts.max(1) {
        match f().await {
            Ok(v) => return Ok(v),
            Err(e) => last_err = Some(e),
        }
        if attempt + 1 < attempts {
            tokio::time::sleep(Duration::from_millis(300 * (attempt as u64 + 1))).await;
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow::anyhow!("retry_transient: no attempts made")))
}

/// Now, as epoch milliseconds -- the `captured_at` clock every poller job
/// uses for its snapshot rows (wall-clock, not chain-derived: unlike
/// main.rs's block-anchored `observed_at`, these are polls, not events tied
/// to a specific block). Matches the same `int(time.time() * 1000)`
/// convention the Python fetch-*.py scripts these jobs replace already used.
pub fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock before unix epoch")
        .as_millis() as i64
}

/// rao rendered as an EXACT TAO decimal string for Postgres NUMERIC. Never
/// routes through f64 (the same precision-loss shape as metagraphed#2588's
/// "Mechanism B" -- an exact rao integer discarded to a lossy double one
/// line before rendering). Postgres NUMERIC is exact-precision, so an exact
/// decimal string here is exact forever, with no ~9M-TAO ceiling at all.
/// Shared by main.rs's `tao_str` (via a `Value<()>` wrapper) and the
/// poller's jobs that decode a raw `u128` rao amount directly.
pub fn rao_to_tao_exact(rao: u128) -> String {
    let whole = rao / 1_000_000_000;
    let frac = rao % 1_000_000_000;
    if frac == 0 {
        return whole.to_string();
    }
    let mut frac_str = format!("{frac:09}");
    while frac_str.ends_with('0') {
        frac_str.pop();
    }
    format!("{whole}.{frac_str}")
}

/// POSTs `body` (already-serialized JSON) to `url` via curl, matching
/// main.rs's own alert_stuck_block() convention (a single, rare, non-hot-path
/// POST doesn't earn a new HTTP client dependency) -- shared by every poller
/// job that syncs via an existing HTTP route rather than writing Postgres
/// directly (subnet-hyperparams, metagraph, account-identity).
///
/// Pipes `body` through curl's stdin (`-d @-`) rather than passing it as a
/// `-d <string>` argv element: confirmed live 2026-07-20 that metagraph's
/// ~30k-row/~7MB payload blew past the OS's ARG_MAX as a command-line
/// argument ("Argument list too long", os error 7) the very first time this
/// job ran against production data -- every prior dry-run test skipped the
/// real curl call entirely, so this never surfaced until then. `-d @-` has
/// no such limit; the body flows through a pipe instead of exec's argv/
/// environment block.
pub async fn post_sync_json(
    url: &str,
    token_header: &str,
    secret: &str,
    body: &str,
    timeout_secs: &str,
) -> Result<()> {
    use tokio::io::AsyncWriteExt;
    let header = format!("{token_header}: {secret}");
    let mut child = tokio::process::Command::new("curl")
        .args([
            "-fsS",
            "-m",
            timeout_secs,
            "-X",
            "POST",
            url,
            "-H",
            "content-type: application/json",
            "-H",
            &header,
            "-d",
            "@-",
        ])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .context("spawn curl")?;
    // curl (with `-d @-`) reads all of stdin to compute Content-Length
    // before sending anything, so this write completes without curl
    // blocking on stdout/stderr in the meantime -- no separate writer task
    // needed for a body this shape (matches every other job's convention
    // of one straightforward, non-streaming POST per tick).
    child
        .stdin
        .take()
        .context("curl stdin")?
        .write_all(body.as_bytes())
        .await
        .context("write curl stdin")?;
    let output = child.wait_with_output().await.context("wait for curl")?;
    if !output.status.success() {
        anyhow::bail!(
            "sync POST failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    Ok(())
}

pub fn redact_rpc_url(url: &str) -> String {
    let scheme_end = url.find("://").map(|idx| idx + 3).unwrap_or(0);
    let after_scheme = &url[scheme_end..];
    let authority_len = after_scheme
        .find(['/', '?', '#'])
        .unwrap_or(after_scheme.len());
    let (authority, rest) = after_scheme.split_at(authority_len);
    let safe_authority = authority
        .rsplit_once('@')
        .map(|(_, host)| host)
        .unwrap_or(authority);
    let path_len = rest.find(['?', '#']).unwrap_or(rest.len());
    let safe_rest = &rest[..path_len];
    format!("{}{}{}", &url[..scheme_end], safe_authority, safe_rest)
}

/// `RpcClientT` over raw hyper with ONE fresh connection per request, for
/// `connect_chain`'s http(s):// path (plaintext http only -- this exists for
/// our own node over the tailnet).
///
/// Deliberately NOT a pooled client. Both persistent-state transports were
/// observed to silently wedge against our own archive node (2026-07-31):
/// subxt-over-WS stalls under import churn (the main.rs KNOWN ISSUE), and
/// jsonrpsee's pooled HttpClient intermittently loses a request forever --
/// no response, no error, and bafflingly no timeout firing -- wedging whole
/// shard processes at startup or mid-run. The only shape that never wedged
/// across every benchmark is the dumbest one: connect, POST, read, close
/// (155+ blk/s sustained at 32-way concurrency from a plain-connection
/// harness; a TCP handshake on the tailnet's ~56ms RTT path is ~1ms of
/// overhead per call -- noise). The whole call is additionally bounded by an
/// explicit tokio timeout here, so a lost request surfaces as a retryable
/// error in <=30s instead of hanging a shard forever. Subscriptions are
/// structurally unsupported over HTTP and error immediately -- fine for
/// backfill + poller, which only ever make one-shot calls; live-follow keeps
/// using ws://.
struct HttpRpcClient {
    /// Resolved once at build time: per-request getaddrinfo across dozens of
    /// concurrent shards would hammer docker's embedded DNS for a name whose
    /// tailnet address is stable anyway.
    addr: std::net::SocketAddr,
    host_header: String,
}

const HTTP_ONESHOT_TIMEOUT: Duration = Duration::from_secs(30);

impl HttpRpcClient {
    async fn build(url: &str) -> Result<Self> {
        let no_scheme = url.strip_prefix("http://").ok_or_else(|| {
            anyhow::anyhow!("HttpRpcClient supports plain http:// only, got {url}")
        })?;
        let authority = no_scheme.split('/').next().unwrap_or(no_scheme).to_string();
        let with_port = if authority.contains(':') {
            authority.clone()
        } else {
            format!("{authority}:80")
        };
        let addr = tokio::net::lookup_host(&with_port)
            .await
            .with_context(|| format!("resolve {with_port}"))?
            .next()
            .ok_or_else(|| anyhow::anyhow!("no address for {with_port}"))?;
        Ok(Self {
            addr,
            host_header: authority,
        })
    }

    /// connect -> POST -> read body -> close. No shared state with any other
    /// call, which is the entire point (see the type-level comment).
    async fn one_shot(&self, body: String) -> Result<Vec<u8>> {
        use http_body_util::BodyExt;
        let stream = tokio::net::TcpStream::connect(self.addr)
            .await
            .with_context(|| format!("connect {}", self.addr))?;
        stream.set_nodelay(true).ok();
        let io = hyper_util::rt::TokioIo::new(stream);
        let (mut sender, conn) = hyper::client::conn::http1::handshake(io)
            .await
            .context("http1 handshake")?;
        // The connection task ends when the response completes or either side
        // drops -- one-shot by construction, nothing lingers.
        tokio::spawn(conn);
        let req = hyper::Request::post("/")
            .header(hyper::header::HOST, &self.host_header)
            .header(hyper::header::CONTENT_TYPE, "application/json")
            .header(hyper::header::CONNECTION, "close")
            .body(http_body_util::Full::new(bytes::Bytes::from(body)))
            .context("build request")?;
        let resp = sender.send_request(req).await.context("send request")?;
        let status = resp.status();
        let bytes = resp
            .into_body()
            .collect()
            .await
            .context("read response body")?
            .to_bytes();
        if !status.is_success() {
            anyhow::bail!(
                "http status {status}: {}",
                String::from_utf8_lossy(&bytes[..bytes.len().min(200)])
            );
        }
        Ok(bytes.to_vec())
    }
}

impl subxt::rpcs::client::RpcClientT for HttpRpcClient {
    fn request_raw<'a>(
        &'a self,
        method: &'a str,
        params: Option<Box<serde_json::value::RawValue>>,
    ) -> subxt::rpcs::client::RawRpcFuture<'a, Box<serde_json::value::RawValue>> {
        use std::sync::atomic::AtomicU64 as ReqId;
        static NEXT_ID: ReqId = ReqId::new(1);
        Box::pin(async move {
            let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
            let params_json = params.as_ref().map(|p| p.get()).unwrap_or("[]");
            let body = format!(
                r#"{{"jsonrpc":"2.0","id":{id},"method":{},"params":{params_json}}}"#,
                serde_json::json!(method),
            );
            let client_err = |e: anyhow::Error| subxt::rpcs::Error::Client(format!("{e:#}").into());
            let raw = tokio::time::timeout(HTTP_ONESHOT_TIMEOUT, self.one_shot(body))
                .await
                .map_err(|_| {
                    client_err(anyhow::anyhow!(
                        "one-shot http rpc {method} timed out ({HTTP_ONESHOT_TIMEOUT:?})"
                    ))
                })?
                .map_err(client_err)?;
            #[derive(serde::Deserialize)]
            struct RpcError {
                code: i32,
                message: String,
                data: Option<Box<serde_json::value::RawValue>>,
            }
            #[derive(serde::Deserialize)]
            struct Envelope {
                result: Option<Box<serde_json::value::RawValue>>,
                error: Option<RpcError>,
            }
            let env: Envelope =
                serde_json::from_slice(&raw).map_err(subxt::rpcs::Error::Deserialization)?;
            if let Some(e) = env.error {
                // JSON-RPC-level errors surface as UserError so subxt's
                // "method not found" fallbacks (e.g. the metadata-version
                // probe) keep working instead of being treated as transport
                // failures.
                return Err(subxt::rpcs::Error::User(subxt::rpcs::UserError {
                    code: e.code,
                    message: e.message,
                    data: e.data,
                }));
            }
            env.result.ok_or_else(|| {
                subxt::rpcs::Error::Client("rpc response had neither result nor error".into())
            })
        })
    }

    fn subscribe_raw<'a>(
        &'a self,
        _sub: &'a str,
        _params: Option<Box<serde_json::value::RawValue>>,
        _unsub: &'a str,
    ) -> subxt::rpcs::client::RawRpcFuture<'a, subxt::rpcs::client::RawRpcSubscription> {
        Box::pin(async move {
            Err(subxt::rpcs::Error::Client(
                "subscriptions are not supported over the HTTP transport; use a ws:// EVENTS_RPC_URL for subscription-based flows"
                    .to_string()
                    .into(),
            ))
        })
    }
}

/// One `(start, end_exclusive, spec_version, transaction_version)` segment of
/// chain history, as discovered by [`discover_spec_ranges`]. Plain tuples
/// (rather than subxt's `SpecVersionForRange`, which they convert into) so
/// `ChainClient` can hold + clone them across reconnects.
pub type SpecRange = (u64, u64, u32, u32);

/// Bisect `[from, to]` into runtime-version segments, two RPCs per probe
/// (`chain_getBlockHash` + `state_getRuntimeVersion`). Spec versions are
/// monotonically non-decreasing in block height, so equal endpoint versions
/// imply a uniform segment and each transition costs O(log range) probes.
///
/// `state_getRuntimeVersion` is NOT cheap -- measured 206-802ms per call at
/// historical blocks, rising with height, because it executes runtime wasm
/// exactly like `Core_version` does. Full-history discovery is therefore
/// genuinely expensive (~150 transitions x ~23 probes) and, run concurrently,
/// starves the node's single sync thread (observed 2026-07-31: archive-node
/// sync fell 0.37 -> 0.017 blk/s while a 16-wide discovery ran). That is
/// accepted because it happens ONCE per [from,to] -- the result is written to
/// a file the launcher shares with every shard (see main.rs's discover-only
/// mode) -- and it is what removes the same wasm call from all ~8.5M blocks.
/// Do NOT raise FANOUT to "speed it up": the node is the bottleneck and more
/// concurrency just deepens the sync starvation.
///
/// WHY: subxt's `at_block()` otherwise issues `state_call("Core_version")` for
/// EVERY block -- a server-side wasm execution measured at 200-800ms alone and
/// far worse under concurrency (concurrent Core_version calls across different
/// historical specs thrash the node's small wasm-instance pool; measured
/// 2026-07-31 as the dominant per-block cost, capping each backfill process
/// near ~1 blk/s while plain storage/body reads ran at 160+ blk/s). Feeding
/// the discovered ranges to `PolkadotConfigBuilder::set_spec_version_for_block_ranges`
/// makes the spec lookup a local RangeMap hit, removing Core_version from the
/// per-block path entirely.
pub async fn discover_spec_ranges(
    rpc: &subxt::rpcs::client::RpcClient,
    from: u64,
    to: u64,
) -> Result<Vec<SpecRange>> {
    use subxt::rpcs::rpc_params;
    // Every probe is individually timeout-bounded and retried: a raw client
    // has none of ChainClient's stall protection, and one silently-hung call
    // here would otherwise hang the whole shard before it ever decodes a
    // block (observed live 2026-07-31: 8/8 shards wedged in discovery with
    // no timeout ever firing).
    async fn version_at(rpc: &subxt::rpcs::client::RpcClient, h: u64) -> Result<(u32, u32)> {
        let mut last: Option<anyhow::Error> = None;
        for attempt in 0..3u32 {
            let probe = async {
                let hash: Option<String> = rpc
                    .request("chain_getBlockHash", rpc_params![h])
                    .await
                    .with_context(|| format!("chain_getBlockHash #{h}"))?;
                let hash = hash
                    .ok_or_else(|| anyhow::anyhow!("no hash for block #{h} (past node head?)"))?;
                let v: serde_json::Value = rpc
                    .request("state_getRuntimeVersion", rpc_params![hash])
                    .await
                    .with_context(|| format!("state_getRuntimeVersion #{h}"))?;
                let spec = v["specVersion"]
                    .as_u64()
                    .ok_or_else(|| anyhow::anyhow!("no specVersion at #{h}"))?
                    as u32;
                let txv = v["transactionVersion"].as_u64().unwrap_or(0) as u32;
                Ok::<(u32, u32), anyhow::Error>((spec, txv))
            };
            match tokio::time::timeout(Duration::from_secs(20), probe).await {
                Ok(Ok(v)) => return Ok(v),
                Ok(Err(e)) => last = Some(e),
                Err(_) => last = Some(anyhow::anyhow!("spec probe #{h} timed out (20s)")),
            }
            tokio::time::sleep(Duration::from_millis(300 * (attempt as u64 + 1))).await;
        }
        Err(last.unwrap())
    }
    async fn bisect_subrange(
        rpc: &subxt::rpcs::client::RpcClient,
        from: u64,
        to: u64,
    ) -> Result<Vec<SpecRange>> {
        let mut ranges: Vec<SpecRange> = Vec::new();
        let mut start = from;
        let mut v_start = version_at(rpc, start).await?;
        let v_to = version_at(rpc, to).await?;
        while start <= to {
            if v_start == v_to {
                ranges.push((start, to + 1, v_start.0, v_start.1));
                break;
            }
            // Binary search the last block in [start, to] still at v_start.
            let (mut lo, mut hi) = (start, to);
            while lo < hi {
                let mid = lo + (hi - lo).div_ceil(2);
                if version_at(rpc, mid).await? == v_start {
                    lo = mid;
                } else {
                    hi = mid - 1;
                }
            }
            ranges.push((start, lo + 1, v_start.0, v_start.1));
            eprintln!(
                "spec discovery: boundary v{} -> ? at #{} ({} segments so far in [{from},{to}])",
                v_start.0,
                lo + 1,
                ranges.len()
            );
            start = lo + 1;
            v_start = version_at(rpc, start).await?;
        }
        Ok(ranges)
    }

    // Fan the range out into sub-ranges bisected concurrently, then merge
    // segments that straddle sub-range boundaries. Full-history discovery is
    // ~150 transitions x ~23 probes each; sequential at ~150ms/probe that's
    // 10+ silent minutes -- fanned out 16-wide it's under a minute.
    use futures::stream::StreamExt;
    const FANOUT: u64 = 16;
    let span = to - from + 1;
    let step = (span / FANOUT).max(1);
    let mut subranges = Vec::new();
    let mut s = from;
    while s <= to {
        let e = (s + step - 1).min(to);
        subranges.push((s, e));
        s = e + 1;
    }
    let results: Vec<Result<Vec<SpecRange>>> = futures::stream::iter(subranges)
        .map(|(s, e)| async move { bisect_subrange(rpc, s, e).await })
        .buffer_unordered(FANOUT as usize)
        .collect()
        .await;
    let mut all: Vec<SpecRange> = Vec::new();
    for r in results {
        all.extend(r?);
    }
    Ok(merge_spec_ranges(all))
}

/// Shift a discovered version map forward by one block, so each block is
/// decoded with the runtime that ENCODED it.
///
/// `state_getRuntimeVersion(B)` reports the version *after* B executes, but a
/// runtime upgrade is applied by an extrinsic inside B -- so B itself runs on,
/// and emits events encoded by, the PREVIOUS runtime. Decoding an upgrade
/// block with the version that call reports uses the wrong type registry and
/// fails; observed live at block 7,430,358 (the v367 -> v372 boundary) as
/// `Can't decode event topics: Not enough data to fill buffer`.
///
/// This is not cosmetic: flush() only commits a chunk when EVERY block in it
/// decodes, so one boundary block wedges its whole 500-block chunk, the shard
/// retries to its round limit, exits, and the launcher restarts it onto the
/// same chunk forever. ~140 boundaries over full history means ~70k blocks
/// that could never land, each also burning a shard in a restart loop.
///
/// For non-boundary blocks `version_at(B) == version_at(B-1)`, so shifting the
/// whole map is a no-op there and correct at the boundaries -- no per-block
/// special-casing. The first segment keeps its original start so the earliest
/// blocks stay covered rather than falling off the front of the map.
pub fn shift_spec_ranges_for_event_decoding(ranges: &[SpecRange]) -> Vec<SpecRange> {
    ranges
        .iter()
        .enumerate()
        .map(|(i, &(start, end, spec, txv))| {
            let shifted_start = if i == 0 { start } else { start + 1 };
            (shifted_start, end + 1, spec, txv)
        })
        .collect()
}

/// Sort segments and coalesce adjacent ones carrying the same versions. A
/// runtime era spanning a fan-out sub-range boundary is discovered as two
/// touching segments; left unmerged they are still CORRECT (subxt's RangeMap
/// would resolve either), but they inflate the map and make the logged
/// segment count misleading.
pub fn merge_spec_ranges(mut ranges: Vec<SpecRange>) -> Vec<SpecRange> {
    ranges.sort_unstable();
    let mut merged: Vec<SpecRange> = Vec::new();
    for seg in ranges {
        match merged.last_mut() {
            Some(last) if last.1 == seg.0 && last.2 == seg.2 && last.3 == seg.3 => {
                last.1 = seg.1;
            }
            _ => merged.push(seg),
        }
    }
    merged
}

/// Serialize/deserialize `SpecRange`s for the launcher's discover-once flow:
/// entrypoint.sh runs one discovery pass (BACKFILL_DISCOVER_TO_FILE) before
/// spawning shards, and every shard then loads the SAME file
/// (BACKFILL_SPEC_FILE) instead of re-probing its slice -- N shards
/// re-discovering concurrently multiplied startup cost for zero benefit and
/// made a fresh launch look wedged for many minutes.
pub fn spec_ranges_to_json(ranges: &[SpecRange]) -> String {
    serde_json::to_string(ranges).expect("Vec of u64/u32 tuples always serializes")
}

pub fn spec_ranges_from_json(s: &str) -> Result<Vec<SpecRange>> {
    serde_json::from_str(s).context("parse spec ranges json")
}

/// Build the raw RPC transport for `url` -- stateless HTTP for http(s)://
/// (see `HttpRpcClient`), the reconnecting WS client otherwise.
pub async fn build_rpc_client(url: &str) -> Result<subxt::rpcs::client::RpcClient> {
    use subxt::rpcs::client::{ReconnectingRpcClient, RpcClient};
    let rpc_client = if url.starts_with("http://") || url.starts_with("https://") {
        // Stateless HTTP transport (HttpRpcClient above). request_timeout
        // bounds every call the same way the WS path's does; the response-size
        // cap is raised from jsonrpsee's 10 MB default because historical
        // state_getMetadata responses run to several MB and a truncated
        // metadata read fails the whole connect.
        eprintln!(
            "connect_chain: building http rpc client -> {}",
            redact_rpc_url(url)
        );
        RpcClient::new(HttpRpcClient::build(url).await?)
    } else {
        // Reconnecting WS client: a multi-hour backfill WILL see the archive drop the WSS
        // socket; without auto-reconnect every call after the first drop fails (verified).
        // request_timeout is the critical one: a throttled/wedged upstream that drops a
        // request on the floor (no error, no close) would otherwise leave the in-flight
        // decode futures awaiting forever — the whole run wedges alive-but-frozen with no
        // log line (the exact failure mode that silently stalled the metered run). A
        // bounded timeout turns that into an Err the retry loop recovers from (a dead/
        // half-open socket surfaces as a timed-out request within 60s rather than never).
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
        RpcClient::new(inner)
    };
    Ok(rpc_client)
}

pub async fn connect_chain(url: &str) -> Result<Api> {
    connect_chain_with_spec_ranges(url, &[]).await
}

/// `connect_chain`, with a pre-discovered block-range -> runtime-version map
/// baked into the client's config (see `discover_spec_ranges` for why). An
/// empty slice is exactly the old behavior: subxt falls back to a
/// `Core_version` runtime call per `at_block`.
pub async fn connect_chain_with_spec_ranges(url: &str, spec_ranges: &[SpecRange]) -> Result<Api> {
    let rpc_client = build_rpc_client(url).await?;
    connect_chain_from_rpc(rpc_client, spec_ranges).await
}

/// Assemble the OnlineClient over an ALREADY-BUILT rpc client. Exists so the
/// backfill path can reuse the one client it already probed spec ranges
/// through, rather than building a second HttpClient in the same process --
/// observed live (2026-07-31, 8/8 shards): a second jsonrpsee HttpClient's
/// FIRST request can hang indefinitely while the first client keeps working.
/// One client per process sidesteps whatever that is entirely.
pub async fn connect_chain_from_rpc(
    rpc_client: subxt::rpcs::client::RpcClient,
    spec_ranges: &[SpecRange],
) -> Result<Api> {
    use subxt::backend::LegacyBackend;
    use subxt::config::substrate::SpecVersionForRange;
    // LegacyBackend, not OnlineClient::from_rpc_client's default (CombinedBackend,
    // which tries chainhead_* before legacy_* per call): this is the actual fix for
    // the KNOWN ISSUE documented at the top of main.rs, not just a mitigation.
    // paritytech/subxt#2050 is specifically the chainHead_v1_follow subscription
    // silently going idle under heavy concurrent block-import churn -- a failure
    // mode intrinsic to that stateful subscription protocol. LegacyBackend never
    // opens one; every call (state_getMetadata, chain_getBlock, state_getStorage,
    // Core_version via state_call, ...) is a stateless one-shot RPC request, so the
    // whole bug CLASS is structurally unreachable, not just recovered-from-faster.
    // ChainClient's timeout+reconnect below stays as defense-in-depth (a slow/dead
    // TCP connection is still possible under any backend), but is no longer the
    // primary defense against #2050 specifically.
    eprintln!(
        "connect_chain: calling OnlineClient::from_backend (LegacyBackend, {} spec ranges)",
        spec_ranges.len()
    );
    let backend = LegacyBackend::builder().build(rpc_client);
    let config = PolkadotConfig::builder()
        .set_spec_version_for_block_ranges(spec_ranges.iter().map(
            |&(start, end, spec_version, transaction_version)| SpecVersionForRange {
                block_range: start..end,
                spec_version,
                transaction_version,
            },
        ))
        .build();
    let api = OnlineClient::<PolkadotConfig>::from_backend_with_config(
        config,
        std::sync::Arc::new(backend),
    )
    .await
    .context("online client")?;
    eprintln!("connect_chain: OnlineClient ready");
    Ok(api)
}

pub async fn connect_pg(url: &str) -> Result<tokio_postgres::Client> {
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

const POLLER_CONNECT_RETRY_DELAY: Duration = Duration::from_secs(30);

/// Retries `ChainClient::connect` forever (30s backoff) instead of giving
/// up after one failed attempt. Every poller job's `run_loop` uses this for
/// its startup connection: `main.rs`'s scheduler waits on the FIRST job
/// task to return via `futures::select_all` (so it can report which job
/// panicked) -- live-tested 2026-07-19 and confirmed that a `run_loop`
/// which just `return`s on a connect failure makes the WHOLE poller
/// process exit as soon as that one job's startup fails, even though every
/// OTHER job is healthy and still running. A transient/misconfigured
/// connection should keep retrying (systemd's own restart_policy is the
/// right tool for "give up and restart everything," not one job's own
/// first-attempt failure).
pub async fn connect_chain_retrying(job_name: &str, url: String) -> ChainClient {
    loop {
        match ChainClient::connect(url.clone()).await {
            Ok(c) => return c,
            Err(e) => {
                eprintln!(
                    "{job_name}: chain connect failed ({e:#}), retrying in {POLLER_CONNECT_RETRY_DELAY:?}"
                );
                tokio::time::sleep(POLLER_CONNECT_RETRY_DELAY).await;
            }
        }
    }
}

/// Retries `connect_pg` forever (30s backoff) -- see
/// `connect_chain_retrying`'s own doc comment for why every poller job's
/// `run_loop` needs this instead of giving up after one failed attempt.
pub async fn connect_pg_retrying(job_name: &str, url: &str) -> tokio_postgres::Client {
    loop {
        match connect_pg(url).await {
            Ok(c) => return c,
            Err(e) => {
                eprintln!(
                    "{job_name}: postgres connect failed ({e:#}), retrying in {POLLER_CONNECT_RETRY_DELAY:?}"
                );
                tokio::time::sleep(POLLER_CONNECT_RETRY_DELAY).await;
            }
        }
    }
}

// KNOWN ISSUE (2026-07-03, MITIGATED by ChainClient below): against our own
// metagraphed subtensor node while it is still catching up from genesis (rapidly
// importing many blocks/sec, as opposed to steady-state ~1 block/12s), both
// connect_chain()'s initial api.at_current_block() call and later
// at.at_block()-per-block metadata fetches can hang indefinitely (0% CPU, zero
// further websocket traffic, no error — NOT a slow response, a true stall).
// subxt 0.50's metadata-version probe falls back from archive_v1_call ("method not
// found") to chainHead_v1_call, which depends on a chainHead_v1_follow
// subscription, observed to receive an immediate {"event": "stop"} and require
// re-subscribing under heavy concurrent block import churn. This is a known,
// still-open upstream gap (paritytech/subxt#2050) with no built-in fix; ChainClient
// adds the app-level timeout + reconnect the subxt maintainers themselves
// recommend as the workaround. connect_chain()'s own LegacyBackend choice above
// is the structural fix for #2050 specifically; this stays as defense-in-depth
// for plain connection staleness under any backend.
//
// A generation counter guards against a reconnect storm: if several concurrent
// callers all stall around the same time, only the first to notice actually
// reconnects -- everyone else sees the generation has already moved and just
// retries against the fresh client.
const RPC_STALL_TIMEOUT: Duration = Duration::from_secs(90);
const RPC_CALL_ATTEMPTS: u32 = 3;

pub struct ChainClient {
    url: String,
    /// Reapplied on every reconnect so a rebuilt client keeps the same
    /// block-range -> runtime-version map (empty = the old per-block
    /// Core_version behavior; see `discover_spec_ranges`).
    spec_ranges: Vec<SpecRange>,
    api: RwLock<Api>,
    generation: AtomicU64,
}

impl ChainClient {
    pub async fn connect(url: String) -> Result<Self> {
        Self::connect_with_spec_ranges(url, Vec::new()).await
    }

    pub async fn connect_with_spec_ranges(
        url: String,
        spec_ranges: Vec<SpecRange>,
    ) -> Result<Self> {
        let api = connect_chain_with_spec_ranges(&url, &spec_ranges).await?;
        Ok(Self::from_parts(url, spec_ranges, api))
    }

    /// Wrap an already-constructed Api. Reconnects (rare, stall-triggered)
    /// still rebuild from `url` + `spec_ranges`.
    pub fn from_parts(url: String, spec_ranges: Vec<SpecRange>, api: Api) -> Self {
        Self {
            url,
            spec_ranges,
            api: RwLock::new(api),
            generation: AtomicU64::new(0),
        }
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
        let fresh = connect_chain_with_spec_ranges(&self.url, &self.spec_ranges).await?;
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
    /// relying on every call site to also wrap it in its own retry loop.
    pub async fn call<T, F, Fut>(&self, mut f: F) -> Result<T>
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shift_spec_ranges_moves_the_boundary_so_an_upgrade_block_uses_the_old_runtime() {
        // Discovery reports v367 up to (not including) 7430358 and v372 from
        // 7430358. Block 7430358 is the upgrade block: it EXECUTED on v367, so
        // its events must decode with v367 -- the shifted map must cover it
        // with the old version, and start v372 at the block after.
        let shifted = shift_spec_ranges_for_event_decoding(&[
            (7287033, 7430358, 367, 1),
            (7430358, 7435433, 372, 1),
        ]);
        assert_eq!(
            shifted,
            vec![(7287033, 7430359, 367, 1), (7430359, 7435434, 372, 1)]
        );
        // The upgrade block falls in the v367 segment, not the v372 one.
        let (start, end, spec, _) = shifted[0];
        assert!((start..end).contains(&7430358) && spec == 367);
    }

    #[test]
    fn shift_spec_ranges_keeps_the_first_segment_start_so_early_blocks_stay_covered() {
        // Shifting the very first start would leave block 1 off the front of
        // the map and force a per-block Core_version fallback for it.
        let shifted =
            shift_spec_ranges_for_event_decoding(&[(1, 561, 101, 1), (561, 1075, 102, 1)]);
        assert_eq!(shifted[0].0, 1);
        assert_eq!(shifted, vec![(1, 562, 101, 1), (562, 1076, 102, 1)]);
    }

    #[test]
    fn shift_spec_ranges_leaves_no_gaps_between_segments() {
        // Every block must resolve to exactly one segment; a gap would send
        // that block back to the slow per-block path.
        let shifted = shift_spec_ranges_for_event_decoding(&[
            (1, 100, 1, 1),
            (100, 200, 2, 1),
            (200, 300, 3, 1),
        ]);
        for pair in shifted.windows(2) {
            assert_eq!(pair[0].1, pair[1].0, "segment end must meet the next start");
        }
    }

    #[test]
    fn shift_spec_ranges_on_empty_input_is_empty() {
        assert!(shift_spec_ranges_for_event_decoding(&[]).is_empty());
    }

    #[test]
    fn merge_spec_ranges_coalesces_segments_split_across_fanout_boundaries() {
        // The same runtime era discovered as two touching segments by two
        // different fan-out workers must come back as one.
        let merged = merge_spec_ranges(vec![(1, 500, 101, 1), (500, 900, 101, 1)]);
        assert_eq!(merged, vec![(1, 900, 101, 1)]);
    }

    #[test]
    fn merge_spec_ranges_sorts_out_of_order_fanout_results() {
        // buffer_unordered returns sub-ranges in completion order, not block
        // order -- the map must still come out ascending.
        let merged = merge_spec_ranges(vec![(900, 1200, 133, 2), (1, 900, 101, 1)]);
        assert_eq!(merged, vec![(1, 900, 101, 1), (900, 1200, 133, 2)]);
    }

    #[test]
    fn merge_spec_ranges_keeps_touching_segments_with_different_versions_apart() {
        let merged = merge_spec_ranges(vec![(1, 900, 101, 1), (900, 1200, 133, 1)]);
        assert_eq!(merged, vec![(1, 900, 101, 1), (900, 1200, 133, 1)]);
    }

    #[test]
    fn merge_spec_ranges_does_not_bridge_a_gap_between_segments() {
        // Non-touching segments must never be merged -- doing so would claim a
        // runtime version for blocks that were never probed.
        let merged = merge_spec_ranges(vec![(1, 500, 101, 1), (600, 900, 101, 1)]);
        assert_eq!(merged, vec![(1, 500, 101, 1), (600, 900, 101, 1)]);
    }

    #[test]
    fn merge_spec_ranges_separates_equal_spec_with_differing_transaction_version() {
        // transaction_version is part of what subxt caches per range, so a
        // change in it is a real boundary even when spec_version matches.
        let merged = merge_spec_ranges(vec![(1, 900, 101, 1), (900, 1200, 101, 2)]);
        assert_eq!(merged, vec![(1, 900, 101, 1), (900, 1200, 101, 2)]);
    }

    #[test]
    fn merge_spec_ranges_on_empty_input_is_empty() {
        assert!(merge_spec_ranges(Vec::new()).is_empty());
    }

    #[test]
    fn spec_ranges_survive_a_json_round_trip() {
        // The launcher writes this file and every shard reads it; a lossy
        // round trip would silently hand shards the wrong metadata.
        let ranges: Vec<SpecRange> = vec![(1, 561, 101, 1), (561, 1075, 102, 1)];
        let restored = spec_ranges_from_json(&spec_ranges_to_json(&ranges)).unwrap();
        assert_eq!(restored, ranges);
    }

    #[test]
    fn spec_ranges_from_json_rejects_malformed_input() {
        assert!(spec_ranges_from_json("not json").is_err());
    }

    #[test]
    fn redact_rpc_url_strips_userinfo_and_query() {
        assert_eq!(
            redact_rpc_url("wss://user:pass@archive.chain.opentensor.ai:443/ws?token=secret"),
            "wss://archive.chain.opentensor.ai:443/ws"
        );
    }

    #[test]
    fn redact_rpc_url_passes_through_plain_host() {
        assert_eq!(
            redact_rpc_url("ws://meta-fullnode-01-us-nyc1:9944"),
            "ws://meta-fullnode-01-us-nyc1:9944"
        );
    }

    #[test]
    fn rao_to_tao_exact_renders_whole_amounts_with_no_decimal_point() {
        assert_eq!(rao_to_tao_exact(5_000_000_000), "5");
    }

    #[test]
    fn rao_to_tao_exact_trims_trailing_zeros_in_the_fraction() {
        assert_eq!(rao_to_tao_exact(1_500_000_000), "1.5");
    }

    #[test]
    fn rao_to_tao_exact_is_exact_above_the_f64_double_rounding_threshold() {
        // 2**53 rao (~9.007M TAO) is where `rao as f64 / 1e9` starts silently
        // losing precision -- this must stay exact past that point.
        assert_eq!(rao_to_tao_exact(9_007_199_254_740_993), "9007199.254740993");
    }

    #[test]
    fn rao_to_tao_exact_zero_is_zero() {
        assert_eq!(rao_to_tao_exact(0), "0");
    }

    // Regression test for the live 2026-07-20 finding: a `-d <body>` argv
    // element blows past the OS's ARG_MAX for a large body ("Argument list
    // too long", os error 7) BEFORE curl even attempts to connect. Posting
    // an oversized (5MB) body against a port nothing listens on must fail
    // with a curl-level connection error, not a process-spawn error --
    // proving the body traveled through stdin, not argv, regardless of size.
    #[tokio::test]
    async fn post_sync_json_handles_a_body_far_larger_than_argv_limits() {
        let big_body = "x".repeat(5 * 1024 * 1024);
        // 192.0.2.1 (TEST-NET-1, RFC 5737): reserved by IANA for exactly
        // this -- documentation/testing -- guaranteed non-routable, so curl
        // fails fast on a connection error, never a real request.
        let result = post_sync_json(
            "http://192.0.2.1:1/",
            "x-test-token",
            "secret",
            &big_body,
            "2",
        )
        .await;
        let err = result.unwrap_err().to_string();
        assert!(
            !err.contains("Argument list too long") && !err.contains("spawn curl"),
            "expected a curl-level connection error, got: {err}"
        );
    }

    #[tokio::test]
    async fn retry_transient_returns_immediately_on_first_success() {
        let mut calls = 0;
        let result = retry_transient(3, || {
            calls += 1;
            async { Ok::<_, anyhow::Error>(42) }
        })
        .await;
        assert_eq!(result.unwrap(), 42);
        assert_eq!(calls, 1);
    }

    #[tokio::test(start_paused = true)]
    async fn retry_transient_succeeds_after_transient_failures() {
        let attempt = std::cell::Cell::new(0);
        let result = retry_transient(3, || {
            attempt.set(attempt.get() + 1);
            async {
                if attempt.get() < 3 {
                    anyhow::bail!("transient");
                }
                Ok(attempt.get())
            }
        })
        .await;
        assert_eq!(result.unwrap(), 3);
    }

    #[tokio::test(start_paused = true)]
    async fn retry_transient_gives_up_after_exhausting_attempts() {
        let attempt = std::cell::Cell::new(0);
        let result: Result<()> = retry_transient(3, || {
            attempt.set(attempt.get() + 1);
            async { anyhow::bail!("always fails") }
        })
        .await;
        assert!(result.is_err());
        assert_eq!(attempt.get(), 3);
    }
}
