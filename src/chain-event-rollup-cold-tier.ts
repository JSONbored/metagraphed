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
import { r2SqlQuery, safeBlockNumber } from "./r2-sql.ts";

type Row = Record<string, unknown>;

/** One rollup's shape: which event kind, and what the builder calls its counts. */
export interface ChainEventRollupSpec {
  /** `account_events.event_kind` this rollup counts. */
  eventKind: string;
  /** Field name the builder reads for the per-subnet event count. */
  countField: string;
  /** Field name the builder reads for the distinct-participant count, per
   * subnet AND on the network block. */
  distinctField: string;
  /**
   * Column the distinct count is taken over.
   *
   * `hotkey` where the export carries it. `uid` for WeightsSet, whose hotkey
   * column is NULL on all 50,890,747 rows -- the chain event itself only emits
   * [netuid, uid], so uid IS the identity the event records. Within a subnet a
   * uid is one neuron, so a distinct-uid count is the distinct-setter count.
   * Over a long window a uid can be reassigned after a deregistration, which
   * makes this an upper bound on distinct hotkeys rather than an identity --
   * accurate for the 7d/30d windows these routes serve, and stated here rather
   * than left for a reader to infer.
   */
  distinctColumn: "hotkey" | "uid";
}

export const CHAIN_SERVING_ROLLUP: ChainEventRollupSpec = {
  eventKind: "AxonServed",
  countField: "announcements",
  distinctField: "distinct_servers",
  distinctColumn: "hotkey",
};

export const CHAIN_WEIGHTS_ROLLUP: ChainEventRollupSpec = {
  eventKind: "WeightsSet",
  countField: "weight_sets",
  distinctField: "distinct_setters",
  // See distinctColumn's note: WeightsSet has no hotkey in the export because
  // the chain event does not emit one.
  distinctColumn: "uid",
};

// StakeMoved / StakeTransferred carry a real hotkey (unlike WeightsSet), so both
// count distinct participants by hotkey. Added for the per-subnet summary cards, whose
// chain-wide siblings were already serving 674 movers across 128 subnets and 430 senders
// across 126 while the per-subnet cards answered 0 (#9369).
export const CHAIN_STAKE_MOVES_ROLLUP: ChainEventRollupSpec = {
  eventKind: "StakeMoved",
  countField: "movements",
  distinctField: "distinct_movers",
  distinctColumn: "hotkey",
};

export const CHAIN_STAKE_TRANSFERS_ROLLUP: ChainEventRollupSpec = {
  eventKind: "StakeTransferred",
  countField: "transfers",
  distinctField: "distinct_senders",
  distinctColumn: "hotkey",
};

export const CHAIN_REGISTRATIONS_ROLLUP: ChainEventRollupSpec = {
  eventKind: "NeuronRegistered",
  countField: "registrations",
  distinctField: "distinct_registrants",
  distinctColumn: "hotkey",
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

/**
 * The column aliases a spec contributes, guarded the same way.
 *
 * `countField` and `distinctField` land in `AS <name>` and `ORDER BY <name>` --
 * IDENTIFIER position, not a quoted value, so there are no quotes to break out
 * of and anything accepted here executes as SQL. `ORDER BY` in particular is a
 * clause an attacker can hang a subquery off, which makes it the sink worth
 * guarding even though today's only callers are the two module constants
 * below. That is the same reasoning `safeEventKind` already carried; applying
 * it to the value and not to its siblings was an inconsistency, not a
 * judgement that these were safe.
 *
 * Separate from `safeEventKind` because the shapes genuinely differ: chain
 * event kinds are PascalCase with no underscore, column aliases are
 * snake_case. One permissive regex covering both would accept more than either
 * position needs.
 */
export function safeColumnAlias(value: unknown): string | null {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value)
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
  const countField = safeColumnAlias(spec.countField);
  const distinctField = safeColumnAlias(spec.distinctField);
  // Closed set rather than the alias guard: this one names a real column, so
  // anything outside the two the table has is a bug, not merely unsafe.
  const distinctColumn =
    spec.distinctColumn === "hotkey" || spec.distinctColumn === "uid"
      ? spec.distinctColumn
      : null;
  // Every interpolated identifier is guarded, not just the quoted value.
  if (!kind || !countField || !distinctField || !distinctColumn) return null;
  if (!Number.isFinite(windowDays) || windowDays <= 0) return null;

  const cutoff = now - windowDays * 24 * 60 * 60 * 1000;
  if (!Number.isSafeInteger(cutoff) || cutoff < 0) return null;
  const cap =
    Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 1000) : 200;

  const where = `WHERE event_kind = '${kind}' AND observed_at >= ${cutoff}`;

  // What identifies ONE participant on the network block below. A uid is unique
  // only WITHIN a subnet -- uid 5 on twenty subnets is twenty neurons -- so the
  // participant is the (netuid, uid) pair; a hotkey is globally unique and
  // stands alone. The per-subnet half below is already scoped to one netuid, so
  // there the column alone is the identity either way.
  const identity =
    distinctColumn === "uid" ? `netuid, ${distinctColumn}` : distinctColumn;

  const [rows, networkRows] = await Promise.all([
    // TWO LEVELS, NOT count(DISTINCT)+GROUP BY (#9227). The single-level form
    //
    //   SELECT netuid, count(*), count(DISTINCT hotkey) ... GROUP BY netuid
    //
    // is rejected at 30d -- one of the two windows these routes offer -- with
    //
    //   40015: scan budget exceeded: scanning too much data for
    //          count(DISTINCT) with GROUP BY
    //
    // and a rejection here declines the whole rollup, which is why /chain/
    // serving and /chain/weights both answered an EMPTY 30d window while their
    // 7d window worked. Having a GROUP BY is not the cure the error message
    // suggests: this query already had one. The budget is spent on the DISTINCT
    // itself, so the fix is to leave no DISTINCT to evaluate -- group to
    // (netuid, identity) first, then sum the per-pair counts and COUNT THE ROWS
    // to get the distinct participants. Verified live against the 30d and 90d
    // windows of both AxonServed and WeightsSet, and proved row-for-row
    // identical to the form it replaces at every window where that form still
    // executes (1d and 7d).
    query(
      env,
      `SELECT netuid, sum(n) AS ${countField}, count(*) AS ${distinctField}` +
        ` FROM (SELECT netuid, ${distinctColumn}, count(*) AS n` +
        ` FROM chain.account_events ${where}` +
        ` GROUP BY netuid, ${distinctColumn})` +
        ` GROUP BY netuid ORDER BY ${countField} DESC LIMIT ${cap}`,
    ),
    // Separate because a distinct count does not sum across subnets: one
    // participant active on five subnets is five rows above and one here.
    //
    // The SHAPE depends on what identifies a participant. A hotkey is globally
    // unique, so an ungrouped COUNT(DISTINCT hotkey) is the answer. A uid is
    // only unique WITHIN a subnet -- uid 5 on twenty subnets is twenty
    // different neurons -- so the same query would collapse them and report
    // roughly "how many distinct uid numbers appeared", which is capped near
    // 256 and means nothing as a participant count. Measured: it reported 254
    // where the true distinct-pair count was 1,280.
    //
    // Counting rows of a GROUP BY gives the distinct participants exactly, and
    // it is also the form the engine can execute: an ungrouped COUNT(DISTINCT)
    // over this many rows is rejected with `40015: scan budget exceeded ... add
    // a GROUP BY to distribute the aggregation`.
    //
    // ONE SHAPE FOR BOTH IDENTITIES. The hotkey branch used to be a bare
    // ungrouped `count(DISTINCT hotkey)`, which still executes today (measured
    // 14,883 over a 90d AxonServed window) -- but that is the exact form that
    // has been rejected twice as the table grew, and the grouped form returns
    // the identical number over the identical window. Keeping one shape means
    // there is no COUNT(DISTINCT) left in this module to grow into the budget
    // later, and no second form to reason about.
    query(
      env,
      `SELECT count(*) AS ${distinctField}, max(newest) AS newest_observed` +
        ` FROM (SELECT ${identity}, max(observed_at) AS newest` +
        ` FROM chain.account_events ${where} GROUP BY ${identity})`,
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

/** The per-identity leaderboard, plus the ungrouped totals it is a share of. */
export interface ChainEventIdentityRollup {
  /** One row per (netuid, identity), ordered most-active first. */
  rows: Row[];
  /** The window's totals: the count denominator, the distinct identities, and
   * the newest reading. */
  totals: Row;
}

/**
 * The same window as loadChainEventRollup, grouped one level finer.
 *
 * That reader answers "which subnets", keyed by netuid. This one answers "which
 * participants", keyed by (netuid, identity) -- the shape the weight-setter and
 * equivalent leaderboards publish.
 *
 * IDENTITY IS PER SPEC, and for WeightsSet it is `uid`, not `hotkey`. The chain
 * event emits [netuid, uid] and carries no hotkey at all, so `hotkey` is NULL on
 * every one of the 50,890,747 WeightsSet rows in the export. Grouping on it
 * would collapse every setter into a single null bucket. `uid` is only unique
 * WITHIN a subnet, which is why the grouping is the pair rather than the
 * identity alone -- and why the builders publish these rows under (netuid, uid)
 * with a null hotkey rather than inventing one.
 *
 * `GROUP BY netuid, <identity>` is also the distributed shape R2 SQL wants: no
 * COUNT(DISTINCT) in the grouped half at all, so the scan budget that rejects
 * count(DISTINCT)+GROUP BY over a 30d span is never spent here. The one
 * COUNT(DISTINCT) left is in the ungrouped totals, over a single row.
 */
export async function loadChainEventIdentityRollup(
  env: Parameters<typeof r2SqlQuery>[0],
  spec: ChainEventRollupSpec,
  {
    windowDays,
    now = Date.now(),
    limit = 200,
    netuid,
    query = r2SqlQuery,
  }: {
    windowDays: number;
    now?: number;
    limit?: number;
    /**
     * Narrow to one subnet. Absent means every subnet, which is the chain-wide
     * leaderboard; supplied, the grouping still carries netuid so the rows keep
     * the identity shape the builders read either way.
     */
    netuid?: number;
    query?: typeof r2SqlQuery;
  },
): Promise<ChainEventIdentityRollup | null> {
  const kind = safeEventKind(spec.eventKind);
  const countField = safeColumnAlias(spec.countField);
  const distinctField = safeColumnAlias(spec.distinctField);
  const identity =
    spec.distinctColumn === "hotkey" || spec.distinctColumn === "uid"
      ? spec.distinctColumn
      : null;
  if (!kind || !countField || !distinctField || !identity) return null;
  if (!Number.isFinite(windowDays) || windowDays <= 0) return null;

  const cutoff = now - windowDays * 24 * 60 * 60 * 1000;
  if (!Number.isSafeInteger(cutoff) || cutoff < 0) return null;
  const cap =
    Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 1000) : 200;

  // An unusable netuid is a decline, not a silent chain-wide scan answering a
  // per-subnet question.
  let subnetFilter = "";
  if (netuid !== undefined) {
    const safe = safeBlockNumber(netuid);
    if (safe === null) return null;
    subnetFilter = ` AND netuid = ${safe}`;
  }

  const where = `WHERE event_kind = '${kind}' AND observed_at >= ${cutoff}${subnetFilter}`;

  const [rows, totalsRows, distinctRows] = await Promise.all([
    query(
      env,
      `SELECT netuid, ${identity} AS ${identity}, count(*) AS ${countField},` +
        ` min(observed_at) AS first_set, max(observed_at) AS last_set` +
        ` FROM chain.account_events ${where}` +
        ` GROUP BY netuid, ${identity}` +
        ` ORDER BY ${countField} DESC LIMIT ${cap}`,
    ),
    // Separate from the row page for the same reason the netuid rollup keeps
    // its network half separate: the page is capped at `cap`, so summing it
    // would make the share denominator depend on the page size.
    //
    // The distinct half is a GROUP BY subquery, not an ungrouped
    // COUNT(DISTINCT). Two independent reasons, both measured:
    //
    //  * The engine REJECTS the ungrouped form at this scale -- `40015: scan
    //    budget exceeded: scanning too much data for count(DISTINCT) without
    //    GROUP BY` -- which made the whole rollup decline and served this route
    //    a card of zeros.
    //  * For a uid identity it also answered the wrong question. A uid is
    //    unique only WITHIN a subnet, so an ungrouped distinct count collapses
    //    uid 5 on twenty subnets into one and lands near 256 regardless of the
    //    truth. The pair is the participant; see the netuid rollup's own note.
    //
    // COUNT(*) stays ungrouped -- it is a plain row count with no distinct in
    // it, so neither problem applies and it is the honest share denominator.
    query(
      env,
      `SELECT count(*) AS ${countField}, max(observed_at) AS newest_observed` +
        ` FROM chain.account_events ${where}`,
    ),
    query(
      env,
      `SELECT count(*) AS ${distinctField}` +
        ` FROM (SELECT netuid, ${identity} FROM chain.account_events ${where}` +
        ` GROUP BY netuid, ${identity})`,
    ),
  ]);

  if (!rows || !totalsRows || !distinctRows) return null;
  const totals = totalsRows[0];
  const distinct = distinctRows[0];
  if (!totals || !distinct) return null;
  if (rows.length === 0) return null;

  // The distinct count rides back inside `totals` so the shape callers and
  // the builder already read is unchanged -- only where the number comes from
  // is different.
  return {
    rows,
    totals: { ...totals, [distinctField]: distinct[distinctField] },
  };
}
