import assert from "node:assert/strict";
import { test } from "vitest";
import { handleRequest } from "../workers/api.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.ts";

// #5746: ?format=csv on the block-scoped extrinsics/events feeds, reusing the
// unscoped/account-scoped siblings' CSV-columns constants (same row shapes).
const REF = "8621331";
const EXTRINSICS_CSV_HEADER =
  "extrinsic_id,block_number,signer,call_module,call_function,success";
const EVENTS_CSV_HEADER =
  "block_number,event_index,event_kind,hotkey,coldkey,netuid,uid,amount_tao,alpha_amount,observed_at,extrinsic_index";

function req(path: string, init?: RequestInit) {
  return new Request(`https://api.metagraph.sh${path}`, init);
}

test("GET /blocks/{ref}/extrinsics?format=csv emits a header-only CSV for an empty block", async () => {
  const res = await handleRequest(
    req(`/api/v1/blocks/${REF}/extrinsics?format=csv`),
    {},
    {},
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/csv/);
  assert.equal((await res.text()).trim(), EXTRINSICS_CSV_HEADER);
});

test("GET /blocks/{ref}/extrinsics?format=csv exports the block's extrinsics via the Postgres tier", async () => {
  const env = {
    ...createLocalArtifactEnv(),
    METAGRAPH_EXTRINSICS_SOURCE: "postgres",
    DATA_API: {
      fetch: async () =>
        Response.json({
          data: {
            block_number: Number(REF),
            extrinsics: [
              {
                block_number: Number(REF),
                extrinsic_index: 0,
                signer: "5Signer",
                call_module: "SubtensorModule",
                call_function: "set_weights",
                success: true,
              },
            ],
          },
        }),
    },
  };
  const res = await handleRequest(
    req(`/api/v1/blocks/${REF}/extrinsics?format=csv`),
    env,
    {},
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/csv/);
  const lines = (await res.text()).trim().split("\r\n");
  assert.equal(lines[0], EXTRINSICS_CSV_HEADER);
  assert.equal(lines.length, 2);
  assert.match(
    lines[1],
    /^8621331-0,8621331,5Signer,SubtensorModule,set_weights,/,
  );
});

test("GET /blocks/{ref}/extrinsics rejects an invalid ?format with 400", async () => {
  const res = await handleRequest(
    req(`/api/v1/blocks/${REF}/extrinsics?format=xml`),
    {},
    {},
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, "invalid_query");
});

test("GET /blocks/{ref}/events?format=csv emits a header-only CSV for an empty block", async () => {
  const res = await handleRequest(
    req(`/api/v1/blocks/${REF}/events?format=csv`),
    {},
    {},
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/csv/);
  assert.equal((await res.text()).trim(), EVENTS_CSV_HEADER);
});

test("GET /blocks/{ref}/events?format=csv exports the block's events via the Postgres tier", async () => {
  const env = {
    ...createLocalArtifactEnv(),
    METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
    DATA_API: {
      fetch: async () =>
        Response.json({
          data: {
            block_number: Number(REF),
            events: [
              {
                block_number: Number(REF),
                event_index: 0,
                event_kind: "Transfer",
                hotkey: "5Hot",
                coldkey: "5Cold",
                netuid: 1,
                uid: 0,
                amount_tao: 10.5,
                alpha_amount: null,
                observed_at: 1750000000000,
                extrinsic_index: 0,
              },
            ],
          },
        }),
    },
  };
  const res = await handleRequest(
    req(`/api/v1/blocks/${REF}/events?format=csv`),
    env,
    {},
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/csv/);
  const lines = (await res.text()).trim().split("\r\n");
  assert.equal(lines[0], EVENTS_CSV_HEADER);
  assert.equal(lines.length, 2);
  assert.match(lines[1], /^8621331,0,Transfer,5Hot,5Cold,1,0,10\.5,/);
});

test("GET /blocks/{ref}/events rejects an invalid ?format with 400", async () => {
  const res = await handleRequest(
    req(`/api/v1/blocks/${REF}/events?format=xml`),
    {},
    {},
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, "invalid_query");
});
