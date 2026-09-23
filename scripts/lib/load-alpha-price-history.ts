/** Recent alpha-price history for the artifact bake, read from the same
 * protected D1 export protocol as the archive producers (#12199). Missing
 * credentials are the ordinary local-build case; failed or mixed snapshots
 * decline as a whole. No database URL or Cloudflare management token is used.
 */
import { z } from "zod";
import { indexAlphaPriceHistoryByNetuid } from "../../src/alpha-price-change.ts";

export const ALPHA_PRICE_HISTORY_LOOKBACK_DAYS = 40;
export interface AlphaPriceHistoryEnv {
  STATE_EXPORT_URL?: string;
  STATE_EXPORT_SECRET?: string;
  [key: string]: string | undefined;
}

export function alphaPriceHistoryCutoff(
  lookbackDays: number = ALPHA_PRICE_HISTORY_LOOKBACK_DAYS,
  now: () => number = Date.now,
): string {
  const cutoff = now() - Math.trunc(lookbackDays) * 86_400_000;
  return new Date(cutoff).toISOString().slice(0, 10);
}

export function alphaPriceHistoryQuery(
  lookbackDays: number = ALPHA_PRICE_HISTORY_LOOKBACK_DAYS,
  now: () => number = Date.now,
): string {
  return (
    // captured_at is load-bearing, not decoration (#9449): a snapshot row is
    // upserted repeatedly through its own day, so `snapshot_date` says WHICH
    // day a row belongs to and nothing at all about how far apart two rows
    // actually are. Two consecutive dates were measured one hour apart.
    "SELECT netuid, snapshot_date, alpha_price_tao, captured_at " +
    "FROM subnet_snapshots " +
    `WHERE snapshot_date >= '${alphaPriceHistoryCutoff(lookbackDays, now)}' ` +
    "ORDER BY netuid ASC, snapshot_date ASC"
  );
}

const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const keySchema = z.tuple([daySchema, z.number().int().safe()]);
const revisionSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative().safe(),
});
const pageSchema = revisionSchema.extend({
  rows: z
    .array(
      z.tuple([
        z.number().int().nonnegative().safe(),
        daySchema,
        z.number().finite().nullable(),
        z.number().int().nonnegative().safe().nullable(),
      ]),
    )
    .max(2000),
  next_cursor: keySchema.nullable(),
});
const MAX_PAGE_BYTES = 512 * 1024;
const MAX_ROWS = 20000;
class SnapshotChanged extends Error {}

async function exportReply(response: Response): Promise<unknown> {
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 409) throw new SnapshotChanged();
    throw new Error("Export request failed");
  }
  if (!response.body) throw new Error("Export body absent");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let bytes = 0,
    text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_PAGE_BYTES) {
        await reader.cancel();
        throw new Error("Export page exceeds byte budget");
      }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    reader.releaseLock();
  }
}

export async function loadAlphaPriceHistoryByNetuid(
  env: AlphaPriceHistoryEnv = process.env,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<ReturnType<typeof indexAlphaPriceHistoryByNetuid> | null> {
  if (!env.STATE_EXPORT_URL || !env.STATE_EXPORT_SECRET) return null;
  try {
    const url = new URL(env.STATE_EXPORT_URL);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("Invalid export URL");
    const signal = AbortSignal.timeout(30000);
    const request = async (payload: Record<string, unknown>) =>
      exportReply(
        await fetchImpl(url, {
          method: "POST",
          redirect: "error",
          signal,
          headers: {
            "content-type": "application/json",
            "accept-encoding": "gzip",
            "x-state-export-token": env.STATE_EXPORT_SECRET!,
          },
          body: JSON.stringify({ table: "subnet_snapshots", ...payload }),
        }),
      );
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const { revision } = revisionSchema.parse(
          await request({ kind: "revision" }),
        );
        let cursor: [string, number] = [
          alphaPriceHistoryCutoff(undefined, now),
          -1,
        ];
        const rows: Record<string, unknown>[] = [];
        for (let page = 0; page < 11; page++) {
          const result = pageSchema.parse(
            await request({
              kind: "rows",
              columns: [
                "netuid",
                "snapshot_date",
                "alpha_price_tao",
                "captured_at",
              ],
              cursor,
              revision,
            }),
          );
          if (result.revision !== revision) throw new SnapshotChanged();
          let last = cursor;
          for (const [
            netuid,
            snapshot_date,
            alpha_price_tao,
            captured_at,
          ] of result.rows) {
            if (
              snapshot_date < last[0] ||
              (snapshot_date === last[0] && netuid <= last[1])
            )
              throw new Error("Export keys did not advance");
            rows.push({ netuid, snapshot_date, alpha_price_tao, captured_at });
            last = [snapshot_date, netuid];
          }
          if (rows.length > MAX_ROWS)
            throw new Error("Export row budget exceeded");
          if (result.next_cursor === null) {
            const end = revisionSchema.parse(
              await request({ kind: "revision", revision }),
            );
            if (end.revision !== revision) throw new SnapshotChanged();
            return indexAlphaPriceHistoryByNetuid(rows);
          }
          if (
            !result.rows.length ||
            JSON.stringify(result.next_cursor) !== JSON.stringify(last)
          )
            throw new Error("Export cursor does not match its page");
          cursor = result.next_cursor;
        }
        throw new Error("Export page budget exceeded");
      } catch (error) {
        if (!(error instanceof SnapshotChanged) || attempt === 2) throw error;
      }
    }
  } catch {
    // Do not log response bodies or credential-bearing transport exceptions.
    console.warn(
      "::warning::D1 alpha-price history unavailable; economics bake continues with null change fields.",
    );
  }
  return null;
}
