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

pub async fn connect_chain(url: &str) -> Result<Api> {
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
    eprintln!("connect_chain: calling OnlineClient::from_backend (LegacyBackend)");
    let backend = LegacyBackend::builder().build(rpc_client);
    let api = OnlineClient::<PolkadotConfig>::from_backend(std::sync::Arc::new(backend))
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
    api: RwLock<Api>,
    generation: AtomicU64,
}

impl ChainClient {
    pub async fn connect(url: String) -> Result<Self> {
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
}
