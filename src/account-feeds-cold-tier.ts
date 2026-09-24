import { declineRetainedHistoryFailure } from "./retained-history-store.ts";
// Native account feeds share the canonical formatters and preserve every
// supported filter, cursor, aggregate and explicit unavailable-history state.

import { hasRetainedHistoryStore } from "./retained-history-store.ts";
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
  declineAccountStakeMoves,
  DEFAULT_ACCOUNT_STAKE_MOVES_WINDOW,
  STAKE_MOVED_EVENT_KIND,
} from "./account-stake-moves.ts";
import {
  ACCOUNT_WEIGHT_SETTERS_WINDOWS,
  buildAccountWeightSetters,
  DEFAULT_ACCOUNT_WEIGHT_SETTERS_WINDOW,
} from "./account-weight-setters.ts";
import {
  buildCounterparties,
  buildCounterpartyRelationship,
  COUNTERPARTIES_SCAN_CAP,
  type CounterpartyRelationshipResult,
} from "./counterparties.ts";
import { ACCOUNT_SUMMARY_RECENT_LIMIT } from "./account-events.ts";
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
  buildAccountPrometheus,
  PROMETHEUS_EVENT_KIND,
  PROMETHEUS_WINDOWS,
  DEFAULT_PROMETHEUS_WINDOW,
} from "./account-prometheus.ts";
import {
  buildValidatorNominators,
  DEFAULT_NOMINATOR_SORT,
  DEFAULT_NOMINATOR_WINDOW,
  NOMINATOR_SORTS,
  NOMINATOR_WINDOWS,
} from "./validator-nominators.ts";
import { storeAll } from "./analytics-live.ts";
import { decodeCursor, encodeCursor } from "./cursor.ts";
import { safeBlockNumber, safeSs58Literal } from "./history-readers.ts";
import { loadAccountSummaryProjection } from "./account-summary-projection.ts";
import { offsetBeyondEmulationCap } from "./cold-tier-offset.ts";
import { readStore } from "./read-store.ts";
import type { HistoryReadEnv } from "./history-readers.ts";
import { loadIndexedValidatorNominators } from "./validator-nominators-indexed.ts";
import { loadNativeAccountWeightSetters } from "./account-weight-setters-native.ts";
import {
  loadIndexedAccountFeedPage,
  loadIndexedAccountFeedGroups,
} from "./indexed-account-feeds.ts";
import type { AccountFeedSelector } from "./history-account-feed.ts";

/** Equality views bound the physical reads; the timestamp range is inclusive,
 * matching the existing aggregate predicates. No pagination cap enters totals. */
function indexedAccountWindow(
  env: unknown,
  account: string,
  kinds: string[],
  cutoff: number,
  hotkeyOnly = false,
) {
  const sides: AccountFeedSelector["side"][] = hotkeyOnly
    ? ["hotkey"]
    : ["hotkey", "coldkey"];
  return loadIndexedAccountFeedGroups(
    env,
    kinds.flatMap((kind) =>
      sides.map((side) => ({
        side,
        account,
        kind,
        observedStart: cutoff,
      })),
    ),
  );
}

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
  env: HistoryReadEnv | null | undefined,
  ss58: string,
  query: AccountTransfersQuery,
): Promise<ReturnType<typeof buildAccountTransfers> | null> {
  const limit = safeBlockNumber(query.limit);
  const offset = safeBlockNumber(query.offset ?? 0);
  if (limit === null || offset === null || limit <= 0) return null;
  // Preserve the public depth cap; past this depth the index traversal is not a
  // reasonable trade and declining beats serving a page that is quietly wrong.
  if (offsetBeyondEmulationCap(offset)) return null;

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
  for (const [value] of [
    [query.blockStart, "block_number >="],
    [query.blockEnd, "block_number <="],
  ] as [unknown, string][]) {
    if (value == null) continue;
    const n = safeBlockNumber(value);
    if (n === null) return null;
  }
  const cursor = decodeCursor(query.cursor, CURSOR_ARITY);

  // Cursor pages never carry an offset, mirroring data-api.
  const paged = cursor ? 0 : offset;
  const sides: AccountFeedSelector["side"][] =
    direction === "sent"
      ? ["hotkey"]
      : direction === "received"
        ? ["coldkey"]
        : ["hotkey", "coldkey"];
  const indexed = await loadIndexedAccountFeedPage(
    env,
    sides.map((side) => ({
      side,
      account: ss58,
      kind: "Transfer",
      blockStart:
        query.blockStart == null ? undefined : Number(query.blockStart),
      blockEnd: query.blockEnd == null ? undefined : Number(query.blockEnd),
      cursor: cursor ? [cursor[0], cursor[1], cursor[2]] : null,
    })),
    limit,
    paged,
  );
  if (indexed == null) return null;
  const page = indexed;
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
    // The fixed-label hint applies only when the selector filtered one side --
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
  env: HistoryReadEnv | null | undefined,
  ss58: string,
  query: { window?: string | null; direction?: unknown } = {},
): Promise<{
  data: ReturnType<typeof buildAccountStakeFlow>;
  generatedAt: string | null;
  rows: Array<Record<string, unknown>>;
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
  const { label, cutoff } = windowCutoff(
    STAKE_FLOW_WINDOWS,
    DEFAULT_STAKE_FLOW_WINDOW,
    query.window,
  );
  // ALSO SUMS alpha_amount (#10930). `account_events` carries both units on
  // every StakeAdded/StakeRemoved row, so one query yields both -- the same
  // rationale src/alpha-volume.ts states for its own read. The owner-cut
  // disposition needs the ALPHA leg specifically: its buckets are alpha, and
  // pricing a TAO figure into them would put a reconstruction where the
  // reconciliation needs a reading. `buildAccountStakeFlow` ignores the extra
  // column, so the published stake-flow card is unchanged.
  const indexed = await indexedAccountWindow(
    env,
    ss58,
    direction === "in"
      ? [STAKE_ADDED_KIND]
      : direction === "out"
        ? [STAKE_REMOVED_KIND]
        : [STAKE_ADDED_KIND, STAKE_REMOVED_KIND],
    cutoff,
  );
  const rows = indexed;
  if (rows == null) return null;
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
    // The raw grouped rows, so a caller needing the alpha leg does not have to
    // re-read the table. Returned beside the card rather than folded into it,
    // because the card's shape is a published contract.
    rows,
  };
}

/**
 * GET /api/v1/accounts/{ss58}/stake-moves -- the windowed per-subnet
 * StakeMoved footprint, GROUP BY netuid. Same wrapped shape as stake-flow.
 */
export async function loadAccountStakeMovesColdTier(
  env: HistoryReadEnv | null | undefined,
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
  const indexed = await indexedAccountWindow(
    env,
    ss58,
    [STAKE_MOVED_EVENT_KIND],
    cutoff,
  );
  const rows = indexed;
  if (rows == null) {
    return indexed !== undefined || hasRetainedHistoryStore(env)
      ? {
          data: declineAccountStakeMoves(ss58, label),
          // No read, so no reading instant -- never `new Date()`, which would
          // date an empty card to now.
          generatedAt: null,
        }
      : null;
  }
  return {
    data: buildAccountStakeMoves(
      rows.map((row) => ({ ...row, movements: row.event_count })),
      ss58,
      {
        window: label,
        // #4332's price-at-tx enrichment, restored. buildAccountStakeMoves has
        // always taken this map, and NOBODY passed it once the Postgres tier was
        // retired (#10190) -- data-api computed it, so `price_tao_at_last_move`
        // has been null on REST, GraphQL and MCP alike ever since. The tests
        // could not show it: they doubled the tier, which supplied the field.
        priceByNetuidDate: await alphaPriceByNetuidDate(env, rows, cutoff),
      },
    ),
    generatedAt: latestObservedIso(rows),
  };
}

/** The price enrichment's own read (#4332).
 *
 * Declared HERE rather than in src/read-store-tables.ts, whose sets exist for
 * loaders called from two or three modules: this one has a single consumer, and
 * tests/read-store-declares-its-tables.test.ts holds every ported reader --
 * this file among them -- to declaring the tables its own SQL names, which it
 * checks by reading this module. A set it has to follow an import to find is a
 * set that gate cannot check.
 */
const ACCOUNT_STAKE_MOVES_PRICE_TABLES = ["subnet_snapshots"] as const;

/**
 * `netuid:YYYY-MM-DD -> alpha_price_tao`, for the days the rows actually land
 * on.
 *
 * Scoped to those days rather than the whole window: the map is keyed by the
 * date of each subnet's LAST move, so a wider read would cost more and answer
 * the same. A store that cannot answer yields an empty map, which the builder
 * already reads as "no price for that day" -- the same null it published while
 * this enrichment had no caller at all.
 */
async function alphaPriceByNetuidDate(
  env: HistoryReadEnv | null | undefined,
  rows: Array<Record<string, unknown>>,
  cutoff: number,
): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  const netuids = [
    ...new Set(
      rows
        .map((row) => Number(row.netuid))
        .filter((netuid) => Number.isSafeInteger(netuid)),
    ),
  ];
  if (netuids.length === 0) return prices;
  try {
    const since = new Date(cutoff).toISOString().slice(0, 10);
    const snapshots = await storeAll(
      readStore(env, ACCOUNT_STAKE_MOVES_PRICE_TABLES),
      `SELECT netuid, snapshot_date, alpha_price_tao FROM subnet_snapshots
       WHERE snapshot_date >= ? AND netuid IN (${netuids.join(", ")})
         AND alpha_price_tao IS NOT NULL`,
      [since],
    );
    for (const row of snapshots) {
      const price = Number(row.alpha_price_tao);
      if (!Number.isFinite(price)) continue;
      prices.set(`${Number(row.netuid)}:${String(row.snapshot_date)}`, price);
    }
  } catch {
    // A price the store cannot serve is a null price, never a failed feed.
  }
  return prices;
}

/** Registrations belong to the registered hotkey alone. Including the coldkey
 * would incorrectly credit a funding account with all its hotkeys' activity. */
export async function loadAccountRegistrationsColdTier(
  env: HistoryReadEnv | null | undefined,
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
  const indexed = await indexedAccountWindow(
    env,
    ss58,
    [REGISTRATION_EVENT_KIND],
    cutoff,
    true,
  );
  const rows = indexed;
  if (rows == null) return null;
  return {
    data: buildAccountRegistrations(
      rows.map((row) => ({ ...row, registrations: row.event_count })),
      ss58,
      { window: label },
    ),
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
  env: HistoryReadEnv | null | undefined,
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
  const indexed = await indexedAccountWindow(
    env,
    ss58,
    [SERVING_EVENT_KIND],
    cutoff,
    true,
  );
  const rows = indexed;
  if (rows == null) return null;
  return {
    data: buildAccountServing(
      rows.map((row) => ({ ...row, announcements: row.event_count })),
      ss58,
      { window: label },
    ),
    generatedAt: latestObservedIso(rows),
  };
}

/**
 * One account's per-subnet PrometheusServed footprint -- the telemetry
 * companion to loadAccountServingColdTier above, same query shape, same
 * hotkey-only attribution, differing only in event kind.
 *
 * #10322: this rung did not exist, so `/accounts/{ss58}/prometheus` bottomed
 * out in `buildAccountPrometheus([])` for every account while the chain-level
 * card answered from the same PrometheusServed stream.
 */
export async function loadAccountPrometheusColdTier(
  env: HistoryReadEnv | null | undefined,
  ss58: string,
  query: { window?: string | null } = {},
): Promise<{
  data: ReturnType<typeof buildAccountPrometheus>;
  generatedAt: string | null;
} | null> {
  const addr = safeSs58Literal(ss58);
  if (addr === null) return null;
  const { label, cutoff } = windowCutoff(
    PROMETHEUS_WINDOWS,
    DEFAULT_PROMETHEUS_WINDOW,
    query.window,
  );
  const indexed = await indexedAccountWindow(
    env,
    ss58,
    [PROMETHEUS_EVENT_KIND],
    cutoff,
    true,
  );
  const rows = indexed;
  if (rows == null) return null;
  return {
    data: buildAccountPrometheus(
      rows.map((row) => ({ ...row, announcements: row.event_count })),
      ss58,
      {
        window: label,
        sourceAvailable: true,
      },
    ),
    generatedAt: latestObservedIso(rows),
  };
}

/** The hotkey's registered (netuid, uid) slots from `neurons` -- the same
 * decomposition data-api runs now that neurons is off Postgres. null when the
 * slots cannot be read (no binding, D1 failure, or an unusable cell), because
 * without them the hotkey-less WeightsSet rows would be silently dropped --
 * a degrade, and this family declines rather than degrades. */
async function neuronSlots(
  env: HistoryReadEnv | null | undefined,
  addr: string,
): Promise<{ netuid: number; uid: number }[] | null> {
  const db = readStore(env, ["neurons"]);
  if (!db?.query) return null;
  let results: unknown[];
  try {
    results = await db.query(
      "SELECT netuid, uid FROM neurons WHERE hotkey = ?",
      [addr],
    );
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
  env: HistoryReadEnv | null | undefined,
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

  const { label, cutoff } = windowCutoff(
    ACCOUNT_WEIGHT_SETTERS_WINDOWS,
    DEFAULT_ACCOUNT_WEIGHT_SETTERS_WINDOW,
    query.window,
  );
  const native = await loadNativeAccountWeightSetters(env, addr, slots, cutoff);
  return native == null
    ? null
    : {
        data: buildAccountWeightSetters(native, ss58, { window: label }),
        generatedAt: latestObservedIso(native),
      };
}

export interface ValidatorNominatorsQuery {
  window?: string | null;
  sort?: string | null;
  limit: number;
  offset?: number | null;
  /** ?coldkey= narrows to one nominator's own flow -- an exact match, so it
   * narrows the native aggregate to that coldkey. */
  coldkey?: unknown;
}

/** Rank complete native staking aggregates per coldkey, then apply one page.
 * The total count describes every matching nominator before pagination. */
export async function loadValidatorNominatorsColdTier(
  env: HistoryReadEnv | null | undefined,
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
  if (offsetBeyondEmulationCap(offset)) return null;

  const sort = query.sort ?? DEFAULT_NOMINATOR_SORT;
  // A sort this tier cannot express would otherwise silently serve the default
  // ordering under the caller's requested label -- decline instead.
  if (!(NOMINATOR_SORTS as readonly string[]).includes(sort)) return null;

  if (query.coldkey != null) {
    const nominator = safeSs58Literal(query.coldkey);
    // An unusable coldkey filter must not widen to "every nominator".
    if (nominator === null) return null;
  }
  const { label, cutoff } = windowCutoff(
    NOMINATOR_WINDOWS,
    DEFAULT_NOMINATOR_WINDOW,
    query.window,
  );

  const indexed = await loadIndexedValidatorNominators(env, addr, cutoff, {
    coldkey: query.coldkey == null ? null : String(query.coldkey),
    sort,
    limit,
    offset,
  });
  if (indexed == null) return null;
  const rows = indexed.rows;
  const counted = Number(indexed.totalCount);
  const totalCount = Number.isFinite(counted) ? counted : null;

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
      totalCount,
      alreadyPaged: true,
    }),
    generatedAt: latestObservedIso(page),
  };
}

/**
 * GET /api/v1/accounts/{ss58}/counterparties (list mode) -- who this account
 * transacts native TAO with, aggregated client-side from the capped scan by
 * the same builder every tier feeds.
 */
export async function loadAccountCounterpartiesColdTier(
  env: HistoryReadEnv | null | undefined,
  ss58: string,
  query: { limit?: number } = {},
): Promise<ReturnType<typeof buildCounterparties> | null> {
  const addr = safeSs58Literal(ss58);
  if (addr === null) return null;
  const indexed = await loadIndexedAccountFeedPage(
    env,
    [
      { side: "hotkey", account: ss58, kind: "Transfer" },
      { side: "coldkey", account: ss58, kind: "Transfer" },
    ],
    COUNTERPARTIES_SCAN_CAP,
  );
  // `need` here is COUNTERPARTIES_SCAN_CAP (5,000), so the walk's two probes
  // essentially never fill and every request reached its unbounded third read.
  const rows = indexed;
  if (rows == null) return null;
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
  env: HistoryReadEnv | null | undefined,
  ss58: string,
  counterparty: string,
  query: { limit?: number } = {},
): Promise<CounterpartyDrilldownResult | null> {
  const addr = safeSs58Literal(ss58);
  const other = safeSs58Literal(counterparty);
  if (addr === null || other === null) return null;
  const indexed = await loadIndexedAccountFeedPage(
    env,
    [
      { side: "hotkey", account: ss58, counterparty, kind: "Transfer" },
      { side: "coldkey", account: ss58, counterparty, kind: "Transfer" },
    ],
    COUNTERPARTIES_SCAN_CAP,
  );
  const rows = indexed;
  if (rows == null) return null;
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
/**
 * What the summary read returns.
 *
 * A decline carries WHY (#9386). The route used to fail ~50% of requests for a
 * high-activity coldkey with a typed 503 that named no cause, and the reason was
 * discarded here: every failure mode collapsed to a bare `null`. `declined` lists one
 * entry per leg that failed, each carrying the engine's own explanation, so an
 * operator reading the 503 learns whether it was a timeout, a scan-budget rejection or
 * an HTTP error -- without needing Worker-side visibility to guess.
 *
 * An empty `declined` on a decline is still possible and still honest: it means a leg
 * returned no usable row without raising.
 */
export type AccountSummaryColdTierResult =
  | {
      agg: Record<string, unknown>;
      kinds: Array<Record<string, unknown>>;
      scanned: number;
      /**
       * Whether `scanned` is the account's LIFETIME event count rather than a
       * probe's lower bound (#11468).
       *
       * The distinction the card used to infer from `scanned > CAP` alone, which
       * was only ever a proxy for "the lakehouse probe stopped at CAP + 1". It
       * stopped being a valid proxy once the projection could answer above the
       * cap: those totals are running sums folded forward from a 2020 floor, so
       * a large one is exact rather than truncated, and inferring truncation
       * from its SIZE nulls `first_block`/`first_seen_at` on the very accounts
       * whose full history the projection actually knows.
       *
       * So the reader that assembled the aggregate says whether it is whole,
       * instead of the formatter guessing from a number.
       */
      complete: boolean;
      recent: Array<Record<string, unknown>>;
      declined?: undefined;
    }
  | { declined: string[] };

/** Combine the verified lifetime fold with complete indexed deltas and a recent page. */
export async function loadAccountSummaryColdTier(
  env: HistoryReadEnv | null | undefined,
  ss58: string,
  {
    recentLimit = ACCOUNT_SUMMARY_RECENT_LIMIT,
  }: {
    recentLimit?: number;
  } = {},
): Promise<AccountSummaryColdTierResult> {
  const addr = safeSs58Literal(ss58);
  if (addr === null) return { declined: ["input: unusable ss58"] };
  const limit = safeBlockNumber(recentLimit);
  if (limit === null || limit <= 0) {
    return { declined: ["input: unusable recent limit"] };
  }

  const projected = await loadAccountSummaryProjection(env, ss58, {
    recentLimit: limit,
  });

  const absentFloor = projected?.absent === true ? projected.floorMs : null;
  const found = projected && projected.absent !== true ? projected : null;

  // Keep the compact lifetime fold and read only events after its cutoff. If no
  // trustworthy fold edge exists, the qualified index supplies the complete
  // retained aggregate. The recent page uses its own bounded account seek.
  const foldFloor = absentFloor ?? found?.span?.foldFloorMs;
  const selectors: AccountFeedSelector[] = [
    { side: "hotkey", account: addr },
    { side: "coldkey", account: addr },
  ];
  const [indexedGroups, indexedRecent] = await Promise.all([
    declineRetainedHistoryFailure(
      loadIndexedAccountFeedGroups(
        env,
        selectors.map((selector) => ({
          ...selector,
          observedStart: foldFloor,
        })),
      ),
    ),
    declineRetainedHistoryFailure(
      loadIndexedAccountFeedPage(env, selectors, limit),
    ),
  ]);
  if (indexedGroups == null || indexedRecent == null)
    return { declined: ["indexed history: account summary read failed"] };
  const folded = foldSummaryGroups([
    ...(foldFloor !== undefined && found ? found.groups : []),
    ...indexedGroups.map((row) => ({
      kind: row.event_kind,
      netuid: row.netuid,
      count: row.event_count,
      fb: row.first_block,
      lb: row.last_block,
      fo: row.first_observed,
      lo: row.last_observed,
    })),
  ]);
  return {
    ...folded,
    scanned: Number(folded.agg.c),
    complete: true,
    recent: indexedRecent,
  };
}

/**
 * Fold `GROUP BY event_kind, netuid` rows back into the three shapes the three
 * separate queries used to return. Each derivation is EXACT, not an approximation:
 *
 *  - `c` was `count(*)` over the CTE; every scanned row lands in exactly one
 *    (kind, netuid) group, so the group counts sum to it.
 *  - `fb`/`lb`/`fo`/`lo` were `min`/`max` over the CTE. SQL's min/max ignore NULLs,
 *    so a group whose column is entirely NULL reports NULL, and the fold skips those
 *    the same way -- an all-NULL column therefore stays NULL rather than becoming 0.
 *  - `sc` was `count(*) FROM (SELECT netuid FROM scan GROUP BY netuid)`. SQL GROUP BY
 *    treats NULL as its OWN group, so a NULL netuid counted as one distinct value and
 *    must still count here. That is why this counts distinct netuid KEYS rather than
 *    filtering nulls out, which would quietly shrink the number by one.
 *  - `kinds` was `GROUP BY event_kind`; summing each kind's rows across netuids
 *    reproduces it, NULL kind included, for the same reason.
 */
export function foldSummaryGroups(rows: Record<string, unknown>[]): {
  agg: Record<string, unknown>;
  kinds: Record<string, unknown>[];
} {
  let count = 0;
  let fb: number | null = null;
  let lb: number | null = null;
  let fo: number | null = null;
  let lo: number | null = null;
  // Keyed by the raw cell so NULL stays a distinct key rather than colliding with a
  // literal "null" string a subnet could never actually have.
  const netuids = new Set<unknown>();
  const kinds = new Map<unknown, number>();

  for (const row of rows) {
    const n = Number(row?.count);
    const rowCount = Number.isFinite(n) ? n : 0;
    count += rowCount;
    netuids.add(row?.netuid ?? null);
    kinds.set(
      row?.kind ?? null,
      (kinds.get(row?.kind ?? null) ?? 0) + rowCount,
    );
    fb = minOf(fb, row?.fb);
    lb = maxOf(lb, row?.lb);
    fo = minOf(fo, row?.fo);
    lo = maxOf(lo, row?.lo);
  }

  return {
    agg: { c: count, fb, lb, fo, lo, sc: netuids.size },
    kinds: [...kinds].map(([kind, c]) => ({ kind, count: c })),
  };
}

/** SQL `min` semantics: NULLs are skipped, never treated as 0. */
function minOf(current: number | null, value: unknown): number | null {
  const n = Number(value);
  if (value == null || !Number.isFinite(n)) return current;
  return current === null || n < current ? n : current;
}

/** SQL `max` semantics: NULLs are skipped, never treated as 0. */
function maxOf(current: number | null, value: unknown): number | null {
  const n = Number(value);
  if (value == null || !Number.isFinite(n)) return current;
  return current === null || n > current ? n : current;
}
