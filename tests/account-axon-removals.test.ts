import { describe, test } from "vitest";
import assert from "node:assert/strict";

import {
  ACCOUNT_AXON_CHANGES_WINDOWS,
  DEFAULT_ACCOUNT_AXON_CHANGES_WINDOW,
  axonChangesCoverage,
} from "../src/axon-reachability-changes.ts";
import { buildAccountAxonRemovals } from "../src/account-axon-removals.ts";

const coverage = axonChangesCoverage(
  "2026-07-10",
  "2026-08-16",
  30,
  "2026-08-16",
);

const ADDRESS = "5HK5tp6t2S59DywmHRWPBVJeJ86T61KjurYqeooqj8sREpeN";

describe("the window set the account route accepts", () => {
  test("7d, 30d and 90d, defaulting to 30d", () => {
    assert.deepEqual(Object.keys(ACCOUNT_AXON_CHANGES_WINDOWS), [
      "7d",
      "30d",
      "90d",
    ]);
    assert.equal(DEFAULT_ACCOUNT_AXON_CHANGES_WINDOW, "30d");
  });
});

describe("an account that lost slots did not remove anything", () => {
  // THE REAL SHAPE, measured against production 2026-08-16. This is the
  // busiest account in the whole 38-day window: 6 transitions across 5
  // subnets, every one a DEREGISTRATION. The old contract reported that as
  // "6 removals" for an account that tore down nothing.
  const rows = [
    {
      netuid: 23,
      kind: "deregistered",
      n: 1,
      first_date: "2026-07-27",
      last_date: "2026-07-27",
    },
    {
      netuid: 37,
      kind: "deregistered",
      n: 2,
      first_date: "2026-08-06",
      last_date: "2026-08-08",
    },
    {
      netuid: 41,
      kind: "deregistered",
      n: 1,
      first_date: "2026-08-06",
      last_date: "2026-08-06",
    },
    {
      netuid: 44,
      kind: "deregistered",
      n: 1,
      first_date: "2026-08-01",
      last_date: "2026-08-01",
    },
    {
      netuid: 60,
      kind: "deregistered",
      n: 1,
      first_date: "2026-07-30",
      last_date: "2026-07-30",
    },
  ];

  test("total_removals is ZERO, and the churn is still visible", () => {
    const card = buildAccountAxonRemovals(rows, ADDRESS, {
      window: "30d",
      coverage,
    });
    assert.equal(card.total_removals, 0);
    assert.equal(card.subnet_count, 5, "the subnets still appear");
    assert.deepEqual(card.changes, {
      deregistered: 6,
      moved_unroutable: 0,
      stopped_announcing: 0,
      total: 6,
    });
  });

  test("no dominant subnet and no concentration without a removal", () => {
    // Concentration is HHI over REMOVALS. An account that removed nothing has
    // nothing to concentrate, and naming a dominant subnet would imply it did.
    const card = buildAccountAxonRemovals(rows, ADDRESS, { coverage });
    assert.equal(card.dominant_netuid, null);
    assert.equal(card.concentration, null);
  });

  test("a deregistration carries NO removal dates", () => {
    // Those dates would belong to whoever took the UID, not to this account.
    const card = buildAccountAxonRemovals(rows, ADDRESS, { coverage });
    for (const subnet of card.subnets) {
      assert.equal(subnet.first_removed_at, null);
      assert.equal(subnet.last_removed_at, null);
    }
  });
});

describe("a genuine withdrawal is counted, dated and concentrated", () => {
  test("removals, dates and HHI come only from stopped-announcing", () => {
    const card = buildAccountAxonRemovals(
      [
        {
          netuid: 101,
          kind: "stopped-announcing",
          n: 3,
          first_date: "2026-08-11",
          last_date: "2026-08-13",
        },
        { netuid: 101, kind: "deregistered", n: 9 },
        {
          netuid: 8,
          kind: "stopped-announcing",
          n: 1,
          first_date: "2026-08-02",
          last_date: "2026-08-02",
        },
      ],
      ADDRESS,
      { window: "30d", coverage },
    );
    assert.equal(card.total_removals, 4);
    assert.equal(card.dominant_netuid, 101);
    // HHI over 3 and 1: (9 + 1) / 16 = 0.625.
    assert.equal(card.concentration, 0.625);
    assert.equal(card.subnets[0].netuid, 101);
    assert.equal(card.subnets[0].first_removed_at, "2026-08-11T00:00:00.000Z");
    assert.equal(card.subnets[0].last_removed_at, "2026-08-13T00:00:00.000Z");
    // The deregistrations ride along without inflating the removal count.
    assert.equal(card.subnets[0].changes.deregistered, 9);
    assert.equal(card.changes.total, 13);
  });

  test("subnets rank by removals, then by total change, then netuid", () => {
    const card = buildAccountAxonRemovals(
      [
        { netuid: 9, kind: "moved-unroutable", n: 50 },
        {
          netuid: 3,
          kind: "stopped-announcing",
          n: 1,
          first_date: "2026-08-01",
          last_date: "2026-08-01",
        },
      ],
      ADDRESS,
      { coverage },
    );
    assert.deepEqual(
      card.subnets.map((s) => s.netuid),
      [3, 9],
      "one real removal outranks fifty moves",
    );
  });
});

describe("unusable rows and empty answers", () => {
  test("an unrecognised kind or netuid is dropped, never bucketed", () => {
    const card = buildAccountAxonRemovals(
      [
        { netuid: 1, kind: "removed", n: 5 },
        { netuid: null, kind: "deregistered", n: 5 },
      ],
      ADDRESS,
      { coverage },
    );
    assert.equal(card.subnet_count, 0);
    assert.equal(card.changes.total, 0);
  });

  test("a declined tier has NULL dates; a real empty read has them", () => {
    const declined = buildAccountAxonRemovals(null, ADDRESS, {});
    assert.equal(declined.start_date, null);
    assert.equal(declined.observed_at, null);
    assert.equal(declined.window_truncated, null);

    const measured = buildAccountAxonRemovals([], ADDRESS, { coverage });
    assert.equal(measured.start_date, "2026-07-10");
    assert.equal(measured.observed_at, "2026-08-16T00:00:00.000Z");
    assert.equal(measured.total_removals, 0);
  });

  test("the degraded marker is gone", () => {
    assert.equal(
      "degraded" in buildAccountAxonRemovals([], ADDRESS, { coverage }),
      false,
    );
  });
});
