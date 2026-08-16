import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  AXON_REMOVAL_DERIVATION_METHOD,
  deriveAxonRemovals,
  type NeuronAxonDayRow,
} from "../src/axon-removal-derivation.ts";

/** One `neuron_daily` observation. */
function day(
  date: string,
  {
    netuid = 25,
    uid = 1,
    hotkey = "hkA",
    axon = null as string | null,
  }: Partial<{
    netuid: number;
    uid: number;
    hotkey: string;
    axon: string | null;
  }> = {},
): NeuronAxonDayRow {
  return { netuid, uid, snapshot_date: date, hotkey, axon };
}

const opts = { lookbackDays: 30 };

describe("deriveAxonRemovals", () => {
  test("a hotkey that stops announcing and stays down IS a removal", () => {
    const { removals, derivation } = deriveAxonRemovals(
      [
        day("2026-08-01", { axon: "1.2.3.4:8091" }),
        day("2026-08-02", { axon: null }),
        day("2026-08-03", { axon: null }),
      ],
      opts,
    );
    assert.equal(removals.length, 1);
    assert.deepEqual(removals[0], {
      netuid: 25,
      uid: 1,
      hotkey: "hkA",
      removed_on: "2026-08-02",
      previous_axon: "1.2.3.4:8091",
    });
    assert.equal(derivation.method, AXON_REMOVAL_DERIVATION_METHOD);
    assert.equal(derivation.excluded_uid_reuse, 0);
    assert.equal(derivation.pending_confirmation, 0);
  });

  // CORRECTION 1. 1,485 of 1,584 drops measured over 30 days are this, so
  // getting it wrong overstates teardowns 18x -- and double-reports an event
  // the deregistration family already publishes.
  test("A SLOT THAT CHANGED HANDS is a deregistration, not a removal", () => {
    const { removals, derivation } = deriveAxonRemovals(
      [
        day("2026-08-01", { hotkey: "hkA", axon: "1.2.3.4:8091" }),
        day("2026-08-02", { hotkey: "hkB", axon: null }),
        day("2026-08-03", { hotkey: "hkB", axon: null }),
      ],
      opts,
    );
    assert.deepEqual(removals, []);
    assert.equal(derivation.excluded_uid_reuse, 1);
  });

  // CORRECTION 2. 5 of 99 same-hotkey drops were back on the very NEXT
  // reading, which is what a missed poll looks like. A recovery further out is
  // a real recovery from a real teardown and does not retract the removal --
  // see the module header for why the weaker test is the deliberate one.
  test("A DROP BACK ON THE NEXT READING is a capture blip, not a removal", () => {
    const { removals, derivation } = deriveAxonRemovals(
      [
        day("2026-08-01", { axon: "1.2.3.4:8091" }),
        day("2026-08-02", { axon: null }),
        day("2026-08-03", { axon: "1.2.3.4:8091" }),
      ],
      opts,
    );
    assert.deepEqual(removals, []);
    // Not pending either: it was answered, and the answer was "no removal".
    assert.equal(derivation.pending_confirmation, 0);
  });

  test("a drop on the NEWEST day is pending, never a removal", () => {
    // Confirmation needs a day after it, so the last day of any window is
    // always unconfirmable. Reporting it would make every window end with a
    // phantom teardown that disappears tomorrow.
    const { removals, derivation } = deriveAxonRemovals(
      [
        day("2026-08-01", { axon: "1.2.3.4:8091" }),
        day("2026-08-02", { axon: null }),
      ],
      opts,
    );
    assert.deepEqual(removals, []);
    assert.equal(derivation.pending_confirmation, 1);
  });

  test("a SUSTAINED absence stays a removal even if it recovers later", () => {
    // The rule choice, pinned. Down on the 2nd, still down on the 3rd, back on
    // the 10th: the teardown happened. Requiring "never announced again"
    // instead would delete this from the feed the moment it recovered, so
    // yesterday's history and today's would disagree.
    const { removals } = deriveAxonRemovals(
      [
        day("2026-08-01", { axon: "1.2.3.4:8091" }),
        day("2026-08-02", { axon: null }),
        day("2026-08-03", { axon: null }),
        day("2026-08-10", { axon: "1.2.3.4:8091" }),
      ],
      opts,
    );
    assert.equal(removals.length, 1);
    assert.equal(removals[0]!.removed_on, "2026-08-02");
  });

  test("counts each slot independently, and reports newest first", () => {
    const { removals } = deriveAxonRemovals(
      [
        day("2026-08-01", { uid: 1, axon: "1.1.1.1:1" }),
        day("2026-08-02", { uid: 1, axon: null }),
        day("2026-08-03", { uid: 1, axon: null }),
        day("2026-08-01", { uid: 2, hotkey: "hkB", axon: "2.2.2.2:2" }),
        day("2026-08-04", { uid: 2, hotkey: "hkB", axon: null }),
        day("2026-08-05", { uid: 2, hotkey: "hkB", axon: null }),
      ],
      opts,
    );
    assert.equal(removals.length, 2);
    assert.equal(removals[0]!.removed_on, "2026-08-04", "newest first");
    assert.equal(removals[1]!.removed_on, "2026-08-02");
  });

  test("tolerates unordered rows — the pull's order is not the story's order", () => {
    const ordered = deriveAxonRemovals(
      [
        day("2026-08-01", { axon: "1.2.3.4:8091" }),
        day("2026-08-02", { axon: null }),
        day("2026-08-03", { axon: null }),
      ],
      opts,
    );
    const shuffled = deriveAxonRemovals(
      [
        day("2026-08-03", { axon: null }),
        day("2026-08-01", { axon: "1.2.3.4:8091" }),
        day("2026-08-02", { axon: null }),
      ],
      opts,
    );
    assert.deepEqual(shuffled, ordered);
  });

  test("a gap in the snapshot is measured across, not treated as a drop", () => {
    // The slot is simply not observed on the 2nd. The transition is measured
    // between the observations that exist, so a missing DAY does not invent a
    // removal -- only a missing AXON does.
    const { removals } = deriveAxonRemovals(
      [
        day("2026-08-01", { axon: "1.2.3.4:8091" }),
        day("2026-08-03", { axon: "1.2.3.4:8091" }),
        day("2026-08-04", { axon: "1.2.3.4:8091" }),
      ],
      opts,
    );
    assert.deepEqual(removals, []);
  });

  test("an empty axon string is the same absence as null", () => {
    // `neuron_daily.axon` is `text`; the poller has written both.
    const { removals } = deriveAxonRemovals(
      [
        day("2026-08-01", { axon: "1.2.3.4:8091" }),
        day("2026-08-02", { axon: "" }),
        day("2026-08-03", { axon: "" }),
      ],
      opts,
    );
    assert.equal(removals.length, 1);
    assert.equal(removals[0]!.removed_on, "2026-08-02");
  });

  test("a NON-NUMERIC netuid or uid is unusable — `null` is not the test", () => {
    // `Number(null)` is 0, which IS an integer, so a null netuid silently
    // becomes subnet 0 rather than being refused. The rejection needs a value
    // that does not coerce, and coverage is what showed the earlier fixture
    // never reached this branch at all.
    const { removals } = deriveAxonRemovals(
      [
        {
          netuid: "abc",
          uid: 1,
          snapshot_date: "2026-08-01",
          hotkey: "h",
          axon: "1.1.1.1:1",
        },
        {
          netuid: 25,
          uid: "xyz",
          snapshot_date: "2026-08-02",
          hotkey: "h",
          axon: null,
        },
        {
          netuid: 1.5,
          uid: 1,
          snapshot_date: "2026-08-03",
          hotkey: "h",
          axon: null,
        },
      ],
      opts,
    );
    assert.deepEqual(removals, []);
  });

  test("refuses rows it cannot place, rather than inventing a slot", () => {
    const { removals } = deriveAxonRemovals(
      [
        {
          netuid: null,
          uid: 1,
          snapshot_date: "2026-08-01",
          hotkey: "h",
          axon: "1.1.1.1:1",
        },
        {
          netuid: 25,
          uid: null,
          snapshot_date: "2026-08-02",
          hotkey: "h",
          axon: null,
        },
        { netuid: 25, uid: 1, snapshot_date: null, hotkey: "h", axon: null },
        {
          netuid: 25,
          uid: 1,
          snapshot_date: "2026-08-03",
          hotkey: "",
          axon: null,
        },
      ],
      opts,
    );
    assert.deepEqual(removals, []);
  });

  test("accepts a Date, which is what pg hands back", () => {
    const { removals } = deriveAxonRemovals(
      [
        {
          netuid: 25,
          uid: 1,
          snapshot_date: new Date("2026-08-01T00:00:00Z"),
          hotkey: "hkA",
          axon: "1.2.3.4:8091",
        },
        {
          netuid: 25,
          uid: 1,
          snapshot_date: new Date("2026-08-02T00:00:00Z"),
          hotkey: "hkA",
          axon: null,
        },
        {
          netuid: 25,
          uid: 1,
          snapshot_date: new Date("2026-08-03T00:00:00Z"),
          hotkey: "hkA",
          axon: null,
        },
      ],
      opts,
    );
    assert.equal(removals.length, 1);
    assert.equal(removals[0]!.removed_on, "2026-08-02");
  });

  test("no rows is an empty answer with a stated lookback, not a throw", () => {
    for (const rows of [null, undefined, []]) {
      const { removals, derivation } = deriveAxonRemovals(rows, opts);
      assert.deepEqual(removals, []);
      assert.equal(derivation.lookback_days, 30);
      assert.equal(derivation.excluded_uid_reuse, 0);
    }
  });
});

describe("deriveAxonRemovals — the shapes a row can arrive in", () => {
  test("a NON-STRING hotkey is unusable, not coerced", () => {
    // `hotkey` is the identity the UID-reuse test turns on, so coercing a
    // number to "123" would let two different occupants compare equal.
    const { removals } = deriveAxonRemovals(
      [
        {
          netuid: 25,
          uid: 1,
          snapshot_date: "2026-08-01",
          hotkey: 123,
          axon: "1.2.3.4:1",
        },
        {
          netuid: 25,
          uid: 1,
          snapshot_date: "2026-08-02",
          hotkey: 123,
          axon: null,
        },
        {
          netuid: 25,
          uid: 1,
          snapshot_date: "2026-08-03",
          hotkey: 123,
          axon: null,
        },
      ],
      opts,
    );
    assert.deepEqual(removals, []);
  });

  test("two observations of one slot on the SAME DAY do not reorder unstably", () => {
    // A duplicate snapshot_date is not expected from `neuron_daily`, but the
    // sort must be total anyway: an unstable comparator would make the
    // derivation's answer depend on the pull's order, which another test
    // asserts it does not.
    const rows = [
      day("2026-08-01", { axon: "1.2.3.4:8091" }),
      day("2026-08-02", { axon: null }),
      day("2026-08-02", { axon: null }),
      day("2026-08-03", { axon: null }),
    ];
    const forward = deriveAxonRemovals(rows, opts);
    const reversed = deriveAxonRemovals([...rows].reverse(), opts);
    assert.deepEqual(reversed.removals, forward.removals);
    assert.equal(forward.removals.length, 1);
  });
});
