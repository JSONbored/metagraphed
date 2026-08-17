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
// THE SCAN IS NOW BEHIND A LANE (#11421). It is pallet+method filtered over a
// large table with no index to lean on, and that was called "acceptable ...
// can be slow on a cold cache" here until it was measured. Against production
// 2026-08-16, `/accounts/{ss58}/entities` spent a MINIMUM of 10,420ms in r2sql
// across five distinct subjects, median 13,711ms -- not a cold-cache tail but
// a floor every caller pays, to return the one row this table holds.
//
// `loadOwnershipChangeRows` reads the projection first and falls through to
// this query when the lane has not run, so the answer is unchanged either way
// and the edge cache is no longer the only thing standing between a caller and
// a 13-second read.

import { buildAccountEntities } from "./entity-labels.ts";
import {
  buildSubnetOwnershipHistory,
  OWNERSHIP_CHANGE_EVENT_METHOD,
} from "./subnet-ownership-history.ts";
import { r2SqlQuery, safeBlockNumber } from "./r2-sql.ts";
import type { R2SqlEnv } from "./r2-sql.ts";
import {
  chainTable,
  type ChainNetworkId,
  DEFAULT_CHAIN_NETWORK,
} from "./chain-network.ts";
import { loadOwnershipRowsFromArtifact } from "./subnet-ownership-artifact.ts";
import type { ArtifactStoreEnv } from "./projection-store.ts";

/**
 * Both stores these readers touch: the lakehouse they fall back to, and the
 * archive the lane writes. Declared rather than cast into -- `R2SqlEnv` names
 * only the warehouse credentials, and widening it would tell every other
 * `r2SqlQuery` caller it has a bucket.
 */
type OwnershipReadEnv = R2SqlEnv & ArtifactStoreEnv;

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
  env: R2SqlEnv | null | undefined,
  network?: ChainNetworkId,
): Promise<Record<string, unknown>[] | null> {
  const rows = await r2SqlQuery(
    env,
    `SELECT ${OWNERSHIP_EVENT_COLUMNS} FROM ${chainTable("chain_events", network)}` +
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
 * The stream, from the LANE if it has run and from the lakehouse if it has not.
 *
 * The artifact is tried first because the read below is the expensive one:
 * measured against production 2026-08-16, `/accounts/{ss58}/entities` spent a
 * median of 13,711ms in r2sql with a MINIMUM of 10,420ms across five distinct
 * subjects -- a floor every caller pays, not a tail some callers draw.
 *
 * Falling through on a miss is what makes this safe to ship before the lane has
 * ever run: the answer is identical either way, because the lane stores exactly
 * what `fetchOwnershipChangeRows` returned.
 */
async function loadOwnershipChangeRows(
  env: OwnershipReadEnv | null | undefined,
  network?: ChainNetworkId,
): Promise<Record<string, unknown>[] | null> {
  const projected = await loadOwnershipRowsFromArtifact(
    env,
    network ?? DEFAULT_CHAIN_NETWORK,
  );
  if (projected !== null) return projected;
  return await fetchOwnershipChangeRows(env, network);
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

/** The ledger's SELECT list. `owner_hotkey` is read but not published: the
 * contract's records are coldkey-to-coldkey, and a hotkey rotation under an
 * unchanged coldkey is not a change of ownership. */
const OWNER_OBSERVATION_COLUMNS = "owner_coldkey, captured_at";

/**
 * One subnet's owner observations, oldest first -- or null when the lakehouse
 * cannot answer.
 *
 * THE SECOND SOURCE, and the one that actually has rows. The whole 895M-row
 * event table holds exactly ONE SubnetOwnerChanged event, so the stream above
 * answers an empty history for 127 of the 128 subnets the poller has ever
 * watched. `chain.subnet_ownership_history` is the poller's own record of who
 * it observed owning each subnet, appended only when the observed owner
 * CHANGES -- so a subnet
 * with two rows changed hands between them whether or not the chain emitted an
 * event for it, and three did (measured 2026-08-03).
 *
 * Small enough to read whole for one netuid: 135 rows chain-wide, at most two
 * per subnet. The netuid is forced through `safeBlockNumber` by the caller
 * before it reaches this string-built query, since R2 SQL takes no bound
 * parameters.
 *
 * FROZEN, LIKE EVERYTHING ELSE THE BOX WROTE. The newest capture is
 * 2026-08-01, so `observed_through` in the payload is the honest ceiling on
 * what this source can know -- not a refresh lane, which is separate work, but
 * enough that a caller is never told "no transfers" when the truth is "not
 * watched since".
 */
export async function loadSubnetOwnerObservations(
  env: R2SqlEnv | null | undefined,
  netuid: number,
): Promise<Record<string, unknown>[] | null> {
  return await r2SqlQuery(
    env,
    `SELECT ${OWNER_OBSERVATION_COLUMNS} FROM chain.subnet_ownership_history` +
      ` WHERE netuid = ${netuid} ORDER BY captured_at ASC`,
  );
}
