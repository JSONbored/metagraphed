import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { pg } = await vi.hoisted(async () => ({
  pg: (await import("./helpers/pg-mock.ts")).createPgMock(),
}));
vi.mock("pg", () => pg.module);

import { pgMockEnv } from "./helpers/pg-mock.ts";
import { createLocalArtifactEnv } from "../scripts/lib.ts";
import { handleRequest, isMainnetOnlyApiPath } from "../workers/api.ts";
import { handleSubnetPriceShareComposition } from "../workers/request-handlers/entities.ts";
import { handleGraphQLRequest } from "../src/graphql.ts";
import { MCP_TOOLS, listToolDefinitions } from "../src/mcp-server.ts";
import { FIELD_COMPLEXITY } from "../src/graphql-limits.ts";
import { SubnetPriceShareCompositionArtifactSchema } from "../schemas-src/routes/subnet-price-share-composition.ts";
import {
  GetSubnetPriceShareCompositionInputSchema,
  GetSubnetPriceShareCompositionOutputSchema,
} from "../schemas-src/mcp-tools/get-subnet-price-share-composition.ts";
import { jsonBody, mockEnv } from "./row-type.ts";

const path = "/api/v1/chain/subnet-price-share-composition";
const address = "https://api.metagraph.sh" + path;
const nowMs = Date.UTC(2026, 9, 18, 12);
const selection = `schema_version quality window_days cohort_limit row_limit other_label
  point_count oldest_day newest_day series { netuid }
  points { day captured_at shares other_share } degraded { reason }`;
const rows = [
  {
    netuid: 0,
    snapshot_date: "2026-10-17",
    captured_at: nowMs - 86_400_000,
    emission_share: 1,
  },
];
const ctx = { waitUntil: (promise: Promise<unknown>) => promise };
const tool = MCP_TOOLS.find(
  (entry) => entry.name === "get_subnet_price_share_composition",
);

function env() {
  return mockEnv({
    ...createLocalArtifactEnv(),
    ...pgMockEnv(["subnet_snapshots"]),
    METAGRAPH_CONTROL: {
      async get(key: string) {
        return key === "health:meta"
          ? { last_run_at: "2026-10-18T11:00:00Z" }
          : null;
      },
    },
  });
}

async function graphql(query: string, source: Env) {
  return handleGraphQLRequest(
    new Request("https://api.metagraph.sh/api/v1/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query }),
    }),
    source,
    ctx,
  );
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(nowMs);
  pg.control.queries.length = 0;
  pg.control.rows = rows;
  pg.control.failNext = null;
  pg.control.answers = [];
  pg.control.onQuery = null;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("price-share route and mirror parity", () => {
  it.each(["populated", "empty", "unavailable"])(
    "shares the full canonical %s payload across REST, GraphQL and MCP",
    async (state) => {
      if (state === "empty") pg.control.rows = [];
      const source = state === "unavailable" ? mockEnv() : env();
      const response = await handleRequest(new Request(address), source, ctx);
      expect(response.status).toBe(200);
      const rest = (await jsonBody(response)).data;
      expect(SubnetPriceShareCompositionArtifactSchema.parse(rest)).toEqual(rest);
      const gqlResponse = await graphql(
        `{ subnet_price_share_composition { ${selection} } }`,
        source,
      );
      const gql = await jsonBody(gqlResponse);
      expect(gql.errors).toBeUndefined();
      // GraphQL includes null for an absent optional degraded field.
      expect(gql.data.subnet_price_share_composition).toEqual({
        ...rest,
        degraded: rest.degraded ?? null,
      });
      expect(tool).toBeDefined();
      expect(await tool!.handler({}, { env: source })).toEqual(rest);
      expect(GetSubnetPriceShareCompositionOutputSchema).toBe(
        SubnetPriceShareCompositionArtifactSchema,
      );
      const reads = pg.control.queries.filter((query) =>
        query.text.includes("FROM subnet_snapshots"),
      );
      expect(reads.length).toBe(state === "unavailable" ? 0 : 3);
      for (const query of reads) {
        expect(query.values).toEqual(["2026-08-23", "2026-10-18", 16385]);
        expect(query.text).not.toMatch(/SELECT \*|JOIN|OFFSET|total_stake/i);
      }
    },
  );

  it("memoizes repeated GraphQL aliases within one request and declares read complexity", async () => {
    const response = await graphql(
      `{ a: subnet_price_share_composition { point_count }
      b: subnet_price_share_composition { point_count } }`,
      env(),
    );
    const body = await jsonBody(response);
    expect(body.errors).toBeUndefined();
    expect(body.data).toEqual({ a: { point_count: 1 }, b: { point_count: 1 } });
    expect(
      pg.control.queries.filter((query) =>
        query.text.includes("FROM subnet_snapshots"),
      ),
    ).toHaveLength(1);
    expect(FIELD_COMPLEXITY.subnet_price_share_composition).toBeGreaterThan(1);
  });

  it("rejects a caller-controlled MCP window and GraphQL network argument", async () => {
    expect(
      GetSubnetPriceShareCompositionInputSchema.safeParse({ window: "all" })
        .success,
    ).toBe(false);
    const response = await graphql(
      `{ subnet_price_share_composition(network: test) { quality } }`,
      env(),
    );
    expect((await jsonBody(response)).errors).toBeDefined();
    expect(pg.control.queries).toHaveLength(0);
    expect(
      listToolDefinitions().some(
        (entry) => entry.name === "get_subnet_price_share_composition",
      ),
    ).toBe(true);
  });

  it("refuses testnet addressing without reading mainnet snapshots", async () => {
    expect(isMainnetOnlyApiPath(path)).toBe(true);
    const response = await handleRequest(
      new Request(address.replace("/api/v1/", "/api/v1/testnet/")),
      env(),
      ctx,
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(
      pg.control.queries.filter((query) =>
        query.text.includes("FROM subnet_snapshots"),
      ),
    ).toHaveLength(0);
  });

  it("checks response format before reading snapshots", async () => {
    const request = new Request(address + "?format=invalid");
    const response = await handleSubnetPriceShareComposition(
      request,
      env(),
      new URL(request.url),
    );
    expect(response.status).toBe(400);
    expect(pg.control.queries).toHaveLength(0);
  });

  it("does not cache transient failures and recovers through the existing cache", async () => {
    const cache = new Map<string, Response>();
    vi.stubGlobal("caches", {
      default: {
        async match(request: Request) {
          return cache.get(request.url)?.clone();
        },
        async put(request: Request, response: Response) {
          cache.set(request.url, response.clone());
        },
      },
    });
    const source = env();
    pg.control.failNext = new Error("fixture unavailable");
    const failed = await handleRequest(new Request(address), source, ctx);
    expect((await jsonBody(failed)).data.degraded.reason).toBe("unavailable");
    expect(cache.size).toBe(0);
    const recovered = await handleRequest(new Request(address), source, ctx);
    expect((await jsonBody(recovered)).data.point_count).toBe(1);
    await Promise.resolve();
    expect(cache.size).toBe(1);
    const reads = pg.control.queries.length;
    const hit = await handleRequest(new Request(address), source, ctx);
    expect((await jsonBody(hit)).data.point_count).toBe(1);
    expect(pg.control.queries).toHaveLength(reads);
  });

  it("normalizes HEAD into the GET cache path and returns no body", async () => {
    const cache = new Map<string, Response>();
    vi.stubGlobal("caches", {
      default: {
        async match(request: Request) {
          return cache.get(request.url)?.clone();
        },
        async put(request: Request, response: Response) {
          cache.set(request.url, response.clone());
        },
      },
    });
    const source = env();
    const head = await handleRequest(
      new Request(address, { method: "HEAD" }),
      source,
      ctx,
    );
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    await Promise.resolve();
    expect(cache.size).toBe(1);
    const reads = pg.control.queries.length;
    const get = await handleRequest(new Request(address), source, ctx);
    expect((await jsonBody(get)).data.point_count).toBe(1);
    expect(pg.control.queries).toHaveLength(reads);
  });
});
