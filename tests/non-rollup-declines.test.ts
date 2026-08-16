// The two readers that reach the lakehouse WITHOUT the shared rollup (#11424).
//
// #11417/#11428 fixed `chain-event-rollup-cold-tier.ts` and its seven
// consumers. These two get there by other paths and had the identical defect: a
// failed read published as data.
//
// Both were measured sitting AT the 15s `QUERY_TIMEOUT_MS` on 2026-08-16 --
// `/accounts/{ss58}/stake-moves` at 15,429ms and `/blocks/{ref}` at 15,085ms --
// so the decline is routine, not exotic.
//
// The contrast cases carry the weight here, as they did in #11428: an answer
// and a deployment with no lakehouse must stay UNMARKED, or the marker is noise.
import assert from "node:assert/strict";
import { describe, test } from "vitest";

import { loadAccountStakeMovesColdTier } from "../src/account-feeds-cold-tier.ts";
import { loadBlockFromR2Sql } from "../src/r2-sql-blocks.ts";
import { answerAccountEntities } from "../src/account-entities-answer.ts";
import { DEGRADED_UNAVAILABLE } from "../src/uncurated-event-streams.ts";
import { LAKEHOUSE_ENV } from "./helpers/cold-tier-env.ts";

const SS58 = "5F4tQyWrhfGVcNhoqeiNsR6KjD4wMZ2kfhLj4oHYuyHbZAc3";
const DEGRADED = { reason: DEGRADED_UNAVAILABLE };

/** A deployment WITH a lakehouse: the one where the rows exist. */
const CONFIGURED = LAKEHOUSE_ENV as never;
/** A self-hoster or CI: no lakehouse, so no rows to be wrong about. */
const UNCONFIGURED = {} as never;

function withFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = stub;
  return Promise.resolve(run()).finally(() => {
    globalThis.fetch = real;
  });
}

/** The transport refusing -- the shape a timeout takes by the time the reader
 * sees it. */
const refusing = (() => {
  throw new Error("lakehouse unreachable");
}) as unknown as typeof fetch;

/** The transport answering, with the rows given. */
const answering = (rows: unknown[]) =>
  (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: { rows } }),
    }) as unknown as Response) as unknown as typeof fetch;

describe("/accounts/{ss58}/stake-moves", () => {
  test("a failed read on a CONFIGURED lakehouse is marked, with NULL counts", async () => {
    const out = await withFetch(refusing, () =>
      loadAccountStakeMovesColdTier(CONFIGURED, SS58, { window: "30d" }),
    );
    assert.ok(out, "a decline still answers, it does not fall through");
    assert.deepEqual(out.data.degraded, DEGRADED);
    // NULL, not 0. `total_movements: 0` is a claim this account has never moved
    // stake, and after a failed read nobody knows that.
    assert.equal(out.data.total_movements, null);
    assert.equal(out.data.subnet_count, null);
    assert.deepEqual(out.data.subnets, []);
    // No read, so no reading instant.
    assert.equal(out.generatedAt, null);
    // Known without reading anything, so still reported.
    assert.equal(out.data.address, SS58);
    assert.equal(out.data.window, "30d");
  });

  test("the SAME failure with no lakehouse configured falls through unmarked", async () => {
    // A self-hoster has no chain history, so the caller's own empty card is
    // correct -- which is why `gap` cannot simply be the default.
    const out = await withFetch(refusing, () =>
      loadAccountStakeMovesColdTier(UNCONFIGURED, SS58, { window: "30d" }),
    );
    assert.equal(out, null);
  });

  test("an account that genuinely never moved stake is a MEASUREMENT", async () => {
    // The read succeeded and found nothing. Marking this would report a fault
    // that did not happen.
    const out = await withFetch(answering([]), () =>
      loadAccountStakeMovesColdTier(CONFIGURED, SS58, { window: "30d" }),
    );
    assert.ok(out);
    assert.equal("degraded" in out.data, false);
    assert.equal(out.data.total_movements, 0);
    assert.equal(out.data.subnet_count, 0);
  });

  test("a real answer is untouched, so this is not just declining everything", async () => {
    // Non-vacuity: a reader that marked everything would satisfy the above.
    const out = await withFetch(
      answering([
        {
          netuid: 7,
          movements: 3,
          first_observed: 1_780_000_000_000,
          last_observed: 1_785_000_000_000,
        },
      ]),
      () => loadAccountStakeMovesColdTier(CONFIGURED, SS58, { window: "30d" }),
    );
    assert.ok(out);
    assert.equal("degraded" in out.data, false);
    assert.equal(out.data.total_movements, 3);
    assert.equal(out.data.subnet_count, 1);
  });
});

describe("/blocks/{ref}", () => {
  test("a failed read is marked, and is NOT the same as no such block", async () => {
    const out = await withFetch(refusing, () =>
      loadBlockFromR2Sql(CONFIGURED, "8848204"),
    );
    assert.ok(out, "a decline still answers");
    assert.deepEqual(out.degraded, DEGRADED);
    assert.equal(out.block, null);
    assert.equal(out.ref, "8848204");
  });

  test("a CONFIRMED ABSENCE is a measurement and carries no marker", async () => {
    // The distinction this reader's own comment already insisted on -- "A
    // confirmed absence is an ANSWER" -- and which the caller used to discard
    // by rebuilding the same payload from a bare null. Both produce
    // `block: null`; only one of them is a fact.
    const out = await withFetch(answering([]), () =>
      loadBlockFromR2Sql(CONFIGURED, "8848204"),
    );
    assert.ok(out);
    assert.equal(out.block, null);
    assert.equal(
      "degraded" in out,
      false,
      "the store answered: this block does not exist",
    );
  });

  test("no lakehouse configured falls through unmarked", async () => {
    const out = await withFetch(refusing, () =>
      loadBlockFromR2Sql(UNCONFIGURED, "8848204"),
    );
    assert.equal(out, null);
  });

  test("a block that exists comes back untouched", async () => {
    const out = await withFetch(
      answering([{ block_number: 8_848_204, block_hash: "0xabc" }]),
      () => loadBlockFromR2Sql(CONFIGURED, "8848204"),
    );
    assert.ok(out);
    assert.equal("degraded" in out, false);
    assert.ok(out.block, "a real block is returned");
  });
});

describe("/accounts/{ss58}/entities -- a PARTIAL decline", () => {
  // This card composes TWO independent sources and only one is the lakehouse:
  // ownership ties come from the economics artifact, transfer-derived ties from
  // the cold tier. So a lakehouse timeout leaves REAL ownership data standing,
  // and the marker must not claim otherwise.
  const OWNERS = {
    rows: [
      { netuid: 7, owner_coldkey: SS58 },
      { netuid: 12, owner_coldkey: SS58 },
    ],
    captured_at: "2026-08-16T00:00:00.000Z",
  };

  /** The cold tier failing, and the owner artifact answering. */
  const declinedTier = async () => null;
  const owners = () => Promise.resolve(OWNERS);

  test("the transfer half failing is MARKED, and the ownership half survives", async () => {
    const out = await answerAccountEntities(CONFIGURED, SS58, null, {
      coldTier: declinedTier,
      owners,
    });
    assert.deepEqual(out.degraded, DEGRADED);
    // THE POINT. The counts stay REAL -- nulling them would discard ownership
    // ties that were read successfully, which is worse than the confident zero
    // the marker replaces.
    // `AccountEntitiesRead` is the read-TOLERANT twin, so its fields are
    // optional -- narrowed here rather than asserted through, which would pass
    // vacuously on an absent field.
    const count = out.ownership_tie_count;
    assert.ok(
      typeof count === "number" && count > 0,
      "ownership ties read from the artifact must survive the decline",
    );
    assert.equal(out.ownership_ties?.length, count);
  });

  test("with NO lakehouse configured the same floor is unmarked", async () => {
    // No transfer stream to have failed, so there is no fault to report.
    const out = await answerAccountEntities(UNCONFIGURED, SS58, null, {
      coldTier: declinedTier,
      owners,
    });
    assert.equal("degraded" in out, false);
    const unmarkedCount = out.ownership_tie_count;
    assert.ok(typeof unmarkedCount === "number" && unmarkedCount > 0);
  });

  test("a tier that ANSWERED is never marked", async () => {
    // Non-vacuity: the marker must track the tier's outcome, not merely the
    // presence of a configured lakehouse.
    const answered = async () => ({
      schema_version: 1 as const,
      ss58: SS58,
      labels: [],
      ownership_tie_count: 0,
      ownership_ties: [],
      owners_observed_at: null,
    });
    const out = await answerAccountEntities(CONFIGURED, SS58, null, {
      coldTier: answered as never,
      owners,
    });
    assert.equal("degraded" in out, false);
  });
});
