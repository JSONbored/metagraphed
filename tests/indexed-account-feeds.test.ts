import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import {
  loadIndexedAccountFeedPage,
  loadIndexedAccountFeedGroups,
} from "../src/indexed-account-feeds.ts";
import { ACCOUNT_EVENTS_COLUMNS } from "../generated/lakehouse/types.ts";
import type { AccountFeedGroup } from "../src/history-account-feed-groups.ts";
import type { HistoryAccountFeed } from "../schemas-src/artifacts/history-account-feed.ts";
import type { AccountEventsRow } from "../generated/lakehouse/types.ts";
import { currentIndexedHistoryFailureGeneration } from "../src/indexed-history-status.ts";

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/account-feeds/native-tree.json", import.meta.url),
    "utf8",
  ),
) as {
  manifest: HistoryAccountFeed;
  selection: HistoryAccountFeed["selection"];
  rows: AccountEventsRow[];
  objects: Record<string, { etag: string; base64: string }>;
};
const selectors = ["hotkey", "coldkey"].map((side) => ({
  side: side as "hotkey" | "coldkey",
  account: "account-0",
}));

function archive(network: "mainnet" | "testnet" = "mainnet") {
  const feed = structuredClone(fixture.manifest);
  const selected = structuredClone(fixture.selection);
  const base = `metagraph/indexed-history/v1/${network}/account_events`;
  const root = `${base}/generations/${selected.generation}`;
  selected.network = feed.network = network;
  selected.blockManifest.key = `${root}/block-manifest.json`;
  feed.plan.key = `${root}/accounts/v1/plan.json`;
  if (network === "testnet") {
    selected.firstBlock = 7700000;
    selected.lastBlock = 7700084;
    feed.rows = feed.entries = 0;
    feed.root = null;
  }
  const objects = new Map(
    Object.entries(fixture.objects).map(([key, value]) => [
      key,
      {
        raw: Buffer.from(value.base64, "base64"),
        etag: value.etag,
      },
    ]),
  );
  const put = (key: string, value: unknown) => {
    const raw = Buffer.from(JSON.stringify(value));
    const etag = createHash("md5").update(raw).digest("hex");
    objects.set(key, { raw, etag });
    return { key, etag, bytes: raw.length };
  };
  selected.blockManifest = put(selected.blockManifest.key, {
    version: 1,
    network,
    table: "account_events",
    generation: selected.generation,
    state: "complete",
    sourceSnapshot: feed.sourceSnapshot,
    rows: feed.rows,
    files: feed.rows
      ? [
          {
            key: `${root}/files/00000.json`,
            etag: "source",
            bytes: 1,
            rows: feed.rows,
          },
        ]
      : [],
    blockIndex: { key: `${root}/blocks/index.json`, etag: "index", bytes: 1 },
  });
  feed.selection = selected;
  const pointer = `${base}/current.json`,
    manifest = `${root}/accounts/v1/manifest.json`;
  const ceilingKey = `${base}/source-ceiling.json`;
  const ceiling = {
    version: 1,
    network,
    table: "account_events",
    through: selected.lastBlock,
    revision: "a".repeat(32),
  };
  const save = () => {
    put(pointer, { version: 1, ...selected });
    put(manifest, feed);
    put(ceilingKey, ceiling);
  };
  save();
  const sizes = new Map<string, number>();
  const counts = new Map<string, number>();
  let onGet: ((key: string, count: number) => void) | undefined;
  const get = vi.fn(async (key: string, options?: R2GetOptions) => {
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    onGet?.(key, count);
    const object = objects.get(key);
    if (!object) return null;
    const range =
      options?.range && "offset" in options.range ? options.range : undefined;
    const offset = range?.offset ?? 0,
      length = range?.length ?? object.raw.length;
    return {
      etag: object.etag,
      size: sizes.get(key) ?? object.raw.length,
      range: { offset, length },
      body: new Response(object.raw.subarray(offset, offset + length)).body,
      json: async () => JSON.parse(object.raw.toString()),
    };
  });
  return {
    env: { METAGRAPH_ARCHIVE: { get } },
    get,
    objects,
    put,
    sizes,
    feed,
    selected,
    ceiling,
    pointer,
    manifest,
    ceilingKey,
    save,
    intercept(fn: (key: string, count: number) => void) {
      onGet = fn;
    },
  };
}

describe("selected account feed serving", () => {
  it("folds complete native windows with SQLite aggregate parity and inclusive time boundaries", async () => {
    const runtime = new Miniflare({
      modules: true,
      script: "export default {fetch(){return new Response('test')}}",
      compatibilityDate: "2026-06-06",
      d1Databases: ["DB"],
    });
    try {
      const db = await runtime.getD1Database("DB");
      await db
        .prepare(
          `CREATE TABLE events(${ACCOUNT_EVENTS_COLUMNS.map((name) => `${name} ${["event_kind", "hotkey", "coldkey"].includes(name) ? "TEXT" : "NUMERIC"}`).join(",")})`,
        )
        .run();
      await db.batch(
        fixture.rows.map((row) =>
          db
            .prepare(
              `INSERT INTO events VALUES(${ACCOUNT_EVENTS_COLUMNS.map(() => "?").join(",")})`,
            )
            .bind(...ACCOUNT_EVENTS_COLUMNS.map((column) => row[column])),
        ),
      );
      const order = <T extends { event_kind: unknown; netuid: unknown }>(
        rows: T[],
      ) =>
        rows.sort((a, b) =>
          JSON.stringify([a.event_kind, a.netuid]).localeCompare(
            JSON.stringify([b.event_kind, b.netuid]),
          ),
        );
      for (const [start, end] of [
        [0, 10000],
        [9910, 9970],
        [9999, 10000],
        [10000, 10000],
        [10001, 11000],
      ]) {
        const a = archive();
        const wanted = ["StakeAdded", "Transfer"].flatMap((kind) =>
          selectors.map((selector) => ({
            ...selector,
            kind,
            observedStart: start,
            observedEnd: end,
          })),
        );
        const indexed = await loadIndexedAccountFeedGroups(a.env, wanted);
        const expected = await db
          .prepare(
            `SELECT event_kind,netuid,COUNT(*) AS event_count,SUM(amount_tao) AS total_tao,SUM(alpha_amount) AS total_alpha,
          MIN(block_number) AS first_block,MAX(block_number) AS last_block,MIN(observed_at) AS first_observed,MAX(observed_at) AS last_observed
          FROM events WHERE (hotkey=? OR coldkey=?) AND observed_at>=? AND observed_at<=? GROUP BY event_kind,netuid`,
          )
          .bind("account-0", "account-0", start, end)
          .all<AccountFeedGroup>();
        expect(indexed).not.toBeNull();
        expect(order(indexed!)).toEqual(order(expected.results));
        expect(
          a.get.mock.calls.filter(([key]) => key.endsWith(".bin")).length,
        ).toBeLessThan(8);
      }
      const a = archive();
      const expected = fixture.rows
        .filter(
          (row) => row.hotkey === "account-0" || row.coldkey === "account-0",
        )
        .sort(
          (a, b) =>
            b.observed_at! - a.observed_at! ||
            b.block_number! - a.block_number! ||
            b.event_index! - a.event_index!,
        );
      const cursor = expected[3];
      const selected = selectors.map((s) => ({
        ...s,
        observedStart: 9950,
        observedEnd: 9995,
        cursor: [
          cursor.observed_at!,
          cursor.block_number!,
          cursor.event_index!,
        ] as [number, number, number],
      }));
      expect(await loadIndexedAccountFeedPage(a.env, selected, 100)).toEqual(
        expected
          .slice(4)
          .filter(
            (row) => row.observed_at! >= 9950 && row.observed_at! <= 9995,
          ),
      );
      expect(
        await loadIndexedAccountFeedGroups(
          a.env,
          selectors.map((s) => ({ ...s, observedStart: 10001 })),
        ),
      ).toEqual([]);
      expect(
        await loadIndexedAccountFeedGroups(
          a.env,
          selectors.map((s) => ({ ...s, observedEnd: 0 })),
        ),
      ).toEqual([]);
      expect(
        await loadIndexedAccountFeedGroups(
          a.env,
          selectors.map((s) => ({
            ...s,
            observedStart: 10001,
            observedEnd: 9990,
          })),
        ),
      ).toEqual([]);
      expect(
        await loadIndexedAccountFeedGroups(
          a.env,
          selectors.map((s) => ({ ...s, observedStart: -1 })),
        ),
      ).toBeNull();
      expect(
        await loadIndexedAccountFeedGroups(a.env, [
          ...selectors,
          ...selectors,
          selectors[0],
        ]),
      ).toBeNull();
      expect(
        await loadIndexedAccountFeedGroups(undefined, selectors),
      ).toBeUndefined();
    } finally {
      await runtime.dispose();
    }
  });

  it("serves native physical rows, filters, offsets and cursors through conditional R2 ranges", async () => {
    const a = archive();
    const expected = fixture.rows
      .filter((r) => r.hotkey === "account-0" || r.coldkey === "account-0")
      .sort(
        (a, b) =>
          b.observed_at! - a.observed_at! ||
          b.block_number! - a.block_number! ||
          b.event_index! - a.event_index!,
      );
    expect(await loadIndexedAccountFeedPage(a.env, selectors, 5001)).toEqual(
      expected,
    );
    expect(await loadIndexedAccountFeedPage(a.env, selectors, 4, 3)).toEqual(
      expected.slice(3, 7),
    );
    const row = expected[4];
    const filtered = selectors.map((s) => ({
      ...s,
      kind: "Transfer",
      netuid: 0,
      blockStart: 2,
      blockEnd: 83,
      cursor: [row.observed_at!, row.block_number!, row.event_index!] as [
        number,
        number,
        number,
      ],
    }));
    expect(await loadIndexedAccountFeedPage(a.env, filtered, 5001)).toEqual(
      expected.filter(
        (r) =>
          r.event_kind === "Transfer" &&
          r.netuid === 0 &&
          r.block_number! >= 2 &&
          r.block_number! <= 83 &&
          (r.observed_at! < row.observed_at! ||
            (r.observed_at === row.observed_at &&
              (r.block_number! < row.block_number! ||
                (r.block_number === row.block_number &&
                  r.event_index! < row.event_index!)))),
      ),
    );
    expect(
      a.get.mock.calls.some(
        ([, options]) => options?.onlyIf && "etagMatches" in options.onlyIf,
      ),
    ).toBe(true);
    expect(
      await loadIndexedAccountFeedPage(
        a.env,
        [{ side: "all", account: "*", netuid: 0 }],
        5001,
      ),
    ).toEqual(
      fixture.rows
        .filter((r) => r.netuid === 0)
        .sort(
          (a, b) =>
            b.observed_at! - a.observed_at! ||
            b.block_number! - a.block_number! ||
            b.event_index! - a.event_index!,
        ),
    );
  });

  it("qualifies only the requested retained range and scopes testnet separately", async () => {
    expect(
      await loadIndexedAccountFeedPage(undefined, selectors, 5),
    ).toBeUndefined();
    const gap = archive("testnet");
    gap.selected.firstBlock = 7700001;
    gap.save();
    expect(
      await loadIndexedAccountFeedPage(gap.env, selectors, 5, 0, "testnet"),
    ).toBeUndefined();
    expect(
      await loadIndexedAccountFeedPage(
        gap.env,
        selectors.map((s) => ({ ...s, blockStart: 7700001 })),
        5,
        0,
        "testnet",
      ),
    ).toEqual([]);
    const tail = archive();
    tail.ceiling.through++;
    tail.save();
    expect(
      await loadIndexedAccountFeedPage(tail.env, selectors, 5),
    ).toBeUndefined();
    expect(
      await loadIndexedAccountFeedPage(
        tail.env,
        selectors.map((s) => ({ ...s, blockEnd: 84 })),
        5,
      ),
    ).toHaveLength(5);
    const testnet = archive("testnet");
    expect(
      await loadIndexedAccountFeedPage(testnet.env, selectors, 5, 0, "testnet"),
    ).toEqual([]);
    expect(
      testnet.get.mock.calls.every(([key]) => key.includes("/testnet/")),
    ).toBe(true);
  });

  it("keeps a missing producer or moving source unqualified rather than claiming empty history", async () => {
    for (const key of ["pointer", "ceilingKey", "manifest"] as const) {
      const a = archive();
      a.objects.delete(a[key]);
      expect(
        await loadIndexedAccountFeedPage(a.env, selectors, 5),
      ).toBeUndefined();
    }
    for (const remove of [false, true]) {
      const a = archive();
      a.intercept((key, count) => {
        if (key === a.ceilingKey && count === 2) {
          if (remove) a.objects.delete(key);
          else a.put(key, { ...a.ceiling, revision: "b".repeat(32) });
        }
      });
      expect(
        await loadIndexedAccountFeedPage(a.env, selectors, 5),
      ).toBeUndefined();
    }
  });

  it("fails closed on corrupt selected data or budgets without a scan fallback", async () => {
    const corruptions: ((a: ReturnType<typeof archive>) => void)[] = [
      (a) => {
        a.sizes.set(a.ceilingKey, 8193);
      },
      (a) => {
        a.put(a.ceilingKey, { ...a.ceiling, network: "testnet" });
      },
      (a) => {
        a.put(a.ceilingKey, { ...a.ceiling, table: "blocks" });
      },
      (a) => {
        a.objects.get(a.ceilingKey)!.etag = "";
      },
      (a) => {
        a.sizes.set(a.manifest, 16385);
      },
      (a) => {
        a.feed.rows--;
        a.save();
      },
      (a) => {
        a.feed.sourceSnapshot = "2";
        a.save();
      },
      (a) => {
        a.objects.delete(a.selected.blockManifest.key);
      },
      (a) => {
        a.feed.state = "incomplete" as "complete";
        a.save();
      },
    ];
    for (const corrupt of corruptions) {
      const a = archive();
      corrupt(a);
      const before = currentIndexedHistoryFailureGeneration();
      expect(await loadIndexedAccountFeedPage(a.env, selectors, 5)).toBeNull();
      expect(currentIndexedHistoryFailureGeneration()).toBe(before + 1);
    }
    for (const selection of [[], [...selectors, selectors[0]]])
      expect(
        await loadIndexedAccountFeedPage(archive().env, selection, 5),
      ).toBeNull();
    expect(
      await loadIndexedAccountFeedPage(archive().env, selectors, 5002),
    ).toBeNull();
  });
});

it("opens only feed segments intersecting the requested block range", async () => {
  const a = archive();
  a.ceiling.through = a.selected.lastBlock + 5;
  a.save();
  const outer = (
    generation: string,
    firstBlock: number,
    lastBlock: number,
  ) => ({
    ...a.selected,
    generation,
    firstBlock,
    lastBlock,
    blockManifest: {
      key: `metagraph/indexed-history/v1/mainnet/account_events/generations/${generation}/block-manifest.json`,
      etag: "missing",
      bytes: 1,
    },
  });
  a.put(a.pointer, {
    version: 2,
    network: "mainnet",
    table: "account_events",
    segments: [
      a.selected,
      outer("8".repeat(64), a.selected.lastBlock + 1, a.ceiling.through),
    ],
  });
  const bounded = [
    { side: "all" as const, account: "*", blockStart: 2, blockEnd: 4 },
  ];
  const expected = fixture.rows
    .filter((r) => r.block_number! >= 2 && r.block_number! <= 4)
    .sort(
      (a, b) =>
        b.observed_at! - a.observed_at! ||
        b.block_number! - a.block_number! ||
        b.event_index! - a.event_index!,
    );
  expect(await loadIndexedAccountFeedPage(a.env, bounded, 5001)).toEqual(
    expected,
  );
  expect(a.get.mock.calls.some(([key]) => key.includes("8".repeat(64)))).toBe(
    false,
  );
  expect(
    (await loadIndexedAccountFeedGroups(a.env, bounded))?.reduce(
      (sum, group) => sum + group.event_count,
      0,
    ),
  ).toBe(expected.length);
  expect(
    await loadIndexedAccountFeedPage(
      a.env,
      [
        {
          ...bounded[0],
          blockStart: a.ceiling.through + 1,
          blockEnd: a.ceiling.through + 2,
        },
      ],
      3,
    ),
  ).toEqual([]);
  expect(
    await loadIndexedAccountFeedPage(a.env, [{ side: "all", account: "*" }], 3),
  ).toBeUndefined();
  expect(
    await loadIndexedAccountFeedPage(
      a.env,
      [
        {
          ...bounded[0],
          blockStart: a.selected.lastBlock + 1,
          blockEnd: a.ceiling.through,
        },
      ],
      3,
    ),
  ).toBeUndefined();
  a.objects.delete(a.manifest);
  expect(await loadIndexedAccountFeedPage(a.env, bounded, 3)).toBeUndefined();
});
