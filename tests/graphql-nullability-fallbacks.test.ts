// The fallbacks that keep a NON-NULL field non-null when the tier body is
// partial (#10786).
//
// graphql-js enforces non-null AT EXECUTION: one null in a non-null field
// nulls the whole surrounding object and attaches an error. The arms that
// could do that are the degraded ones -- a cold store, a tier body missing a
// field -- which is precisely where no probe reaches, because production is not
// degraded when you ask it. So they are driven here instead.
//
// `subnet_lease_history` is the case that has BOTH arms: its other leg is a
// DATA_API body, which this Worker does not build and therefore cannot vouch
// for. The cards whose value never leaves this Worker had their fallbacks
// DELETED rather than corrected -- the builder stamps those fields on every
// leg, so the fallback was an unreachable arm that made a non-null field
// nullable for nothing.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  SUBNET_LEASE_CREATED_KIND,
  SUBNET_LEASE_TERMINATED_KIND,
} from "../src/subnet-lease-history.ts";
import { handleGraphQLRequest } from "../src/graphql.ts";

type Row = Record<string, unknown>;

async function gql(query: string, env: Row) {
  const request = new Request("https://api.metagraph.sh/api/v1/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const response = await handleGraphQLRequest(request, env as never);
  return { status: response.status, body: (await response.json()) as Row };
}

/** A DATA_API binding that answers every path with one body. */
function dataApi(body: unknown) {
  return { DATA_API: { fetch: async () => Response.json(body) } };
}

const QUERY =
  "{ subnet_lease_history(netuid: 9) { schema_version netuid count event_pallet event_kinds } }";

describe("subnet_lease_history — the vocabulary fields stay non-null", () => {
  test("the tier's own values are served, not overwritten by the fallback", async () => {
    // The LEFT arm. A tier that carries the vocabulary must win: falling back
    // unconditionally would hide a tier that had started answering something
    // else, which is the drift this pair of fields exists to make visible.
    const { status, body } = await gql(
      QUERY,
      dataApi({
        schema_version: 1,
        netuid: 9,
        count: 0,
        event_pallet: "SomeOtherPallet",
        event_kinds: ["OnlyOne"],
        lease_events: [],
      }),
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual((body.data as Row).subnet_lease_history, {
      schema_version: 1,
      netuid: 9,
      count: 0,
      event_pallet: "SomeOtherPallet",
      event_kinds: ["OnlyOne"],
    });
  });

  test("a tier body missing them falls back to the builder, never to null", async () => {
    // The RIGHT arm, and the bug: `?? null` here answered null for two fields
    // the components declare non-null, so after the #10214 cutover this body
    // would have nulled the WHOLE card and attached an error.
    const { status, body } = await gql(
      QUERY,
      dataApi({ schema_version: 1, netuid: 9, count: 0, lease_events: [] }),
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    const card = (body.data as Row).subnet_lease_history as Row;
    assert.equal(card.event_pallet, "SubtensorModule");
    assert.deepEqual(card.event_kinds, [
      SUBNET_LEASE_CREATED_KIND,
      SUBNET_LEASE_TERMINATED_KIND,
    ]);
  });

  test("a null tier body answers the builder's empty card, not a null card", async () => {
    // `fetchAllEventsTier` is typed `Row | null` because a tier CAN hand back a
    // null JSON body. That arm used to reach the return with `data` null and
    // every `data?.x ?? null` resolving to null.
    const { status, body } = await gql(QUERY, dataApi(null));
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual((body.data as Row).subnet_lease_history, {
      schema_version: 1,
      netuid: 9,
      count: 0,
      event_pallet: "SubtensorModule",
      event_kinds: [SUBNET_LEASE_CREATED_KIND, SUBNET_LEASE_TERMINATED_KIND],
    });
  });
});
