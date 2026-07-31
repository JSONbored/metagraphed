// Tests for src/emission-gate-history.ts (#8748).
//
// The three cases that matter are the ones a naive differ gets wrong: null is
// a real reading rather than a gap, theta's runtime recomputation is not a
// governance change, and a first observation is not a change at all — the
// 0.61 -> 0.75 quantile move predates any capture and must be representable
// without inventing a date for it.

import { describe, expect, it } from "vitest";
import {
  GATE_PARAM_SOURCES,
  gateParamChanges,
  subnetEnabledChanges,
  type GateParam,
} from "../src/emission-gate-history.ts";

const AT = { blockNumber: 8_740_000, observedAt: 1_785_000_000_000 };

describe("first observation", () => {
  it("records a baseline marked predates_capture rather than a change", () => {
    // The quantile was ALREADY 0.75 when capture began; its move from the 0.61
    // default is unrecoverable. This is how that is stated honestly.
    const changes = gateParamChanges({
      current: { emission_bar_quantile: 0.75 },
      previous: {},
      ...AT,
    });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      param: "emission_bar_quantile",
      value: 0.75,
      previous_value: null,
      predates_capture: true,
    });
  });

  it("marks an unset parameter's baseline too", () => {
    // EmissionGateExponent reads null on chain today. That is a real reading
    // ("use the runtime default"), so it gets a baseline row like any other.
    const changes = gateParamChanges({
      current: { emission_gate_exponent: null },
      previous: {},
      ...AT,
    });
    expect(changes).toHaveLength(1);
    expect(changes[0].value).toBeNull();
    expect(changes[0].predates_capture).toBe(true);
  });
});

describe("append-on-change", () => {
  it("writes nothing when a value has not moved", () => {
    expect(
      gateParamChanges({
        current: { emission_bar_quantile: 0.75 },
        previous: { emission_bar_quantile: 0.75 },
        ...AT,
      }),
    ).toEqual([]);
  });

  it("writes one row carrying the previous value when it moves", () => {
    const changes = gateParamChanges({
      current: { emission_bar_quantile: 0.8 },
      previous: { emission_bar_quantile: 0.75 },
      ...AT,
    });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      value: 0.8,
      previous_value: 0.75,
      predates_capture: false,
      block_number: AT.blockNumber,
      observed_at: AT.observedAt,
    });
  });

  it("treats null as a value, in both directions", () => {
    // An item becoming unset, and an unset item being set, are both real
    // governance events — not gaps to skip.
    const becameUnset = gateParamChanges({
      current: { emission_gate_exponent: null },
      previous: { emission_gate_exponent: 3 },
      ...AT,
    });
    expect(becameUnset).toHaveLength(1);
    expect(becameUnset[0]).toMatchObject({ value: null, previous_value: 3 });

    const becameSet = gateParamChanges({
      current: { emission_gate_exponent: 4 },
      previous: { emission_gate_exponent: null },
      ...AT,
    });
    expect(becameSet).toHaveLength(1);
    expect(becameSet[0]).toMatchObject({ value: 4, previous_value: null });
    // Distinguishable from a baseline despite both showing previous_value null.
    expect(becameSet[0].predates_capture).toBe(false);
  });

  it("ignores a parameter absent from the reading", () => {
    // A failed storage read must not be recorded as "became null".
    expect(
      gateParamChanges({
        current: {},
        previous: { emission_bar_quantile: 0.75 },
        ...AT,
      }),
    ).toEqual([]);
  });
});

describe("theta is not a governance change", () => {
  it("labels the runtime-recomputed parameters distinctly", () => {
    const changes = gateParamChanges({
      current: { emission_gate_bar: 0.0089, emission_bar_quantile: 0.8 },
      previous: { emission_gate_bar: 0.0088, emission_bar_quantile: 0.75 },
      ...AT,
    });
    const bySource = Object.fromEntries(
      changes.map((c) => [c.param, c.source]),
    );
    expect(bySource.emission_gate_bar).toBe("runtime_recomputed");
    expect(bySource.emission_bar_quantile).toBe("governance");
  });

  it("agrees with the exported source table for every parameter", () => {
    // Derived from the real constant: a parameter added there without a source
    // decision would otherwise silently record as whatever the differ guessed.
    for (const param of Object.keys(GATE_PARAM_SOURCES) as GateParam[]) {
      const [change] = gateParamChanges({
        current: { [param]: 1 },
        previous: {},
        ...AT,
      });
      expect(change.source).toBe(GATE_PARAM_SOURCES[param]);
    }
  });

  it("orders rows by the source table, not by caller key order", () => {
    const changes = gateParamChanges({
      current: { emission_bar_quantile: 1, emission_gate_bar: 1 },
      previous: {},
      ...AT,
    });
    expect(changes.map((c) => c.param)).toEqual([
      "emission_gate_bar",
      "emission_bar_quantile",
    ]);
  });
});

describe("per-subnet enablement", () => {
  it("baselines every subnet on first capture", () => {
    const changes = subnetEnabledChanges({
      current: new Map([
        [1, true],
        [2, false],
      ]),
      previous: new Map(),
      ...AT,
    });
    expect(changes).toHaveLength(2);
    expect(changes.every((c) => c.predates_capture)).toBe(true);
    expect(changes.every((c) => c.previous_enabled === null)).toBe(true);
  });

  it("records only the subnet that flipped", () => {
    const changes = subnetEnabledChanges({
      current: new Map([
        [1, true],
        [2, true],
      ]),
      previous: new Map([
        [1, true],
        [2, false],
      ]),
      ...AT,
    });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      netuid: 2,
      enabled: true,
      previous_enabled: false,
      predates_capture: false,
    });
  });

  it("records a disable, which is the state 47 subnets are in", () => {
    const changes = subnetEnabledChanges({
      current: new Map([[8, false]]),
      previous: new Map([[8, true]]),
      ...AT,
    });
    expect(changes[0]).toMatchObject({
      enabled: false,
      previous_enabled: true,
    });
  });

  it("writes nothing when nothing moved", () => {
    expect(
      subnetEnabledChanges({
        current: new Map([[1, true]]),
        previous: new Map([[1, true]]),
        ...AT,
      }),
    ).toEqual([]);
  });

  it("sorts by netuid regardless of map insertion order", () => {
    const changes = subnetEnabledChanges({
      current: new Map([
        [9, true],
        [2, true],
      ]),
      previous: new Map(),
      ...AT,
    });
    expect(changes.map((c) => c.netuid)).toEqual([2, 9]);
  });
});
