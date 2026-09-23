import { z } from "zod";
const count = z.number().int().nonnegative();
const text = z.string().max(2048).nullable();
const stats = [count, count, z.number().int(), count] as const;
const Stats = z.tuple([...stats]);
const Day = z.strictObject({
  day: count,
  rows: count.positive(),
  first: count,
  last: count,
  totals: Stats,
  failover: count,
  cacheHits: count,
  endpoints: z.array(z.tuple([text, text, text, ...stats])).max(65_536),
  hours: z.array(z.tuple([count, ...stats])).max(24),
  latencies: z
    .array(z.tuple([z.number().int(), count.positive()]))
    .max(100_000),
});
export type NativeRpcDay = z.infer<typeof Day>;
export type NativeRpcStats = z.infer<typeof Stats>;

/** Validate all additive censuses before any aggregate enters an answer. */
export function validateNativeRpcDay(
  value: unknown,
  expected: { day: number; rows: number; first: number; last: number },
): NativeRpcDay {
  const day = Day.parse(value);
  if (
    day.day !== expected.day ||
    day.rows !== expected.rows ||
    day.first !== expected.first ||
    day.last !== expected.last ||
    day.totals[0] < day.rows ||
    day.totals[1] > day.totals[0] ||
    day.failover > day.totals[0] ||
    day.cacheHits > day.totals[0] ||
    day.totals[3] > day.totals[0]
  )
    throw Error("RPC daily census mismatch");
  for (let column = 0; column < 4; column++) {
    if (
      day.endpoints.reduce((n, row) => n + Number(row[column + 3]), 0) !==
        day.totals[column] ||
      day.hours.reduce((n, row) => n + row[column + 1], 0) !==
        day.totals[column]
    )
      throw Error("RPC daily breakdown census mismatch");
  }
  if (
    day.hours.some(
      (row) =>
        row[0] % 3_600_000 !== 0 || Math.floor(row[0] / 86_400_000) !== day.day,
    ) ||
    day.latencies.reduce((n, row) => n + row[1], 0) !== day.totals[3] ||
    day.latencies.reduce((n, row) => n + row[0] * row[1], 0) !== day.totals[2]
  )
    throw Error("RPC daily latency or time census mismatch");
  return day;
}
