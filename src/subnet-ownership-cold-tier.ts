// Subnet-ownership reads served from the lakehouse when the Postgres tier
// misses.
//
// THE SOURCE IS chain_events, NOT the subnet_ownership tables, deliberately.
// The one route behind METAGRAPH_SUBNET_OWNERSHIP_SOURCE (/accounts/
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
import { OWNERSHIP_CHANGE_EVENT_METHOD } from "./subnet-ownership-history.ts";
import { r2SqlQuery } from "./r2-sql.ts";

/** Kept identical to the Postgres tier's SELECT list so both tiers hand the
 * formatter the same shape. */
const OWNERSHIP_EVENT_COLUMNS =
  "block_number, pallet, method, args, observed_at";

/**
 * Every SubnetOwnerChanged event, oldest first -- the coldkey filter happens
 * in buildAccountEntities, in JS after decoding, exactly as it does on the
 * Postgres tier (the raw args store hex pubkeys, so a SQL-side address
 * equality is not expressible on either tier). The address therefore never
 * reaches the string-built query and needs no literal guard here.
 *
 * Returns null when the lakehouse cannot answer, so the caller keeps its
 * schema-stable empty-ties fallback.
 */
export async function loadAccountEntitiesColdTier(
  env: Env | null | undefined,
  coldkey: string,
): Promise<ReturnType<typeof buildAccountEntities> | null> {
  const rows = await r2SqlQuery(
    env,
    // Both predicate values are module constants, never caller input -- the
    // only reason string interpolation is tolerable without a guard.
    `SELECT ${OWNERSHIP_EVENT_COLUMNS} FROM chain.chain_events` +
      ` WHERE pallet = 'SubtensorModule' AND method = '${OWNERSHIP_CHANGE_EVENT_METHOD}'` +
      ` ORDER BY block_number ASC`,
  );
  if (rows === null) return null;

  // postgres.js hands JSONB back parsed; the lakehouse stores `args` as a
  // JSON string (Iceberg has no JSON type). Restore the driver shape before
  // the shared decode path sees the rows -- decodeChainEventArgs does not
  // parse strings, and handing it one would silently drop the row from the
  // ties (a wrong answer, not a degraded one). A cell that cannot be
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
  // entities (the community-label artifact join) is [] on this tier exactly
  // as it is on data-api's -- the handler joins labels on afterward.
  return buildAccountEntities(coldkey, {
    entities: [],
    ownershipRows: restored,
  });
}
