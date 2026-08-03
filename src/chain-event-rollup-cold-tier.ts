// Per-subnet event-activity rollups, served from the lakehouse.
//
// /api/v1/chain/serving and /api/v1/chain/registrations answered with a
// schema-stable empty payload after the box wipe. Both are the same shape: one
// `account_events` kind, grouped by netuid, with a network-wide distinct-hotkey
// count alongside. The lakehouse holds 2,791,121 AxonServed and 1,071,405
// NeuronRegistered rows, every one with a populated hotkey.
//
// THE AGGREGATION BELONGS IN SQL, and the builders already assume it does:
// buildChainServing's own comment says "the SQL loader GROUPs BY netuid, so
// production rows are unique per subnet". A per-netuid GROUP BY returns ~129
// rows, small enough to serve at request time -- so this is a cold-tier read,
// not a scheduled projection.
//
// THE NETWORK DISTINCT IS ITS OWN QUERY, because it is not summable. A hotkey
// serving on five subnets is five per-subnet rows but ONE network-wide server,
// so adding the per-netuid counts would overstate it (measured: 2,941
// network-wide against a much larger per-subnet sum). The Postgres tier ran
// the same second query for the same reason.
//
// ONLY TWO KINDS ARE SERVABLE THIS WAY, and that is a property of the export
// rather than of this code. `account_events.hotkey` is NULL for all 50,890,747
// WeightsSet rows, so /chain/weights' distinct_setters and all of
// /chain/weights/setters cannot be derived here at any window -- a reader for
// them would publish 0, which reads as a measured zero rather than an
// unmeasurable one. NeuronDeregistered and AxonInfoRemoved have zero rows in
// both account_events and chain_events, and PrometheusServed exists only in
// chain_events with its hotkey inside the args JSON. See the survey on #9146.
import { r2SqlQuery } from "./r2-sql.ts";

type Row = Record<string, unknown>;

/** One rollup's shape: which event kind, and what the builder calls its counts. */
export interface ChainEventRollupSpec {
  /** `account_events.event_kind` this rollup counts. */
  eventKind: string;
  /** Field name the builder reads for the per-subnet event count. */
  countField: string;
  /** Field name the builder reads for the distinct-hotkey count, per subnet
   * AND on the network block. */
  distinctField: string;
}

export const CHAIN_SERVING_ROLLUP: ChainEventRollupSpec = {
  eventKind: "AxonServed",
  countField: "announcements",
  distinctField: "distinct_servers",
};

export const CHAIN_REGISTRATIONS_ROLLUP: ChainEventRollupSpec = {
  eventKind: "NeuronRegistered",
  countField: "registrations",
  distinctField: "distinct_registrants",
};

/**
 * `event_kind` is interpolated, because R2 SQL has no bound parameters.
 *
 * Every caller passes one of the module constants above, never caller input --
 * but the guard is here anyway so a future caller that forwards a query
 * parameter cannot turn this into an injection point. Chain event kinds are
 * PascalCase identifiers; anything else is refused rather than escaped, the
 * same posture the other lakehouse readers take.
 */
export function safeEventKind(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(value)
    ? value
    : null;
}

export interface ChainEventRollup {
  /** One row per netuid, already grouped -- the shape the builders expect. */
  rows: Row[];
  /** The network block: distinct hotkeys across the whole window, and the
   * newest reading in it. */
  networkDistinct: Row;
}

/**
 * Both halves of one rollup, or null to leave the caller's empty payload
 * standing.
 *
 * Null on ANY miss rather than a partial answer: serving the per-subnet rows
 * without the network distinct would report a distinct-server count of zero
 * beside real per-subnet activity, which is a contradiction a caller cannot
 * detect.
 */
export async function loadChainEventRollup(
  env: Parameters<typeof r2SqlQuery>[0],
  spec: ChainEventRollupSpec,
  {
    windowDays,
    now = Date.now(),
    limit = 200,
    // Injectable so both queries and every decline path are testable without a
    // lakehouse -- a branch that only runs against live infrastructure is a
    // branch nothing verifies.
    query = r2SqlQuery,
  }: {
    windowDays: number;
    now?: number;
    limit?: number;
    query?: typeof r2SqlQuery;
  },
): Promise<ChainEventRollup | null> {
  const kind = safeEventKind(spec.eventKind);
  if (!kind) return null;
  if (!Number.isFinite(windowDays) || windowDays <= 0) return null;

  const cutoff = now - windowDays * 24 * 60 * 60 * 1000;
  if (!Number.isSafeInteger(cutoff) || cutoff < 0) return null;
  const cap =
    Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 1000) : 200;

  const where = `WHERE event_kind = '${kind}' AND observed_at >= ${cutoff}`;

  const [rows, networkRows] = await Promise.all([
    query(
      env,
      `SELECT netuid, count(*) AS ${spec.countField},` +
        ` count(DISTINCT hotkey) AS ${spec.distinctField}` +
        ` FROM chain.account_events ${where}` +
        ` GROUP BY netuid ORDER BY ${spec.countField} DESC LIMIT ${cap}`,
    ),
    // Separate because distinct hotkeys do not sum across subnets: one hotkey
    // serving five subnets is five rows above and one server here.
    query(
      env,
      `SELECT count(DISTINCT hotkey) AS ${spec.distinctField},` +
        ` max(observed_at) AS newest_observed` +
        ` FROM chain.account_events ${where}`,
    ),
  ]);

  if (!rows || !networkRows) return null;
  const networkDistinct = networkRows[0];
  if (!networkDistinct) return null;

  // A window the frozen table no longer reaches. Declining keeps the caller's
  // empty payload rather than publishing zeros that read as measured silence:
  // the events that wrote these rows stopped when the box did, so this window
  // will eventually cover none of them.
  if (rows.length === 0) return null;

  return { rows, networkDistinct };
}
