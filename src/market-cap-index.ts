// Every subnet's alpha_market_cap_tao in one Map, for routes that need the
// denominator across the whole network rather than for one subnet (#9526).
//
// The per-subnet twin is resolveSubnetMarketCapTao in
// workers/request-handlers/entities.ts, which resolves exactly the same two
// tiers and then discards all but one entry. That is the right shape for a
// subnet route and the wrong one for a leaderboard: the economics blob is
// ALREADY the full subnets[] array, so a chain-level caller wants one read and
// a keyed index, not N reads.
//
// Live KV first, committed R2 artifact second — the same order and the same
// staleness/contract guards resolveLiveEconomics applies, so a wedged or
// off-contract writer falls through to the artifact rather than serving a
// frozen denominator.
//
// Returns an EMPTY map, never null, when neither tier answers. Callers divide
// by "the market cap for this netuid, if we have one"; a missing entry and an
// empty index are the same fact to them, and vol_mcap_ratio's own guard already
// renders both as null.

import { resolveLiveEconomics } from "./health-serving.ts";
import { KV_ECONOMICS_CURRENT } from "./kv-keys.ts";
import { readArtifact, readHealthKv } from "../workers/storage.ts";
import { contractVersion } from "../workers/responses.ts";

type Row = Record<string, unknown>;

/** Where economics.json lives when the live KV tier is cold or off-contract. */
const ECONOMICS_ARTIFACT_PATH = "/metagraph/economics.json";

/** Index the economics `subnets[]` rows by netuid, keeping only usable
 * denominators. A zero or negative market cap is dropped rather than stored:
 * volMcapRatio would reject it anyway, and an absent key says "no denominator"
 * more honestly than a stored zero. */
function indexMarketCaps(rows: unknown): Map<number, number> {
  const index = new Map<number, number>();
  if (!Array.isArray(rows)) return index;
  for (const row of rows as Row[]) {
    const netuid = Number(row?.netuid);
    const marketCap = row?.alpha_market_cap_tao;
    if (!Number.isInteger(netuid) || netuid < 0) continue;
    if (typeof marketCap !== "number" || !Number.isFinite(marketCap)) continue;
    if (marketCap <= 0) continue;
    index.set(netuid, marketCap);
  }
  return index;
}

// No try/catch here on purpose. Both reads already degrade to a miss on their
// own -- readHealthKv swallows and returns null (workers/storage.ts:490-499),
// readArtifact reports { ok: false } on a timeout or throw -- and indexing is
// pure. Wrapping them again would add a branch nothing can reach, and the
// guarantee the callers actually need (an unreachable economics tier costs a
// null ratio, never a failed leaderboard) is the one those helpers give.
// tests/market-cap-index.test.ts pins that by exploding both bindings.
export async function resolveMarketCapIndex(
  env: Env | null | undefined,
): Promise<Map<number, number>> {
  if (!env) return new Map();
  const live = await resolveLiveEconomics({
    readHealthKv: (e) => readHealthKv(e, KV_ECONOMICS_CURRENT),
    env,
    contractVersion: contractVersion(env),
  });
  const liveIndex = indexMarketCaps(live?.data?.subnets);
  if (liveIndex.size > 0) return liveIndex;
  const artifact = await readArtifact(env, ECONOMICS_ARTIFACT_PATH);
  return artifact.ok
    ? indexMarketCaps((artifact.data as Row | undefined)?.subnets)
    : new Map();
}
