import { describe, expect, it } from "vitest";
import {
  ACTIVITY_AGGREGATION_WINDOW_MS,
  activityGroupKey,
  activityGroupSpanMinutes,
  aggregateActivityEvents,
  type ActivityGroup,
} from "./activity-aggregation";
import type { AccountEvent } from "./types";

// Newest-first, matching this app's convention -- `t` is minutes before a
// fixed reference instant, so smaller `t` is newer and appears earlier.
function ev(kind: string | null, t: number, extra: Partial<AccountEvent> = {}): AccountEvent {
  return {
    block_number: null,
    event_index: null,
    event_kind: kind,
    observed_at: new Date(Date.UTC(2026, 0, 1, 0, 0, 0) - t * 60_000).toISOString(),
    ...extra,
  };
}

describe("aggregateActivityEvents", () => {
  it("returns one group per event when nothing repeats", () => {
    const events = [ev("StakeAdded", 0), ev("WeightsSet", 1), ev("StakeRemoved", 2)];
    const groups = aggregateActivityEvents(events);
    expect(groups).toHaveLength(3);
    expect(groups.map((g) => g.kind)).toEqual(["StakeAdded", "WeightsSet", "StakeRemoved"]);
    expect(groups.every((g) => g.events.length === 1)).toBe(true);
  });

  it("collapses a consecutive same-kind run within the window into one group", () => {
    const events = [
      ev("WeightsSet", 0),
      ev("WeightsSet", 3),
      ev("WeightsSet", 6),
      ev("WeightsSet", 9),
    ];
    const groups = aggregateActivityEvents(events);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.kind).toBe("WeightsSet");
    expect(groups[0]!.events).toHaveLength(4);
  });

  it("does NOT retroactively merge across an interrupting different kind (#8366: 'consecutive')", () => {
    const events = [ev("WeightsSet", 0), ev("StakeAdded", 2), ev("WeightsSet", 4)];
    const groups = aggregateActivityEvents(events);
    expect(groups).toHaveLength(3);
    expect(groups.map((g) => g.kind)).toEqual(["WeightsSet", "StakeAdded", "WeightsSet"]);
  });

  it("caps a run once it drifts more than windowMs from the group's newest (anchor) member", () => {
    // Anchor at t=0; window is 15m. t=16 is outside that window from the
    // anchor, even though each STEP between successive events is small --
    // the check is always against the group's first/newest member, not the
    // immediately preceding one.
    const events = [ev("WeightsSet", 0), ev("WeightsSet", 14), ev("WeightsSet", 16)];
    const groups = aggregateActivityEvents(events, ACTIVITY_AGGREGATION_WINDOW_MS);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.events).toHaveLength(2); // t=0, t=14 -- both within 15m of t=0
    expect(groups[1]!.events).toHaveLength(1); // t=16 starts a fresh group
  });

  it("respects a custom windowMs", () => {
    const events = [ev("WeightsSet", 0), ev("WeightsSet", 4)];
    expect(aggregateActivityEvents(events, 5 * 60_000)).toHaveLength(1);
    expect(aggregateActivityEvents(events, 3 * 60_000)).toHaveLength(2);
  });

  it("never groups an event missing observed_at, even with an identical neighbor kind", () => {
    const events = [
      ev("WeightsSet", 0),
      ev("WeightsSet", 1, { observed_at: undefined }),
      ev("WeightsSet", 2),
    ];
    const groups = aggregateActivityEvents(events);
    // The undated middle event can neither join the group before it (no
    // timestamp to compare) nor have anything join IT afterward.
    expect(groups).toHaveLength(3);
  });

  it("treats two null-kind events as the same kind (grouped like any other repeated kind)", () => {
    const events = [ev(null, 0), ev(null, 1)];
    const groups = aggregateActivityEvents(events);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.kind).toBeNull();
  });

  it("handles an empty input", () => {
    expect(aggregateActivityEvents([])).toEqual([]);
  });
});

describe("activityGroupSpanMinutes", () => {
  it("returns null for a single-event group (nothing to span)", () => {
    const [group] = aggregateActivityEvents([ev("WeightsSet", 0)]);
    expect(activityGroupSpanMinutes(group!)).toBeNull();
  });

  it("returns the rounded minute span between the newest and oldest member", () => {
    const [group] = aggregateActivityEvents([
      ev("WeightsSet", 0),
      ev("WeightsSet", 5),
      ev("WeightsSet", 12),
    ]);
    expect(activityGroupSpanMinutes(group!)).toBe(12);
  });

  it("returns null when a member is missing observed_at", () => {
    // Can only occur via a caller constructing a group directly (not through
    // aggregateActivityEvents itself, which never groups an undated event) --
    // still handled defensively rather than returning NaN/a bogus span.
    const group = {
      kind: "WeightsSet",
      events: [ev("WeightsSet", 0), ev("WeightsSet", 5, { observed_at: undefined })],
    };
    expect(activityGroupSpanMinutes(group)).toBeNull();
  });
});

describe("activityGroupKey (#8817)", () => {
  it("keeps a group's key stable across a prepend that shifts its array index", () => {
    const base = [
      ev("StakeAdded", 1, { block_number: 100, event_index: 1 }),
      ev("StakeAdded", 2, { block_number: 100, event_index: 2 }),
      ev("WeightsSet", 5, { block_number: 90, event_index: 3 }),
    ];
    const before = aggregateActivityEvents(base);
    expect(before.length).toBeGreaterThanOrEqual(2);
    const targetIndex = before.length - 1;
    const targetKey = activityGroupKey(before[targetIndex]!);

    const prepended = ev("NeuronRegistered", 0, { block_number: 110, event_index: 0 });
    const after = aggregateActivityEvents([prepended, ...base]);
    const newIndex = after.findIndex((g) => activityGroupKey(g) === targetKey);
    expect(newIndex).toBeGreaterThan(targetIndex);
    expect(activityGroupKey(after[newIndex]!)).toBe(targetKey);
  });

  it("never collides two groups in one list, including when anchor fields are nullish", () => {
    const groups: ActivityGroup[] = [
      {
        kind: "WeightsSet",
        events: [
          ev("WeightsSet", 0, { block_number: null, event_index: null, observed_at: undefined }),
        ],
      },
      {
        kind: "StakeAdded",
        events: [
          ev("StakeAdded", 0, { block_number: null, event_index: null, observed_at: undefined }),
        ],
      },
      {
        kind: null,
        events: [ev(null, 0, { block_number: null, event_index: null, observed_at: undefined })],
      },
    ];
    const keys = groups.map(activityGroupKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every((k) => k.includes("∅"))).toBe(true);
  });
});
