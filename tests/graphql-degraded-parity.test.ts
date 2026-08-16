// GraphQL answered a failed proxied read with an ERROR where REST and MCP
// answered with a marked empty (#11423).
//
// Measured live on 2026-08-16, same route and same instant:
//
//   MCP      get_subnet_lease_history(64)  -> 200, count 0, lease_events [],
//                                            degraded { reason tier_unavailable }
//   GraphQL  subnet_lease_history(netuid:64) -> data null, errors [503]
//
// It is the ONE operation the latency sweep reports as "did not answer", and
// the cause is that `fetchAllEventsTier` rethrows where the other two surfaces
// fall to `degradedChainEventsPayload`. The resolvers were written expecting
// otherwise -- `subnet_lease_history` ends `?? empty` and its siblings spell
// `data?.field ?? default` throughout -- so those fallbacks were unreachable.
import assert from "node:assert/strict";
import { describe, test } from "vitest";

import {
  markedChainEventsPayload,
  markedChainEventsPayloadOrThrow,
  TIER_UNAVAILABLE_REASON,
} from "../src/chain-events-degraded.ts";
import { handleGraphQLRequest } from "../src/graphql.ts";

/** A DATA_API binding that fails the way the live one did: a 503. */
const failingDataApi = {
  fetch: async () => new Response("upstream down", { status: 503 }),
};

/**
 * No lakehouse token, so the cold tier declines too and the degraded fallback
 * is the arm under test. With one bound, the cold tier would answer and this
 * would prove nothing about the fallback.
 */
const ENV = {
  METAGRAPH_ACCOUNT_EVENTS_SOURCE: "data-api",
  DATA_API: failingDataApi,
} as unknown as Env;

async function gql(query: string) {
  const res = await handleGraphQLRequest(
    new Request("https://api.test/api/v1/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query }),
    }),
    ENV,
  );
  return (await res.json()) as {
    data?: Record<string, Record<string, unknown>>;
    errors?: unknown[];
  };
}

describe("a failed proxied read ANSWERS on GraphQL, as it does on REST and MCP", () => {
  test("subnet_lease_history returns a marked empty, not a 503", async () => {
    const body = await gql(
      "{ subnet_lease_history(netuid: 64) { schema_version netuid count lease_events { event_kind } degraded { reason } } }",
    );
    assert.equal(
      body.errors,
      undefined,
      "this route used to be the one operation the sweep called unanswerable",
    );
    const out = body.data?.subnet_lease_history;
    assert.ok(out);
    assert.equal(out.count, 0);
    assert.deepEqual(out.lease_events, []);
    // The marker is what makes the zero honest -- without it this would be the
    // confident empty, which is a different bug rather than a fix.
    assert.deepEqual(out.degraded, { reason: TIER_UNAVAILABLE_REASON });
  });

  test("subnet_conviction answers and carries the marker too", async () => {
    const body = await gql(
      "{ subnet_conviction(netuid: 64) { schema_version netuid count degraded { reason } } }",
    );
    assert.equal(body.errors, undefined);
    const out = body.data?.subnet_conviction;
    assert.ok(out);
    assert.deepEqual(out.degraded, { reason: TIER_UNAVAILABLE_REASON });
  });

  test("subnet_ownership_history answers and carries the marker too", async () => {
    const body = await gql(
      "{ subnet_ownership_history(netuid: 64) { schema_version netuid count degraded { reason } } }",
    );
    assert.equal(body.errors, undefined);
    const out = body.data?.subnet_ownership_history;
    assert.ok(out);
    assert.deepEqual(out.degraded, { reason: TIER_UNAVAILABLE_REASON });
  });

  test("the three surfaces read the SAME map, so their empties cannot drift", () => {
    // The shared helper REST's proxy, MCP's `degradedDataApiRead` and
    // GraphQL's `fetchAllEventsTier` all now call. Asserting the map directly
    // is what makes "the same empty" a fact rather than three coincidences.
    const marked = markedChainEventsPayload("/api/v1/subnets/64/lease/history");
    assert.ok(marked);
    assert.deepEqual(marked.degraded, { reason: TIER_UNAVAILABLE_REASON });
    assert.equal(marked.count, 0);
  });

  test("an UNMAPPED path keeps its error rather than inventing an empty", () => {
    // Non-vacuity, and the guard the map's own header asks for: a seventh
    // proxied route added without a map entry must fail loudly instead of
    // serving an empty that satisfies no schema.
    assert.equal(markedChainEventsPayload("/api/v1/not/a/proxied/route"), null);
  });

  test("the OR-THROW form answers a mapped path and rethrows an unmapped one", () => {
    // Both arms of the decision a failing reader makes. It lives in this
    // module rather than inside GraphQL's `catch` precisely so the rethrow is
    // reachable: at the call site every path is a literal the map covers, so
    // that arm could never be exercised there.
    const boom = new Error("upstream down");
    const answered = markedChainEventsPayloadOrThrow(
      "/api/v1/subnets/64/lease/history",
      boom,
    );
    assert.deepEqual(answered.degraded, { reason: TIER_UNAVAILABLE_REASON });

    assert.throws(
      () => markedChainEventsPayloadOrThrow("/api/v1/not/proxied", boom),
      /upstream down/,
      "an unmapped path must keep the failure that brought it here",
    );
  });
});
