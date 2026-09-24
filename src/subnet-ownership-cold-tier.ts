// Ownership cards combine the native event projection with verified owner observations.
// The explicit query reader below is used by the portable projection producer;
// request paths cannot fall back to the retired R2 SQL service.
import { readStateArchiveRows } from "./state-archive-read.ts";
import { buildAccountEntities } from "./entity-labels.ts";
import {
  buildSubnetOwnershipHistory,
  OWNERSHIP_CHANGE_EVENT_METHOD,
} from "./subnet-ownership-history.ts";
import { safeBlockNumber } from "./history-readers.ts";
import type {
  HistoryReadEnv,
  HistoricalQueryReader,
} from "./history-readers.ts";
import {
  chainTable,
  type ChainNetworkId,
  DEFAULT_CHAIN_NETWORK,
} from "./chain-network.ts";
import { loadOwnershipRowsFromArtifact } from "./subnet-ownership-artifact.ts";
import type { ArtifactStoreEnv } from "./projection-store.ts";

/** The ordinary producer and request readers share the same artifact bindings. */
type OwnershipReadEnv = HistoryReadEnv & ArtifactStoreEnv;

/** Kept identical to the Postgres tier's SELECT list so both tiers hand the
 * formatter the same shape. */
const OWNERSHIP_EVENT_COLUMNS =
  "block_number, pallet, method, args, observed_at";

/**
 * Every SubnetOwnerChanged event, oldest first, with `args` restored to the
 * parsed shape postgres.js would have delivered -- or null when the lakehouse
 * cannot answer FAITHFULLY.
 *
 * Unfiltered on purpose, and shared by both readers below. Neither predicate
 * a caller might want is expressible here: the raw args store hex pubkeys
 * (so an address equality is a JS-side filter on BOTH tiers), and the args
 * column is an opaque JSON string in Iceberg (so the netuid equality
 * data-api writes as a JSONB match has no SQL form here either). Both
 * predicate values below are module constants, never caller input -- the only
 * reason string interpolation is tolerable without a guard.
 *
 * The whole stream is small enough for that to be the right trade: automatic
 * ownership transfers are rare chain-wide events, not a feed.
 */
export async function fetchOwnershipChangeRows(
  env: (HistoryReadEnv & ArtifactStoreEnv) | null | undefined,
  network: ChainNetworkId | undefined,
  query: HistoricalQueryReader,
): Promise<Record<string, unknown>[] | null> {
  const rows = await query(
    env,
    `SELECT ${OWNERSHIP_EVENT_COLUMNS} FROM ${chainTable("chain_events", network)}` +
      ` WHERE pallet = 'SubtensorModule' AND method = '${OWNERSHIP_CHANGE_EVENT_METHOD}'` +
      ` ORDER BY block_number ASC`,
  );
  return restoreOwnershipArgs(rows);
}

/** Preserve the producer's parsed argument shape for both native readers. */
function restoreOwnershipArgs(rows: Record<string, unknown>[] | null) {
  if (rows === null) return null;

  // postgres.js hands JSONB back parsed; the lakehouse stores `args` as a
  // JSON string (Iceberg has no JSON type). Restore the driver shape before
  // the shared decode path sees the rows -- decodeChainEventArgs does not
  // parse strings, and handing it one would silently drop the row from the
  // answer (a wrong answer, not a degraded one). A cell that cannot be
  // restored faithfully declines the whole read for the same reason.
  const restored: Record<string, unknown>[] = [];
  for (const row of rows) {
    if (typeof row.args !== "string") {
      restored.push(row);
      continue;
    }
    try {
      restored.push({ ...row, args: JSON.parse(row.args) });
    } catch {
      return null;
    }
  }
  return restored;
}

/** Only a published native projection can establish an empty event stream. */
async function loadOwnershipChangeRows(
  env: OwnershipReadEnv | null | undefined,
  network?: ChainNetworkId,
): Promise<Record<string, unknown>[] | null> {
  return restoreOwnershipArgs(
    await loadOwnershipRowsFromArtifact(env, network ?? DEFAULT_CHAIN_NETWORK),
  );
}

/**
 * GET /api/v1/accounts/{coldkey}/entities -- one address's subnet-ownership
 * ties. The coldkey filter happens in buildAccountEntities, in JS after
 * decoding, exactly as it does on the Postgres tier, so the address never
 * reaches the string-built query and needs no literal guard here.
 *
 * Returns null when the lakehouse cannot answer, so the caller keeps its
 * schema-stable empty-ties fallback.
 */
export async function loadAccountEntitiesColdTier(
  env: OwnershipReadEnv | null | undefined,
  coldkey: string,
): Promise<ReturnType<typeof buildAccountEntities> | null> {
  const rows = await loadOwnershipChangeRows(env);
  if (rows === null) return null;
  // entities (the community-label artifact join) is [] on this tier exactly
  // as it is on data-api's -- the handler joins labels on afterward.
  return buildAccountEntities(coldkey, {
    entities: [],
    ownershipRows: rows,
  });
}

/**
 * GET /api/v1/subnets/{netuid}/ownership-history -- the same SubnetOwnerChanged
 * stream, narrowed to one subnet. `filterByNetuid` moves data-api's JSONB
 * predicate into the shared formatter (see buildSubnetOwnershipHistory's own
 * note for why it lives there and not here): identical row set, one decode of
 * `args`, and no second decoder for the same facts.
 *
 * Returns null when the lakehouse cannot answer, so the caller keeps its
 * schema-stable empty-list fallback. An unusable netuid declines rather than
 * echoing a nonsense value back into the payload.
 */
export async function loadSubnetOwnershipHistoryColdTier(
  env: OwnershipReadEnv | null | undefined,
  netuid: unknown,
): Promise<ReturnType<typeof buildSubnetOwnershipHistory> | null> {
  const subnet = safeBlockNumber(netuid);
  if (subnet === null) return null;
  const [rows, observations] = await Promise.all([
    loadOwnershipChangeRows(env),
    loadSubnetOwnerObservations(env, subnet),
  ]);
  if (rows === null || observations === null) return null;
  return buildSubnetOwnershipHistory(rows, subnet, {
    filterByNetuid: true,
    observations,
  });
}

/** Owner changes observed by the poller, ordered by their original capture. */
export async function loadSubnetOwnerObservations(
  env: (HistoryReadEnv & ArtifactStoreEnv) | null | undefined,
  netuid: number,
): Promise<Record<string, unknown>[] | null> {
  const n = safeBlockNumber(netuid);
  if (n === null) return null;
  const archive = await readStateArchiveRows(env, "subnet_ownership_history");
  return archive == null
    ? null
    : archive
        .filter((row) => Number(row.netuid) === n)
        .sort((a, b) => Number(a.captured_at) - Number(b.captured_at))
        .map(({ owner_coldkey, captured_at }) => ({
          owner_coldkey,
          captured_at,
        }));
}
