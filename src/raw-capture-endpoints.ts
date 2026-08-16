// Which archive endpoints the raw-capture lane may read from this tick.
//
// WHY THIS EXISTS. The lane read one hardcoded host
// (`https://archive.chain.opentensor.ai`) for its whole life, and the measured
// ceiling on this lane is a PER-HOST rate limit -- ~100 requests per client per
// minute (#9378). So the throughput ceiling and the endpoint were the same
// number, and the lane fell 8,409 blocks (~28 h) behind the chain on 2026-08-16
// with no way to buy its way out. Meanwhile the registry already curates,
// probes and scores a second archive-capable HTTP endpoint
// (`onfinality-finney-rpc`), and nothing read it.
//
// WHAT THIS IS NOT. It is not a second endpoint registry, and it does not
// judge health itself. It reads the SAME `/metagraph/rpc/pools.json` the RPC
// proxy and the WSS load balancer read, after the SAME 15-minute live overlay,
// and applies the pool's own eligibility. A host this refuses is a host the
// rest of the estate has already refused.
//
// WHY NOT `orderSafeRpcEndpoints`. That helper is the right shape but the wrong
// layer: it lives in workers/request-handlers/rpc-proxy.ts beside the per-isolate
// circuit breaker it mutates on every proxied request, which is state about
// PROXY traffic and not about this cron. Reusing it would couple a capture tick
// to the eject/half-open state of unrelated user requests. The filtering rules
// this needs are the pool's own published fields, so it reads them directly.
//
// THE FALLBACK IS THE POINT, exactly as it is for the account-summary
// projection: an unreadable artifact, an empty overlay, or a pool with no
// archive-capable member all yield the caller's configured default. This can
// make the lane faster, never blind.

import { KV_HEALTH_RPC_POOL } from "./health-prober.ts";
import { overlayRpcPoolEligibility } from "./health-serving.ts";
import { recordOrNull } from "./read-store.ts";
import type { ChainNetworkId } from "./chain-network.ts";
// PARSED, NOT CAST, and with the schema this artifact already has rather than a
// second one -- a second declaration of the same bytes is a second place for the
// reading to drift.
//
// It pins the structure a consumer NAVIGATES (`pools` is a REQUIRED list, so an
// error body cannot parse as an artifact that merely holds no pools) and leaves
// the leaves `unknown`, because this module narrows them itself. Note that a
// leaf must still be DECLARED there to survive the parse at all: zod strips
// undeclared keys, so an omitted field reads as `undefined` from a perfectly
// healthy artifact rather than going merely untyped.
import { RpcPoolsReadSchema } from "../schemas-src/internal-wire.ts";

/** The pool ids that hold base-layer HTTP RPC endpoints, per network. */
const RPC_POOL_ID: Record<ChainNetworkId, string> = {
  mainnet: "finney-rpc",
  testnet: "test-rpc",
};

type Row = Record<string, unknown>;

export interface CaptureEndpointEnv {
  METAGRAPH_ARCHIVE?: unknown;
}

export interface CaptureEndpointDeps {
  readArtifact: (
    env: unknown,
    path: string,
  ) => Promise<{
    ok?: boolean;
    data?: unknown;
  }>;
  readHealthKv?: (env: unknown, key: string) => Promise<unknown>;
}

export const RPC_POOLS_ARTIFACT_PATH = "/metagraph/rpc/pools.json";

/**
 * Is this a host this lane may read historical STATE from?
 *
 * `archive_support` is the only field that answers it, and it is probe-derived:
 * `chain_getBlockHash(1)` succeeds on an archive node and fails on a pruned one
 * (verified live 2026-08-16 -- `lite` and `entrypoint` fail it, `archive` and
 * `onfinality` pass). Capture reads `state_getStorage` at heights up to a day
 * back, so a pruned host would answer `UnknownBlock: State already discarded`
 * for every one of them.
 *
 * https only: the lane POSTs JSON-RPC, so a `wss://` row is not callable here
 * even though it is perfectly healthy. That is why the `finney-archive` pool --
 * whose four members are all `subtensor-wss` -- cannot serve this lane, and why
 * this reads the rpc pool and filters rather than reading the archive pool.
 */
function usableArchiveEndpoint(row: Row): boolean {
  const url = typeof row.url === "string" ? row.url : "";
  return (
    row.pool_eligible === true &&
    row.archive_support === true &&
    url.startsWith("https://")
  );
}

/**
 * The archive endpoints for `network`, best first, or `[]` when the pool cannot
 * answer.
 *
 * Ordering is the pool's own: it is published already sorted by the comparator
 * `overlayRpcPoolEligibility` applies after refreshing score and reliability, so
 * re-sorting here would be a second opinion about a question the pool owns.
 */
export async function resolveCaptureEndpoints(
  env: CaptureEndpointEnv | null | undefined,
  network: ChainNetworkId,
  deps: CaptureEndpointDeps,
): Promise<string[]> {
  if (!env) return [];
  let parsed: { pools: { id?: string; endpoints?: unknown[] }[] } | null;
  try {
    const result = await deps.readArtifact(env, RPC_POOLS_ARTIFACT_PATH);
    if (!result?.ok) return [];
    const read = RpcPoolsReadSchema.safeParse(result.data);
    if (!read.success) return [];
    // The union accepts the artifact both bare and enveloped, because it is
    // served as a file AND on /api/v1; `pools` is present in either arm.
    parsed = "data" in read.data ? read.data.data : read.data;
  } catch {
    // An unreadable pool is not a fault here -- the caller has a default.
    return [];
  }
  if (!parsed) return [];

  // ONE POOL, not all of them: only this network's is ever read, so overlaying
  // the rest would spend the recompute on rows nothing here looks at.
  const wanted = RPC_POOL_ID[network];
  const found = parsed.pools.find((p) => p.id === wanted);
  if (!found) return [];

  // The same live overlay the REST route and the MCP mirror apply, so this
  // cannot select on a day-old `pool_eligible` or a day-old `archive_support`.
  let pool: Row = found as Row;
  if (deps.readHealthKv) {
    try {
      const live = recordOrNull(
        await deps.readHealthKv(env, KV_HEALTH_RPC_POOL),
      );
      if (live && Array.isArray(live.endpoints)) {
        pool = (overlayRpcPoolEligibility(pool, live) ?? pool) as Row;
      }
    } catch {
      // Fall through on the baked pool rather than declining: a stale
      // eligibility flag is still the estate's own judgement, and the
      // per-endpoint failover in captureTick covers a host that has since died.
    }
  }

  if (!Array.isArray(pool.endpoints)) return [];
  const urls: string[] = [];
  for (const row of pool.endpoints as Row[]) {
    if (usableArchiveEndpoint(row)) urls.push(row.url as string);
  }
  return urls;
}

/**
 * The endpoint list a tick should actually use.
 *
 * The configured default is ALWAYS present and always first: it is the host
 * this lane has read for its whole life, the one whose behaviour under this
 * exact call pattern was measured, and the only one guaranteed to exist when
 * the pool cannot be read. Pool members join behind it, de-duplicated, so a
 * pool that already names it does not double its share of the rotation.
 */
export function captureEndpointList(
  configuredDefault: string,
  fromPool: readonly string[],
): string[] {
  const seen = new Set<string>([configuredDefault]);
  const urls = [configuredDefault];
  for (const url of fromPool) {
    if (seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}
