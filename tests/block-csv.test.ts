import assert from "node:assert/strict";
import { lakehouse, LAKEHOUSE_ENV } from "./helpers/cold-tier-env.ts";
import { test } from "vitest";
import { handleRequest } from "../workers/api.ts";
import { createLocalArtifactEnv } from "../scripts/lib.ts";
import { EVENTS_CSV_COLUMNS } from "../workers/request-handlers/entities.ts";

// #5746: ?format=csv on the block-scoped extrinsics/events feeds, reusing the
// unscoped/account-scoped siblings' CSV-columns constants (same row shapes).
const REF = "8621331";
const EXTRINSICS_CSV_HEADER =
  "extrinsic_id,block_number,signer,call_module,call_function,success";
// Derived, not restated (#9537): a hand-written copy of this header is exactly
// how price_at_tx/price_basis stayed missing from the CSV export while the JSON
// contract published them -- the literal agreed with the bug.
const EVENTS_CSV_HEADER = EVENTS_CSV_COLUMNS.join(",");

function req(path: string, init?: RequestInit) {
  return new Request(`https://api.metagraph.sh${path}`, init);
}

test("GET /blocks/{ref}/extrinsics?format=csv emits a header-only CSV for an empty block", async () => {
  const res = await handleRequest(
    req(`/api/v1/blocks/${REF}/extrinsics?format=csv`),
    {} as unknown as Env,
    {},
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/csv/);
  assert.equal((await res.text()).trim(), EXTRINSICS_CSV_HEADER);
});

test("GET /blocks/{ref}/extrinsics?format=csv exports the block's extrinsics via the Postgres tier", async () => {
  // #10190: METAGRAPH_EXTRINSICS_SOURCE reads "retired" in wrangler.jsonc and is
  // absent from DATA_API_FORWARD_FLAGS, so the tier this doubled was never asked.
  // The per-block extrinsics come from the lakehouse, through the same builder --
  // so the CSV below is produced from lakehouse rows exactly as in production.
  const lake = lakehouse([
    {
      block_number: Number(REF),
      extrinsic_index: 0,
      extrinsic_hash: `0x${"a".repeat(64)}`,
      signer: "5Signer",
      call_module: "SubtensorModule",
      call_function: "set_weights",
      success: true,
      fee_tao: 0,
      tip_tao: 0,
      call_args: null,
      observed_at: 1_750_009_000_000,
    },
  ]);
  const env = { ...createLocalArtifactEnv(), ...LAKEHOUSE_ENV };
  const res = await handleRequest(
    req(`/api/v1/blocks/${REF}/extrinsics?format=csv`),
    env as unknown as Env,
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
  lake.restore();
});

test("GET /blocks/{ref}/extrinsics rejects an invalid ?format with 400", async () => {
  const res = await handleRequest(
    req(`/api/v1/blocks/${REF}/extrinsics?format=xml`),
    {} as unknown as Env,
    {},
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, "invalid_query");
});

test("GET /blocks/{ref}/events?format=csv emits a header-only CSV for an empty block", async () => {
  const res = await handleRequest(
    req(`/api/v1/blocks/${REF}/events?format=csv`),
    {} as unknown as Env,
    {},
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/csv/);
  assert.equal((await res.text()).trim(), EVENTS_CSV_HEADER);
});

test("GET /blocks/{ref}/events?format=csv exports the block's events via the Postgres tier", async () => {
  // #10190: METAGRAPH_EXTRINSICS_SOURCE reads "retired" in wrangler.jsonc and is
  // absent from DATA_API_FORWARD_FLAGS, so the tier this doubled was never asked.
  // The per-block events come from the lakehouse, through the same builder --
  // so the CSV below is produced from lakehouse rows exactly as in production.
  const lake = lakehouse([
    {
      block_number: Number(REF),
      event_index: 0,
      event_kind: "Transfer",
      hotkey: "5Hot",
      coldkey: "5Cold",
      netuid: 1,
      uid: 0,
      amount_tao: 10.5,
      observed_at: 1_750_009_000_000,
    },
  ]);
  const env = { ...createLocalArtifactEnv(), ...LAKEHOUSE_ENV };
  const res = await handleRequest(
    req(`/api/v1/blocks/${REF}/events?format=csv`),
    env as unknown as Env,
    {},
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/csv/);
  const lines = (await res.text()).trim().split("\r\n");
  assert.equal(lines[0], EVENTS_CSV_HEADER);
  assert.equal(lines.length, 2);
  assert.match(lines[1], /^8621331,0,Transfer,5Hot,5Cold,1,0,10\.5,/);
  lake.restore();
});

test("GET /blocks/{ref}/events rejects an invalid ?format with 400", async () => {
  const res = await handleRequest(
    req(`/api/v1/blocks/${REF}/events?format=xml`),
    {} as unknown as Env,
    {},
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, "invalid_query");
});
