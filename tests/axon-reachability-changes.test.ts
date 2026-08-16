import { describe, test } from "vitest";
import assert from "node:assert/strict";

import {
  AXON_CHANGE_KIND_SQL,
  AXON_CHANGE_PREDICATE_SQL,
  AXON_CHANGES_MAX_WINDOW_DAYS,
  AXON_TRANSITION_SEQ_SQL,
  AXON_TRANSITION_WINDOW_SQL,
  axonChangeKind,
  axonChangesDerivation,
  axonChangesWindow,
  buildAxonChangesChain,
  buildAxonChangesScoped,
  emptyAxonChangeBreakdown,
  tallyAxonChanges,
  toAxonReachabilityChange,
  type AxonReachabilityChange,
} from "../src/axon-reachability-changes.ts";
import { ROUTABLE_AXON_SQL } from "../src/axon-routable.ts";

const change = (
  over: Partial<AxonReachabilityChange> = {},
): AxonReachabilityChange => ({
  netuid: 1,
  uid: 0,
  date: "2026-08-16",
  kind: "stopped-announcing",
  hotkey: "5Hot",
  previous_hotkey: "5Hot",
  coldkey: "5Cold",
  previous_axon: "1.2.3.4:8091",
  current_axon: null,
  ...over,
});

describe("the derivation is defined ONCE, and shares the routable rule", () => {
  test("the sequence embeds the shared routability predicate", () => {
    // If this ever stops being true the alarm and the API can disagree about
    // what "reachable" means -- the failure this family keeps producing.
    assert.ok(AXON_TRANSITION_SEQ_SQL.includes(ROUTABLE_AXON_SQL));
    assert.ok(AXON_TRANSITION_SEQ_SQL.includes("LAG(hotkey) OVER w"));
    assert.ok(AXON_TRANSITION_SEQ_SQL.includes("FROM neuron_daily"));
    assert.ok(AXON_TRANSITION_WINDOW_SQL.includes("PARTITION BY netuid, uid"));
  });

  test("a deregistration is decided BEFORE the still-announcing test", () => {
    // Order is load-bearing: on a reused UID the newcomer's axon says nothing
    // about the miner that left, so testing it first would attribute the
    // newcomer's state to the previous occupant.
    const dereg = AXON_CHANGE_KIND_SQL.indexOf("deregistered");
    const moved = AXON_CHANGE_KIND_SQL.indexOf("moved-unroutable");
    assert.ok(dereg >= 0 && moved > dereg);
  });

  test("the predicate is a loss of REACHABILITY, not of the axon", () => {
    assert.equal(AXON_CHANGE_PREDICATE_SQL, "prev_routable AND NOT routable");
  });
});

describe("row shaping drops what it cannot trust", () => {
  test("a well-formed row survives, including the column aliases", () => {
    assert.deepEqual(
      toAxonReachabilityChange({
        netuid: 126,
        uid: 7,
        snapshot_date: "2026-08-11",
        kind: "moved-unroutable",
        hotkey: "5A",
        prev_hotkey: "5A",
        coldkey: "5C",
        prev_axon: "1.2.3.4:8091",
        axon: "192.0.2.1:8091",
      }),
      {
        netuid: 126,
        uid: 7,
        date: "2026-08-11",
        kind: "moved-unroutable",
        hotkey: "5A",
        previous_hotkey: "5A",
        coldkey: "5C",
        previous_axon: "1.2.3.4:8091",
        current_axon: "192.0.2.1:8091",
      },
    );
  });

  test("uid 0 is a real UID, not a falsy one", () => {
    // The burn UID is 0 on many subnets; a truthiness check would drop it.
    assert.equal(toAxonReachabilityChange({ ...base(), uid: 0 })?.uid, 0);
  });

  function base() {
    return {
      netuid: 1,
      uid: 3,
      snapshot_date: "2026-08-16",
      kind: "stopped-announcing",
    };
  }

  test("an UNRECOGNISED kind drops the row rather than defaulting", () => {
    // Defaulting would attribute a mechanism nothing measured -- #11381.
    assert.equal(
      toAxonReachabilityChange({ ...base(), kind: "removed" }),
      null,
    );
    assert.equal(toAxonReachabilityChange({ ...base(), kind: null }), null);
    assert.equal(toAxonReachabilityChange({ ...base(), kind: 7 }), null);
  });

  test("a missing netuid, uid or date drops the row", () => {
    assert.equal(toAxonReachabilityChange({ ...base(), netuid: null }), null);
    assert.equal(toAxonReachabilityChange({ ...base(), netuid: "" }), null);
    assert.equal(toAxonReachabilityChange({ ...base(), netuid: -1 }), null);
    assert.equal(toAxonReachabilityChange({ ...base(), netuid: 1.5 }), null);
    assert.equal(toAxonReachabilityChange({ ...base(), uid: undefined }), null);
    assert.equal(
      toAxonReachabilityChange({ ...base(), snapshot_date: "  " }),
      null,
    );
    assert.equal(toAxonReachabilityChange(null), null);
  });

  test("blank and non-string text collapse to null", () => {
    const out = toAxonReachabilityChange({
      ...base(),
      hotkey: "   ",
      coldkey: 42,
      prev_axon: "",
    });
    assert.equal(out?.hotkey, null);
    assert.equal(out?.coldkey, null);
    assert.equal(out?.previous_axon, null);
  });

  test("axonChangeKind accepts only the closed set", () => {
    assert.equal(axonChangeKind("deregistered"), "deregistered");
    assert.equal(axonChangeKind("moved-unroutable"), "moved-unroutable");
    assert.equal(axonChangeKind("stopped-announcing"), "stopped-announcing");
    assert.equal(axonChangeKind("withdrawn"), null);
    assert.equal(axonChangeKind(undefined), null);
  });
});

describe("tallies state every kind, including the zeroes", () => {
  test("an empty tally names all three at zero", () => {
    // An absent key reads as "not measured"; a zero is a finding.
    assert.deepEqual(emptyAxonChangeBreakdown(), {
      deregistered: 0,
      moved_unroutable: 0,
      stopped_announcing: 0,
      total: 0,
    });
    assert.deepEqual(tallyAxonChanges(null), emptyAxonChangeBreakdown());
    assert.deepEqual(tallyAxonChanges([]), emptyAxonChangeBreakdown());
  });

  test("THE NETWORK SHAPE: mostly deregistrations, barely any removals", () => {
    // The 38-day proportions, scaled down: reporting the total as "removals"
    // would be 95% wrong.
    const changes = [
      ...Array.from({ length: 19 }, () => change({ kind: "deregistered" })),
      ...Array.from({ length: 2 }, () => change({ kind: "moved-unroutable" })),
      change({ kind: "stopped-announcing" }),
    ];
    assert.deepEqual(tallyAxonChanges(changes), {
      deregistered: 19,
      moved_unroutable: 2,
      stopped_announcing: 1,
      total: 22,
    });
  });

  test("an unknown kind is not counted, and does not inflate the total", () => {
    const tally = tallyAxonChanges([
      change(),
      { ...change(), kind: "nonsense" } as unknown as AxonReachabilityChange,
    ]);
    assert.equal(tally.total, 1);
    assert.equal(tally.stopped_announcing, 1);
  });
});

describe("the window says what was read, and whether it had settled", () => {
  test("a window ending on the newest day is NOT settled", () => {
    // Measured 2026-08-16: the newest snapshot_date was rewritten mid-day and
    // the same query returned different counts forty minutes apart.
    const w = axonChangesWindow(
      "7d",
      7,
      "2026-08-10",
      "2026-08-16",
      "2026-08-16",
    );
    assert.equal(w.end_date_settled, false);
    assert.equal(w.start_date, "2026-08-10");
    assert.equal(w.requested_days, 7);
  });

  test("a window stopping short of the newest day is settled", () => {
    assert.equal(
      axonChangesWindow("7d", 7, "2026-08-01", "2026-08-08", "2026-08-16")
        .end_date_settled,
      true,
    );
  });

  test("no end date is not settled, because nothing was read", () => {
    assert.equal(
      axonChangesWindow("7d", 7, null, null, "2026-08-16").end_date_settled,
      false,
    );
  });
});

describe("the chain scope ranks by what the route NAME means", () => {
  const window = axonChangesWindow("30d", 30, "2026-07-17", "2026-08-16", null);

  test("SN126's 160 moves do NOT outrank a genuine withdrawal", () => {
    // Sorting by total would put the largest source on the network -- which is
    // miners moving, not leaving -- above every real removal. That is exactly
    // the misreading this family exists to stop making.
    const result = buildAxonChangesChain(
      [
        ...Array.from({ length: 160 }, () =>
          change({ netuid: 126, kind: "moved-unroutable" }),
        ),
        ...Array.from({ length: 3 }, () =>
          change({ netuid: 101, kind: "stopped-announcing" }),
        ),
      ],
      window,
      10,
    );
    assert.equal(result.subnets[0].netuid, 101);
    assert.equal(result.subnets[0].changes.stopped_announcing, 3);
    assert.equal(result.subnets[1].netuid, 126);
    assert.equal(result.subnets[1].changes.moved_unroutable, 160);
    assert.equal(result.network.total, 163);
    assert.equal(result.subnet_count, 2);
  });

  test("equal removals fall back to total, then to netuid", () => {
    const result = buildAxonChangesChain(
      [
        change({ netuid: 9, kind: "deregistered" }),
        change({ netuid: 4, kind: "deregistered" }),
        change({ netuid: 4, kind: "deregistered" }),
      ],
      window,
      10,
    );
    assert.deepEqual(
      result.subnets.map((s) => s.netuid),
      [4, 9],
    );
  });

  test("the leaderboard is paged but the rollup is not", () => {
    const result = buildAxonChangesChain(
      [
        change({ netuid: 1, kind: "stopped-announcing" }),
        change({ netuid: 2, kind: "stopped-announcing" }),
        change({ netuid: 3, kind: "stopped-announcing" }),
      ],
      window,
      1,
    );
    assert.equal(result.subnets.length, 1);
    assert.equal(result.subnet_count, 3, "counted every subnet, not the page");
    assert.equal(result.network.total, 3);
  });

  test("an empty answer still states the derivation and every zero", () => {
    const result = buildAxonChangesChain([], window, 10);
    assert.deepEqual(result.network, emptyAxonChangeBreakdown());
    assert.equal(result.subnets.length, 0);
    assert.equal(result.derivation.source, "neuron_daily");
    assert.equal(result.derivation.resolution, "daily");
    assert.equal(
      result.derivation.max_window_days,
      AXON_CHANGES_MAX_WINDOW_DAYS,
    );
  });

  test("a nonsense limit cannot produce a negative slice", () => {
    assert.equal(
      buildAxonChangesChain([change()], window, -5).subnets.length,
      0,
    );
    assert.equal(buildAxonChangesChain(null, window, 10).subnet_count, 0);
  });
});

describe("the scoped answer pages the rows but tallies the window", () => {
  const window = axonChangesWindow("7d", 7, "2026-08-10", "2026-08-16", null);

  test("newest first, then netuid, then uid", () => {
    const result = buildAxonChangesScoped(
      [
        change({ date: "2026-08-10", netuid: 2, uid: 1 }),
        change({ date: "2026-08-16", netuid: 5, uid: 9 }),
        change({ date: "2026-08-16", netuid: 5, uid: 2 }),
        change({ date: "2026-08-16", netuid: 1, uid: 0 }),
      ],
      window,
      10,
    );
    assert.deepEqual(
      result.items.map((i) => [i.date, i.netuid, i.uid]),
      [
        ["2026-08-16", 1, 0],
        ["2026-08-16", 5, 2],
        ["2026-08-16", 5, 9],
        ["2026-08-10", 2, 1],
      ],
    );
  });

  test("THE TALLY SPANS THE WINDOW, not the page", () => {
    // A caller reading only `items` would otherwise assume the counts matched
    // it, and they do not once the limit truncates.
    const result = buildAxonChangesScoped(
      [
        change({ kind: "deregistered" }),
        change({ kind: "deregistered" }),
        change({ kind: "stopped-announcing" }),
      ],
      window,
      1,
    );
    assert.equal(result.items.length, 1);
    assert.equal(result.changes.total, 3);
    assert.equal(result.changes.deregistered, 2);
  });

  test("the input array is never reordered in place", () => {
    const input = [
      change({ date: "2026-08-10" }),
      change({ date: "2026-08-16" }),
    ];
    buildAxonChangesScoped(input, window, 10);
    assert.equal(input[0].date, "2026-08-10");
  });

  test("empty and null answer with stated zeroes", () => {
    assert.deepEqual(
      buildAxonChangesScoped(null, window, 10).changes,
      emptyAxonChangeBreakdown(),
    );
    assert.equal(
      buildAxonChangesScoped([change()], window, -1).items.length,
      0,
    );
  });
});

describe("the derivation block is a provenance note, not a degraded marker", () => {
  test("it names the source, the resolution and the bound", () => {
    const d = axonChangesDerivation();
    assert.equal(d.source, "neuron_daily");
    assert.equal(d.resolution, "daily");
    assert.equal(d.max_window_days, 38);
    assert.match(d.note, /AxonInfoRemoved has never been emitted/);
    assert.match(d.note, /moved-unroutable/);
  });
});
