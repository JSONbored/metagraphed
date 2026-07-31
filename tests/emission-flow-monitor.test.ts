// Tests for src/emission-flow-monitor.ts (#8750).
//
// The cases that matter are the ones a naive watcher gets wrong: the EMA is
// the early signal rather than the flag (it resumes whether or not
// NetTaoFlowEnabled was flipped), unset->unset is the steady state and must
// stay silent, and a subnet with no entry at all is not the same as one
// stamped at block 0.

import { describe, expect, it } from "vitest";
import {
  EMA_FROZEN_BASELINE_BLOCK,
  FLOW_PARAM_ITEMS,
  decodeSubnetEmaTaoFlow,
  emaAdvancedEvents,
  flowParamEvents,
  type FlowParamItem,
} from "../src/emission-flow-monitor.ts";

const AT = { blockNumber: 8_740_000, observedAt: 1_785_000_000_000 };

/** A 24-byte SubnetEmaTaoFlow value: 8-byte LE block ++ 16-byte I64F64 EMA. */
function emaHex(block: number): string {
  const bytes: string[] = [];
  let remaining = BigInt(block);
  for (let i = 0; i < 8; i += 1) {
    bytes.push((remaining & 0xffn).toString(16).padStart(2, "0"));
    remaining >>= 8n;
  }
  return `0x${bytes.join("")}${"11".repeat(16)}`;
}

describe("decodeSubnetEmaTaoFlow", () => {
  it("reads the block from the FIRST eight bytes, little-endian", () => {
    expect(decodeSubnetEmaTaoFlow(emaHex(EMA_FROZEN_BASELINE_BLOCK))).toEqual({
      block: EMA_FROZEN_BASELINE_BLOCK,
    });
  });

  it("returns null for an absent entry", () => {
    // 4 of 128 subnets have no entry at all. That is a real reading, not a
    // zero — treating it as block 0 would read as "moved backwards".
    expect(decodeSubnetEmaTaoFlow(null)).toBeNull();
  });

  it("returns null for a value of the wrong width", () => {
    // Guards against decoding a 16-byte U64F64 as if it were this 24-byte
    // tuple, which would silently produce a nonsense block height.
    expect(decodeSubnetEmaTaoFlow(`0x${"00".repeat(16)}`)).toBeNull();
  });

  it("returns null for a non-string", () => {
    expect(decodeSubnetEmaTaoFlow(12345)).toBeNull();
  });

  it("returns null for a malformed hex string", () => {
    expect(decodeSubnetEmaTaoFlow(`0x${"zz".repeat(24)}`)).toBeNull();
  });
});

describe("flowParamEvents", () => {
  const allItems = Object.keys(FLOW_PARAM_ITEMS) as FlowParamItem[];

  it("records a baseline marked predates_capture on first observation", () => {
    const events = flowParamEvents({
      current: [{ item: "net_tao_flow_enabled", raw: null }],
      previous: new Map(),
      ...AT,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      item: "net_tao_flow_enabled",
      is_set: false,
      netuid: null,
      ema_block: null,
      predates_capture: true,
    });
  });

  it("stays silent while an unset parameter stays unset", () => {
    // This is what "zero alerts is the correct steady state" means.
    const previous = new Map<FlowParamItem, boolean>(
      allItems.map((i) => [i, false]),
    );
    const events = flowParamEvents({
      current: allItems.map((item) => ({ item, raw: null })),
      previous,
      ...AT,
    });
    expect(events).toEqual([]);
  });

  it("fires when a parameter becomes set", () => {
    const events = flowParamEvents({
      current: [{ item: "net_tao_flow_enabled", raw: "0x01" }],
      previous: new Map([["net_tao_flow_enabled", false]]),
      ...AT,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ is_set: true, predates_capture: false });
  });

  it("fires when a parameter is cleared again", () => {
    // Provisioning then un-provisioning is still a state change worth seeing.
    const events = flowParamEvents({
      current: [{ item: "tao_flow_cutoff", raw: null }],
      previous: new Map([["tao_flow_cutoff", true]]),
      ...AT,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ item: "tao_flow_cutoff", is_set: false });
  });

  it("skips items absent from the observation rather than inventing a reading", () => {
    // A failed storage read must not be recorded as "unset" — that would be a
    // false alert in one direction and a false silence in the other.
    const events = flowParamEvents({
      current: [],
      previous: new Map([["flow_norm_exponent", true]]),
      ...AT,
    });
    expect(events).toEqual([]);
  });

  it("emits rows in FLOW_PARAM_ITEMS order regardless of observation order", () => {
    const reversed = [...allItems]
      .reverse()
      .map((item) => ({ item, raw: "0x01" }));
    const events = flowParamEvents({
      current: reversed,
      previous: new Map(),
      ...AT,
    });
    expect(events.map((e) => e.item)).toEqual(allItems);
  });
});

describe("emaAdvancedEvents", () => {
  it("stays silent while every subnet is frozen at the baseline", () => {
    const current = new Map([
      [1, { block: EMA_FROZEN_BASELINE_BLOCK }],
      [2, { block: EMA_FROZEN_BASELINE_BLOCK }],
    ]);
    expect(
      emaAdvancedEvents({
        current,
        baselineBlock: EMA_FROZEN_BASELINE_BLOCK,
        ...AT,
      }),
    ).toEqual([]);
  });

  it("fires for a subnet whose EMA advanced past the baseline", () => {
    // The earliest signal available: the EMA resumes the moment
    // get_shares_flow runs, whether or not NetTaoFlowEnabled was flipped.
    const current = new Map([
      [1, { block: EMA_FROZEN_BASELINE_BLOCK }],
      [7, { block: EMA_FROZEN_BASELINE_BLOCK + 1 }],
    ]);
    const events = emaAdvancedEvents({
      current,
      baselineBlock: EMA_FROZEN_BASELINE_BLOCK,
      ...AT,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      item: "subnet_ema_tao_flow",
      netuid: 7,
      ema_block: EMA_FROZEN_BASELINE_BLOCK + 1,
      is_set: true,
      predates_capture: false,
    });
  });

  it("skips subnets with no entry instead of treating them as block 0", () => {
    const current = new Map([[3, null]]);
    expect(
      emaAdvancedEvents({
        current,
        baselineBlock: EMA_FROZEN_BASELINE_BLOCK,
        ...AT,
      }),
    ).toEqual([]);
  });

  it("stays silent for an EMA stamped BEFORE the baseline", () => {
    const current = new Map([[4, { block: EMA_FROZEN_BASELINE_BLOCK - 100 }]]);
    expect(
      emaAdvancedEvents({
        current,
        baselineBlock: EMA_FROZEN_BASELINE_BLOCK,
        ...AT,
      }),
    ).toEqual([]);
  });

  it("emits rows sorted by netuid regardless of map insertion order", () => {
    const current = new Map([
      [9, { block: EMA_FROZEN_BASELINE_BLOCK + 5 }],
      [2, { block: EMA_FROZEN_BASELINE_BLOCK + 5 }],
    ]);
    const events = emaAdvancedEvents({
      current,
      baselineBlock: EMA_FROZEN_BASELINE_BLOCK,
      ...AT,
    });
    expect(events.map((e) => e.netuid)).toEqual([2, 9]);
  });
});
