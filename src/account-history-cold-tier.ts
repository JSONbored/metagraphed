// Account daily history folds qualified native events by UTC day and subnet.
// Hotkey attribution, complete cursor boundary days, distinct kinds and the
// retained history floor match the original rollup contract.
import {
  buildAccountHistory,
  type AccountHistoryResult,
} from "./account-events.ts";
import { accountHistoryFloorMs } from "./account-summary-projection.ts";
import { decodeCursor, encodeCursor } from "./cursor.ts";
import { safeBlockNumber, safeSs58Literal } from "./history-readers.ts";
import type { HistoryReadEnv } from "./history-readers.ts";
import { loadIndexedAccountHistoryRows } from "./account-history-indexed.ts";

type Row = Record<string, unknown>;

const MS_PER_DAY = 86_400_000;

/**
 * Over-fetch beyond `limit + offset` so the cursor's exact `(day, netuid)`
 * boundary can be applied here.
 *
 * The native input is bounded to whole DAYS (the tuple's two
 * halves live on opposite sides of the aggregation), so the first day of a
 * cursor page arrives complete and its already-seen netuids are dropped below.
 * One day holds at most one row per subnet, and the network has ~129 -- 512 is
 * four times that, so the exact boundary is always inside the fetched window.
 */
const CURSOR_DAY_SLACK = 512;

/** `YYYY-MM-DD` from the engine's day timestamp, or null if unrecognisable. */
function toDayString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const day = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

/** Midnight UTC for a `YYYY-MM-DD`, or null when it is not a real date. */
function dayStartMs(day: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isSafeInteger(ms) ? ms : null;
}

export interface AccountHistoryQuery {
  limit: number;
  offset?: number | null;
  /** data-api's own 2-part `(YYYYMMDD, netuid)` token, opaque to callers.
   * Decoded here rather than by each surface, so a malformed token means
   * page 1 everywhere -- which is exactly how data-api treated it. */
  cursor?: unknown;
  netuid?: unknown;
  /** `YYYY-MM-DD` bounds, inclusive at both ends. */
  from?: string | null;
  to?: string | null;
}

/**
 * One account's day series, newest day first, already built into the response
 * shape -- or null when the lakehouse cannot answer.
 *
 * HOTKEY-ATTRIBUTED, matching the retired rollup and the published contract:
 * `/events` matches hotkey OR coldkey, this does not, so a coldkey-only
 * address genuinely has zero days here. Widening it would make this route
 * disagree with its own documentation and with every historical answer.
 *
 * An empty result is NOT a decline: the query layer returns null on failure and
 * `[]` on a successful empty scan, so a quiet account publishes a real zero
 * rather than being indistinguishable from a broken tier.
 */
export async function loadAccountHistoryColdTier(
  env: HistoryReadEnv | null | undefined,
  ss58: string,
  query: AccountHistoryQuery,
): Promise<AccountHistoryResult | null> {
  // An unusable address is a decline, not an unfiltered scan of every account.
  const addr = safeSs58Literal(ss58);
  if (addr === null) return null;

  const limit = safeBlockNumber(query.limit);
  const offset = safeBlockNumber(query.offset ?? 0);
  if (limit === null || offset === null || limit <= 0) return null;

  // `netuid IS NOT NULL` mirrors the retired writer's own WHERE clause: a row
  // with no subnet has no (hotkey, netuid, day) key and was never rolled up.
  // Preserve the advertised mainnet retention floor for unbounded requests.
  const historyFloorMs = await accountHistoryFloorMs(env, ss58);
  let observedStart = historyFloorMs ?? 0;
  let observedEnd: number | undefined;
  let nativeNetuid: number | undefined;

  if (query.netuid != null) {
    const netuid = safeBlockNumber(query.netuid);
    if (netuid === null) return null;
    nativeNetuid = netuid;
  }
  if (query.from != null) {
    const ms = dayStartMs(query.from);
    if (ms === null) return null;
    observedStart = Math.max(observedStart, ms);
  }
  if (query.to != null) {
    // `?to` is INCLUSIVE of its day, so the bound is that day's END.
    const ms = dayStartMs(query.to);
    if (ms === null) return null;
    observedEnd = ms + MS_PER_DAY - 1;
  }

  // Read the complete cursor day, then apply its subnet boundary below.
  const cursor = decodeCursor(query.cursor, 2);
  const cursorDay = cursor
    ? String(cursor[0]).replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3")
    : null;
  // A token that decodes but names no real date is IGNORED, not fatal: that is
  // data-api's never-throw contract, and it means page 1.
  const cursorStart = cursorDay === null ? null : dayStartMs(cursorDay);
  if (cursorStart !== null) {
    observedEnd = Math.min(
      observedEnd ?? Infinity,
      cursorStart + MS_PER_DAY - 1,
    );
  }

  // A cursor page carries no offset, mirroring data-api.
  const paged = cursorStart !== null ? 0 : offset;
  const want = limit + paged + (cursorStart !== null ? CURSOR_DAY_SLACK : 0);

  const indexed = await loadIndexedAccountHistoryRows(
    env,
    addr,
    { netuid: nativeNetuid, observedStart, observedEnd },
    want,
  );
  if (indexed == null) return null;
  const rows = indexed;

  // Normalise the day to its published string form before anything compares it.
  const dated = rows
    .map((row) => ({ ...row, day: toDayString(row.day) }))
    .filter((row): row is Row & { day: string } => row.day !== null);

  // Apply the exact composite cursor: drop the cursor day's
  // already-seen subnets. `netuid DESC` means "seen" is >= the cursor's.
  const seeked =
    cursor && cursorDay !== null
      ? dated.filter(
          (row) =>
            row.day < cursorDay ||
            (safeBlockNumber(row.netuid) ?? -1) < cursor[1]!,
        )
      : dated;

  const page = (paged > 0 ? seeked.slice(paged) : seeked).slice(0, limit);
  const kinds = new Map(
    page.map((row) => [`${row.day}|${row.netuid}`, String(row.event_kinds)]),
  );

  const withKinds: Array<Row & { day: string }> = page.map((row) => ({
    ...row,
    event_kinds: kinds.get(`${row.day}|${row.netuid}`) ?? "",
  }));

  // Only a FULL page can have more behind it; a short one ends the series.
  const last =
    withKinds.length === limit ? withKinds[withKinds.length - 1] : null;
  const nextCursor = last
    ? encodeCursor([
        Number(String(last.day).replaceAll("-", "")),
        safeBlockNumber(last.netuid),
      ])
    : null;
  return buildAccountHistory(withKinds, ss58, { limit, offset, nextCursor });
}
