// One subnet's rolling 24h alpha volume, read from the SAME scheduled projection the
// chain-wide leaderboard already serves from (#9146).
//
// Sixth instance of the shape #9367/#9369 fixed. `handleSubnetAlphaVolume` had a
// two-tier fallback -- `tryDataApiTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE)`, which is
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
import { z } from "zod";

import { buildAlphaVolume } from "./alpha-volume.ts";
import { type ChainNetworkId, DEFAULT_CHAIN_NETWORK } from "./chain-network.ts";
import {
  ALPHA_VOLUME_WINDOW,
  ALPHA_VOLUME_WINDOWS,
  CHAIN_ALPHA_VOLUME_PROJECTION_KEY,
} from "./chain-alpha-volume-artifact.ts";
import { readProjectionWindow } from "./projection-store.ts";
import { ProjectionRowsCellSchema } from "../schemas-src/projection-artifact.ts";

/**
 * The alpha-volume cell: rows, plus the window's own compute stamp.
 *
 * `observed_at` is `.catch(undefined)` rather than a hard string, and that is
 * deliberate: it is a DISPLAY field with an envelope-level fallback, so a lane
 * that wrote it as a number should degrade to the envelope's `generated_at`,
 * not fail the whole read and drop a subnet's volume card. Rows, which the
 * numbers come from, get no such leniency.
 */
const AlphaVolumeCellSchema = ProjectionRowsCellSchema.extend({
  observed_at: z.string().optional().catch(undefined),
});

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
  const read = await readProjectionWindow(env, {
    key: CHAIN_ALPHA_VOLUME_PROJECTION_KEY,
    network,
    window: ALPHA_VOLUME_WINDOW,
    defaultWindow: ALPHA_VOLUME_WINDOW,
    windows: ALPHA_VOLUME_WINDOWS,
    cell: AlphaVolumeCellSchema,
  });
  if (!read) return null;
  const rows = read.cell.rows.filter((row) => Number(row.netuid) === netuid);
  return {
    data: buildAlphaVolume(rows, netuid, { marketCapTao }),
    // The lane's own timestamp, not "now": the card reports when the projection
    // was computed, so a stalled lane reads as stale rather than as fresh zeros.
    // The cell's own stamp wins over the envelope's because a multi-window
    // artifact is written once but its windows can be computed at different
    // ticks.
    generatedAt: read.cell.observed_at ?? read.generatedAt,
  };
}
