// Frozen pre-retirement query oracle from 8e2cdd9b. This test-only code
// runs against SQLite, independently of native tree selection and folding.
import {
  buildAccountHistory,
  type AccountHistoryResult,
} from "../../src/account-events.ts";
import { accountHistoryFloorMs } from "../../src/account-summary-projection.ts";
import { decodeCursor, encodeCursor } from "../../src/cursor.ts";
import { safeBlockNumber, safeSs58Literal } from "../../src/history-readers.ts";
import type { HistoricalQueryReader } from "../../src/history-readers.ts";
import type { HistoryReadEnv } from "../../src/history-readers.ts";

type Row = Record<string, unknown>;

const DAY = "date_trunc('day', to_timestamp(observed_at / 1000))";

const MS_PER_DAY = 86_400_000;

const CURSOR_DAY_SLACK = 512;

function toDayString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const day = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

function dayStartMs(day: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isSafeInteger(ms) ? ms : null;
}

export interface AccountHistoryQuery {
  limit: number;
  offset?: number | null;

  cursor?: unknown;
  netuid?: unknown;

  from?: string | null;
  to?: string | null;
}

export async function loadAccountHistoryColdTier(
  env: HistoryReadEnv | null | undefined,
  ss58: string,
  query: AccountHistoryQuery,
  { queryFn }: { queryFn: HistoricalQueryReader },
): Promise<AccountHistoryResult | null> {
  const addr = safeSs58Literal(ss58);
  if (addr === null) return null;

  const limit = safeBlockNumber(query.limit);
  const offset = safeBlockNumber(query.offset ?? 0);
  if (limit === null || offset === null || limit <= 0) return null;
  const where = [`hotkey = '${addr}'`, "netuid IS NOT NULL"];
  const historyFloorMs = await accountHistoryFloorMs(env, ss58);
  if (historyFloorMs !== null) {
    where.push(`observed_at >= ${Math.trunc(historyFloorMs)}`);
  }

  if (query.netuid != null) {
    const netuid = safeBlockNumber(query.netuid);
    if (netuid === null) return null;
    where.push(`netuid = ${netuid}`);
  }
  if (query.from != null) {
    const ms = dayStartMs(query.from);
    if (ms === null) return null;
    where.push(`observed_at >= ${ms}`);
  }
  if (query.to != null) {
    const ms = dayStartMs(query.to);
    if (ms === null) return null;
    where.push(`observed_at < ${ms + MS_PER_DAY}`);
  }
  const cursor = decodeCursor(query.cursor, 2);
  const cursorDay = cursor
    ? String(cursor[0]).replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3")
    : null;
  const cursorStart = cursorDay === null ? null : dayStartMs(cursorDay);
  if (cursorStart !== null) {
    where.push(`observed_at < ${cursorStart + MS_PER_DAY}`);
  }
  const paged = cursorStart !== null ? 0 : offset;
  const want = limit + paged + (cursorStart !== null ? CURSOR_DAY_SLACK : 0);

  const rows = await queryFn(
    env,
    `SELECT ${DAY} AS day, netuid, count(*) AS event_count,` +
      ` min(block_number) AS first_block, max(block_number) AS last_block` +
      ` FROM chain.account_events WHERE ${where.join(" AND ")}` +
      ` GROUP BY ${DAY}, netuid ORDER BY day DESC, netuid DESC LIMIT ${want}`,
  );
  if (rows === null) return null;
  const dated = rows
    .map((row) => ({ ...row, day: toDayString(row.day) }))
    .filter((row): row is Row & { day: string } => row.day !== null);
  const seeked =
    cursor && cursorDay !== null
      ? dated.filter(
          (row) =>
            row.day < cursorDay ||
            (safeBlockNumber(row.netuid) ?? -1) < cursor[1]!,
        )
      : dated;

  const page = (paged > 0 ? seeked.slice(paged) : seeked).slice(0, limit);
  const kinds = await loadKindsForPage(env, where, page, queryFn);
  if (kinds === null) return null;

  const withKinds: Array<Row & { day: string }> = page.map((row) => ({
    ...row,
    event_kinds: kinds.get(`${row.day}|${row.netuid}`) ?? "",
  }));
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

async function loadKindsForPage(
  env: HistoryReadEnv | null | undefined,
  where: string[],
  page: Array<Row & { day: string }>,
  queryFn: HistoricalQueryReader,
): Promise<Map<string, string> | null> {
  if (page.length === 0) return new Map();
  const newest = dayStartMs(page[0]!.day);
  const oldest = dayStartMs(page[page.length - 1]!.day);
  if (newest === null || oldest === null) return null;

  const rows = await queryFn(
    env,
    `SELECT ${DAY} AS day, netuid, event_kind FROM chain.account_events` +
      ` WHERE ${where.join(" AND ")}` +
      ` AND observed_at >= ${oldest} AND observed_at < ${newest + MS_PER_DAY}` +
      ` GROUP BY ${DAY}, netuid, event_kind`,
  );
  if (rows === null) return null;
  const out = new Map<string, string>();
  for (const row of rows) {
    const day = toDayString(row.day);
    const kind = row.event_kind;
    if (day === null || typeof kind !== "string" || kind.length === 0) continue;
    const key = `${day}|${row.netuid}`;
    const seen = out.get(key);
    out.set(key, seen ? `${seen},${kind}` : kind);
  }
  return out;
}
