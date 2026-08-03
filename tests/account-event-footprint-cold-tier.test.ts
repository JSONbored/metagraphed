// The per-account AxonServed / NeuronRegistered footprints, from the lakehouse.
//
// /accounts/{ss58}/serving and /accounts/{ss58}/registrations were the two
// account_events feeds with no cold-tier reader, so they served schema-stable
// zeros for every account while their siblings answered from the lakehouse.
//
// The interesting property is which PREDICATE they use. The weight-setters
// reader resolves `(netuid, uid)` slots because WeightsSet has a NULL hotkey on
// every row; these two do not, because AxonServed and NeuronRegistered carry a
// populated hotkey. Borrowing the slot path here would attribute rows by neuron
// slot rather than by account -- a subtly wrong answer that still looks
// plausible, since a slot the account once held may now belong to someone else.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  loadAccountRegistrationsColdTier,
  loadAccountServingColdTier,
} from "../src/account-feeds-cold-tier.ts";

const SS58 = "5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ5u";

function stubQuery(rows: Record<string, unknown>[] | null) {
  const seen: string[] = [];
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    seen.push(String(body.query ?? ""));
    return {
      ok: true,
      status: 200,
      json: async () =>
        rows === null
          ? { success: false, errors: ["boom"] }
          : { success: true, result: { rows } },
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return seen;
}

const ENV = { R2_SQL_TOKEN: "cfut_test" } as never;

describe("the per-account event footprints", () => {
  test("serving filters by hotkey, not by neuron slot", async () => {
    // AxonServed carries a real hotkey, so the account IS the hotkey. The slot
    // path exists only to work around WeightsSet's NULL hotkey; using it here
    // would credit this account with rows from whoever holds the slot now.
    const seen = stubQuery([
      { netuid: 4, announcements: 12, first_observed: 1, last_observed: 2 },
    ]);
    const result = await loadAccountServingColdTier(ENV, SS58, {
      window: "30d",
    });
    assert.ok(result);
    assert.match(seen[0], /event_kind = 'AxonServed'/);
    assert.ok(seen[0].includes(`hotkey = '${SS58}'`));
    assert.doesNotMatch(
      seen[0],
      /\(netuid, uid\) IN/,
      "this feed must not use the WeightsSet slot workaround",
    );
  });

  test("registrations counts NeuronRegistered under its own alias", async () => {
    // buildAccountRegistrations reads row.registrations; the serving builder
    // reads row.announcements. A shared alias would leave one of them reading
    // undefined and reporting an empty footprint rather than failing.
    const seen = stubQuery([
      { netuid: 9, registrations: 3, first_observed: 1, last_observed: 2 },
    ]);
    const result = await loadAccountRegistrationsColdTier(ENV, SS58, {});
    assert.ok(result);
    assert.match(seen[0], /event_kind = 'NeuronRegistered'/);
    assert.match(seen[0], /AS registrations/);
  });

  test("each feed groups by netuid, as its builder expects", async () => {
    for (const load of [
      loadAccountServingColdTier,
      loadAccountRegistrationsColdTier,
    ]) {
      const seen = stubQuery([]);
      await load(ENV, SS58, {});
      assert.match(seen[0], /GROUP BY netuid/);
      assert.match(seen[0], /MIN\(observed_at\) AS first_observed/);
      assert.match(seen[0], /MAX\(observed_at\) AS last_observed/);
    }
  });

  test("an unparseable address declines without querying", async () => {
    // safeSs58Literal refuses rather than escapes; R2 SQL has no bound
    // parameters, so a rejected address must never reach the string.
    for (const bad of ["not-an-address", "'; DROP TABLE--", ""]) {
      const seen = stubQuery([]);
      assert.equal(await loadAccountServingColdTier(ENV, bad, {}), null);
      assert.deepEqual(seen, [], `${bad} must not reach SQL`);
    }
  });

  test("a failed query declines so the caller keeps its zeroed payload", async () => {
    stubQuery(null);
    assert.equal(await loadAccountServingColdTier(ENV, SS58, {}), null);
    stubQuery(null);
    assert.equal(await loadAccountRegistrationsColdTier(ENV, SS58, {}), null);
  });

  test("an empty footprint is an answer, not a decline", async () => {
    // An account that served nothing in the window is a real answer: the
    // builder renders zeros. Declining would fall through to the same zeros
    // but lose the generated_at the caller reports.
    stubQuery([]);
    const result = await loadAccountServingColdTier(ENV, SS58, {});
    assert.ok(result, "an empty result must still be an answer");
    assert.equal(result.generatedAt, null);
  });
});
