// The daily rollups' history, for days Neon no longer keeps.
//
// A DATE SEAM, and the same argument blocks-cold-tier.ts makes for its height
// one: each day must come from EXACTLY ONE source.
//
//   snapshot_date >= seam  -> Neon      (hot)
//   snapshot_date <  seam  -> lakehouse (cold)
//
// The two stores overlap today -- the lakehouse was seeded 2026-07-10..08-02
// while Neon holds 07-10 onward -- so "merge whatever both have" would double
// every overlapping day. Routing on a single date makes each day's provenance
// reproducible instead of depending on what each store happens to retain.
//
// THE SEAM IS RESOLVED, NOT PINNED, and it is Neon's own `MIN(snapshot_date)`.
// blocks-cold-tier.ts records what a pinned constant costs: the decode lane
// extended the lakehouse hourly while the Worker kept routing against a number
// from the last deploy, so every recently-decoded block served reduced columns
// forever. A configured date here would rot the same way, and worse -- the
// retention job that moves Neon's floor would leave a window in which a pruned
// day is served by NEITHER side.
//
// Taking the seam from Neon's floor closes that by construction: the hot store
// cannot drop a day without the seam moving with it, in the same transaction's
// worth of truth, with nothing to deploy and no constant to bump.
//
// COLUMN COVERAGE IS UNIFORM HERE, unlike the blocks seam. Both stores carry
// the same 22 (neuron_daily) and 15 (account_position_daily) columns -- the
// producer copies Postgres rather than deriving a narrower projection -- so
// there is no `storeCanServe` equivalent, no filter that has to be declined, and
// no reduced-column arm to explain. That is a property of the producer, and it
// is worth stating because it is what makes this seam simpler than the other.
//
// SELECTIVE, SO REQUEST-TIME. The predicate is `netuid = N` (plus `uid = U`),
// against a table holding ~30,000 rows per day. subnet-ohlc-cold-tier.ts's
// header states the rule this follows: selective predicates stay request-time,
// chain-wide aggregates move to a cron. One subnet's slice of a day is ~256
// rows, so even an `all` window over a year is a five-figure row count, not a
// scan.
//
// AGGREGATION HAPPENS IN SQL for the subnet series, matching what the hot tier
// does and for the same reason: the payload is one row per day, so grouping at
// the engine bounds the response by DAY count rather than by neuron count.
import {
  r2SqlQuery,
  safeBlockNumber,
  safeIsoDate,
  safeSs58Literal,
  type R2SqlDeps,
} from "./r2-sql.ts";
import {
  ACCOUNT_POSITION_DAILY_COLUMNS,
  NEURON_DAILY_COLUMNS,
} from "../generated/lakehouse/types.ts";
import type {
  AccountPositionDailyRow,
  NeuronDailyRow,
} from "../generated/lakehouse/types.ts";
import { shiftIsoDate } from "./iso-date-window.ts";
import {
  buildNeuronHistory,
  buildSubnetHistory,
  MAX_HISTORY_POINTS,
} from "./neuron-history.ts";
import { buildAccountPositionHistory } from "./account-position-history.ts";
import { buildValidatorHistory } from "./validator-history.ts";
import type { R2SqlEnv } from "./r2-sql.ts";

/** The lakehouse namespace holding the decoded/copied chain tables. */
const NAMESPACE = "chain";

/**
 * The columns the neuron-history payload reads, in the order the hot tier's
 * `NEURON_DAILY_READ_COLUMNS` selects them.
 *
 * Derived from the GENERATED tuple rather than hand-written, so a column the
 * catalog gains or renames cannot silently stop being read -- which is the
 * whole point of `validate:untyped-lakehouse-reads`. The hot list is
 * `snapshot_date, uid, hotkey, ... take`; `updated_at`, `netuid` and
 * `coldkey`'s position differ between the two stores' natural orders, so the
 * projection is stated by NAME and the row is keyed by name too.
 */
const NEURON_HISTORY_FIELDS = [
  "snapshot_date",
  "uid",
  "hotkey",
  "coldkey",
  "active",
  "validator_permit",
  "rank",
  "trust",
  "validator_trust",
  "consensus",
  "incentive",
  "dividends",
  "emission_tao",
  "stake_tao",
  "registered_at_block",
  "is_immunity_period",
  "axon",
  "block_number",
  "captured_at",
  "take",
] as const satisfies readonly (typeof NEURON_DAILY_COLUMNS)[number][];

/**
 * One day of one neuron: exactly the columns `NEURON_HISTORY_FIELDS` projects,
 * typed by PICKING them off the generated row rather than restated.
 *
 * `Record<string, unknown>` would have been accepted by every compiler here
 * and rejected by `validate:untyped-db-reads`, which is the gate's whole
 * point -- a read that will not name what it returns is how 124 untyped reads
 * accumulated one PR at a time. Deriving it also means a column the catalog
 * renames breaks HERE rather than as a silently-absent field in a payload.
 */
export type ColdNeuronHistoryRow = Pick<
  NeuronDailyRow,
  (typeof NEURON_HISTORY_FIELDS)[number]
>;

/** One day of one subnet, in the shape the hot tier's GROUP BY produces. */
export interface ColdSubnetHistoryRow {
  snapshot_date: string;
  neuron_count: number | null;
  validator_count: number | null;
  total_stake_tao: number | null;
  total_emission_tao: number | null;
}

/**
 * Whether a cold read is worth making at all.
 *
 * `start` is the window's oldest wanted day and `seam` is Neon's floor. When
 * the window does not reach below the floor there is nothing cold to fetch,
 * and asking anyway would spend an R2 SQL round trip -- and a share of the
 * ACCOUNT-wide rate limit -- to be told so.
 *
 * A null `seam` means Neon holds nothing, which happens on an empty table
 * rather than on a pruned one; the cold side is then the only side, so the
 * read IS worth making and the range is open-ended above.
 */
export function needsColdRead(
  start: string | null,
  seam: string | null,
): boolean {
  if (seam == null) return true;
  // A null start is an `all` window: it reaches as far back as anything does,
  // so it always crosses a non-null seam.
  return start == null || start < seam;
}

/** `snapshot_date` bounds for the cold leg, or null when the query is unsafe
 * to build. Exported so the predicate can be asserted directly rather than
 * only through a query string. */
export function coldDateRange(
  start: string | null,
  seam: string | null,
): { lo: string | null; hi: string | null } | null {
  const hi = seam == null ? null : safeIsoDate(seam);
  if (seam != null && hi == null) return null;
  const lo = start == null ? null : safeIsoDate(start);
  if (start != null && lo == null) return null;
  return { lo, hi };
}

function datePredicate(range: {
  lo: string | null;
  hi: string | null;
}): string {
  const parts: string[] = [];
  // STRICTLY below the seam. `<=` would re-serve the seam day the hot tier
  // already owns, which is the double-count this seam exists to prevent.
  if (range.hi != null) parts.push(`snapshot_date < '${range.hi}'`);
  if (range.lo != null) parts.push(`snapshot_date >= '${range.lo}'`);
  return parts.length === 0 ? "" : ` AND ${parts.join(" AND ")}`;
}

/**
 * One subnet's per-day rollup, below the seam.
 *
 * Returns null rather than [] when the lakehouse cannot answer, so the caller
 * keeps whatever the hot tier gave it instead of publishing a short series as
 * though it were the whole history. Every cold tier in this repo draws that
 * distinction, and it is the difference between "no older days exist" and "we
 * could not look".
 */
export async function loadSubnetHistoryColdTier(
  env: R2SqlEnv | null | undefined,
  netuid: unknown,
  start: string | null,
  seam: string | null,
  limit: number,
  deps: R2SqlDeps = {},
): Promise<ColdSubnetHistoryRow[] | null> {
  const id = safeBlockNumber(netuid);
  if (id == null) return null;
  const range = coldDateRange(start, seam);
  if (range == null) return null;
  const rows = await r2SqlQuery<{
    snapshot_date: string | null;
    neuron_count: number | string | null;
    validator_count: number | string | null;
    total_stake_tao: number | string | null;
    total_emission_tao: number | string | null;
  }>(
    env,
    `SELECT snapshot_date,
        COUNT(*) AS neuron_count,
        SUM(CASE WHEN validator_permit THEN 1 ELSE 0 END) AS validator_count,
        SUM(stake_tao) AS total_stake_tao,
        SUM(emission_tao) AS total_emission_tao
      FROM ${NAMESPACE}.neuron_daily
      WHERE netuid = ${id}${datePredicate(range)}
      GROUP BY snapshot_date
      ORDER BY snapshot_date DESC
      LIMIT ${Math.max(1, Math.trunc(limit))}`,
    deps,
  );
  if (rows == null) return null;
  return rows.flatMap((r) => {
    // A grouped row with no day cannot be placed in the series, and guessing
    // one would put a neighbour's counts on the wrong date.
    const day = typeof r.snapshot_date === "string" ? r.snapshot_date : null;
    if (day == null) return [];
    return [
      {
        snapshot_date: day,
        neuron_count: numeric(r.neuron_count),
        validator_count: numeric(r.validator_count),
        total_stake_tao: numeric(r.total_stake_tao),
        total_emission_tao: numeric(r.total_emission_tao),
      },
    ];
  });
}

/**
 * One neuron's per-day rows, below the seam.
 *
 * Keyed by (netuid, uid) exactly as the hot tier is -- a UID is a slot, and it
 * is reused after deregistration, so a run of days under one UID can span more
 * than one neuron. That is a property of the data both tiers share, not
 * something this reader should smooth over.
 */
export async function loadNeuronHistoryColdTier(
  env: R2SqlEnv | null | undefined,
  netuid: unknown,
  uid: unknown,
  start: string | null,
  seam: string | null,
  limit: number,
  deps: R2SqlDeps = {},
): Promise<ColdNeuronHistoryRow[] | null> {
  const id = safeBlockNumber(netuid);
  const slot = safeBlockNumber(uid);
  if (id == null || slot == null) return null;
  const range = coldDateRange(start, seam);
  if (range == null) return null;
  const rows = await r2SqlQuery<ColdNeuronHistoryRow>(
    env,
    `SELECT ${NEURON_HISTORY_FIELDS.join(", ")}
      FROM ${NAMESPACE}.neuron_daily
      WHERE netuid = ${id} AND uid = ${slot}${datePredicate(range)}
      ORDER BY snapshot_date DESC
      LIMIT ${Math.max(1, Math.trunc(limit))}`,
    deps,
  );
  return rows ?? null;
}

/** A `snapshot_date`-shaped cell off a builder's generic `Row`. The builders
 * return an untyped record, so the coverage fields arrive as `unknown` even
 * though the schema declares them -- narrowing here rather than casting keeps
 * a non-string (a number, a stray object) out of a date comparison, where it
 * would compare as garbage rather than fail. */
function asDay(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** COUNT/SUM come back as numbers from R2 SQL and as numeric strings from some
 * engines; the payload contract is a number or null, so neither may leak. */
function numeric(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * The cold range a hot payload leaves unanswered, or null when there is none.
 *
 * THE SEAM COMES FROM THE PAYLOAD, which is the whole trick here. `oldest_day`
 * is what the hot tier actually returned, so it IS Neon's floor for this
 * subnet whenever the hot side ran out of data -- no second query, and nothing
 * to keep in sync. #10791 added that field for a different reason (saying what
 * a response covered); it turns out to be exactly the seam.
 *
 * The distinction that matters: `oldest_day` is the oldest day RETURNED, which
 * is Neon's floor only when the window was not the thing that stopped it. A 7d
 * window over a 33-day store stops at 7 days because it was asked to, and
 * reaching below that would answer a question nobody asked. So the cold leg
 * opens only when the hot series ends ABOVE the window's own start.
 */
export function coldWindow(
  coverage: { oldest_day: string | null; newest_day: string | null },
  days: number | null,
  shift: (day: string, delta: number) => string | null,
): { start: string | null; seam: string | null } | null {
  const seam = coverage.oldest_day;
  // The hot tier returned nothing at all -- an empty store, or a subnet with
  // no rows above the floor. The cold side is then the only side, and it has
  // to be anchored on its OWN newest day, which only the rows can say. An
  // open-ended read plus the merge's window trim is what does that.
  if (seam == null) return { start: null, seam: null };
  if (days == null) return { start: null, seam };
  // Anchored on the data, not the clock -- neuronDailyWindowBounds' rule. With
  // no newest_day there is nothing to anchor to but the seam itself.
  const start = shift(coverage.newest_day ?? seam, -days);
  // shiftIsoDate refuses a malformed day rather than guessing one. Without a
  // start there is no window to compare the seam against, so the honest move
  // is to leave the hot answer alone rather than fetch an unbounded range.
  if (start == null) return null;
  // The hot series already reaches the window's start, so nothing is missing.
  return seam <= start ? null : { start, seam };
}

/**
 * Hot and cold days into one series, newest first.
 *
 * HOT WINS on a day both sides carry. They should not disagree -- the
 * reconciler exists to make that true -- but if they ever do, the store the
 * writer commits to is the one to believe, and silently preferring a copy
 * would hide exactly the drift the reconciler is there to report.
 *
 * The window is applied AFTER the merge, anchored on the merged series' own
 * newest day, so a caller asking for 30d gets 30 days whether they came from
 * one store or two.
 */
export function mergeHistoryDays<T extends { snapshot_date?: unknown }>(
  hot: readonly T[],
  cold: readonly T[],
  days: number | null,
  limit: number,
  shift: (day: string, delta: number) => string | null,
): T[] {
  const byDay = new Map<string, T>();
  // Cold first so a hot row for the same day overwrites it.
  for (const row of [...cold, ...hot]) {
    const day = row.snapshot_date;
    if (typeof day === "string" && day !== "") byDay.set(day, row);
  }
  // Sorted by KEY through the Map, so there is no equal case to handle: keys
  // are unique by construction. A three-way comparator would carry a branch
  // nothing can reach.
  const dayKeys = [...byDay.keys()].sort();
  if (dayKeys.length === 0) return [];
  const merged = dayKeys.reverse().map((d) => byDay.get(d)!);
  const newest = dayKeys[0]!;
  const floor = days == null ? null : shift(newest, -days);
  const windowed =
    floor == null
      ? merged
      : merged.filter((row) => (row.snapshot_date as string) >= floor);
  return windowed.slice(0, Math.max(0, Math.trunc(limit)));
}

/**
 * Extend a subnet-history payload with days below Neon's floor.
 *
 * AN OVERLAY AT TIER CONVERGENCE, not an argument to the builder --
 * `R2_SQL_TOKEN` is a secret on the MAIN Worker and not on
 * `metagraphed-data-api`, so the lakehouse is unreachable from the tier that
 * produced this payload. That is a deployment fact, not a preference, and it
 * is why this runs after the hot tier has already built its answer.
 *
 * The payload is REBUILT from the merged rows rather than patched, so
 * `point_count`, `oldest_day`, `newest_day` and `days_covered` all describe
 * what is actually being served. Patching `points` alone would leave a
 * response whose own coverage fields contradicted its contents.
 *
 * Returns the input unchanged whenever the cold side declines, which keeps
 * "we could not look" from turning into "there is nothing older".
 */
export async function overlaySubnetHistoryColdTier(
  env: R2SqlEnv | null | undefined,
  data: ReturnType<typeof buildSubnetHistory>,
  netuid: number,
  window: { label: string; days: number | null },
  deps: R2SqlDeps = {},
): Promise<ReturnType<typeof buildSubnetHistory>> {
  const range = coldWindow(
    { oldest_day: asDay(data.oldest_day), newest_day: asDay(data.newest_day) },
    window.days,
    shiftIsoDate,
  );
  if (range == null) return data;
  const cold = await loadSubnetHistoryColdTier(
    env,
    netuid,
    range.start,
    range.seam,
    MAX_HISTORY_POINTS,
    deps,
  );
  if (cold == null || cold.length === 0) return data;
  const merged = mergeHistoryDays(
    (data.points ?? []) as { snapshot_date?: unknown }[],
    cold,
    window.days,
    MAX_HISTORY_POINTS,
    shiftIsoDate,
  );
  return buildSubnetHistory(merged as never[], netuid, {
    window: window.label,
  });
}

/** The neuron twin of `overlaySubnetHistoryColdTier`; same reasoning
 * throughout, keyed by (netuid, uid). */
export async function overlayNeuronHistoryColdTier(
  env: R2SqlEnv | null | undefined,
  data: ReturnType<typeof buildNeuronHistory>,
  netuid: number,
  uid: number,
  window: { label: string; days: number | null },
  deps: R2SqlDeps = {},
): Promise<ReturnType<typeof buildNeuronHistory>> {
  const range = coldWindow(
    { oldest_day: asDay(data.oldest_day), newest_day: asDay(data.newest_day) },
    window.days,
    shiftIsoDate,
  );
  if (range == null) return data;
  const cold = await loadNeuronHistoryColdTier(
    env,
    netuid,
    uid,
    range.start,
    range.seam,
    MAX_HISTORY_POINTS,
    deps,
  );
  if (cold == null || cold.length === 0) return data;
  const merged = mergeHistoryDays(
    (data.points ?? []) as { snapshot_date?: unknown }[],
    cold,
    window.days,
    MAX_HISTORY_POINTS,
    shiftIsoDate,
  );
  return buildNeuronHistory(merged as never[], netuid, uid, {
    window: window.label,
  });
}

/**
 * The columns `/accounts/{ss58}/subnets/{netuid}/history` reads, again derived
 * from the generated tuple rather than restated.
 */
const ACCOUNT_POSITION_FIELDS = [
  "snapshot_date",
  "captured_at",
  "uid",
  "coldkey",
  "active",
  "validator_permit",
  "rank",
  "trust",
  "incentive",
  "dividends",
  "stake_tao",
  "emission_tao",
] as const satisfies readonly (typeof ACCOUNT_POSITION_DAILY_COLUMNS)[number][];

export type ColdAccountPositionRow = Pick<
  AccountPositionDailyRow,
  (typeof ACCOUNT_POSITION_FIELDS)[number]
>;

/**
 * One account's position in one subnet, below the seam.
 *
 * `account` is the HOTKEY here, not the coldkey -- the row carries `coldkey`
 * as a separate column, and reading it the other way round would silently
 * return nothing for every caller. Verified against the live table rather than
 * inferred from the name.
 */
export async function loadAccountPositionHistoryColdTier(
  env: R2SqlEnv | null | undefined,
  ss58: unknown,
  netuid: unknown,
  start: string | null,
  seam: string | null,
  limit: number,
  deps: R2SqlDeps = {},
): Promise<ColdAccountPositionRow[] | null> {
  const account = safeSs58Literal(ss58);
  const id = safeBlockNumber(netuid);
  if (account == null || id == null) return null;
  const range = coldDateRange(start, seam);
  if (range == null) return null;
  const rows = await r2SqlQuery<ColdAccountPositionRow>(
    env,
    `SELECT ${ACCOUNT_POSITION_FIELDS.join(", ")}
      FROM ${NAMESPACE}.account_position_daily
      WHERE account = '${account}' AND netuid = ${id}${datePredicate(range)}
      ORDER BY snapshot_date DESC
      LIMIT ${Math.max(1, Math.trunc(limit))}`,
    deps,
  );
  return rows ?? null;
}

/** The account-position twin of the history overlays; same seam, same rules. */
export async function overlayAccountPositionHistoryColdTier(
  env: R2SqlEnv | null | undefined,
  data: ReturnType<typeof buildAccountPositionHistory>,
  ss58: string,
  netuid: number,
  window: { label: string; days: number | null },
  deps: R2SqlDeps = {},
): Promise<ReturnType<typeof buildAccountPositionHistory>> {
  // This builder publishes no coverage fields, so the seam is read off the
  // POINTS. That is the more general form -- `oldest_day` is only ever a
  // cached answer to this same question -- and it keeps the seam from
  // depending on a payload contract that differs per family.
  const range = coldWindow(coverageOf(data.points), window.days, shiftIsoDate);
  if (range == null) return data;
  const cold = await loadAccountPositionHistoryColdTier(
    env,
    ss58,
    netuid,
    range.start,
    range.seam,
    MAX_HISTORY_POINTS,
    deps,
  );
  if (cold == null || cold.length === 0) return data;
  const merged = mergeHistoryDays(
    (data.points ?? []) as { snapshot_date?: unknown }[],
    cold,
    window.days,
    MAX_HISTORY_POINTS,
    shiftIsoDate,
  );
  return buildAccountPositionHistory(
    merged as Array<Record<string, unknown>>,
    ss58,
    netuid,
    { window: window.label },
  );
}

/**
 * Oldest and newest day in a points array.
 *
 * The seam only ever needs these two values, and computing them from the rows
 * works for every history family -- including the ones whose builders publish
 * no coverage fields at all.
 */
export function coverageOf(points: unknown): {
  oldest_day: string | null;
  newest_day: string | null;
} {
  const days: string[] = [];
  for (const row of Array.isArray(points) ? points : []) {
    const day = asDay((row as { snapshot_date?: unknown })?.snapshot_date);
    if (day != null) days.push(day);
  }
  if (days.length === 0) return { oldest_day: null, newest_day: null };
  days.sort();
  return { oldest_day: days[0]!, newest_day: days[days.length - 1]! };
}

/**
 * One day of one validator, as the hot tier's SELECT list shapes it.
 *
 * Named rather than `Record<string, unknown>` because this projection is
 * COMPUTED -- aliases plus the TAO conversion -- so no generated row describes
 * it and `validate:untyped-db-reads` is right to insist it be written down.
 * The alpha/TAO pairing is the part worth stating: `stake_alpha` is the raw
 * column and `total_stake_tao` is it priced through subnet_snapshots, which is
 * why that join has to exist at all.
 */
export interface ColdValidatorHistoryRow {
  snapshot_date: string | null;
  subnet_count: number | null;
  netuid: number | null;
  uid: number | null;
  stake_alpha: number | null;
  emission_alpha: number | null;
  validator_trust: number | null;
  consensus: number | null;
  dividends: number | null;
  take: number | null;
  validator_permit: boolean | null;
  subnet_total_stake: number | null;
  total_stake_tao: number | null;
  total_emission_tao: number | null;
}

/**
 * One validator's per-day series, below the seam.
 *
 * THE JOIN IS WHY infra#447 EXISTS. The hot query prices stake and emission in
 * TAO through `LEFT JOIN subnet_snapshots ON netuid AND snapshot_date`, so a
 * lakehouse copy of neuron_daily alone cannot answer this route -- it would
 * have to serve the alpha-denominated columns and quietly drop the TAO ones,
 * which is the silent-shortening failure the seam exists to prevent. Carrying
 * subnet_snapshots costs ~124 rows a day and makes this expressible.
 *
 * netuid is OPTIONAL: the route is chain-wide by default and scoped on
 * request, exactly as the hot tier reads it.
 */
export async function loadValidatorHistoryColdTier(
  env: R2SqlEnv | null | undefined,
  hotkey: unknown,
  netuid: number | null,
  start: string | null,
  seam: string | null,
  limit: number,
  deps: R2SqlDeps = {},
): Promise<ColdValidatorHistoryRow[] | null> {
  const key = safeSs58Literal(hotkey);
  if (key == null) return null;
  const scoped = netuid == null ? null : safeBlockNumber(netuid);
  if (netuid != null && scoped == null) return null;
  const range = coldDateRange(start, seam);
  if (range == null) return null;
  // `nd.` prefixed, because datePredicate names the bare column and this is
  // the one query here with two tables carrying a snapshot_date.
  const dates = datePredicate(range).replaceAll(
    "snapshot_date",
    "nd.snapshot_date",
  );
  const rows = await r2SqlQuery<ColdValidatorHistoryRow>(
    env,
    `SELECT nd.snapshot_date AS snapshot_date, 1 AS subnet_count,
        nd.netuid AS netuid, nd.uid AS uid,
        nd.stake_tao AS stake_alpha, nd.emission_tao AS emission_alpha,
        nd.validator_trust AS validator_trust, nd.consensus AS consensus,
        nd.dividends AS dividends, nd.take AS take,
        nd.validator_permit AS validator_permit,
        s.total_stake_tao AS subnet_total_stake,
        nd.stake_tao * CASE WHEN nd.netuid = 0 THEN 1 ELSE s.tao_in_pool_tao / s.alpha_in_pool END AS total_stake_tao,
        nd.emission_tao * CASE WHEN nd.netuid = 0 THEN 1 ELSE s.tao_in_pool_tao / s.alpha_in_pool END AS total_emission_tao
      FROM ${NAMESPACE}.neuron_daily nd
      LEFT JOIN ${NAMESPACE}.subnet_snapshots s
        ON s.netuid = nd.netuid AND s.snapshot_date = nd.snapshot_date
      WHERE nd.hotkey = '${key}'${scoped == null ? "" : ` AND nd.netuid = ${scoped}`}${dates}
      ORDER BY nd.snapshot_date DESC
      LIMIT ${Math.max(1, Math.trunc(limit))}`,
    deps,
  );
  return rows ?? null;
}

/** The validator twin of the history overlays. */
export async function overlayValidatorHistoryColdTier(
  env: R2SqlEnv | null | undefined,
  data: ReturnType<typeof buildValidatorHistory>,
  hotkey: string,
  netuid: number | null,
  window: { label: string; days: number | null },
  deps: R2SqlDeps = {},
): Promise<ReturnType<typeof buildValidatorHistory>> {
  const range = coldWindow(coverageOf(data.points), window.days, shiftIsoDate);
  if (range == null) return data;
  const cold = await loadValidatorHistoryColdTier(
    env,
    hotkey,
    netuid,
    range.start,
    range.seam,
    MAX_HISTORY_POINTS,
    deps,
  );
  if (cold == null || cold.length === 0) return data;
  const merged = mergeHistoryDays(
    (data.points ?? []) as { snapshot_date?: unknown }[],
    cold,
    window.days,
    MAX_HISTORY_POINTS,
    shiftIsoDate,
  );
  return buildValidatorHistory(merged as never[], hotkey, {
    window: window.label,
    netuid,
  });
}
