import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { qualifyAccountFeed } from "../scripts/qualify-account-feed.ts";
import type { HistoryAccountFeed } from "../schemas-src/artifacts/history-account-feed.ts";
import type { AccountEventsRow } from "../generated/lakehouse/types.ts";
import {
  iterateAccountFeed,
  mergeAccountFeedPage,
  validateAccountFeed,
  type AccountFeedSelector,
  type IndexedAccountFeedEntry,
} from "../src/history-account-feed.ts";
import {
  parquetReadBudget,
  type ParquetRangeSource,
} from "../src/indexed-parquet.ts";

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/account-feeds/native-tree.json", import.meta.url),
    "utf8",
  ),
) as {
  manifest: unknown;
  selection: HistoryAccountFeed["selection"];
  rows: AccountEventsRow[];
  objects: Record<string, { etag: string; base64: string }>;
};
const original = validateAccountFeed(fixture.manifest, fixture.selection);
const buffer = (raw: Uint8Array) => Uint8Array.from(raw).buffer;
const source: ParquetRangeSource = {
  async read(key, etag, offset, length) {
    const object = fixture.objects[key];
    expect(object.etag).toBe(etag);
    const raw = Buffer.from(object.base64, "base64");
    expect(offset + length).toBeLessThanOrEqual(raw.length);
    return buffer(raw.subarray(offset, offset + length));
  },
};
const expected = (
  side: "hotkey" | "coldkey" | "both" | "all",
  account: string,
  kind: string | null,
  netuid: number | null,
) =>
  fixture.rows
    .filter(
      (row) =>
        (side === "all" ||
          (side === "both"
            ? row.hotkey === account || row.coldkey === account
            : row[side] === account)) &&
        (kind === null || row.event_kind === kind) &&
        (netuid === null || row.netuid === netuid),
    )
    .sort(
      (a, b) =>
        b.observed_at! - a.observed_at! ||
        b.block_number! - a.block_number! ||
        b.event_index! - a.event_index!,
    );

function single(
  lines: string[],
  change: Partial<HistoryAccountFeed> = {},
  newline = true,
) {
  const raw = Buffer.from(lines.join("\n") + (newline ? "\n" : ""));
  const compressed = gzipSync(raw);
  const base = original.plan.key.replace(/plan.json$/, "");
  const rows = lines.map((line) => JSON.parse(line.slice(167)) as unknown[]);
  const obj = {
    key: base + "0/packs/" + "a".repeat(64) + ".bin",
    etag: "etag",
    bytes: compressed.length,
  };
  const feed = structuredClone(original);
  feed.rows = feed.entries = lines.length;
  feed.root = {
    object: obj,
    first: lines[0].slice(0, 166),
    last: lines.at(-1)!.slice(0, 166),
    rows: lines.length,
    height: 0,
    minBlock: Math.min(...rows.map((r) => Number(r[0]))),
    maxBlock: Math.max(...rows.map((r) => Number(r[0]))),
    offset: 0,
    length: compressed.length,
    decodedBytes: raw.length,
  };
  Object.assign(feed, change);
  return {
    feed,
    source: {
      async read(_key: string, _etag: string, offset: number, length: number) {
        return buffer(compressed.subarray(offset, offset + length));
      },
    },
  };
}
const values = [
  1,
  0,
  null,
  "Transfer",
  "account-0",
  "account-1",
  null,
  2,
  1.5,
  null,
  10000,
];
const hash = (selector: AccountFeedSelector) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        selector.side,
        selector.account,
        selector.kind ?? null,
        selector.netuid ?? null,
      ]),
    )
    .digest("hex");
const selector: AccountFeedSelector = { side: "hotkey", account: "account-0" };
const order = (n: number, maximum: number, width: number) =>
  (maximum - n).toString(16).padStart(width, "0");
const token =
  hash(selector) +
  order(10000, Number.MAX_SAFE_INTEGER, 14) +
  order(1, 0xffffffff, 8) +
  order(0, 0xffffffff, 8) +
  "b".repeat(64) +
  "00000000";
const line = (row = values, key = token) => key + "\t" + JSON.stringify(row);
async function readAll(
  feed = original,
  input = selector,
  store = source,
  budget = parquetReadBudget(24 * 1024 * 1024, 128),
) {
  return mergeAccountFeedPage(
    [iterateAccountFeed(store, feed, input, budget)],
    5001,
  );
}

describe("native Python account feed tree", () => {
  it("matches independent filtering and stable ordering over complete native Parquet captures", async () => {
    for (const side of ["hotkey", "coldkey", "both", "all"] as const) {
      for (const account of ["account-0", "account-4", "absent"]) {
        for (const kind of [null, "Transfer", "Absent"]) {
          for (const netuid of [null, 0, 9]) {
            const sides =
              side === "both" ? (["hotkey", "coldkey"] as const) : [side];
            const budget = parquetReadBudget(24 * 1024 * 1024, 128);
            const streams = sides.map((s) =>
              iterateAccountFeed(
                source,
                original,
                { side: s, account: s === "all" ? "*" : account, kind, netuid },
                budget,
              ),
            );
            const rows = await mergeAccountFeedPage(streams, 5001);
            expect(rows).toEqual(expected(side, account, kind, netuid));
            expect(budget.requests).toBeLessThanOrEqual(128);
            expect(budget.bytes).toBeLessThan(24 * 1024 * 1024);
          }
        }
      }
    }
  });

  it("preserves offsets, strict tuple cursors, block bounds, and repeated physical captures", async () => {
    const rows = expected("both", "account-0", null, null);
    const make = (query: Partial<AccountFeedSelector> = {}) =>
      ["hotkey", "coldkey"].map((side) =>
        iterateAccountFeed(
          source,
          original,
          { ...selector, side: side as "hotkey" | "coldkey", ...query },
          parquetReadBudget(),
        ),
      );
    expect(await mergeAccountFeedPage(make(), 7, 3)).toEqual(rows.slice(3, 10));
    expect(await mergeAccountFeedPage(make(), 1)).toEqual(rows.slice(0, 1));
    const cursor: [number, number, number] = [
      rows[0].observed_at!,
      rows[0].block_number!,
      rows[0].event_index!,
    ];
    const after = rows.filter(
      (row) =>
        row.observed_at! < cursor[0] ||
        (row.observed_at === cursor[0] &&
          (row.block_number! < cursor[1] ||
            (row.block_number === cursor[1] && row.event_index! < cursor[2]))),
    );
    expect(await mergeAccountFeedPage(make({ cursor }), 100)).toEqual(after);
    expect(
      await mergeAccountFeedPage(make({ blockStart: 2, blockEnd: 4 }), 100),
    ).toEqual(rows.filter((r) => r.block_number! >= 2 && r.block_number! <= 4));
    expect(
      await mergeAccountFeedPage(make({ blockStart: 4, blockEnd: 2 }), 100),
    ).toEqual([]);
    expect(await mergeAccountFeedPage(make({ blockStart: 100 }), 100)).toEqual(
      [],
    );
  });

  it("refuses scope, source identity, census, unsafe paths, and unsupported encodings", () => {
    const changes: Partial<HistoryAccountFeed>[] = [
      { generation: "c".repeat(64) },
      { network: "testnet" },
      { entries: 0 },
      { rows: 0 },
      { plan: { ...original.plan, key: "foreign" } },
      { plan: { ...original.plan, bytes: 33 * 1024 * 1024 } },
      { selection: { ...original.selection, network: "testnet" } },
      { selection: { ...original.selection, generation: "e".repeat(64) } },
      { selection: { ...original.selection, firstBlock: 5 } },
      { selection: { ...original.selection, lastBlock: 0 } },
      ...["key", "etag", "bytes"].map((key) => ({
        selection: {
          ...original.selection,
          blockManifest: {
            ...original.selection.blockManifest,
            [key]: key === "bytes" ? 1 : "changed",
          },
        },
      })),
    ];
    for (const change of changes)
      expect(() =>
        validateAccountFeed({ ...original, ...change }, fixture.selection),
      ).toThrow();
    expect(() =>
      validateAccountFeed(
        { ...original, encoding: "other" },
        fixture.selection,
      ),
    ).toThrow();
    for (const change of [
      { first: "f".repeat(166), last: "0".repeat(166) },
      { minBlock: 10, maxBlock: 2 },
      { maxBlock: 1000 },
      { object: { ...original.root!.object, key: "foreign" } },
      { object: { ...original.root!.object, key: original.plan.key } },
      { object: { ...original.root!.object, bytes: 129 * 1024 } },
    ])
      expect(() =>
        validateAccountFeed(
          { ...original, root: { ...original.root!, ...change } },
          fixture.selection,
        ),
      ).toThrow();
    expect(
      validateAccountFeed(
        { ...original, rows: 0, entries: 0, root: null },
        fixture.selection,
      ).root,
    ).toBeNull();
  });

  it("rejects malformed directory bounds before yielding rows", async () => {
    for (const mutate of [
      (node: { children: Record<string, unknown>[] }) => {
        node.children[0].rows = 999;
      },
      (node: { children: Record<string, unknown>[] }) => {
        node.children[0].first = "0".repeat(166);
      },
      (node: { children: Record<string, unknown>[] }) => {
        node.children.at(-1)!.last = "f".repeat(166);
      },
      (node: { children: Record<string, unknown>[] }) => {
        node.children[0].height = 16;
      },
      (node: { children: Record<string, unknown>[] }) => {
        node.children.forEach((child) => {
          child.minBlock = 4;
        });
      },
      (node: { children: Record<string, unknown>[] }) => {
        node.children[0].maxBlock = 10;
      },
      (node: { children: Record<string, unknown>[] }) => {
        node.children.reverse();
      },
    ]) {
      const object = fixture.objects[original.root!.object.key];
      const node = JSON.parse(Buffer.from(object.base64, "base64").toString());
      mutate(node);
      const raw = Buffer.from(JSON.stringify(node));
      const feed = structuredClone(original);
      feed.root!.object.bytes = raw.length;
      const changed: ParquetRangeSource = {
        async read(key, etag, offset, length) {
          return key === feed.root!.object.key
            ? buffer(raw)
            : source.read(key, etag, offset, length);
        },
      };
      await expect(readAll(feed, selector, changed)).rejects.toThrow();
    }
  });

  it("fully validates gzip records, row tokens, selectors, ordering, and complete page census", async () => {
    const valid = single([line()]);
    expect(await readAll(valid.feed, selector, valid.source)).toEqual([
      Object.fromEntries(
        [
          "block_number",
          "event_index",
          "extrinsic_index",
          "event_kind",
          "hotkey",
          "coldkey",
          "netuid",
          "uid",
          "amount_tao",
          "alpha_amount",
          "observed_at",
        ].map((key, i) => [key, values[i]]),
      ),
    ]);
    for (const bad of [
      line([...values.slice(0, 10), null]),
      line([2, ...values.slice(1)]),
      line(values.slice(0, 10)),
      line(values, "x" + token.slice(1)),
      line(values).replace("\t", " "),
      line([1, 0, null, "Transfer", "different", ...values.slice(5)]),
      line(values, hash({ ...selector, kind: "StakeAdded" }) + token.slice(64)),
      line(values, hash({ ...selector, netuid: 9 }) + token.slice(64)),
    ]) {
      const input = bad.includes(hash({ ...selector, kind: "StakeAdded" }))
        ? { ...selector, kind: "StakeAdded" }
        : bad.includes(hash({ ...selector, netuid: 9 }))
          ? { ...selector, netuid: 9 }
          : selector;
      const test = single([bad]);
      if (bad.startsWith("x")) {
        test.feed.root!.first = token;
        test.feed.root!.last = token;
      }
      await expect(readAll(test.feed, input, test.source)).rejects.toThrow();
    }
    for (const change of [
      { rows: 2 },
      { decodedBytes: 1 },
      { decodedBytes: 9999 },
      { first: "0".repeat(166) },
      { last: "f".repeat(166) },
      { minBlock: 0 },
      { maxBlock: 2 },
    ]) {
      const test = single([line()]);
      Object.assign(test.feed.root!, change);
      await expect(readAll(test.feed, selector, test.source)).rejects.toThrow();
    }
    const duplicate = single([line(), line()]);
    await expect(
      readAll(duplicate.feed, selector, duplicate.source),
    ).rejects.toThrow();
    const corrupt: ParquetRangeSource = {
      async read(_key, _etag, _offset, length) {
        return new ArrayBuffer(length);
      },
    };
    await expect(readAll(valid.feed, selector, corrupt)).rejects.toThrow();
  });

  it("filters adjacent keys and within-page cursor ties without losing older rows", async () => {
    const otherKey =
      hash(selector).slice(0, 63) + (hash(selector).endsWith("f") ? "0" : "f");
    const mixed = single(
      [line(), line(values, otherKey + token.slice(64))].sort(),
    );
    expect(await readAll(mixed.feed, selector, mixed.source)).toHaveLength(1);
    const olderValues = [...values.slice(0, 10), 9999];
    const olderToken =
      token.slice(0, 64) +
      order(9999, Number.MAX_SAFE_INTEGER, 14) +
      token.slice(78);
    const timed = single([line(), line(olderValues, olderToken)]);
    expect(
      await readAll(
        timed.feed,
        { ...selector, cursor: [10000, 1, 0] },
        timed.source,
      ),
    ).toHaveLength(1);
    const truncated = single([line()], {}, false);
    await expect(
      readAll(truncated.feed, selector, truncated.source),
    ).rejects.toThrow("Truncated history feed record");
  });

  it("seeks exact transfer relationships in both directions without scanning unrelated accounts", async () => {
    for (const counterparty of ["account-1", "account-2", "absent"]) {
      const streams = (["hotkey", "coldkey"] as const).map((side) =>
        iterateAccountFeed(
          source,
          original,
          { side, account: "account-0", kind: "Transfer", counterparty },
          parquetReadBudget(),
        ),
      );
      const rows = expected("both", "account-0", "Transfer", null).filter(
        (row) =>
          (row.hotkey === "account-0" && row.coldkey === counterparty) ||
          (row.coldkey === "account-0" && row.hotkey === counterparty),
      );
      expect(await mergeAccountFeedPage(streams, 100)).toEqual(rows);
    }
    const pair: AccountFeedSelector = {
      ...selector,
      kind: "Transfer",
      counterparty: "account-1",
    };
    for (const change of [
      { counterparty: "" },
      { counterparty: "a:b" },
      { account: "a:b" },
      { side: "all" as const, account: "*" },
      { kind: "StakeAdded" },
      { netuid: 0 },
    ])
      await expect(readAll(original, { ...pair, ...change })).rejects.toThrow(
        "relationship selector",
      );
    for (const side of ["hotkey", "coldkey"] as const) {
      const pairKey = createHash("sha256")
        .update(
          JSON.stringify([
            "pair",
            side === "hotkey" ? "account-0:account-1" : "account-1:account-0",
            "Transfer",
            null,
          ]),
        )
        .digest("hex");
      const row =
        side === "hotkey"
          ? [...values.slice(0, 5), "different", ...values.slice(6)]
          : [
              ...values.slice(0, 4),
              "different",
              "account-0",
              ...values.slice(6),
            ];
      const test = single([line(row, pairKey + token.slice(64))]);
      await expect(
        readAll(test.feed, { ...pair, side }, test.source),
      ).rejects.toThrow("selector");
    }
  });

  it("qualifies pinned native object bytes through the standalone producer boundary", async () => {
    const input = {
      manifest: fixture.manifest,
      selection: fixture.selection,
      objects: fixture.objects,
      queries: [
        {
          selectors: [selector, { ...selector, side: "coldkey" }],
          limit: 7,
          offset: 2,
          expected: expected("both", "account-0", null, null).slice(2, 9),
        },
      ],
    };
    const proof = await qualifyAccountFeed(input);
    expect(proof.queries[0].rows).toBe(7);
    expect(proof.rows).toBe(fixture.rows.length);
    await expect(
      qualifyAccountFeed({
        ...input,
        queries: [{ ...input.queries[0], expected: [] }],
      }),
    ).rejects.toThrow("parity failed");
    const changed = structuredClone(input);
    Object.values(changed.objects)[0].etag = "changed";
    await expect(qualifyAccountFeed(changed)).rejects.toThrow(
      "identity mismatch",
    );
    await expect(qualifyAccountFeed({ ...input, objects: {} })).rejects.toThrow(
      "range identity",
    );
  });

  it("enforces aggregate read, decoded, selector, and pagination budgets without partial success", async () => {
    await expect(
      readAll(original, selector, source, parquetReadBudget(1, 1)),
    ).rejects.toThrow("budget");
    const test = single([line()]);
    const budget = parquetReadBudget();
    budget.decodedBytes = budget.maxBytes * 4;
    await expect(
      readAll(test.feed, selector, test.source, budget),
    ).rejects.toThrow("budget");
    for (const change of [
      { account: "" },
      { side: "all" as const },
      { kind: "" },
      { netuid: -1 },
      { cursor: [-1, 0, 0] as [number, number, number] },
      { blockStart: -1 },
    ])
      await expect(
        readAll(original, { ...selector, ...change }),
      ).rejects.toThrow();
    for (const [limit, offset] of [
      [0, 0],
      [5002, 0],
      [1, -1],
      [1, 5001],
    ])
      await expect(mergeAccountFeedPage([], limit, offset)).rejects.toThrow(
        "budget",
      );
    expect(await readAll({ ...original, root: null })).toEqual([]);
    let closed = 0;
    async function* fails(): AsyncGenerator<IndexedAccountFeedEntry> {
      yield await Promise.reject<IndexedAccountFeedEntry>(
        new Error("range failed"),
      );
    }
    async function* sibling(): AsyncGenerator<IndexedAccountFeedEntry> {
      try {
        yield { token, row: fixture.rows[0] };
      } finally {
        closed++;
      }
    }
    await expect(mergeAccountFeedPage([fails(), sibling()], 1)).rejects.toThrow(
      "range failed",
    );
    expect(closed).toBe(1);
    await expect(
      mergeAccountFeedPage(
        Array.from({ length: 11 }, () => sibling()),
        1,
      ),
    ).rejects.toThrow("budget");
  });
});
