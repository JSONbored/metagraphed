import { describe, test } from "vitest";
import assert from "node:assert/strict";

import {
  AXON_CHANGE_KIND_SQL,
  AXON_CHANGE_PREDICATE_SQL,
  AXON_CHANGES_MAX_WINDOW_DAYS,
  AXON_TRANSITION_SEQ_SQL,
  AXON_TRANSITION_WINDOW_SQL,
  axonChangeKind,
  axonChangesCoverage,
  axonChangesDerivation,
  emptyAxonChangeBreakdown,
  foldAxonChangeRows,
  rankAxonChangeSubnets,
  sumAxonChangeBreakdowns,
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

describe("the coverage block says what was read, and whether it settled", () => {
  test("a window ending on the newest day is NOT settled", () => {
    // Measured 2026-08-16: the newest snapshot_date was rewritten mid-day and
    // the same aggregate returned different counts forty minutes apart.
    const c = axonChangesCoverage("2026-08-10", "2026-08-16", 7, "2026-08-16");
    assert.equal(c.end_date_settled, false);
    assert.equal(c.start_date, "2026-08-10");
    assert.equal(c.requested_days, 7);
    assert.equal(c.covered_days, 6);
  });

  test("a window stopping short of the newest day IS settled", () => {
    assert.equal(
      axonChangesCoverage("2026-08-01", "2026-08-08", 7, "2026-08-16")
        .end_date_settled,
      true,
    );
  });

  test("no end date is not settled, because nothing was read", () => {
    const c = axonChangesCoverage(null, null, 7, "2026-08-16");
    assert.equal(c.end_date_settled, false);
    assert.equal(c.covered_days, null);
    // Unknowable rather than complete -- windowCoverage's own rule.
    assert.equal(c.window_truncated, null);
  });

  test("a short window is reported as truncated, not as a quiet network", () => {
    const c = axonChangesCoverage("2026-08-10", "2026-08-14", 30, "2026-08-16");
    assert.equal(c.covered_days, 4);
    assert.equal(c.window_truncated, true);
  });
});

describe("folding the grouped rows", () => {
  test("THE NETWORK SHAPE: three kinds per subnet, only one is a removal", () => {
    const folded = foldAxonChangeRows([
      { netuid: 25, kind: "deregistered", n: 67 },
      { netuid: 126, kind: "moved-unroutable", n: 160 },
      { netuid: 101, kind: "stopped-announcing", n: 76, removers: 74 },
      { netuid: 101, kind: "deregistered", n: 64 },
    ]);
    const byNetuid = new Map(folded.map((f) => [f.netuid, f]));
    assert.equal(byNetuid.get(126)!.changes.moved_unroutable, 160);
    assert.equal(byNetuid.get(126)!.changes.total, 160);
    // A move has no remover: nobody removed anything.
    assert.equal(byNetuid.get(126)!.distinct_removers, 0);
    assert.equal(byNetuid.get(101)!.changes.stopped_announcing, 76);
    assert.equal(byNetuid.get(101)!.changes.deregistered, 64);
    assert.equal(byNetuid.get(101)!.changes.total, 140);
    assert.equal(byNetuid.get(101)!.distinct_removers, 74);
  });

  test("int8 counts arriving as STRINGS are still counted", () => {
    // COUNT(*) is int8 and node-postgres hands it back as a string.
    const folded = foldAxonChangeRows([
      { netuid: 1, kind: "stopped-announcing", n: "9", removers: "7" },
    ]);
    assert.equal(folded[0].changes.stopped_announcing, 9);
    assert.equal(folded[0].distinct_removers, 7);
  });

  test("an unrecognised kind is DROPPED, never bucketed", () => {
    // Attributing a mechanism nothing measured is the #11381 failure.
    assert.deepEqual(
      foldAxonChangeRows([{ netuid: 1, kind: "removed", n: 5 }]),
      [],
    );
    assert.deepEqual(
      foldAxonChangeRows([{ netuid: null, kind: "deregistered", n: 5 }]),
      [],
    );
    assert.deepEqual(foldAxonChangeRows(null), []);
  });

  test("a negative or unreadable count reads as zero, not as a negative", () => {
    const folded = foldAxonChangeRows([
      { netuid: 1, kind: "stopped-announcing", n: -4, removers: "junk" },
    ]);
    assert.equal(folded[0].changes.stopped_announcing, 0);
    assert.equal(folded[0].distinct_removers, 0);
  });
});

describe("ranking puts real removals above volume", () => {
  test("SN126's 160 moves do NOT outrank three genuine withdrawals", () => {
    // Sorting by total would put the largest source on the network -- miners
    // moving, not leaving -- above every real removal.
    const ranked = rankAxonChangeSubnets(
      foldAxonChangeRows([
        { netuid: 126, kind: "moved-unroutable", n: 160 },
        { netuid: 101, kind: "stopped-announcing", n: 3, removers: 3 },
      ]),
    );
    assert.deepEqual(
      ranked.map((s) => s.netuid),
      [101, 126],
    );
  });

  test("equal removals fall back to total, then to netuid", () => {
    const ranked = rankAxonChangeSubnets(
      foldAxonChangeRows([
        { netuid: 9, kind: "deregistered", n: 1 },
        { netuid: 4, kind: "deregistered", n: 2 },
        { netuid: 2, kind: "deregistered", n: 2 },
      ]),
    );
    assert.deepEqual(
      ranked.map((s) => s.netuid),
      [2, 4, 9],
    );
  });

  test("the input array is never reordered in place", () => {
    const input = foldAxonChangeRows([
      { netuid: 9, kind: "moved-unroutable", n: 5 },
      { netuid: 1, kind: "stopped-announcing", n: 5, removers: 5 },
    ]);
    rankAxonChangeSubnets(input);
    assert.equal(input[0].netuid, 9);
  });
});

describe("the network rollup sums every kind", () => {
  test("totals across subnets, each kind kept separate", () => {
    const total = sumAxonChangeBreakdowns(
      foldAxonChangeRows([
        { netuid: 1, kind: "deregistered", n: 1915 },
        { netuid: 2, kind: "moved-unroutable", n: 166 },
        { netuid: 3, kind: "stopped-announcing", n: 105, removers: 100 },
      ]),
    );
    // The measured 38-day network shape: 95% of transitions are not removals.
    assert.deepEqual(total, {
      deregistered: 1915,
      moved_unroutable: 166,
      stopped_announcing: 105,
      total: 2186,
    });
  });

  test("no subnets is every kind at zero, not an absent block", () => {
    assert.deepEqual(sumAxonChangeBreakdowns([]), emptyAxonChangeBreakdown());
  });
});

describe("the derivation block is provenance, not a degraded marker", () => {
  test("it names the source, the resolution and the retention bound", () => {
    // Degraded means "we could not measure". This is a complete measurement of
    // a different thing from what the route name implies, and saying so is the
    // point -- an honest marker on a permanently-empty answer is still empty.
    const d = axonChangesDerivation();
    assert.equal(d.source, "neuron_daily");
    assert.equal(d.resolution, "daily");
    assert.equal(d.max_window_days, AXON_CHANGES_MAX_WINDOW_DAYS);
    assert.match(d.note, /AxonInfoRemoved has never been emitted/);
    assert.match(d.note, /moved-unroutable/);
    assert.match(d.note, /no block height/);
  });
});
