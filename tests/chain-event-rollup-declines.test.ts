// A declined rollup is never published as a card of zeros (#11417).
//
// The seven loaders below all read `chain-event-rollup-cold-tier.ts`, and all
// seven used to spell its decline `?? emptyCard`. Seven published reads were
// measured sitting AT the 15s `QUERY_TIMEOUT_MS` on 2026-08-16, so a timeout is
// routine here -- and a timed-out card was byte-identical to a genuinely quiet
// week.
//
// Each test drives ONE loader with a lakehouse that fails, and asserts the card
// says so. The contrast cases matter as much: an empty window and a deployment
// with no lakehouse must stay UNMARKED, or the marker means nothing.
import assert from "node:assert/strict";
import { describe, test } from "vitest";

import { loadChainServingColdTier } from "../src/chain-serving-loader.ts";
import { loadChainPrometheusColdTier } from "../src/chain-prometheus-loader.ts";
import { loadChainWeightsColdTier } from "../src/chain-weights-loader.ts";
import { loadChainWeightSettersColdTier } from "../src/chain-weight-setters-loader.ts";
import { loadSubnetWeightsColdTier } from "../src/subnet-weights-loader.ts";
import { DEGRADED_UNAVAILABLE } from "../src/uncurated-event-streams.ts";
import { LAKEHOUSE_ENV } from "./helpers/cold-tier-env.ts";

/**
 * A deployment WITH a lakehouse: the one where the rows exist.
 *
 * The shared `LAKEHOUSE_ENV`, not a local copy -- it is the same "R2 SQL is
 * configured" fact `isR2SqlConfigured` reads, and two spellings of it would
 * drift the day the key changes.
 */
const CONFIGURED = LAKEHOUSE_ENV as never;
/** A self-hoster or CI: no lakehouse, so no rows to be wrong about. */
const UNCONFIGURED = {} as never;

/** An engine that cannot answer -- the shape a timeout takes by the time the
 * reader sees it. */
const failing = async () => null;
/**
 * An engine that ANSWERS, with nothing in the window.
 *
 * Not simply `() => []` for every query: the network and subnet-count legs are
 * COUNT queries, which always return a row even when the count is zero. An
 * empty result THERE is a malformed answer and is correctly a gap -- so a stub
 * returning `[]` everywhere would exercise the decline path while claiming to
 * test the quiet one.
 */
const quiet = () => {
  // A FACTORY, not a module-level singleton: the counter is per-call state, and
  // a shared one would carry across tests (and across the suite's two passes),
  // which is a flake rather than a fixture.
  let call = 0;
  return async () => {
    call += 1;
    if (call === 1) return [];
    if (call === 2) return [{ distinct_servers: 0, newest_observed: null }];
    return [{ subnet_count: 0 }];
  };
};

const DEGRADED = { reason: DEGRADED_UNAVAILABLE };

describe("a failed rollup is marked, on every route that reads it", () => {
  test("chain/serving marks the decline and nulls what it does not know", async () => {
    const card = await loadChainServingColdTier(CONFIGURED, {
      window: "7d",
      query: failing,
    });
    assert.ok(card);
    assert.deepEqual(card.degraded, DEGRADED);
    // NULL, not 0. `subnet_count: 0` is a claim that no subnet served
    // anything, and after a failed read nobody knows that.
    assert.equal(card.subnet_count, null);
    // The whole network block goes, rather than five nested zeros.
    assert.equal(card.network, null);
    assert.deepEqual(card.subnets, []);
    // Known without reading anything, so still reported.
    assert.equal(card.window, "7d");
  });

  test("chain/prometheus marks the decline", async () => {
    const card = await loadChainPrometheusColdTier(CONFIGURED, {
      window: "7d",
      query: failing,
    });
    assert.ok(card);
    assert.deepEqual(card.degraded, DEGRADED);
    assert.equal(card.subnet_count, null);
    assert.equal(card.network, null);
  });

  test("chain/weights marks the decline", async () => {
    const card = await loadChainWeightsColdTier(CONFIGURED, {
      window: "7d",
      query: failing,
    });
    assert.ok(card);
    assert.deepEqual(card.degraded, DEGRADED);
    assert.equal(card.subnet_count, null);
    assert.equal(card.network, null);
  });

  test("chain/weights/setters marks the decline and nulls all three totals", async () => {
    const card = await loadChainWeightSettersColdTier(CONFIGURED, {
      window: "7d",
      query: failing,
    });
    assert.ok(card);
    assert.deepEqual(card.degraded, DEGRADED);
    assert.equal(card.distinct_setters, null);
    assert.equal(card.weight_sets, null);
    assert.equal(card.setter_count, null);
    assert.deepEqual(card.setters, []);
  });

  test("a per-subnet card marks the decline while keeping its key set", async () => {
    const card = await loadSubnetWeightsColdTier(CONFIGURED, 64, {
      windowLabel: "7d",
      windowDays: 7,
      query: failing,
    });
    assert.ok(card);
    assert.deepEqual(card.degraded, DEGRADED);
    // This card's builder owns its own shape, so the marked payload carries the
    // SAME keys a measured one does -- a consumer branches on `degraded`, never
    // on which fields exist.
    assert.ok("distinct_setters" in card);
    assert.ok("weight_sets" in card);
  });
});

describe("the two answers that must stay unmarked", () => {
  test("an empty window is a MEASUREMENT, not a decline", async () => {
    // The read succeeded and the window holds nothing. Marking this would
    // report a fault that did not happen -- the same category error as the
    // original defect, pointing the other way.
    const card = await loadChainServingColdTier(CONFIGURED, {
      window: "7d",
      query: quiet(),
    });
    assert.equal(card, null, "an empty window leaves the caller's own empty");
  });

  test("no lakehouse configured is a MISS, not a decline", async () => {
    // A self-hoster has no chain history at all, so its empty card is correct
    // and always was. This is why `gap` cannot simply be the default.
    const card = await loadChainServingColdTier(UNCONFIGURED, {
      window: "7d",
      query: failing,
    });
    assert.equal(card, null, "no lakehouse means no fault to report");
  });

  test("a healthy read is untouched, so this is not just declining everything", async () => {
    // Non-vacuity. A loader that marked every card would satisfy every
    // assertion above and be useless.
    const rows = [{ netuid: 7, announcements: 9, distinct_servers: 4 }];
    let call = 0;
    const answering = async () => {
      call += 1;
      if (call === 1) return rows;
      if (call === 2) return [{ distinct_servers: 4, newest_observed: 1 }];
      return [{ subnet_count: 1 }];
    };
    const card = await loadChainServingColdTier(CONFIGURED, {
      window: "7d",
      query: answering,
    });
    assert.ok(card);
    assert.equal("degraded" in card, false);
    assert.equal(card.subnet_count, 1);
    assert.ok(card.network);
    assert.equal(card.network.distinct_servers, 4);
  });
});
