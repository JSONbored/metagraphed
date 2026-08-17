// The SubnetOwnerChanged stream, served from a SCHEDULED PROJECTION artifact
// instead of scanning 895M rows per request (#11421).
//
// ## What this replaces, and what it costs today
//
// `loadOwnershipChangeRows` asks `chain.chain_events` for
// `pallet = 'SubtensorModule' AND method = 'SubnetOwnerChanged'` with NO block
// window and NO limit. Neither predicate prunes files -- they are low-cardinality
// string equalities on a 895M-row table -- so the engine opens the table to
// return, by that module's own account, ONE row. Automatic ownership transfers
// are rare chain-wide events, which is what makes the unfiltered read
// defensible and also what makes precomputing it obvious.
//
// Measured against production 2026-08-16 with `Server-Timing` (#11442), five
// draws each with DISTINCT subjects so the edge cache could not answer:
//
//   /accounts/{ss58}/entities            min 10,420  median 13,711  max 15,108
//   /subnets/{netuid}/ownership-history  min  6,842  median 10,516  max 27,704
//
// The narrow spread on `entities` (1.45x, and a MINIMUM of 10.4s) is what marks
// this as a real floor rather than the warehouse variance #11420 turned out to
// be: there is no lucky draw here, every call pays it. The second route runs
// this scan plus its own observations read, which is why it reports two calls.
//
// ## Why the whole stream, not a window
//
// The other lanes store per-window rollups because their routes ask about a
// window. This one is a HISTORY: a caller asking who has ever traded a subnet
// is asking about all of it, so the artifact holds the entire stream. It can
// afford to -- one row today, and a chain-wide ownership transfer is not a
// thing that arrives in volume.
//
// ## What it does NOT change
//
// The rows are stored exactly as `loadOwnershipChangeRows` returns them, with
// `args` already restored from Iceberg's JSON string to the parsed shape
// postgres.js would have delivered. That restoration is the reader's contract
// with `decodeChainEventArgs`, which does not parse strings and would silently
// drop a row handed one -- so doing it in the lane rather than after the read
// keeps one definition of "a usable ownership row" instead of two.
import { z } from "zod";

import { type ChainNetworkId, DEFAULT_CHAIN_NETWORK } from "./chain-network.ts";
import {
  type ArtifactStoreEnv,
  readArtifactObject,
} from "./projection-store.ts";
import { ProjectionRowsSchema } from "../schemas-src/projection-artifact.ts";

export const CHAIN_OWNERSHIP_PROJECTION_KEY =
  "metagraph/projections/chain-ownership.json";

/**
 * The stored stream.
 *
 * `rows` is REQUIRED and an empty array is a real answer: a chain on which
 * nothing has been traded is the honest state for 127 of 128 subnets, and a
 * lane that found none must be able to say so. What must never happen is an
 * absent `rows` reading as "none", which is why it is not optional.
 */
const OwnershipArtifactSchema = z.object({
  schema_version: z.literal(1),
  rows: ProjectionRowsSchema,
});

/**
 * Every SubnetOwnerChanged row the lane last stored, or null when the artifact
 * store cannot answer FAITHFULLY -- unbound, missing object, or a body that is
 * not what the lane wrote.
 *
 * Null sends the caller to the lakehouse read this exists to avoid, which is
 * the point: this can only make the route faster, never wrong, and shipping it
 * before the lane has first run is safe by construction.
 */
export async function loadOwnershipRowsFromArtifact(
  env: ArtifactStoreEnv | null | undefined,
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): Promise<Record<string, unknown>[] | null> {
  const body = await readArtifactObject(
    env,
    CHAIN_OWNERSHIP_PROJECTION_KEY,
    network,
    OwnershipArtifactSchema,
  );
  return body?.rows ?? null;
}
