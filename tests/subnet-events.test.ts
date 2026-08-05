import assert from "node:assert/strict";
import { test } from "vitest";
import { handleRequest } from "../workers/api.ts";
import { EVENTS_CSV_COLUMNS } from "../workers/request-handlers/entities.ts";

function req(path: string) {
  return new Request(`https://api.metagraph.sh${path}`);
}

test("GET /subnets/{netuid}/events rejects an unsupported query param", async () => {
  const res = await handleRequest(
    req("/api/v1/subnets/7/events?bogus=1"),
    {} as unknown as Env,
    {},
  );
  assert.equal(res.status, 400);
});

// Derived, not restated (#9537): a hand-written copy of this header is exactly
// how price_at_tx/price_basis stayed missing from the CSV export while the JSON
// contract published them -- the literal agreed with the bug.
const EVENTS_CSV_HEADER = EVENTS_CSV_COLUMNS.join(",");

test("GET /subnets/{netuid}/events?format=csv emits a header-only CSV when cold", async () => {
  const res = await handleRequest(
    req("/api/v1/subnets/7/events?format=csv"),
    {} as unknown as Env,
    {},
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/csv/);
  assert.equal((await res.text()).trim(), EVENTS_CSV_HEADER);
});

test("GET /subnets/{netuid}/events is schema-stable when D1 is cold (never 404)", async () => {
  const res = await handleRequest(
    req("/api/v1/subnets/7/events"),
    {} as unknown as Env,
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.netuid, 7);
  assert.equal(body.data.event_count, 0);
  assert.equal(Array.isArray(body.data.events), true);
});

test("GET /subnets/{netuid}/event-summary rejects bad window", async () => {
  const res = await handleRequest(
    req("/api/v1/subnets/7/event-summary?window=1y"),
    {} as unknown as Env,
    {},
  );
  assert.equal(res.status, 400);
});
