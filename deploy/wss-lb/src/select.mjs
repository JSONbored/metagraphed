// Pure health-aware upstream selection for the WSS load balancer (ADR 0013).
// Consumes the /api/v1/rpc-endpoints shape:
//   { id, url, kind, network, pool_eligible, score, status, latest_block, ... }
// No I/O — unit-tested (test/select.test.mjs).

function scoreOf(e) {
  const n = Number(e.score);
  return Number.isFinite(n) ? n : 0;
}

// A registered endpoint usable as a wss upstream for `network`: the right kind,
// network, currently pool-eligible (live health + static policy agree), status
// ok, and an actual wss:// URL.
export function isHealthyWss(network) {
  return (e) =>
    Boolean(e) &&
    e.kind === "subtensor-wss" &&
    e.network === network &&
    e.pool_eligible === true &&
    e.status === "ok" &&
    typeof e.url === "string" &&
    e.url.startsWith("wss://");
}

// Ordered list of upstream wss URLs for `network`, best first. Two filters,
// mirroring cosmos.directory's "route to the most up-to-date node": (1) healthy
// + eligible; (2) within `maxBlockLag` of the freshest tip among them (an
// endpoint with no reported block is kept — benefit of the doubt). Tie-broken by
// score desc. Empty when nothing is healthy (the caller 503s).
// A reported block height, or null when absent. Explicit null/undefined check —
// NOT Number(e.latest_block), because Number(null) === 0 (finite), which would
// mis-read a block-less endpoint as height 0 and wrongly drop it as stale.
function blockOf(e) {
  if (e.latest_block == null) return null;
  const n = Number(e.latest_block);
  return Number.isFinite(n) ? n : null;
}

export function selectWssUpstreams(endpoints, network, opts = {}) {
  const maxBlockLag = opts.maxBlockLag ?? 50;
  const healthy = (Array.isArray(endpoints) ? endpoints : []).filter(
    isHealthyWss(network),
  );
  const blocks = healthy.map(blockOf).filter((b) => b != null);
  let pool = healthy;
  if (blocks.length) {
    const tip = Math.max(...blocks);
    pool = healthy.filter((e) => {
      const b = blockOf(e);
      return b == null || tip - b <= maxBlockLag; // no block → benefit of the doubt
    });
  }
  return pool
    .slice()
    .sort((a, b) => scoreOf(b) - scoreOf(a))
    .map((e) => e.url);
}
