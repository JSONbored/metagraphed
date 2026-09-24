// Frozen pre-retirement query oracle from 8e2cdd9b, executed only by SQLite tests.
import { safeBlockNumber, safeSs58Literal } from "../../src/history-readers.ts";
import type {
  HistoricalQueryReader,
  HistoryReadEnv,
} from "../../src/history-readers.ts";
import { offsetBeyondEmulationCap } from "../../src/cold-tier-offset.ts";
import {
  STAKE_ADDED_KIND,
  STAKE_REMOVED_KIND,
} from "../../src/account-stake-flow.ts";
import {
  buildValidatorNominators,
  DEFAULT_NOMINATOR_SORT,
  DEFAULT_NOMINATOR_WINDOW,
  NOMINATOR_SORTS,
  NOMINATOR_WINDOWS,
} from "../../src/validator-nominators.ts";
import type { ValidatorNominatorsQuery } from "../../src/account-feeds-cold-tier.ts";
function windowCutoff(
  windows: Record<string, number>,
  defaultLabel: string,
  label: string | null | undefined,
): { label: string; cutoff: number } {
  const resolved =
    label != null && Object.hasOwn(windows, label) ? label : defaultLabel;
  return { label: resolved, cutoff: Date.now() - windows[resolved] * DAY_MS };
}
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
const DAY_MS = 86400000;
const NOMINATOR_ORDER: Record<string, string> = {
  net_staked: "net_staked_tao DESC, coldkey ASC",
  gross_staked: "gross_staked_tao DESC, coldkey ASC",
  last_activity: "last_observed DESC, coldkey ASC",
};
export async function loadValidatorNominatorsColdTier(
  env: HistoryReadEnv | null | undefined,
  hotkey: string,
  query: ValidatorNominatorsQuery,
  queryFn: HistoricalQueryReader,
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
  if (!(NOMINATOR_SORTS as readonly string[]).includes(sort)) return null;

  const where = [
    `hotkey = '${addr}'`,
    `(event_kind = '${STAKE_ADDED_KIND}' OR event_kind = '${STAKE_REMOVED_KIND}')`,
  ];
  if (query.coldkey != null) {
    const nominator = safeSs58Literal(query.coldkey);
    if (nominator === null) return null;
    where.push(`coldkey = '${nominator}'`);
  }
  const { label, cutoff } = windowCutoff(
    NOMINATOR_WINDOWS,
    DEFAULT_NOMINATOR_WINDOW,
    query.window,
  );
  where.push(`observed_at >= ${cutoff}`);

  const rows = await queryFn(
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
  const countRows = await queryFn(
    env,
    `SELECT count(*) AS c FROM (SELECT coldkey FROM chain.account_events` +
      ` WHERE ${where.join(" AND ")} GROUP BY coldkey)`,
  );
  const counted = Number(countRows?.[0]?.c);
  const totalCount =
    countRows === null || !Number.isFinite(counted) ? null : counted;
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
