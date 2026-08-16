import { describe, test } from "vitest";
import assert from "node:assert/strict";

import {
  DEFAULT_SUBNET_AXON_REMOVALS_WINDOW,
  SUBNET_AXON_REMOVALS_WINDOWS,
  buildSubnetAxonRemovals,
} from "../src/subnet-axon-removals.ts";
import {
  axonChangesCoverage,
  foldAxonChangeRows,
} from "../src/axon-reachability-changes.ts";

const coverage = axonChangesCoverage(
  "2026-08-09",
  "2026-08-16",
  7,
  "2026-08-16",
);

/** The folded aggregate for one subnet, from grouped rows. */
function aggregate(rows: Array<Record<string, unknown>>) {
  return foldAxonChangeRows(rows)[0] ?? null;
}

describe("the window set the route accepts", () => {
  test("7d and 30d, defaulting to 7d", () => {
    assert.deepEqual(Object.keys(SUBNET_AXON_REMOVALS_WINDOWS), ["7d", "30d"]);
    assert.equal(DEFAULT_SUBNET_AXON_REMOVALS_WINDOW, "7d");
  });
});

describe("removals means STOPPED ANNOUNCING, and nothing else", () => {
  test("SN126's shape: 36 moves are not 36 removals", () => {
    // Measured against production 2026-08-16 over the 8-day window: SN126 had
    // 3 deregistrations and 36 same-hotkey losses, ALL of them moves. Reporting
    // 39 removals would be the answer this route used to imply.
    const card = buildSubnetAxonRemovals(
      aggregate([
        { netuid: 126, kind: "deregistered", n: 3 },
        { netuid: 126, kind: "moved-unroutable", n: 36 },
      ]),
      126,
      { window: "7d", coverage },
    );
    assert.equal(card.removals, 0);
    assert.equal(card.distinct_removers, 0);
    assert.equal(card.removals_per_remover, null);
    assert.deepEqual(card.changes, {
      deregistered: 3,
      moved_unroutable: 36,
      stopped_announcing: 0,
      total: 39,
    });
  });

  test("a genuine withdrawal is counted, with its intensity", () => {
    const card = buildSubnetAxonRemovals(
      aggregate([
        { netuid: 101, kind: "stopped-announcing", n: 76, removers: 38 },
        { netuid: 101, kind: "deregistered", n: 64 },
      ]),
      101,
      { window: "30d", coverage },
    );
    assert.equal(card.removals, 76);
    assert.equal(card.distinct_removers, 38);
    assert.equal(card.removals_per_remover, 2);
    assert.equal((card.changes as { total: number }).total, 140);
  });

  test("no removers has no defined intensity -- null, not zero", () => {
    const card = buildSubnetAxonRemovals(null, 5, { coverage });
    assert.equal(card.removals, 0);
    assert.equal(card.removals_per_remover, null);
  });
});

describe("nothing read is distinguishable from a genuine zero", () => {
  test("a declined tier has NULL dates, not a measured window", () => {
    // This is what the `degraded` marker used to say, now said by the data.
    const card = buildSubnetAxonRemovals(null, 5, { window: "7d" });
    assert.equal(card.start_date, null);
    assert.equal(card.end_date, null);
    assert.equal(card.observed_at, null);
    assert.equal(card.covered_days, null);
    // Unknowable rather than complete: nobody measured this window.
    assert.equal(card.window_truncated, null);
    assert.equal(card.end_date_settled, false);
    assert.equal(card.removals, 0);
  });

  test("a real read that found nothing carries its dates", () => {
    const card = buildSubnetAxonRemovals(null, 5, {
      window: "7d",
      coverage,
    });
    assert.equal(card.start_date, "2026-08-09");
    assert.equal(card.end_date, "2026-08-16");
    assert.equal(card.removals, 0);
    assert.deepEqual(card.changes, {
      deregistered: 0,
      moved_unroutable: 0,
      stopped_announcing: 0,
      total: 0,
    });
  });

  test("the degraded marker is gone -- it described a route that could not answer", () => {
    assert.equal(
      "degraded" in buildSubnetAxonRemovals(null, 5, { coverage }),
      false,
    );
  });
});

describe("the card states how it was derived", () => {
  test("observed_at is MIDNIGHT of the last day read, not now()", () => {
    // The answer describes a day. Stamping it with the request time would
    // claim a freshness the daily snapshot behind it does not have.
    const card = buildSubnetAxonRemovals(null, 5, { coverage });
    assert.equal(card.observed_at, "2026-08-16T00:00:00.000Z");
  });

  test("the trailing day is flagged unsettled while it is still being written", () => {
    assert.equal(card().end_date_settled, false);
    function card() {
      return buildSubnetAxonRemovals(null, 5, { coverage });
    }
  });

  test("a window ending before the newest day is settled", () => {
    const card = buildSubnetAxonRemovals(null, 5, {
      coverage: axonChangesCoverage(
        "2026-08-01",
        "2026-08-08",
        7,
        "2026-08-16",
      ),
    });
    assert.equal(card.end_date_settled, true);
  });

  test("the derivation names neuron_daily and the daily resolution", () => {
    const card = buildSubnetAxonRemovals(null, 5, { coverage });
    assert.deepEqual(
      (card.derivation as { source: string; resolution: string }).source,
      "neuron_daily",
    );
    assert.equal(
      (card.derivation as { resolution: string }).resolution,
      "daily",
    );
  });
});
