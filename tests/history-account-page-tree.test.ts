import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { qualifyAccountFeed } from "../scripts/qualify-account-feed.ts";
import {
  iterateAccountFeed,
  mergeAccountFeedPage,
  validateAccountFeed,
  type AccountFeedSelector,
} from "../src/history-account-feed.ts";
import { parquetReadBudget } from "../src/indexed-parquet.ts";
import type { HistoryAccountFeed } from "../schemas-src/artifacts/history-account-feed.ts";
import type { AccountEventsRow } from "../generated/lakehouse/types.ts";

function fixture(name: string) {
  const data = JSON.parse(
    readFileSync(
      new URL(`./fixtures/account-feeds/${name}.json`, import.meta.url),
      "utf8",
    ),
  ) as {
    manifest: unknown;
    selection: HistoryAccountFeed["selection"];
    rows: AccountEventsRow[];
    objects: Record<string, { etag: string; base64: string }>;
  };
  const feed = validateAccountFeed(data.manifest, data.selection);
  const source = {
    async read(key: string, etag: string, offset: number, length: number) {
      const object = data.objects[key];
      expect(object.etag).toBe(etag);
      const bytes = Buffer.from(object.base64, "base64");
      expect(offset + length).toBeLessThanOrEqual(bytes.length);
      return Uint8Array.from(bytes.subarray(offset, offset + length)).buffer;
    },
  };
  return {
    data,
    feed,
    source,
    async query(selectors: AccountFeedSelector[], limit = 5001, offset = 0) {
      const budget = parquetReadBudget();
      const rows = await mergeAccountFeedPage(
        selectors.map((selector) =>
          iterateAccountFeed(source, feed, selector, budget),
        ),
        limit,
        offset,
      );
      expect(budget.requests).toBeLessThanOrEqual(budget.maxRequests);
      return rows;
    },
  };
}
const legacy = fixture("native-tree");
const compact = fixture("compact-tree");

describe("mixed legacy and compact account trees", () => {
  it("preserves every selector, physical duplicate, offset and cursor", async () => {
    for (const side of ["hotkey", "coldkey", "all", "both"] as const)
      for (const account of ["account-0", "account-4", "absent"])
        for (const kind of [null, "Transfer", "Absent"])
          for (const netuid of [null, 0, 9]) {
            const selectors = (
              side === "both" ? (["hotkey", "coldkey"] as const) : [side]
            ).map((side) => ({
              side,
              account: side === "all" ? "*" : account,
              kind,
              netuid,
            }));
            const rows = await legacy.query(selectors);
            expect(await compact.query(selectors)).toEqual(rows);
            expect(await compact.query(selectors, 7, 3)).toEqual(
              rows.slice(3, 10),
            );
          }
    const selectors: AccountFeedSelector[] = [
      { side: "hotkey", account: "account-0" },
      { side: "coldkey", account: "account-0" },
    ];
    for (const bounds of [
      { blockStart: 2, blockEnd: 4 },
      { observedStart: 10000, observedEnd: 10002 },
      { cursor: [10002, 3, 1] as [number, number, number] },
      { kind: "Transfer", counterparty: "account-1" },
    ]) {
      const query = selectors.map((selector) => ({ ...selector, ...bounds }));
      expect(await compact.query(query)).toEqual(await legacy.query(query));
    }
  });

  it("qualifies Python-produced pages at the producer's public reader boundary", async () => {
    const selectors: AccountFeedSelector[] = [{ side: "all", account: "*" }];
    const { manifest, selection, objects } = compact.data;
    const proof = await qualifyAccountFeed({
      manifest,
      selection,
      objects,
      queries: [
        {
          selectors,
          limit: 17,
          offset: 2,
          expected: await legacy.query(selectors, 17, 2),
        },
      ],
    });
    expect(proof.rows).toBe(compact.data.rows.length);
  });

  it("requires explicit format opt-in before accepting binary pages", async () => {
    const feed = { ...compact.feed, encoding: "jsonl-gzip-v1" as const };
    await expect(
      mergeAccountFeedPage(
        [
          iterateAccountFeed(
            compact.source,
            feed,
            { side: "all", account: "*" },
            parquetReadBudget(),
          ),
        ],
        5001,
      ),
    ).rejects.toThrow();
  });
});
