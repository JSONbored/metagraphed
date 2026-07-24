import assert from "node:assert/strict";
import { test } from "vitest";
import { handleRequest } from "../workers/api.ts";
import { createLocalArtifactEnv } from "../scripts/lib.ts";

// #5745: ?format=csv on GET /api/v1/validators/{hotkey}/nominators, mirroring
// the accounts-list / global-validators CSV-export convention.
const HOTKEY = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";
const CSV_HEADER =
  "coldkey,staked_tao,unstaked_tao,net_staked_tao,gross_staked_tao,event_count,last_observed_at";

function req(path: string, init?: RequestInit) {
  return new Request(`https://api.metagraph.sh${path}`, init);
}

test("GET /validators/{hotkey}/nominators?format=csv emits a header-only CSV when there are no nominators (cold)", async () => {
  const res = await handleRequest(
    req(`/api/v1/validators/${HOTKEY}/nominators?format=csv`),
    {} as unknown as Env,
    {},
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/csv/);
  assert.equal((await res.text()).trim(), CSV_HEADER);
});

test("GET /validators/{hotkey}/nominators?format=csv exports the ranked nominator rows via the Postgres tier", async () => {
  const env = {
    ...createLocalArtifactEnv(),
    METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
    DATA_API: {
      fetch: async () =>
        Response.json({
          data: {
            schema_version: 1,
            hotkey: HOTKEY,
            window: "30d",
            sort: "net_staked",
            limit: 20,
            offset: 0,
            nominator_count: 1,
            nominators: [
              {
                coldkey: "5CoLdKeyExampleAddress000000000000000000000000",
                staked_tao: 1200.5,
                unstaked_tao: 200.25,
                net_staked_tao: 1000.25,
                gross_staked_tao: 1400.75,
                event_count: 7,
                last_observed_at: new Date(1750000000000).toISOString(),
              },
            ],
          },
          generatedAt: new Date(1750000000000).toISOString(),
        }),
    },
  };
  const res = await handleRequest(
    req(`/api/v1/validators/${HOTKEY}/nominators?format=csv&window=30d`),
    env as unknown as Env,
    {},
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/csv/);
  const lines = (await res.text()).trim().split("\r\n");
  assert.equal(lines[0], CSV_HEADER);
  assert.equal(lines.length, 2);
  assert.match(
    lines[1],
    /^5CoLdKeyExampleAddress[0]+,1200\.5,200\.25,1000\.25,1400\.75,7,/,
  );
});

test("GET /validators/{hotkey}/nominators rejects an invalid ?format with 400", async () => {
  const res = await handleRequest(
    req(`/api/v1/validators/${HOTKEY}/nominators?format=xml`),
    {} as unknown as Env,
    {},
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, "invalid_query");
});
