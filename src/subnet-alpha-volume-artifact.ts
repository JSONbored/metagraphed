// One subnet's rolling 24h alpha volume, read from the SAME scheduled projection the
// chain-wide leaderboard already serves from (#9146).
//
// Sixth instance of the shape #9367/#9369 fixed. `handleSubnetAlphaVolume` had a
// two-tier fallback -- `tryPostgresTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE)`, which is
// `"retired"` and declines unconditionally, then a zeroed card. Its chain-wide sibling
// got the projection tier and this route did not.
//
// The zeros were provably wrong, from the sibling's own output. Measured live
// 2026-08-04, `/api/v1/chain/alpha-volume` carries subnet 64 in its per-subnet
// breakdown:
//
//   buy_volume_alpha   58,932.17
//   sell_volume_alpha  66,733.61
//   total_volume_alpha 125,665.78
//
// while `/api/v1/subnets/64/volume` reported 0 for every field, over the same fixed 24h
// window, from the same rows.
//
// NO NEW QUERY AND NO NEW CRON. The projection stores data-api's per-(netuid,
// event_kind) aggregate verbatim, so this narrows the rows it already holds to one
// netuid and hands them to the per-subnet builder the Postgres tier used to feed. The
// two routes therefore cannot disagree about a subnet's volume: they are shaping the
// same rows.
import { buildAlphaVolume } from "./alpha-volume.ts";
import {
  type ChainNetworkId,
  DEFAULT_CHAIN_NETWORK,
  projectionKey,
} from "./chain-network.ts";
import { CHAIN_ALPHA_VOLUME_PROJECTION_KEY } from "./chain-alpha-volume-artifact.ts";

/** The route's one window label (fixed 24h, no `?window=` param). */
const ALPHA_VOLUME_WINDOW = "24h";

interface ArtifactBucket {
  get(key: string): Promise<{ json(): Promise<unknown> } | null>;
}

/**
 * One subnet's 24h alpha volume, or null when the artifact store cannot answer
 * FAITHFULLY — unbound, missing object, unrecognized body, or a missing 24h window.
 *
 * Declining rather than returning zeros is the whole point: the caller keeps its
 * schema-stable empty, and "no trades" stays distinguishable from "could not read". A
 * subnet genuinely absent from the projection's rows is the one case that legitimately
 * shapes to zero, and it does so through the builder rather than through a guess.
 */
export async function loadSubnetAlphaVolumeFromArtifact(
  env: Env | null | undefined,
  netuid: number,
  { marketCapTao }: { marketCapTao?: number | null } = {},
  /** Which chain's projection to read (#9412). */
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): Promise<{
  data: ReturnType<typeof buildAlphaVolume>;
  generatedAt: string | null;
} | null> {
  if (!Number.isSafeInteger(netuid) || netuid < 0) return null;
  const bucket = (env as { METAGRAPH_ARCHIVE?: ArtifactBucket } | null)
    ?.METAGRAPH_ARCHIVE;
  if (!bucket?.get) return null;
  try {
    const object = await bucket.get(
      projectionKey(CHAIN_ALPHA_VOLUME_PROJECTION_KEY, network),
    );
    if (!object) return null;
    const body = (await object.json()) as {
      schema_version?: unknown;
      windows?: unknown;
    } | null;
    // A body that is not the artifact the lane wrote is a decline, not a guess — the
    // same contract loadChainAlphaVolumeFromArtifact applies to the same object.
    if (
      body?.schema_version !== 1 ||
      typeof body.windows !== "object" ||
      body.windows === null
    ) {
      return null;
    }
    const win = (body.windows as Record<string, unknown>)[
      ALPHA_VOLUME_WINDOW
    ] as { rows?: unknown; observed_at?: unknown } | null;
    if (!Array.isArray(win?.rows)) return null;
    const rows = (win.rows as Record<string, unknown>[]).filter(
      (row) => Number(row?.netuid) === netuid,
    );
    // The lane's own timestamp, not "now": the card reports when the projection was
    // computed, so a stalled lane reads as stale rather than as fresh zeros.
    const observedAt =
      typeof win.observed_at === "string"
        ? win.observed_at
        : typeof (body as { generated_at?: unknown }).generated_at === "string"
          ? ((body as { generated_at?: string }).generated_at ?? null)
          : null;
    return {
      data: buildAlphaVolume(rows, netuid, { marketCapTao }),
      generatedAt: observedAt,
    };
  } catch {
    return null;
  }
}
