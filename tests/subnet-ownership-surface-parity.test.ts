// REST, MCP and GraphQL must answer /subnets/{netuid}/ownership-history the
// SAME way (#9312).
//
// THE SHAPE OF THE BUG. All three surfaces already reached the same cold-tier
// reader -- and then each rebuilt the answer from it by hand. MCP had
// `narrowOwnershipHistory` (four fields), GraphQL's resolver had the same four
// inline, and REST returned the reader's payload whole. So they agreed only by
// coincidence, and every field the reader gained reached exactly one of them:
// `source` and `observed_through`, added here, would have shipped to REST
// alone. That is #9263, #9269, #9285 and #9296 over again, and it recurs for a
// structural reason -- a projection written at the call site has to be
// REMEMBERED at every call site.
//
// So this file pins both halves of the fix:
//
//   1. STRUCTURAL -- no surface reaches the tier reader or shapes the payload
//      itself. Read from source, because "they happen to agree today" is
//      exactly the state this route was already in.
//   2. BEHAVIOURAL -- given one set of store responses, all three surfaces
//      publish the same records, the same labels and the same coverage.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, test } from "vitest";
import { coldTierChainEventsPayload } from "../src/chain-events-degraded.ts";
import { MCP_TOOLS } from "../src/mcp-server.ts";
import { handleGraphQLRequest } from "../src/graphql.ts";
import { R2_SQL_TOKEN_ENV } from "../src/r2-sql.ts";
import { jsonBody, mockEnv } from "./row-type.ts";
import type { Row } from "./row-type.ts";

/** Where each surface's ownership-history code lives. REST reaches this route
 * through the proxied-path table, not through the entity handlers, so that
 * module is the REST surface here. */
const SURFACE_SOURCES = {
  REST: "src/chain-events-degraded.ts",
  MCP: "src/mcp-server.ts",
  GraphQL: "src/graphql.ts",
} as const;

/** The tier readers a surface must NOT reach for. Each one is a decision the
 * composer owns: which stores to ask, and what a decline means. */
const TIER_READERS = [
  "loadSubnetOwnershipHistoryColdTier",
  "loadSubnetOwnerObservations",
  "subnet-ownership-cold-tier.ts",
];

/** Import lines only -- prose in a comment naming the old projection is
 * history, not a call. */
function importLines(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
    .split("\n")
    .filter((line) => /^\s*(import|} from|\s+from)\b/.test(line.trim()))
    .join("\n");
}

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("no surface owns the ownership-history cascade", () => {
  for (const [surface, path] of Object.entries(SURFACE_SOURCES)) {
    test(`${surface} answers through the composer and shapes nothing itself`, () => {
      assert.match(
        source(path),
        /answerSubnetOwnershipHistory|subnetOwnershipHistoryNode/,
        `${surface} must answer through src/subnet-ownership-answer.ts`,
      );
      const imports = importLines(path);
      for (const reader of TIER_READERS) {
        assert.ok(
          !imports.includes(reader),
          `${surface} imports ${reader} directly -- the cascade belongs to src/subnet-ownership-answer.ts`,
        );
      }
    });
  }

  // The per-surface projection that made the three disagree is gone, and
  // nothing may reintroduce one under another name.
  test("no per-surface ownership projection survives", () => {
    for (const path of Object.values(SURFACE_SOURCES)) {
      assert.ok(
        !/narrowOwnershipHistory/.test(source(path)),
        `${path} still projects the payload itself`,
      );
    }
  });
});

// --- behavioural parity ------------------------------------------------------

const ENV = mockEnv({ [R2_SQL_TOKEN_ENV]: "cfut_test" });
const NETUID = 86;
const OWNER_A = "5DHwWLjtpwnZQUQKKXE2N5Gdy2N8PpqhgjLUuzgSB7yuGZkF";
const OWNER_B = "5GgvCi6h7dNsC489T8UnUMv912SoEXpEUDVt71VJU1Td7WKh";

/** The exact ledger rows measured for netuid 86 on 2026-08-03: two captures,
 * different coldkeys, and no SubnetOwnerChanged event for either. */
const LEDGER_ROWS: Row[] = [
  { owner_coldkey: OWNER_A, captured_at: 1_784_537_200_378 },
  { owner_coldkey: OWNER_B, captured_at: 1_784_915_720_256 },
];
const OBSERVED_THROUGH = new Date(1_784_915_720_256).toISOString();

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Answers the event-stream read with nothing (the chain emitted no event for
 * this subnet) and the ledger read with the two captures, keyed on the SQL so
 * the two concurrent reads cannot be mixed up. */
function lakehouse(): void {
  globalThis.fetch = (async (_u: string, init: RequestInit) => {
    const query = String(JSON.parse(String(init.body)).query);
    const rows = query.includes("subnet_ownership_history") ? LEDGER_ROWS : [];
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: { rows } }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

/** MCP and GraphQL only consult the lakehouse once DATA_API has degraded, so
 * both are handed a binding that answers the way a dead tier does. */
const DEGRADED_DATA_API = {
  fetch: async () => new Response("gone", { status: 503 }),
};

async function restOwnership(): Promise<Row> {
  return (await coldTierChainEventsPayload(
    ENV,
    new URL(`https://api.test/api/v1/subnets/${NETUID}/ownership-history`),
  )) as Row;
}

async function mcpOwnership(): Promise<Row> {
  const tool = MCP_TOOLS.find(
    (t) => t.name === "get_subnet_ownership_history",
  )!;
  return (await tool.handler(
    { netuid: NETUID } as never,
    {
      env: mockEnv({
        [R2_SQL_TOKEN_ENV]: "cfut_test",
        DATA_API: DEGRADED_DATA_API,
      }),
    } as never,
  )) as Row;
}

async function graphqlOwnership(): Promise<Row> {
  const res = await handleGraphQLRequest(
    new Request("https://api.test/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: `{ subnet_ownership_history(netuid: ${NETUID}) { schema_version netuid event_pallet event_method count observed_through ownership_changes } }`,
      }),
    }),
    mockEnv({ [R2_SQL_TOKEN_ENV]: "cfut_test", DATA_API: DEGRADED_DATA_API }),
  );
  return ((await jsonBody(res)).data as Row).subnet_ownership_history as Row;
}

describe("all three surfaces publish the same ownership history", () => {
  test("the same store responses produce the same records everywhere", async () => {
    lakehouse();
    const surfaces: [string, Row][] = [
      ["REST", await restOwnership()],
      ["MCP", await mcpOwnership()],
      ["GraphQL", await graphqlOwnership()],
    ];
    for (const [name, data] of surfaces) {
      assert.equal(data.count, 1, name);
      assert.equal(data.netuid, NETUID, name);
      const change = (data.ownership_changes as Row[])[0]!;
      assert.equal(change.old_coldkey, OWNER_A, name);
      assert.equal(change.new_coldkey, OWNER_B, name);
      // The label a per-surface projection would have dropped.
      assert.equal(change.source, "owner-observation", name);
      assert.equal(change.block_number, null, name);
    }
  });

  test("the same coverage stamp and event identity reach every surface", async () => {
    lakehouse();
    const surfaces: [string, Row][] = [
      ["REST", await restOwnership()],
      ["MCP", await mcpOwnership()],
      ["GraphQL", await graphqlOwnership()],
    ];
    for (const [name, data] of surfaces) {
      assert.equal(data.observed_through, OBSERVED_THROUGH, name);
      assert.equal(data.event_pallet, "SubtensorModule", name);
      assert.equal(data.event_method, "SubnetOwnerChanged", name);
      assert.equal(data.schema_version, 1, name);
    }
  });

  // The regression itself: before the second source, every one of these
  // answered an empty list for a subnet that provably changed hands.
  test("no surface answers an empty history for a subnet that changed hands", async () => {
    lakehouse();
    assert.notEqual((await restOwnership()).count, 0);
    assert.notEqual((await mcpOwnership()).count, 0);
    assert.notEqual((await graphqlOwnership()).count, 0);
  });
});
