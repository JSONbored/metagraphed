// Subnet-ownership reads served from the lakehouse when the Postgres tier
// misses.
//
// TWO ROUTES, ONE STREAM. /accounts/{coldkey}/entities reads the ownership
// ties of one ADDRESS; /subnets/{netuid}/ownership-history reads the transfer
// log of one SUBNET. Both are the same SubnetOwnerChanged events, so both
// read them once, here, and differ only in which formatter narrows them.
//
// THE SOURCE IS chain_events, NOT the subnet_ownership tables, deliberately.
// The route behind METAGRAPH_SUBNET_OWNERSHIP_SOURCE (/accounts/
// {coldkey}/entities) is built on the SubnetOwnerChanged event stream:
// data-api reads raw chain_events rows and buildAccountEntities decodes the
// hex pubkeys in `args` to SS58 addresses itself. The lakehouse's
// subnet_ownership_history snapshot could only reproduce those ties by
// diffing consecutive owner rows locally -- a second, subtly different
// decoder for the same facts -- so parity means reading the same stream from
// chain.chain_events and feeding the same formatter.
//
// The scan is pallet+method filtered over a large table with no index to
// lean on, so it can be slow on a cold cache. That is acceptable here: the
// route sits behind the edge cache, ownership changes are rare enough that
// the match set is tiny, and a timeout declines to the caller's existing
// schema-stable empty rather than failing the request.

import { buildAccountEntities } from "./entity-labels.ts";
import {
  buildSubnetOwnershipHistory,
  OWNERSHIP_CHANGE_EVENT_METHOD,
} from "./subnet-ownership-history.ts";
import { r2SqlQuery, safeBlockNumber } from "./r2-sql.ts";

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
async function loadOwnershipChangeRows(
  env: Env | null | undefined,
): Promise<Record<string, unknown>[] | null> {
  const rows = await r2SqlQuery(
    env,
    `SELECT ${OWNERSHIP_EVENT_COLUMNS} FROM chain.chain_events` +
      ` WHERE pallet = 'SubtensorModule' AND method = '${OWNERSHIP_CHANGE_EVENT_METHOD}'` +
      ` ORDER BY block_number ASC`,
  );
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
  env: Env | null | undefined,
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
  env: Env | null | undefined,
  netuid: unknown,
): Promise<ReturnType<typeof buildSubnetOwnershipHistory> | null> {
  const subnet = safeBlockNumber(netuid);
  if (subnet === null) return null;
  const rows = await loadOwnershipChangeRows(env);
  if (rows === null) return null;
  return buildSubnetOwnershipHistory(rows, subnet, { filterByNetuid: true });
}
