type Query = (
  sql: string,
  values?: unknown[],
) => Promise<Record<string, unknown>[]>;

export type DailySeriesTable = "neuron_daily" | "account_position_daily";

/** Count one date at a time: a complete membership scan can reset D1 and
 * discard unrelated queued writes. Empty documents cannot displace a real
 * day from the newest 90 populated days, so page their dates until full. */
export async function dailySeriesCountsD1(
  query: Query,
  table: DailySeriesTable,
  limit: number,
): Promise<Record<string, unknown>[]> {
  const result: Record<string, unknown>[] = [];
  let before = "9999-12-31";
  for (let page = 0; page < 128; page++) {
    const dates = await query(
      `SELECT day FROM ${table}_documents WHERE day < ?
       GROUP BY day ORDER BY day DESC LIMIT 32`,
      [before],
    );
    if (dates.length === 0) return result;
    for (const { day } of dates) {
      const rows = await query(
        `WITH member_counts AS MATERIALIZED (
          SELECT netuid, shard, COUNT(*) AS rows
          FROM ${table}_members WHERE snapshot_date = ?
          GROUP BY netuid, shard
        )
        SELECT ? AS date, SUM(m.rows) AS rows
        FROM member_counts m JOIN ${table}_documents d
          ON d.netuid=m.netuid AND d.day=? AND d.shard=m.shard
        HAVING SUM(m.rows)>0`,
        [day, day, day],
      );
      result.push(...rows);
      if (result.length >= limit) return result;
    }
    before = String(dates[dates.length - 1].day);
  }
  throw new Error("Daily coverage document dates exceed their query budget");
}
