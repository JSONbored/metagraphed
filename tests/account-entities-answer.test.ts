// The composer for /api/v1/accounts/{ss58}/entities (#9313).
//
// Two sources answer this route and they say different things. The transfer
// stream (SubnetOwnerChanged) knows who has TRADED a subnet — one event in all
// of chain history. The economics blob knows who OWNS one right now. Reading
// only the first reported `ownership_ties: 0` for coldkeys that plainly own a
// subnet, which a caller reads as "owns nothing" rather than "we did not look".
//
// So the composer resolves current ownership itself, and the property under
// test is that it keeps doing so INDEPENDENTLY of whether the transfer half
// answered: the ownership record must not disappear because the event stream
// declined.
import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";

// The artifact read is mocked so BOTH of its failure modes are reachable:
// readArtifact answers `{ ok: false }` for a miss or timeout, and THROWS when
// the binding it reaches for is absent. They arrive by different paths and both
// have to land on the same decline.
const storage = vi.hoisted(() => ({
  behaviour: { kind: "ok", data: undefined as unknown },
}));
vi.mock("../workers/storage.ts", () => ({
  readArtifact: async () => {
    if (storage.behaviour.kind === "throws") throw new TypeError("no binding");
    if (storage.behaviour.kind === "miss") return { ok: false };
    return { ok: true, data: storage.behaviour.data };
  },
}));

import { answerAccountEntities } from "../src/account-entities-answer.ts";
import type { SubnetOwnerSnapshot } from "../src/entity-labels.ts";

// Chutes' REAL owner coldkey, and it resolves: the address #9313 quoted
// (5FRYKhbmT3ij…, same eight-char prefix) fails SS58 checksum validation,
// so the endpoint answers invalid_ss58 for it rather than any tie count.
// A fixture that cannot exist invites a test that validates addresses to
// pass for the wrong reason.
const OWNER = "5FRYKhbmfXPDoHdUUDMx27E3HuMvAzwjzFMMq3rNurUhAyS9";
const CAPTURED = "2026-08-10T09:26:12.433Z";

const owners = (): SubnetOwnerSnapshot => ({
  rows: [
    { netuid: 64, owner_coldkey: OWNER },
    { netuid: 7, owner_coldkey: "someone-else" },
  ],
  captured_at: CAPTURED,
});

/** A tier that declines, which is what the retired Postgres leg does today. */
const declines = async () => null;

describe("current ownership survives a declining transfer tier", () => {
  test("the cold tier declining does NOT drop the owned ties", async () => {
    // The bug's shape: every store answered empty, so the payload said this
    // coldkey has no ties at all.
    const data = await answerAccountEntities(null, OWNER, null, {
      coldTier: declines,
      owners: async () => owners(),
    });
    assert.equal(data.ownership_tie_count, 1);
    const ties = data.ownership_ties as Array<Record<string, unknown>>;
    assert.equal(ties[0].netuid, 64);
    assert.equal(ties[0].role, "owns");
    assert.equal(data.owners_observed_at, CAPTURED);
  });

  test("a tier that ANSWERED keeps its transfers, and gains the owned ties", async () => {
    // The tier stays authoritative for what it read; this only adds the half it
    // never had access to.
    const transfer = {
      netuid: 7,
      role: "gained_ownership",
      block_number: 8587754,
      observed_at: "2026-07-09T12:26:40.000Z",
    };
    const data = await answerAccountEntities(
      null,
      OWNER,
      {
        schema_version: 1,
        ss58: OWNER,
        labels: [],
        ownership_tie_count: 1,
        ownership_ties: [transfer],
      },
      { coldTier: declines, owners: async () => owners() },
    );
    const ties = data.ownership_ties as Array<Record<string, unknown>>;
    assert.deepEqual(
      ties.map((t) => t.role),
      ["owns", "gained_ownership"],
    );
    // The count is RECOMPUTED, not carried over from the tier — a stale count
    // beside a longer list is the kind of quiet inconsistency this route had.
    assert.equal(data.ownership_tie_count, 2);
  });

  test("no owner snapshot leaves owners_observed_at NULL, not invented", async () => {
    // "Could not read who owns what" has to stay distinguishable from "owns
    // nothing", and this field is the only thing that separates them.
    const data = await answerAccountEntities(null, OWNER, null, {
      coldTier: declines,
      owners: async () => null,
    });
    assert.deepEqual(data.ownership_ties, []);
    assert.equal(data.owners_observed_at, null);
  });

  test("a tier answered but no snapshot: the tier's ties survive untouched", async () => {
    const transfer = { netuid: 7, role: "lost_ownership", block_number: 1 };
    const data = await answerAccountEntities(
      null,
      OWNER,
      {
        schema_version: 1,
        ss58: OWNER,
        labels: [],
        ownership_tie_count: 1,
        ownership_ties: [transfer],
      },
      { coldTier: declines, owners: async () => null },
    );
    assert.deepEqual(data.ownership_ties, [transfer]);
    assert.equal(data.owners_observed_at, null);
  });

  test("a coldkey owning nothing still reports WHEN we looked", async () => {
    const data = await answerAccountEntities(null, "nobody", null, {
      coldTier: declines,
      owners: async () => owners(),
    });
    assert.deepEqual(data.ownership_ties, []);
    assert.equal(data.owners_observed_at, CAPTURED);
  });

  test("a tier payload with no ties array is tolerated, not thrown on", async () => {
    // The tier result is an untrusted shape here — it crosses a module and a
    // store boundary — so a missing array must degrade rather than throw.
    const data = await answerAccountEntities(
      null,
      OWNER,
      { schema_version: 1, ss58: OWNER, labels: [] },
      { coldTier: declines, owners: async () => owners() },
    );
    assert.equal(data.ownership_tie_count, 1);
  });
});

describe("reading the economics artifact (#9313)", () => {
  const read = async () =>
    await answerAccountEntities(null, OWNER, null, { coldTier: declines });

  test("a MISS declines rather than inventing an empty ownership set", async () => {
    storage.behaviour = { kind: "miss", data: undefined };
    const data = await read();
    assert.deepEqual(data.ownership_ties, []);
    assert.equal(data.owners_observed_at, null);
  });

  test("a THROW declines too -- this route has a schema-stable floor", async () => {
    // readArtifact does not swallow a missing binding; it throws. Letting that
    // propagate would turn a degradable read into a 500 on a route documented
    // to answer an empty payload once every store has declined.
    storage.behaviour = { kind: "throws", data: undefined };
    const data = await read();
    assert.deepEqual(data.ownership_ties, []);
    assert.equal(data.owners_observed_at, null);
  });

  test("a readable blob produces the owned ties", async () => {
    storage.behaviour = {
      kind: "ok",
      data: {
        captured_at: CAPTURED,
        subnets: [{ netuid: 64, owner_coldkey: OWNER }],
      },
    };
    const data = await read();
    assert.equal(data.ownership_tie_count, 1);
    assert.equal(data.owners_observed_at, CAPTURED);
  });
});
