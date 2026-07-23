import assert from "node:assert/strict";
import { test } from "vitest";
import { handleRequest } from "../workers/api.mjs";

function req(path: string) {
  return new Request(`https://api.metagraph.sh${path}`);
}

test("GET /subnets/{netuid}/events rejects an unsupported query param", async () => {
  const res = await handleRequest(
    req("/api/v1/subnets/7/events?bogus=1"),
    {},
    {},
  );
  assert.equal(res.status, 400);
});

const EVENTS_CSV_HEADER =
  "block_number,event_index,event_kind,hotkey,coldkey,netuid,uid,amount_tao,alpha_amount,observed_at,extrinsic_index";

test("GET /subnets/{netuid}/events?format=csv emits a header-only CSV when cold", async () => {
  const res = await handleRequest(
    req("/api/v1/subnets/7/events?format=csv"),
    {},
    {},
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/csv/);
  assert.equal((await res.text()).trim(), EVENTS_CSV_HEADER);
});

test("GET /subnets/{netuid}/events is schema-stable when D1 is cold (never 404)", async () => {
  const res = await handleRequest(req("/api/v1/subnets/7/events"), {}, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.netuid, 7);
  assert.equal(body.data.event_count, 0);
  assert.equal(Array.isArray(body.data.events), true);
});

test("GET /subnets/{netuid}/event-summary rejects bad window", async () => {
  const res = await handleRequest(
    req("/api/v1/subnets/7/event-summary?window=1y"),
    {},
    {},
  );
  assert.equal(res.status, 400);
});
