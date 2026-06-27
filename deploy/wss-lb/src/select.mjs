// Pure health-aware upstream selection for the WSS load balancer (ADR 0013).
// Consumes the /api/v1/rpc/pools artifact:
//   { pools: [{ id: "finney-wss", kind: "subtensor-wss",
//               endpoints: [{ url, pool_eligible, score, latest_block, status }] }] }
// Network is the POOL id (`<network>-wss`), NOT a per-endpoint field, and the
// pool already kind-filters + score-sorts. No I/O — unit-tested.

function scoreOf(e) {
  const n = Number(e.score);
  return Number.isFinite(n) ? n : 0;
}

// A reported block height, or null when absent. Explicit null/undefined check —
// NOT Number(e.latest_block), because Number(null) === 0 (finite), which would
// mis-read a block-less endpoint (e.g. the unmonitored testnet pool) as height 0
// and wrongly drop it as stale.
function blockOf(e) {
  if (e.latest_block == null) return null;
  const n = Number(e.latest_block);
  return Number.isFinite(n) ? n : null;
}

// A pool endpoint routable as a wss upstream. `pool_eligible` is THE canonical
// gate — it already encodes "monitored && status ok" for finney AND "static
// testnet member, liveness via the breaker/failover" for test. We must NOT also
// require status === "ok": static testnet wss is pool_eligible with
// status "unknown", and a status gate would drop the whole testnet pool.
export function isWssUpstream(e) {
  return (
    Boolean(e) &&
    e.pool_eligible === true &&
    typeof e.url === "string" &&
    e.url.startsWith("wss://")
  );
}

// The subtensor-wss pool for `network` (pool id `<network>-wss`, e.g. finney-wss).
export function wssPoolFor(poolsArtifact, network) {
  const pools = Array.isArray(poolsArtifact?.pools) ? poolsArtifact.pools : [];
  return (
    pools.find(
      (p) => p && p.kind === "subtensor-wss" && p.id === `${network}-wss`,
    ) || null
  );
}

// Ordered list of upstream wss URLs for `network`, best first: pool-eligible
// endpoints within `maxBlockLag` of the freshest tip among them (an endpoint with
// no reported block is kept — benefit of the doubt), score desc. Empty when the
// pool is absent or has no eligible members (the caller 503s).
export function selectWssUpstreams(poolsArtifact, network, opts = {}) {
  const maxBlockLag = opts.maxBlockLag ?? 50;
  const pool = wssPoolFor(poolsArtifact, network);
  const healthy = (pool?.endpoints || []).filter(isWssUpstream);
  const blocks = healthy.map(blockOf).filter((b) => b != null);
  let upstreams = healthy;
  if (blocks.length) {
    const tip = Math.max(...blocks);
    upstreams = healthy.filter((e) => {
      const b = blockOf(e);
      return b == null || tip - b <= maxBlockLag; // no block → benefit of the doubt
    });
  }
  return upstreams
    .slice()
    .sort((a, b) => scoreOf(b) - scoreOf(a))
    .map((e) => e.url);
}
