// The remaining ACCOUNT-scoped feeds served from the lakehouse when the
// Postgres tier misses: transfers, stake-flow, stake-moves, weight-setters,
// and counterparties. Fourth member of the cold-tier family (blocks,
// extrinsics, events, now the account analytics feeds), same posture
// throughout: rows feed the SAME src/ formatters the Postgres tier feeds,
// filters the lakehouse cannot express make the whole read DECLINE (null,
// never a silently-wrong answer), and cursors are data-api's own tokens so
// paging survives a tier transition.
//
// /validators/{hotkey}/nominators lives here too, despite hanging off a
// different route family. It is the same `chain.account_events` read with the
// hotkey fixed and the grouping turned around -- StakeAdded/StakeRemoved carry
// both the validator hotkey and the staker coldkey on every row, so "who is
// behind this validator" is loadAccountStakeFlowColdTier's query grouped by
// coldkey instead of netuid. Putting it beside its siblings shares their
// window cutoff and generatedAt derivation rather than restating both in a
// module whose only difference is a GROUP BY.
//
// These are all reads over chain.account_events with a selective predicate
// (one address against a big table), which is exactly the shape the
// request-time lane is for -- unlike the chain-wide aggregates, which moved to
// scheduled projections. Latency is second-scale (src/r2-sql.ts's measured
// numbers) and acceptable behind the edge cache, the precedent the merged
// account-events reader set.
//
// EQUIVALENCE ARGUMENTS, stated because data-api's SQL is index-shaped for
// Postgres/TimescaleDB and R2 SQL has no indexes to shape around:
//   - transfers "all directions": data-api reads TWO scans (hotkey = X, then
//     coldkey = X) merged client-side; this tier issues the single disjunction
//     `(hotkey = X OR coldkey = X)`. Identical row sets -- see
//     src/events-cold-tier.ts's header for the full argument.
//   - weight-setters: data-api's UNION ALL of a hotkey branch and a
//     (netuid, uid)-slot branch has DISJOINT branches (the second requires
//     hotkey NULL/'', the first requires hotkey = X, a non-empty value), so a
//     single OR of both predicates yields the identical multiset -- which
//     matters, because R2 SQL has no UNION at all. The slot list itself still
//     comes from D1 `neurons`, the same source data-api reads it from.
//   - counterparties: data-api's UNION ALL of two per-leg-capped ordered scans
//     re-sorted and capped again equals the top-CAP of the single OR predicate
//     under the same total order (each leg is a subset of the OR set, so any
//     row in the overall top CAP sits within its own leg's top CAP; the
//     IS DISTINCT FROM guards only prevent UNION ALL double-counting, which a
//     single OR cannot do).

import { buildAccountTransfers } from "./account-events.ts";
import {
  buildAccountStakeFlow,
  DEFAULT_STAKE_FLOW_WINDOW,
  STAKE_ADDED_KIND,
  STAKE_FLOW_WINDOWS,
  STAKE_REMOVED_KIND,
} from "./account-stake-flow.ts";
import {
  ACCOUNT_STAKE_MOVES_WINDOWS,
  buildAccountStakeMoves,
  DEFAULT_ACCOUNT_STAKE_MOVES_WINDOW,
  STAKE_MOVED_EVENT_KIND,
} from "./account-stake-moves.ts";
import {
  ACCOUNT_WEIGHT_SETTERS_WINDOWS,
  buildAccountWeightSetters,
  DEFAULT_ACCOUNT_WEIGHT_SETTERS_WINDOW,
  WEIGHTS_EVENT_KIND,
} from "./account-weight-setters.ts";
import {
  buildCounterparties,
  buildCounterpartyRelationship,
  COUNTERPARTIES_SCAN_CAP,
  type CounterpartyRelationshipResult,
} from "./counterparties.ts";
import {
  ACCOUNT_EVENT_SUMMARY_SCAN_CAP,
  ACCOUNT_SUMMARY_RECENT_LIMIT,
} from "./account-events.ts";
import {
  buildAccountRegistrations,
  REGISTRATION_EVENT_KIND,
  REGISTRATION_WINDOWS,
  DEFAULT_REGISTRATION_WINDOW,
} from "./account-registrations.ts";
import {
  buildAccountServing,
  SERVING_EVENT_KIND,
  SERVING_WINDOWS,
  DEFAULT_SERVING_WINDOW,
} from "./account-serving.ts";
import {
  buildValidatorNominators,
  DEFAULT_NOMINATOR_SORT,
  DEFAULT_NOMINATOR_WINDOW,
  NOMINATOR_SORTS,
  NOMINATOR_WINDOWS,
} from "./validator-nominators.ts";
import { decodeCursor, encodeCursor } from "./cursor.ts";
import { r2SqlQuery, safeBlockNumber, safeSs58Literal } from "./r2-sql.ts";
import { OFFSET_EMULATION_CAP } from "./r2-sql-blocks.ts";

/** Kept identical to the Postgres tier's SELECT list so both tiers hand the
 * formatter the same shape. */
const EVENT_COLUMNS =
  "block_number, event_index, extrinsic_index, event_kind, hotkey, coldkey, " +
  "netuid, uid, amount_tao, alpha_amount, observed_at";

/** EXACTLY the Postgres tier's feed order -- the public cursor token encodes
 * this composite key, so a different order would emit tokens the other tier
 * mis-seeks on. */
const FEED_ORDER =
  "ORDER BY observed_at DESC, block_number DESC, event_index DESC";

/** The 3-part key the transfer feed pages on, mirroring data-api. */
const CURSOR_ARITY = 3;

/** Same day length windowCutoff (workers/data-api.ts) uses, so both tiers
 * compute the identical request-time cutoff for the same window label. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** Resolve a window label to its request-time epoch-ms cutoff, mirroring
 * data-api's windowCutoff exactly: an unrecognized label falls back to the
 * map's default rather than erroring (the REST/MCP callers already rejected
 * genuinely bad values before any tier is tried). */
function windowCutoff(
  windows: Record<string, number>,
  defaultLabel: string,
  label: string | null | undefined,
): { label: string; cutoff: number } {
  const resolved =
    label != null && Object.hasOwn(windows, label) ? label : defaultLabel;
  return { label: resolved, cutoff: Date.now() - windows[resolved] * DAY_MS };
}

/** The newest `last_observed` epoch-ms across a row set as an ISO string --
 * the same generatedAt data-api's latestObservedIso derives for these routes,
 * so the envelope reads identically across tiers. */
function latestObservedIso(rows: Record<string, unknown>[]): string | null {
  let latest: number | null = null;
  for (const row of rows) {
    const n = Number(row?.last_observed);
    if (Number.isFinite(n) && n > 0 && (latest == null || n > latest)) {
      latest = n;
    }
  }
  return latest == null ? null : new Date(latest).toISOString();
}

export interface AccountTransfersQuery {
  limit: number;
  offset?: number | null;
  cursor?: unknown;
  /** "sent" | "received" narrows the side; "all"/null/undefined reads both.
   * Anything else is a filter this tier will not guess at -- decline. */
  direction?: unknown;
  blockStart?: unknown;
  blockEnd?: unknown;
}

/**
 * GET /api/v1/accounts/{ss58}/transfers -- the native-TAO Balances.Transfer
 * feed (event_kind='Transfer', hotkey=from / coldkey=to), newest first.
 * Returns null when the lakehouse cannot answer faithfully.
 */
export async function loadAccountTransfersColdTier(
  env: Env | null | undefined,
  ss58: string,
  query: AccountTransfersQuery,
): Promise<ReturnType<typeof buildAccountTransfers> | null> {
  const limit = safeBlockNumber(query.limit);
  const offset = safeBlockNumber(query.offset ?? 0);
  if (limit === null || offset === null || limit <= 0) return null;
  // R2 SQL has no OFFSET; past this depth the over-fetch stops being a
  // reasonable trade and declining beats serving a page that is quietly wrong.
  if (offset > OFFSET_EMULATION_CAP) return null;

  // An unusable address is a decline, not an unfiltered scan of every account.
  const addr = safeSs58Literal(ss58);
  if (addr === null) return null;

  const direction = query.direction ?? null;
  if (
    direction !== null &&
    direction !== "all" &&
    direction !== "sent" &&
    direction !== "received"
  ) {
    return null;
  }
  const where = ["event_kind = 'Transfer'"];
  // data-api's exact direction semantics: sent matches the from side (hotkey),
  // received the to side (coldkey), and "all"/omitted reads both -- the single
  // OR standing in for its two-scan merge (see the module header).
  if (direction === "sent") where.push(`hotkey = '${addr}'`);
  else if (direction === "received") where.push(`coldkey = '${addr}'`);
  else where.push(`(hotkey = '${addr}' OR coldkey = '${addr}')`);

  for (const [value, clause] of [
    [query.blockStart, "block_number >="],
    [query.blockEnd, "block_number <="],
  ] as [unknown, string][]) {
    if (value == null) continue;
    const n = safeBlockNumber(value);
    if (n === null) return null;
    where.push(`${clause} ${n}`);
  }
  const cursor = decodeCursor(query.cursor, CURSOR_ARITY);
  if (cursor) {
    // data-api's exact 3-part tuple seek; an invalid token means page 1,
    // exactly as data-api treats it.
    where.push(
      `(observed_at, block_number, event_index) < ` +
        `(${cursor[0]}, ${cursor[1]}, ${cursor[2]})`,
    );
  }

  // Cursor pages never carry an offset, mirroring data-api.
  const paged = cursor ? 0 : offset;
  const rows = await r2SqlQuery(
    env,
    `SELECT ${EVENT_COLUMNS} FROM chain.account_events WHERE ${where.join(" AND ")}` +
      ` ${FEED_ORDER} LIMIT ${limit + paged}`,
  );
  if (rows === null) return null;

  const page = paged > 0 ? rows.slice(paged) : rows;
  const last = page.length === limit ? page[page.length - 1] : null;
  const nextCursor = last
    ? encodeCursor([
        safeBlockNumber(last.observed_at),
        safeBlockNumber(last.block_number),
        safeBlockNumber(last.event_index),
      ])
    : null;
  return buildAccountTransfers(page, ss58, {
    limit,
    offset,
    nextCursor,
    // The fixed-label hint ONLY when the SQL already filtered one side --
    // the same rule data-api applies (#2362's self-transfer fix).
    direction:
      direction === "sent" || direction === "received" ? direction : undefined,
  });
}

/**
 * GET /api/v1/accounts/{ss58}/stake-flow -- the windowed StakeAdded vs
 * StakeRemoved aggregate, GROUP BY (netuid, event_kind), ACCOUNT-scoped so a
 * live selective query is fine where the chain-wide twin needed a projection.
 * Returns data-api's `{ data, generatedAt }` wrapped shape.
 */
export async function loadAccountStakeFlowColdTier(
  env: Env | null | undefined,
  ss58: string,
  query: { window?: string | null; direction?: unknown } = {},
): Promise<{
  data: ReturnType<typeof buildAccountStakeFlow>;
  generatedAt: string | null;
} | null> {
  const addr = safeSs58Literal(ss58);
  if (addr === null) return null;

  const direction = query.direction ?? null;
  if (
    direction !== null &&
    direction !== "all" &&
    direction !== "in" &&
    direction !== "out"
  ) {
    return null;
  }
  // data-api's per-direction kind filter; the IN (added, removed) branch is
  // rewritten as an OR of the two equalities -- same row set, no IN-list
  // dependence on the beta engine.
  const kind =
    direction === "in"
      ? `event_kind = '${STAKE_ADDED_KIND}'`
      : direction === "out"
        ? `event_kind = '${STAKE_REMOVED_KIND}'`
        : `(event_kind = '${STAKE_ADDED_KIND}' OR event_kind = '${STAKE_REMOVED_KIND}')`;

  const { label, cutoff } = windowCutoff(
    STAKE_FLOW_WINDOWS,
    DEFAULT_STAKE_FLOW_WINDOW,
    query.window,
  );
  const rows = await r2SqlQuery(
    env,
    `SELECT netuid, event_kind, SUM(amount_tao) AS total_tao, ` +
      `COUNT(*) AS event_count, MAX(observed_at) AS last_observed ` +
      `FROM chain.account_events ` +
      `WHERE (hotkey = '${addr}' OR coldkey = '${addr}') AND ${kind} ` +
      `AND observed_at >= ${cutoff} GROUP BY netuid, event_kind`,
  );
  if (rows === null) return null;
  // data-api wraps the SUM in COALESCE(..., 0); replicate that client-side
  // rather than lean on the beta engine's function coverage -- an all-null
  // group must still count its events, not be skipped by the formatter.
  const coalesced = rows.map((row) => ({
    ...row,
    total_tao: row.total_tao ?? 0,
  }));
  return {
    data: buildAccountStakeFlow(coalesced, ss58, { window: label }),
    generatedAt: latestObservedIso(rows),
  };
}

/**
 * GET /api/v1/accounts/{ss58}/stake-moves -- the windowed per-subnet
 * StakeMoved footprint, GROUP BY netuid. Same wrapped shape as stake-flow.
 */
export async function loadAccountStakeMovesColdTier(
  env: Env | null | undefined,
  ss58: string,
  query: { window?: string | null } = {},
): Promise<{
  data: ReturnType<typeof buildAccountStakeMoves>;
  generatedAt: string | null;
} | null> {
  const addr = safeSs58Literal(ss58);
  if (addr === null) return null;
  const { label, cutoff } = windowCutoff(
    ACCOUNT_STAKE_MOVES_WINDOWS,
    DEFAULT_ACCOUNT_STAKE_MOVES_WINDOW,
    query.window,
  );
  const rows = await r2SqlQuery(
    env,
    `SELECT netuid, COUNT(*) AS movements, MIN(observed_at) AS first_observed, ` +
      `MAX(observed_at) AS last_observed FROM chain.account_events ` +
      `WHERE (hotkey = '${addr}' OR coldkey = '${addr}') ` +
      `AND event_kind = '${STAKE_MOVED_EVENT_KIND}' ` +
      `AND observed_at >= ${cutoff} GROUP BY netuid`,
  );
  if (rows === null) return null;
  return {
    data: buildAccountStakeMoves(rows, ss58, { window: label }),
    generatedAt: latestObservedIso(rows),
  };
}

/**
 * One account's per-subnet NeuronRegistered footprint.
 *
 * The retired D1 loader's query verbatim, minus its SQLite `INDEXED BY
 * idx_account_events_hotkey` hint -- R2 SQL has no indexes to name. Keyed on
 * `hotkey` ALONE, not the `(hotkey OR coldkey)` disjunction the transfer-shaped
 * feeds use: a registration is attributed to the hotkey being registered, and
 * widening it to the coldkey would credit an operator with every registration
 * made by every hotkey it funds.
 *
 * Measured live before shipping (2026-08-03): all three windows execute inside
 * the query timeout on an account registered across 119 subnets -- 7d 82 MB,
 * 30d 238 MB, 90d 392 MB at ~4s. A selective single-hotkey predicate is the
 * shape this request-time module is for; see the header above.
 */
export async function loadAccountRegistrationsColdTier(
  env: Env | null | undefined,
  ss58: string,
  query: { window?: string | null } = {},
): Promise<{
  data: ReturnType<typeof buildAccountRegistrations>;
  generatedAt: string | null;
} | null> {
  const addr = safeSs58Literal(ss58);
  if (addr === null) return null;
  const { label, cutoff } = windowCutoff(
    REGISTRATION_WINDOWS,
    DEFAULT_REGISTRATION_WINDOW,
    query.window,
  );
  const rows = await r2SqlQuery(
    env,
    `SELECT netuid, COUNT(*) AS registrations, MIN(observed_at) AS first_observed, ` +
      `MAX(observed_at) AS last_observed FROM chain.account_events ` +
      `WHERE hotkey = '${addr}' AND event_kind = '${REGISTRATION_EVENT_KIND}' ` +
      `AND observed_at >= ${cutoff} GROUP BY netuid`,
  );
  if (rows === null) return null;
  return {
    data: buildAccountRegistrations(rows, ss58, { window: label }),
    generatedAt: latestObservedIso(rows),
  };
}

/**
 * One account's per-subnet AxonServed footprint -- the serving companion to
 * loadAccountRegistrationsColdTier above, same query shape, same hotkey-only
 * attribution, differing only in event kind and the count column the builder
 * reads (`announcements`).
 */
export async function loadAccountServingColdTier(
  env: Env | null | undefined,
  ss58: string,
  query: { window?: string | null } = {},
): Promise<{
  data: ReturnType<typeof buildAccountServing>;
  generatedAt: string | null;
} | null> {
  const addr = safeSs58Literal(ss58);
  if (addr === null) return null;
  const { label, cutoff } = windowCutoff(
    SERVING_WINDOWS,
    DEFAULT_SERVING_WINDOW,
    query.window,
  );
  const rows = await r2SqlQuery(
    env,
    `SELECT netuid, COUNT(*) AS announcements, MIN(observed_at) AS first_observed, ` +
      `MAX(observed_at) AS last_observed FROM chain.account_events ` +
      `WHERE hotkey = '${addr}' AND event_kind = '${SERVING_EVENT_KIND}' ` +
      `AND observed_at >= ${cutoff} GROUP BY netuid`,
  );
  if (rows === null) return null;
  return {
    data: buildAccountServing(rows, ss58, { window: label }),
    generatedAt: latestObservedIso(rows),
  };
}

/** The D1 surface this module needs from `neurons` -- structural, so tests
 * can hand a plain object (same pattern as src/blocks-cold-tier.ts). */
interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      all?(): Promise<{ results?: unknown[] } | null>;
    };
  };
}

/** The hotkey's registered (netuid, uid) slots from D1 `neurons` -- the same
 * decomposition data-api runs now that neurons is off Postgres. null when the
 * slots cannot be read (no binding, D1 failure, or an unusable cell), because
 * without them the hotkey-less WeightsSet rows would be silently dropped --
 * a degrade, and this family declines rather than degrades. */
async function neuronSlots(
  env: Env | null | undefined,
  addr: string,
): Promise<{ netuid: number; uid: number }[] | null> {
  const db = (env as { METAGRAPH_HEALTH_DB?: D1Like } | null | undefined)
    ?.METAGRAPH_HEALTH_DB;
  if (!db?.prepare) return null;
  let results: unknown[];
  try {
    const res = await db
      .prepare("SELECT netuid, uid FROM neurons WHERE hotkey = ?")
      .bind(addr)
      .all?.();
    if (!Array.isArray(res?.results)) return null;
    results = res.results;
  } catch {
    return null;
  }
  const slots: { netuid: number; uid: number }[] = [];
  for (const row of results as Record<string, unknown>[]) {
    const netuid = safeBlockNumber(row?.netuid);
    const uid = safeBlockNumber(row?.uid);
    // A slot that cannot be inlined safely poisons the whole predicate --
    // refuse the read rather than build a partial one.
    if (netuid === null || uid === null) return null;
    slots.push({ netuid, uid });
  }
  return slots;
}

/**
 * GET /api/v1/accounts/{ss58}/weight-setters -- the windowed per-subnet
 * WeightsSet footprint. data-api's two-branch read (direct hotkey rows UNION
 * ALL hotkey-less rows matched via the hotkey's D1 neuron slots) collapses to
 * one disjunction here; see the module header for the equivalence.
 */
export async function loadAccountWeightSettersColdTier(
  env: Env | null | undefined,
  ss58: string,
  query: { window?: string | null } = {},
): Promise<{
  data: ReturnType<typeof buildAccountWeightSetters>;
  generatedAt: string | null;
} | null> {
  const addr = safeSs58Literal(ss58);
  if (addr === null) return null;
  const slots = await neuronSlots(env, addr);
  if (slots === null) return null;

  let predicate = `hotkey = '${addr}'`;
  if (slots.length > 0) {
    // A TUPLE IN LIST, NOT A CHAIN OF ORs. One `(netuid = a AND uid = x) OR ...`
    // clause per slot exceeds R2 SQL's expression nesting limit once an
    // account holds enough of them:
    //
    //   40018: query expression too deep: nesting depth exceeds the protocol's
    //   limit; rewrite long chains of AND/OR operators using IN/NOT IN lists
    //
    // The rejected query made r2SqlQuery return null, the reader decline, and
    // the route serve an empty payload -- so this failed for exactly the
    // validators that matter most, the ones registered on many subnets, while
    // passing for accounts on a handful. Verified live 2026-08-03: an account
    // on 119 subnets got 40018 from the OR chain and real rows (netuid 19: 454
    // weight-sets, netuid 15: 444) from the IN form.
    //
    // `(netuid, uid) IN (...)` is the engine's own suggested rewrite and is
    // exact. It must stay a TUPLE list -- `netuid IN (...) AND uid IN (...)`
    // would match the cross product and attribute other neurons' weight-sets
    // to this account.
    const pairs = slots.map((s) => `(${s.netuid}, ${s.uid})`).join(", ");
    predicate =
      `(${predicate} OR ` +
      `((hotkey IS NULL OR hotkey = '') AND (netuid, uid) IN (${pairs})))`;
  }
  const { label, cutoff } = windowCutoff(
    ACCOUNT_WEIGHT_SETTERS_WINDOWS,
    DEFAULT_ACCOUNT_WEIGHT_SETTERS_WINDOW,
    query.window,
  );
  const rows = await r2SqlQuery(
    env,
    `SELECT netuid, COUNT(*) AS weight_sets, MIN(observed_at) AS first_observed, ` +
      `MAX(observed_at) AS last_observed FROM chain.account_events ` +
      `WHERE event_kind = '${WEIGHTS_EVENT_KIND}' AND observed_at >= ${cutoff} ` +
      `AND ${predicate} GROUP BY netuid`,
  );
  if (rows === null) return null;
  return {
    data: buildAccountWeightSetters(rows, ss58, { window: label }),
    generatedAt: latestObservedIso(rows),
  };
}

/** The retired Postgres tier's ORDER BY, keyed by sort label. Every branch
 * tie-breaks on `coldkey` ASC (the original wrote it as the ordinal `1`, the
 * grouped column) so equal aggregates page deterministically -- which matters
 * more here than usual, since the offset emulation below re-slices a single
 * ordered scan. */
const NOMINATOR_ORDER: Record<string, string> = {
  net_staked: "net_staked_tao DESC, coldkey ASC",
  gross_staked: "gross_staked_tao DESC, coldkey ASC",
  last_activity: "last_observed DESC, coldkey ASC",
};

export interface ValidatorNominatorsQuery {
  window?: string | null;
  sort?: string | null;
  limit: number;
  offset?: number | null;
  /** ?coldkey= narrows to one nominator's own flow -- an exact match, so it
   * rides the SQL predicate exactly as it did on Postgres. */
  coldkey?: unknown;
}

/**
 * GET /api/v1/validators/{hotkey}/nominators -- who has staked to one
 * validator over the window, aggregated per coldkey and ranked.
 *
 * Carries the retired Postgres query's projection verbatim: the same six
 * aggregates, the same `hotkey = X AND kind IN (added, removed) AND
 * observed_at >= cutoff` predicate, the same optional coldkey narrowing. Two
 * dialect rewrites, neither of which changes the row set:
 *   - `event_kind IN (a, b)` becomes an OR of the two equalities, as every
 *     sibling here does rather than lean on the beta engine's IN support.
 *   - `LIMIT n OFFSET m` becomes a single `LIMIT n + m` scan sliced in JS,
 *     because R2 SQL has no OFFSET. Past OFFSET_EMULATION_CAP the over-fetch
 *     stops being a reasonable trade and the read declines instead of paging
 *     wrongly -- the same rule the block and transfer feeds apply.
 *
 * `totalCount` is the returned page's own length, which is what the Postgres
 * route passed (`rows.length` of its LIMIT/OFFSET result). Preserved
 * deliberately: it makes the builder emit the SQL-ordered page unsliced, and
 * changing it here would change `nominator_count` under existing callers on a
 * tier switch rather than on a decision to change it.
 *
 * Measured live before shipping (2026-08-03) against the busiest validator on
 * the network (64,520 StakeAdded rows in 30d): 30d 1.36 GB at ~4.2s, 90d
 * 2.06 GB at ~4.1s, against a 15s ceiling.
 */
export async function loadValidatorNominatorsColdTier(
  env: Env | null | undefined,
  hotkey: string,
  query: ValidatorNominatorsQuery,
): Promise<{
  data: ReturnType<typeof buildValidatorNominators>;
  generatedAt: string | null;
} | null> {
  const addr = safeSs58Literal(hotkey);
  if (addr === null) return null;
  const limit = safeBlockNumber(query.limit);
  const offset = safeBlockNumber(query.offset ?? 0);
  if (limit === null || offset === null || limit <= 0) return null;
  if (offset > OFFSET_EMULATION_CAP) return null;

  const sort = query.sort ?? DEFAULT_NOMINATOR_SORT;
  // A sort this tier cannot express would otherwise silently serve the default
  // ordering under the caller's requested label -- decline instead.
  if (!NOMINATOR_SORTS.includes(sort)) return null;

  const where = [
    `hotkey = '${addr}'`,
    `(event_kind = '${STAKE_ADDED_KIND}' OR event_kind = '${STAKE_REMOVED_KIND}')`,
  ];
  if (query.coldkey != null) {
    const nominator = safeSs58Literal(query.coldkey);
    // An unusable coldkey filter must not widen to "every nominator".
    if (nominator === null) return null;
    where.push(`coldkey = '${nominator}'`);
  }
  const { label, cutoff } = windowCutoff(
    NOMINATOR_WINDOWS,
    DEFAULT_NOMINATOR_WINDOW,
    query.window,
  );
  where.push(`observed_at >= ${cutoff}`);

  const rows = await r2SqlQuery(
    env,
    `SELECT coldkey,` +
      ` SUM(CASE WHEN event_kind = '${STAKE_ADDED_KIND}' THEN amount_tao ELSE 0 END) AS staked_tao,` +
      ` SUM(CASE WHEN event_kind = '${STAKE_REMOVED_KIND}' THEN amount_tao ELSE 0 END) AS unstaked_tao,` +
      ` COUNT(*) AS event_count, MAX(observed_at) AS last_observed,` +
      ` SUM(CASE WHEN event_kind = '${STAKE_ADDED_KIND}' THEN amount_tao ELSE -amount_tao END) AS net_staked_tao,` +
      ` SUM(amount_tao) AS gross_staked_tao` +
      ` FROM chain.account_events WHERE ${where.join(" AND ")}` +
      ` GROUP BY coldkey ORDER BY ${NOMINATOR_ORDER[sort]} LIMIT ${limit + offset}`,
  );
  if (rows === null) return null;

  // data-api wrapped every sum in COALESCE(..., 0); replicate that client-side
  // rather than lean on the beta engine's function coverage. Without it an
  // all-null group would be skipped by the builder instead of counted at zero.
  const page = rows.slice(offset).map((row) => ({
    ...row,
    staked_tao: row.staked_tao ?? 0,
    unstaked_tao: row.unstaked_tao ?? 0,
  }));
  return {
    data: buildValidatorNominators(page, hotkey, {
      window: label,
      sort,
      limit,
      offset,
      totalCount: page.length,
    }),
    generatedAt: latestObservedIso(page),
  };
}

/** The bounded newest-first Transfer scan both counterparty modes read.
 * observed_at is selected (it drives the ORDER BY) but STRIPPED before the
 * rows reach a builder: data-api's outer projection drops it, so keeping it
 * would let this tier populate relationship timestamps the Postgres tier
 * leaves null -- a payload difference callers could observe. */
async function counterpartyScan(
  env: Env | null | undefined,
  predicate: string,
): Promise<Record<string, unknown>[] | null> {
  const rows = await r2SqlQuery(
    env,
    `SELECT hotkey, coldkey, amount_tao, block_number, event_index, observed_at ` +
      `FROM chain.account_events WHERE event_kind = 'Transfer' AND ${predicate} ` +
      `${FEED_ORDER} LIMIT ${COUNTERPARTIES_SCAN_CAP}`,
  );
  if (rows === null) return null;
  return rows.map(({ observed_at: _observedAt, ...rest }) => rest);
}

/**
 * GET /api/v1/accounts/{ss58}/counterparties (list mode) -- who this account
 * transacts native TAO with, aggregated client-side from the capped scan by
 * the same builder every tier feeds.
 */
export async function loadAccountCounterpartiesColdTier(
  env: Env | null | undefined,
  ss58: string,
  query: { limit?: number } = {},
): Promise<ReturnType<typeof buildCounterparties> | null> {
  const addr = safeSs58Literal(ss58);
  if (addr === null) return null;
  const rows = await counterpartyScan(
    env,
    `(hotkey = '${addr}' OR coldkey = '${addr}')`,
  );
  if (rows === null) return null;
  return buildCounterparties(rows, ss58, { limit: query.limit });
}

/** The composite drilldown payload data-api assembles inline for
 * ?counterparty= -- reproduced field-for-field so the route's shape does not
 * depend on which tier answered. */
export interface CounterpartyDrilldownResult {
  schema_version: 1;
  ss58: string;
  counterparty_count: number;
  transfers_scanned: number;
  scan_capped: boolean;
  total_sent_tao: number;
  total_received_tao: number;
  counterparties: {
    address: string;
    sent_tao: number;
    received_tao: number;
    net_tao: number;
    transfer_count: number;
    last_block: number | null;
  }[];
  relationship: CounterpartyRelationshipResult;
}

/**
 * GET /api/v1/accounts/{ss58}/counterparties?counterparty= (drilldown mode) --
 * one relationship's fund-flow totals plus the transfer evidence.
 */
export async function loadCounterpartyRelationshipColdTier(
  env: Env | null | undefined,
  ss58: string,
  counterparty: string,
  query: { limit?: number } = {},
): Promise<CounterpartyDrilldownResult | null> {
  const addr = safeSs58Literal(ss58);
  const other = safeSs58Literal(counterparty);
  if (addr === null || other === null) return null;
  const rows = await counterpartyScan(
    env,
    `((hotkey = '${addr}' AND coldkey = '${other}') OR ` +
      `(hotkey = '${other}' AND coldkey = '${addr}'))`,
  );
  if (rows === null) return null;
  const relationship = buildCounterpartyRelationship(rows, ss58, counterparty, {
    limit: query.limit,
  });
  return {
    schema_version: 1,
    ss58,
    counterparty_count: relationship.transfer_count === 0 ? 0 : 1,
    transfers_scanned: relationship.transfers_scanned,
    scan_capped: relationship.scan_capped,
    total_sent_tao: relationship.total_sent_tao,
    total_received_tao: relationship.total_received_tao,
    counterparties:
      relationship.transfer_count === 0
        ? []
        : [
            {
              address: counterparty,
              sent_tao: relationship.total_sent_tao,
              received_tao: relationship.total_received_tao,
              net_tao: relationship.net_tao,
              transfer_count: relationship.transfer_count,
              last_block: relationship.last_block,
            },
          ],
    relationship,
  };
}

/**
 * The event-history half of one account's summary card.
 *
 * `/api/v1/accounts/{ss58}` answered an all-zero card while its own detail
 * routes read the same rows: `/events` returned 6 events and `/registrations`
 * 146 for the address whose summary said `event_count: 0`. The handler's single
 * Postgres read was the only tier it had, so when that missed, every field on
 * the card went to zero at once.
 *
 * SCOPE: the account_events-derived fields only. buildAccountSummary composes
 * three sources -- account_events (here), `neurons` for the current-registration
 * list, and the extrinsics tier for the signing-activity sub-object -- and it is
 * null-safe per field, so those two stay empty until they get readers of their
 * own rather than being faked from this one.
 *
 * ATTRIBUTION IS `hotkey OR coldkey`, matching loadAccountEventsColdTier
 * exactly. The card and the feed describe the same event set, so an attribution
 * that differed between them would reintroduce, in a subtler form, the very
 * disagreement this fixes.
 *
 * THE CAPPED SCAN IS THE CONTRACT, not an optimisation. The aggregates are over
 * the account's newest ACCOUNT_EVENT_SUMMARY_SCAN_CAP events, and `scanned` is a
 * separate probe over CAP + 1: when it exceeds CAP the totals are a lower bound
 * and the window's minimum block/time is its floor rather than the account's
 * first-ever, which is why buildAccountSummary nulls `first_*` in that case.
 * Reproducing the probe rather than reusing the aggregate's own count is what
 * lets an account with EXACTLY CAP events still report exact totals.
 */
export async function loadAccountSummaryColdTier(
  env: Env | null | undefined,
  ss58: string,
  {
    recentLimit = ACCOUNT_SUMMARY_RECENT_LIMIT,
    query = r2SqlQuery,
  }: {
    recentLimit?: number;
    query?: typeof r2SqlQuery;
  } = {},
): Promise<{
  agg: Record<string, unknown> | null;
  kinds: Array<Record<string, unknown>>;
  scanned: number | null;
  recent: Array<Record<string, unknown>>;
} | null> {
  const addr = safeSs58Literal(ss58);
  if (addr === null) return null;
  const limit = safeBlockNumber(recentLimit);
  if (limit === null || limit <= 0) return null;

  const where = `(hotkey = '${addr}' OR coldkey = '${addr}')`;
  // The newest CAP events, named once so the three reads that share it cannot
  // drift onto different windows.
  const scan =
    `SELECT netuid, event_kind, block_number, observed_at ` +
    `FROM chain.account_events WHERE ${where} ` +
    `ORDER BY block_number DESC LIMIT ${ACCOUNT_EVENT_SUMMARY_SCAN_CAP}`;

  const [aggRows, subnetRows, kindRows, probeRows, recentRows] =
    await Promise.all([
      query(
        env,
        `WITH scan AS (${scan}) SELECT count(*) AS c, ` +
          `min(block_number) AS fb, max(block_number) AS lb, ` +
          `min(observed_at) AS fo, max(observed_at) AS lo FROM scan`,
      ),
      // subnet_count is its own GROUP BY subquery, NOT count(DISTINCT netuid).
      // The engine rejects an ungrouped count(DISTINCT) at this scale -- the
      // `40015: scan budget exceeded ... without GROUP BY` failure #9251 hit --
      // and being inside a capped CTE does not save it, because the planner
      // still evaluates the DISTINCT against the underlying scan. That
      // rejection made this whole read decline, which is why the card shipped
      // in #9254 still served zeros in production.
      query(
        env,
        `WITH scan AS (${scan}) SELECT count(*) AS sc ` +
          `FROM (SELECT netuid FROM scan GROUP BY netuid)`,
      ),
      query(
        env,
        `WITH scan AS (${scan}) SELECT event_kind AS kind, count(*) AS count ` +
          `FROM scan GROUP BY event_kind`,
      ),
      // CAP + 1 so "exactly CAP" is distinguishable from "more than CAP".
      query(
        env,
        `SELECT count(*) AS c FROM (SELECT block_number FROM chain.account_events ` +
          `WHERE ${where} LIMIT ${ACCOUNT_EVENT_SUMMARY_SCAN_CAP + 1})`,
      ),
      query(
        env,
        `SELECT ${EVENT_COLUMNS} FROM chain.account_events WHERE ${where} ` +
          `${FEED_ORDER} LIMIT ${limit}`,
      ),
    ]);

  // Any half missing is a decline: a card mixing measured aggregates with a
  // zeroed probe would silently flip event_scan_capped and publish a first_seen
  // that is really a window floor.
  if (!aggRows || !subnetRows || !kindRows || !probeRows || !recentRows) {
    return null;
  }
  const aggRow = aggRows[0] ?? null;
  const subnetCount = subnetRows[0]?.sc;
  const scanned = probeRows[0]?.c;
  if (aggRow === null || subnetCount === undefined || scanned === undefined) {
    return null;
  }
  // The distinct count rides back inside `agg` under the key the builder
  // already reads, so only where the number comes from changed.
  const agg = { ...aggRow, sc: subnetCount };

  return {
    agg,
    kinds: kindRows,
    scanned: Number(scanned),
    recent: recentRows,
  };
}
