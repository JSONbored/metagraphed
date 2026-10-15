import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiError } from "./client";
import { setNetwork } from "./config";
import { accountIdentityQuery, blocksQuery, blocksSummaryQuery } from "./queries";
import { runQuery } from "./run-query";

// Transport replay of fields verified by tests/restored-state-serving.test.ts.
// The API client and query functions are real; this UI test does not restore a
// database, run a browser, or substitute canned rows behind a storage reader.
const corpus = JSON.parse(
  readFileSync(
    new URL("../../../../../tests/fixtures/restored-serving-v1.json", import.meta.url),
    "utf8",
  ),
) as {
  identity: { data: { account: string; additional: string }; meta: object; ok: boolean };
  blocks: Record<"mainnet" | "testnet", Record<string, unknown>[]>;
  first_cursor: string;
};
const serving = JSON.parse(
  gunzipSync(
    readFileSync(
      new URL("../../../../../tests/fixtures/native-projections/serving.json.gz", import.meta.url),
    ),
  ).toString(),
) as Record<string, { raw: string }>;
const manifest = JSON.parse(
  serving["metagraph/native-projections/v1/mainnet/current.json"].raw,
) as { artifacts: { artifactKey: string; object: { key: string } }[] };
const summaryObject = manifest.artifacts.find((a) =>
  a.artifactKey.endsWith("/blocks-summary.json"),
)!;
const summary = JSON.parse(serving[summaryObject.object.key].raw).summary;
let mode: "healthy" | "empty" | "unavailable" | "corrupt";
const paths: string[] = [];
beforeEach(() => {
  mode = "healthy";
  paths.length = 0;
  setNetwork("mainnet");
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(String(input));
    paths.push(url.pathname + url.search);
    if (mode === "unavailable")
      return Response.json(
        {
          ok: false,
          error: {
            code: "history_unavailable",
            message: "Retained historical data is unavailable. Please retry.",
          },
        },
        { status: 503 },
      );
    if (url.pathname.endsWith("/identity")) return Response.json(corpus.identity);
    if (url.pathname.endsWith("/blocks/summary"))
      return Response.json(
        {
          ok: true,
          data: mode === "corrupt" ? { schema_version: 1, block_count: 0 } : summary,
          meta: {},
        },
        { headers: mode === "corrupt" ? { "x-metagraph-degraded": "tier_unavailable" } : {} },
      );
    if (!url.pathname.endsWith("/blocks"))
      throw Error(`Unexpected fixture request: ${url.pathname}`);
    const network = url.pathname.includes("/testnet/") ? "testnet" : "mainnet";
    const rows = mode === "empty" ? [] : corpus.blocks[network];
    const next = url.searchParams.get("cursor");
    const blocks = next ? rows.slice(2) : rows.slice(0, 2);
    return Response.json({
      ok: true,
      data: {
        schema_version: 1,
        blocks,
        limit: 2,
        offset: 0,
        next_cursor: next ? null : corpus.first_cursor,
      },
      meta: { network },
    });
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  setNetwork("mainnet");
});

it("keeps exact decimal text, Unicode and nulls from the verified restored identity envelope", async () => {
  const actual = await runQuery(accountIdentityQuery(corpus.identity.data.account));
  expect(actual.data).toEqual(corpus.identity.data);
  expect(actual.data.additional).toContain("340282366920938463463374607431768211455");
});

it("preserves verified ordering, nullable counts, cursor requests and network-scoped keys", async () => {
  const first = await runQuery(blocksQuery({ limit: 2 }));
  expect(first.data.map((b) => b.block_number)).toEqual([11, 10]);
  expect(first.data[0].extrinsic_count).toBeNull();
  expect(first.data[0].event_count).toBe(0);
  const next = await runQuery(blocksQuery({ limit: 2, cursor: corpus.first_cursor }));
  expect(next.data.map((b) => b.block_number)).toEqual([9]);
  expect(new Set([...first.data, ...next.data].map((b) => b.block_hash)).size).toBe(3);
  const mainnetKey = blocksQuery({ limit: 2 }).queryKey;
  setNetwork("testnet");
  const testnet = await runQuery(blocksQuery({ limit: 2 }));
  expect(testnet.data.map((b) => b.block_number)).toEqual([22, 21]);
  expect(blocksQuery({ limit: 2 }).queryKey).not.toEqual(mainnetKey);
  expect(paths).toContain(`/api/v1/blocks?limit=2&cursor=${corpus.first_cursor}`);
  expect(paths).toContain("/api/v1/testnet/blocks?limit=2");
});

it("keeps verified empty successful and propagates an unavailable restored owner as an error", async () => {
  mode = "empty";
  expect((await runQuery(blocksQuery({ limit: 2 }))).data).toEqual([]);
  mode = "unavailable";
  await expect(runQuery(blocksQuery({ limit: 2 }))).rejects.toMatchObject({
    status: 503,
    code: "history_unavailable",
  });
  mode = "healthy";
  expect((await runQuery(blocksQuery({ limit: 2 }))).data).toHaveLength(2);
});

it("refuses the degraded zero envelope after object corruption and consumes repaired summary bytes", async () => {
  expect((await runQuery(blocksSummaryQuery())).data.block_count).toBe(summary.block_count);
  mode = "corrupt";
  await expect(runQuery(blocksSummaryQuery())).rejects.toBeInstanceOf(ApiError);
  await expect(runQuery(blocksSummaryQuery())).rejects.toMatchObject({
    code: "data_tier_unavailable",
  });
  mode = "healthy";
  expect((await runQuery(blocksSummaryQuery())).data.block_count).toBe(summary.block_count);
});
