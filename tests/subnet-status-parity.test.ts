import assert from "node:assert/strict";
import { afterAll, beforeAll, test } from "vitest";
import { Miniflare } from "miniflare";
import { loadSubnetStatus } from "../src/subnet-status-read.ts";
import { handleSubnetHyperparams } from "../workers/request-handlers/entities.ts";
import { handleGraphQLRequest } from "../src/graphql.ts";
import { MCP_TOOLS } from "../src/mcp-server.ts";
import { buildSubnetHyperparams } from "../src/subnet-hyperparams.ts";

const runtime = new Miniflare({
  modules: true,
  script: "export default {fetch(){return new Response('fixture')}}",
  compatibilityDate: "2026-06-06",
  d1Databases: ["STATE"],
});
let db: D1Database;
beforeAll(async () => {
  db = (await runtime.getD1Database("STATE")) as unknown as D1Database;
  await db.exec(
    "CREATE TABLE subnet_lifecycle (id INTEGER PRIMARY KEY,netuid INTEGER,event TEXT,block_number INTEGER,observed_at INTEGER,predates_capture INTEGER,_invalidated_at INTEGER)",
  );
});
afterAll(() => runtime.dispose());
function env(extra: Record<string, unknown> = {}) {
  return {
    D1_STATE: db,
    D1_STATE_TABLES: "subnet_lifecycle",
    METAGRAPH_SUBNET_HYPERPARAMS_SOURCE: "data-api",
    DATA_API: {
      fetch: async () => Response.json(buildSubnetHyperparams(null, 19)),
    },
    ...extra,
  } as unknown as Env;
}
async function cards(e: Env) {
  const response = await handleSubnetHyperparams(
    new Request("https://api.metagraph.sh/api/v1/subnets/19/hyperparameters"),
    e,
    19,
  );
  const rest = ((await response.json()) as { data: Record<string, unknown> })
    .data;
  const mcp = (await MCP_TOOLS.find(
    (t) => t.name === "get_subnet_hyperparams",
  )!.handler({ netuid: 19 }, { env: e } as never)) as Record<string, unknown>;
  const result = await handleGraphQLRequest(
    new Request("https://api.metagraph.sh/api/v1/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: "{ subnet_hyperparameters(netuid:19) { netuid subnet_status } }",
      }),
    }),
    e,
  );
  const gql = (await result.json()) as {
    errors?: unknown;
    data: { subnet_hyperparameters: Record<string, unknown> };
  };
  assert.equal(gql.errors, undefined);
  assert.equal(rest.subnet_status, mcp.subnet_status);
  assert.equal(
    rest.subnet_status,
    gql.data.subnet_hyperparameters.subnet_status,
  );
  return rest.subnet_status;
}
test("REST, GraphQL and MCP share the latest valid lifecycle status", async () => {
  assert.equal(await cards(env()), null);
  await db
    .prepare(
      "INSERT INTO subnet_lifecycle VALUES (1,19,'registered',NULL,100,1,NULL)",
    )
    .run();
  assert.equal(await cards(env()), "live");
  await db
    .prepare(
      "INSERT INTO subnet_lifecycle VALUES (2,19,'deregistered',99,200,0,NULL)",
    )
    .run();
  assert.equal(await cards(env()), "deregistered");
  await db
    .prepare("UPDATE subnet_lifecycle SET _invalidated_at=300 WHERE id=2")
    .run();
  assert.equal(await cards(env()), "live");
});
test("missing or failed lifecycle ownership remains explicitly unknown on every surface", async () => {
  assert.equal(
    await cards(env({ D1_STATE_TABLES: undefined, D1_STATE: undefined })),
    null,
  );
  assert.equal(await cards(env({ D1_STATE: undefined })), null);
  assert.equal(await loadSubnetStatus(null, 19), null);
});
