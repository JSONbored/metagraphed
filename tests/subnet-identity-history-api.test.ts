import assert from "node:assert/strict";
import { test } from "vitest";
import { createLocalArtifactEnv } from "../scripts/lib.ts";
import { handleRequest } from "../workers/api.ts";
import type { Row } from "./row-type.ts";

function req(path: string) {
  return new Request(`https://api.metagraph.sh${path}`);
}

// D1 fully eliminated (2026-07-16): subnet_identity_history's D1 write/read
// path is fully retired -- handleSubnetIdentityHistory now goes
// tryDataApiTier -> buildSubnetIdentityHistory([], ...) on any miss/outage,
// never a live store read.
// REMOVED (#10190): "returns the identity timeline (#1647)". It served the
// timeline by stubbing DATA_API behind METAGRAPH_SUBNET_IDENTITY_SOURCE
// ="postgres" -- retired everywhere and absent from FORWARDABLE_TIER_FLAGS, so
// that arm declined on every real request and the MIAO row it asserted existed
// only in this test. The route's real leg is the lakehouse cold tier through
// src/identity-history-answer.ts; the schema-stable cold shape is pinned by the
// test below, and a populated timeline becomes assertable again when
// subnet_identity_history is restored as a Neon lane (#10706's sibling work).

test("GET /subnets/{netuid}/identity-history rejects an unsupported query param", async () => {
  const res = await handleRequest(
    req("/api/v1/subnets/86/identity-history?bogus=1"),
    {} as unknown as Env,
    {},
  );
  assert.equal(res.status, 400);
});

test("GET /subnets/{netuid}/identity-history is schema-stable when cold (no Postgres tier flag)", async () => {
  const res = await handleRequest(
    req("/api/v1/subnets/86/identity-history"),
    {} as unknown as Env,
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.netuid, 86);
  assert.equal(body.data.entry_count, 0);
  assert.deepEqual(body.data.entries, []);
});

// previously_known_as HAS NO SOURCE (#10706), and these tests now say so.
//
// They populated the overlay by stubbing DATA_API behind
// METAGRAPH_SUBNET_IDENTITY_SOURCE="postgres". That flag is retired everywhere
// and absent from FORWARDABLE_TIER_FLAGS, so the alias read declined on every
// real request -- the field has been empty in production since the flag was
// retired, on all three routes that publish it. Nothing writes
// subnet_identity_history at all: D1 was its primary writer and the Postgres
// mirror went through this same flag.
//
// So these assert the honest current behaviour. The SHAPING logic they used to
// demonstrate is covered directly, with 17 assertions over
// derivePreviouslyKnownAs / deriveNetuidGroupedAliases / overlayPreviouslyKnownAs
// in tests/subnet-identity-history.test.ts. When the Neon lane lands, these are
// the tests to restore to a populated overlay.

test("GET /subnets/{netuid} publishes no previously_known_as overlay on the subnet detail (#10706)", async () => {
  const env = createLocalArtifactEnv({});
  const res = await handleRequest(
    req("/api/v1/subnets/7"),
    env as unknown as Env,
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  // No source, so no overlay (#10706).
  assert.equal(body.data.subnet?.previously_known_as, undefined);
});

test("GET /subnets/{netuid} publishes no previously_known_as overlay on flat subnet detail (#10706)", async () => {
  const env = createLocalArtifactEnv({
    METAGRAPH_ARCHIVE: {
      async get(key: string) {
        if (!String(key).includes("subnets/7.json")) return null;
        return {
          async json() {
            return {
              schema_version: 1,
              generated_at: "2026-06-12T21:00:00.000Z",
              netuid: 7,
              name: "Allways",
              endpoints: [],
            };
          },
          async text() {
            return JSON.stringify({
              schema_version: 1,
              generated_at: "2026-06-12T21:00:00.000Z",
              netuid: 7,
              name: "Allways",
              endpoints: [],
            });
          },
        };
      },
    },
  });
  const res = await handleRequest(
    req("/api/v1/subnets/7"),
    env as unknown as Env,
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  // No source, so no overlay (#10706).
  assert.equal(body.data.previously_known_as, undefined);
  assert.equal(body.data.subnet, undefined);
});

test("GET /agent-catalog publishes no previously_known_as overlay on index entries (#10706)", async () => {
  const env = createLocalArtifactEnv({});
  const res = await handleRequest(
    req("/api/v1/agent-catalog"),
    env as unknown as Env,
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  const subnet = (body.data.subnets as Row[]).find(
    (entry) => entry.netuid === 7,
  );
  assert.ok(subnet);
  // No source, so no overlay (#10706).
  assert.equal(subnet.previously_known_as, undefined);
});

test("GET /agent-catalog/{netuid} publishes no previously_known_as overlay on the detail entry (#10706)", async () => {
  const env = createLocalArtifactEnv({});
  const res = await handleRequest(
    req("/api/v1/agent-catalog/7"),
    env as unknown as Env,
    {},
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  // No source, so no overlay (#10706).
  assert.equal(body.data.previously_known_as, undefined);
});

// The D1 alias-query tracker went with the three tests that used it (#10190):
// there is no D1 to assert was left unqueried.

// THREE TESTS REMOVED HERE (#10190/#10706). All three drove the alias overlay
// through METAGRAPH_SUBNET_IDENTITY_SOURCE="postgres" plus a DATA_API stub: two
// asserting it "serves the DATA_API response, the store never queried", one asserting it
// degrades when that stub fails. The flag forwards nowhere, there is no D1 left to
// leave unqueried, and the degrade case is now simply the only case -- asserted by
// the four overlay tests above. Restore them against a real source when
// subnet_identity_history becomes a Neon lane.
