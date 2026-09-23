import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  ACCOUNT_EVENTS_COLUMNS,
  type AccountEventsRow,
} from "../generated/lakehouse/types.ts";
import type { HistoryAccountFeed } from "../schemas-src/artifacts/history-account-feed.ts";
import { loadSubnetOhlcColdTier } from "../src/subnet-ohlc-cold-tier.ts";
import { loadSubnetEventSummaryColdTier } from "../src/subnet-event-summary-cold-tier.ts";
import {
  foldSubnetEventSummaryRows,
  loadIndexedSubnetEventSummaryRows,
} from "../src/subnet-indexed-aggregates.ts";
import { loadAccountHistoryColdTier } from "../src/account-history-cold-tier.ts";
import {
  foldAccountHistoryRows,
  loadIndexedAccountHistoryRows,
} from "../src/account-history-indexed.ts";
import { encodeCursor } from "../src/cursor.ts";
import { R2_SQL_TOKEN_ENV } from "../src/r2-sql.ts";
import { loadValidatorNominatorsColdTier } from "../src/account-feeds-cold-tier.ts";
const fixture = JSON.parse(
  gunzipSync(
    readFileSync(
      new URL("./fixtures/account-feeds/subnet-tree.json.gz", import.meta.url),
    ),
  ).toString(),
) as {
  manifest: HistoryAccountFeed;
  selection: HistoryAccountFeed["selection"];
  rows: AccountEventsRow[];
  objects: Record<string, { etag: string; base64: string }>;
};
const NOW = 1790186400000;
const ACCOUNT = "5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F";
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
    env: {
      METAGRAPH_ARCHIVE: { get },
      [R2_SQL_TOKEN_ENV]: "cfut_native_fixture",
    },
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

const db = new DatabaseSync(":memory:");
beforeAll(() => {
  db.exec(
    `CREATE TABLE events(${ACCOUNT_EVENTS_COLUMNS.map((name) => `${name} ${["event_kind", "hotkey", "coldkey"].includes(name) ? "TEXT" : ["amount_tao", "alpha_amount"].includes(name) ? "REAL" : "INTEGER"}`).join(",")})`,
  );
  const insert = db.prepare(
    `INSERT INTO events VALUES(${ACCOUNT_EVENTS_COLUMNS.map(() => "?").join(",")})`,
  );
  db.exec("BEGIN");
  for (const row of fixture.rows)
    insert.run(...ACCOUNT_EVENTS_COLUMNS.map((name) => row[name]));
  db.exec("COMMIT");
});
afterAll(() => db.close());
beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(NOW));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const sql = async (_env: unknown, text: string) =>
  db
    .prepare(
      text
        .replaceAll("chain.account_events", "events")
        .replaceAll(
          "date_trunc('day', to_timestamp(observed_at / 1000))",
          "strftime('%Y-%m-%d',observed_at/1000,'unixepoch')",
        ),
    )
    .all();

it("validator nominators preserve every window, ordering, page and total without SQL", async () => {
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const text = JSON.parse(String(init?.body)).query.replace(
      /ORDER BY ([a-z_]+) DESC, coldkey ASC/,
      "ORDER BY $1 DESC NULLS FIRST, coldkey ASC NULLS LAST",
    );
    return new Response(
      JSON.stringify({
        success: true,
        result: { rows: await sql(undefined, text) },
      }),
    );
  });
  vi.stubGlobal("fetch", fetch);
  for (const window of ["7d", "30d", "90d"]) {
    for (const sort of ["net_staked", "gross_staked", "last_activity"]) {
      for (const offset of [0, 1, 10]) {
        const query = { window, sort, limit: 2, offset };
        const expected = await loadValidatorNominatorsColdTier(
          { [R2_SQL_TOKEN_ENV]: "cfut_sql_fixture" },
          ACCOUNT,
          query,
        );
        fetch.mockClear();
        expect(
          await loadValidatorNominatorsColdTier(archive().env, ACCOUNT, query),
        ).toEqual(expected);
        expect(fetch).not.toHaveBeenCalled();
      }
    }
  }
  expect(
    (await loadValidatorNominatorsColdTier(archive().env, ACCOUNT, {
      limit: 5,
      coldkey: ACCOUNT,
    }))!.data.nominator_count,
  ).toBe(0);
  expect(fetch).not.toHaveBeenCalled();
});

it("a corrupt selected nominator feed declines without a paid fallback", async () => {
  const a = archive();
  a.put(a.manifest, {});
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  expect(
    await loadValidatorNominatorsColdTier(a.env, ACCOUNT, { limit: 20 }),
  ).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

it("native OHLC candles match SQLite at every supported window boundary", async () => {
  const fetch = vi.fn(
    async (_url: unknown, init?: RequestInit) =>
      new Response(
        JSON.stringify({
          success: true,
          result: {
            rows: await sql(undefined, JSON.parse(String(init?.body)).query),
          },
        }),
      ),
  );
  vi.stubGlobal("fetch", fetch);
  for (const netuid of [1, 2, 3])
    for (const interval of ["1h", "1d"])
      for (const days of [1, 7, 90, 365]) {
        const query = { interval, days, limit: netuid === 1 ? 2 : 2000 };
        const expected = await loadSubnetOhlcColdTier(
          { [R2_SQL_TOKEN_ENV]: "cfut_fixture" },
          netuid,
          query,
        );
        const count = fetch.mock.calls.length;
        const native = await loadSubnetOhlcColdTier(
          archive().env,
          netuid,
          query,
        );
        expect(native).toEqual(expected);
        expect(native.kind).toBe("answer");
        expect(fetch).toHaveBeenCalledTimes(count);
      }
}, 60_000);

it("native subnet summaries match SQLite nullable aggregates and participants", async () => {
  for (const netuid of [1, 2, 3])
    for (const window of ["1d", "7d", "30d", "90d"]) {
      const expected = await loadSubnetEventSummaryColdTier(undefined, netuid, {
        window,
        limit: 4,
        query: sql,
      });
      expect(
        await loadSubnetEventSummaryColdTier(archive().env, netuid, {
          window,
          limit: 4,
          query: async () => {
            throw new Error("selected native feed queried SQL");
          },
        }),
      ).toEqual(expected);
    }
}, 60_000);

it("native account histories match SQLite filters and cursor boundaries", async () => {
  for (const account of [ACCOUNT, "5" + "a".repeat(47)])
    for (const query of [
      { limit: 2 },
      { limit: 3, offset: 2 },
      { limit: 500, netuid: 1 },
      { limit: 2, from: "2026-09-01", to: "2026-09-20" },
      { limit: 2, cursor: encodeCursor([20260923, 2]) },
      { limit: 3, cursor: encodeCursor([20260920, 2]), offset: 5 },
      { limit: 1, to: "2026-09-21", cursor: encodeCursor([20260920, 2]) },
      { limit: 1, cursor: "bad" },
    ]) {
      const expected = await loadAccountHistoryColdTier(
        undefined,
        account,
        query,
        { queryFn: sql },
      );
      const native = await loadAccountHistoryColdTier(
        archive().env,
        account,
        query,
        {
          queryFn: async () => {
            throw new Error("native account history queried SQL");
          },
        },
      );
      expect(native).toEqual(expected);
      expect(native).not.toBeNull();
    }
}, 60_000);

it("declines selected corrupt indexes and numeric overflow without querying SQL", async () => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  const fetch = vi.fn(async () => {
    throw new Error("selected native index must not query SQL");
  });
  vi.stubGlobal("fetch", fetch);
  try {
    for (const mode of ["corrupt", "overflow"]) {
      const a = archive();
      if (mode === "corrupt") {
        a.feed.entries++;
        a.save();
      }
      const netuid = mode === "overflow" ? 99 : 1;
      expect(
        await loadSubnetOhlcColdTier(a.env, netuid, {
          interval: "1h",
          days: 365,
        }),
      ).toEqual({ kind: "gap" });
      expect(
        await loadSubnetEventSummaryColdTier(a.env, netuid, {
          window: "90d",
          limit: 2,
        }),
      ).toBeNull();
    }
    for (const limit of [0, 1.5, 5001])
      expect(
        await loadIndexedSubnetEventSummaryRows(archive().env, 1, 0, limit),
      ).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it("bounds participant and kind memory without publishing partial totals", async () => {
  async function* events(count: number, mode: "kind" | "identity") {
    for (let i = 0; i < count; i++)
      yield {
        ...fixture.rows[0],
        event_kind: mode === "kind" ? `kind-${i}` : "StakeAdded",
        hotkey: mode === "identity" ? `key-${i}` : null,
        coldkey: null,
        uid: null,
      };
  }
  await expect(
    foldSubnetEventSummaryRows(events(4097, "kind"), 1),
  ).rejects.toThrow("kind budget");
  await expect(
    foldSubnetEventSummaryRows(events(131073, "identity"), 1),
  ).rejects.toThrow("participant budget");
});

it("bounds account day aggregation and skips null subnet and event-kind cells", async () => {
  async function* many(count: number) {
    for (let i = 0; i < count; i++)
      yield {
        ...fixture.rows[0],
        netuid: i,
        event_kind: null,
        observed_at: NOW,
      };
  }
  await expect(foldAccountHistoryRows(many(20001), 1)).rejects.toThrow(
    "group budget",
  );
  for (const need of [0, 1.5, 10001])
    expect(
      await loadIndexedAccountHistoryRows(archive().env, ACCOUNT, {}, need),
    ).toBeNull();
  async function* nullable() {
    yield { ...fixture.rows[0], netuid: null };
    yield { ...fixture.rows[0], netuid: 1, event_kind: null };
  }
  expect(await foldAccountHistoryRows(nullable(), 1)).toMatchObject([
    { netuid: 1, event_kinds: "", event_count: 1 },
  ]);
  const a = archive();
  a.feed.entries++;
  a.save();
  expect(
    await loadAccountHistoryColdTier(a.env, ACCOUNT, { limit: 1 }),
  ).toBeNull();
});
