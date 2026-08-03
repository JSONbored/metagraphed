// Deregistrations derived from UID reuse (#9307).
//
// The route family filtered account_events for `NeuronDeregistered`, an event
// the runtime has never emitted, so it published a permanent 0. Deregistration
// is implicit: a NeuronRegistered on a (netuid, uid) slot already held by a
// DIFFERENT hotkey IS the deregistration of the previous occupant.
//
// The mutations these tests are built to catch, each of which produces a
// plausible-looking number:
//   - counting the slot's FIRST registration as a deregistration (it displaced
//     nobody we can see) -- inflates 7d by 1,726 events on the live data,
//   - counting a same-hotkey re-registration (the account evicting itself),
//   - naming the ARRIVING hotkey instead of the displaced one, which would
//     make /accounts/{ss58}/deregistrations report the exact opposite set,
//   - ordering a slot's registrations by anything but (block, event_index),
//   - summing the per-subnet distinct-hotkey counts into the network rollup.

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  deregistrationRowsForHotkey,
  deregistrationsByHotkey,
  deregistrationsByNetuid,
  deregistrationsNetworkRollup,
  deriveDeregistrations,
} from "../src/deregistration-derivation.ts";

const T0 = Date.UTC(2026, 7, 1, 0, 0, 0);

function reg(
  netuid: number,
  uid: number,
  hotkey: string,
  block: number,
  { eventIndex, at }: { eventIndex?: number; at?: number } = {},
) {
  return {
    netuid,
    uid,
    hotkey,
    block_number: block,
    event_index: eventIndex,
    observed_at: at ?? T0 + block * 1000,
  };
}

describe("deriveDeregistrations", () => {
  test("a slot claimed by a different hotkey deregisters the previous holder", () => {
    const derived = deriveDeregistrations(
      [reg(5, 216, "A", 100), reg(5, 216, "B", 200)],
      { since: T0 },
    );
    assert.equal(derived.events.length, 1);
    assert.deepEqual(derived.events[0], {
      netuid: 5,
      uid: 216,
      // The DISPLACED holder, not the arriving one -- the whole account scope
      // depends on this being A.
      hotkey: "A",
      successor: "B",
      block_number: 200,
      observed_at: T0 + 200_000,
    });
  });

  test("a slot's first observed registration displaces nobody and is counted unattributed", () => {
    const derived = deriveDeregistrations([reg(5, 216, "A", 100)], {
      since: T0,
    });
    assert.deepEqual(derived.events, []);
    assert.equal(derived.unattributed, 1);
    assert.equal(derived.registrations, 1);
  });

  test("a same-hotkey re-registration is nobody's deregistration", () => {
    const derived = deriveDeregistrations(
      [reg(5, 216, "A", 100), reg(5, 216, "A", 200)],
      { since: T0 },
    );
    assert.deepEqual(derived.events, []);
    // Still a window registration, but NOT unattributed: its predecessor was
    // observed, it just happens to be the same account.
    assert.equal(derived.registrations, 2);
    assert.equal(derived.unattributed, 1);
  });

  test("rows before `since` establish occupancy without being reported", () => {
    // A's claim is outside the window; B displacing it is inside. Without the
    // seed prefix this would be an unattributed registration instead of the
    // deregistration it is -- the 66%-to-21% difference on live data.
    const derived = deriveDeregistrations(
      [reg(5, 216, "A", 100), reg(5, 216, "B", 200)],
      { since: T0 + 150_000 },
    );
    assert.equal(
      derived.registrations,
      1,
      "only B's registration is in-window",
    );
    assert.equal(derived.unattributed, 0);
    assert.equal(derived.events[0]!.hotkey, "A");
  });

  test("orders a slot by (block_number, event_index), not input order", () => {
    // Fed newest-first, and with two claims inside ONE block -- the case a
    // block-only sort cannot resolve.
    const derived = deriveDeregistrations(
      [
        reg(5, 216, "C", 200, { eventIndex: 9 }),
        reg(5, 216, "B", 200, { eventIndex: 2 }),
        reg(5, 216, "A", 100),
      ],
      { since: T0 },
    );
    assert.deepEqual(
      derived.events.map((e) => [e.hotkey, e.successor]),
      [
        ["A", "B"],
        ["B", "C"],
      ],
    );
  });

  test("keeps slots apart across subnets and uids", () => {
    const derived = deriveDeregistrations(
      [
        reg(5, 1, "A", 100),
        reg(5, 2, "B", 110),
        reg(9, 1, "C", 120),
        // Same uid on a different subnet must not displace A.
        reg(9, 1, "D", 130),
      ],
      { since: T0 },
    );
    assert.equal(derived.events.length, 1);
    assert.deepEqual(
      [derived.events[0]!.netuid, derived.events[0]!.hotkey],
      [9, "C"],
    );
    assert.equal(derived.unattributed, 3);
  });

  test("drops rows that cannot identify or order a slot", () => {
    const derived = deriveDeregistrations(
      [
        reg(5, 216, "A", 100),
        { netuid: null, uid: 216, hotkey: "X", block_number: 150 },
        { netuid: 5, uid: "", hotkey: "X", block_number: 150 },
        { netuid: 5, uid: 216, hotkey: "  ", block_number: 150 },
        { netuid: 5, uid: 216, hotkey: 42, block_number: 150 },
        { netuid: 5, uid: 216, hotkey: "X", block_number: -1 },
        { netuid: 5, uid: 216, hotkey: "X", block_number: 150 },
        {
          netuid: 5,
          uid: 216,
          hotkey: "X",
          block_number: 150,
          observed_at: 0,
        },
        {
          netuid: 5,
          uid: 216,
          hotkey: "X",
          block_number: 150,
          observed_at: "not-a-time",
        },
        {
          netuid: 5,
          uid: 216,
          hotkey: "X",
          block_number: 150,
          observed_at: 8.7e15,
        },
        reg(5, 216, "B", 200),
      ],
      { since: T0 },
    );
    // Only A -> B survives; a malformed row must never silently become slot 0
    // or reorder the sequence.
    assert.equal(derived.events.length, 1);
    assert.deepEqual(
      [derived.events[0]!.hotkey, derived.events[0]!.successor],
      ["A", "B"],
    );
  });

  test("null/undefined rows derive nothing rather than throwing", () => {
    for (const input of [null, undefined, [] as never[]]) {
      assert.deepEqual(deriveDeregistrations(input, { since: T0 }), {
        events: [],
        unattributed: 0,
        registrations: 0,
      });
    }
  });
});

/** A -> B on subnet 5 twice, plus A -> C on subnet 9. */
const EVENTS = deriveDeregistrations(
  [
    reg(5, 1, "A", 100),
    reg(5, 1, "B", 200),
    reg(5, 2, "A", 210),
    reg(5, 2, "B", 220),
    reg(9, 1, "A", 230),
    reg(9, 1, "C", 240),
  ],
  { since: T0 },
).events;

describe("deregistrationsByNetuid", () => {
  test("counts events and distinct displaced hotkeys per subnet", () => {
    assert.deepEqual(deregistrationsByNetuid(EVENTS), [
      {
        netuid: 5,
        deregistrations: 2,
        // A was displaced twice on subnet 5 -- two events, ONE hotkey.
        distinct_deregistered_hotkeys: 1,
        newest_observed: T0 + 220_000,
      },
      {
        netuid: 9,
        deregistrations: 1,
        distinct_deregistered_hotkeys: 1,
        newest_observed: T0 + 240_000,
      },
    ]);
  });

  test("ranks most-active-first, tie-broken by netuid ascending", () => {
    const rows = deregistrationsByNetuid([
      ...EVENTS,
      {
        netuid: 2,
        uid: 0,
        hotkey: "Z",
        successor: "Y",
        block_number: 1,
        observed_at: T0,
      },
    ]);
    assert.deepEqual(
      rows.map((r) => r.netuid),
      [5, 2, 9],
    );
  });

  test("no events yields no rows", () => {
    assert.deepEqual(deregistrationsByNetuid([]), []);
  });

  test("newest_observed is the MAX, not the last event seen", () => {
    // The per-hotkey index sorts by slot, so a subnet's events do not arrive in
    // time order -- taking the last one would stamp the card with an older
    // instant than it actually observed.
    const rows = deregistrationsByNetuid([
      {
        netuid: 5,
        uid: 1,
        hotkey: "A",
        successor: "B",
        block_number: 9,
        observed_at: 900,
      },
      {
        netuid: 5,
        uid: 2,
        hotkey: "C",
        successor: "D",
        block_number: 2,
        observed_at: 200,
      },
    ]);
    assert.equal(rows[0]!.newest_observed, 900);
  });
});

describe("deregistrationsNetworkRollup", () => {
  test("counts a hotkey once network-wide, never the sum of the per-subnet counts", () => {
    // Per-subnet counts sum to 2 (one on subnet 5, one on subnet 9); the true
    // network-wide figure is 1, because both are the same hotkey A.
    const rollup = deregistrationsNetworkRollup(EVENTS);
    assert.equal(rollup.distinct_deregistered_hotkeys, 1);
    assert.equal(rollup.newest_observed, T0 + 240_000);
  });

  test("no events has no newest_observed rather than a zero stamp", () => {
    assert.deepEqual(deregistrationsNetworkRollup([]), {
      distinct_deregistered_hotkeys: 0,
      newest_observed: null,
    });
  });

  test("newest_observed is the MAX, not the last event seen", () => {
    const rollup = deregistrationsNetworkRollup([
      {
        netuid: 5,
        uid: 1,
        hotkey: "A",
        successor: "B",
        block_number: 9,
        observed_at: 900,
      },
      {
        netuid: 9,
        uid: 2,
        hotkey: "C",
        successor: "D",
        block_number: 2,
        observed_at: 200,
      },
    ]);
    assert.equal(rollup.newest_observed, 900);
  });
});

describe("deregistrationsByHotkey", () => {
  test("keys on the DISPLACED holder and spans its subnets", () => {
    const index = deregistrationsByHotkey(EVENTS);
    assert.deepEqual(Object.keys(index).sort(), ["A"]);
    assert.deepEqual(index.A, [
      [5, 2, T0 + 200_000, T0 + 220_000],
      [9, 1, T0 + 240_000, T0 + 240_000],
    ]);
    // The arriving hotkeys are NOT keys: they gained a slot, they did not lose
    // one.
    assert.equal(index.B, undefined);
    assert.equal(index.C, undefined);
  });

  test("widens first/last as events arrive out of order", () => {
    const index = deregistrationsByHotkey([
      {
        netuid: 5,
        uid: 1,
        hotkey: "A",
        successor: "B",
        block_number: 3,
        observed_at: 300,
      },
      {
        netuid: 5,
        uid: 1,
        hotkey: "A",
        successor: "C",
        block_number: 1,
        observed_at: 100,
      },
      {
        netuid: 5,
        uid: 1,
        hotkey: "A",
        successor: "D",
        block_number: 2,
        observed_at: 200,
      },
    ]);
    assert.deepEqual(index.A, [[5, 3, 100, 300]]);
  });
});

describe("deregistrationRowsForHotkey", () => {
  test("expands tuples into the rows the account builder reads", () => {
    assert.deepEqual(
      deregistrationRowsForHotkey([
        [5, 2, 100, 200],
        [9, 1, 300, 300],
      ]),
      [
        {
          netuid: 5,
          deregistrations: 2,
          first_observed: 100,
          last_observed: 200,
        },
        {
          netuid: 9,
          deregistrations: 1,
          first_observed: 300,
          last_observed: 300,
        },
      ],
    );
  });

  test("a missing or malformed entry expands to nothing, never a partial row", () => {
    assert.deepEqual(deregistrationRowsForHotkey(undefined), []);
    assert.deepEqual(deregistrationRowsForHotkey("nope"), []);
    assert.deepEqual(deregistrationRowsForHotkey([[5, 2, 100], 7, null]), []);
  });
});
