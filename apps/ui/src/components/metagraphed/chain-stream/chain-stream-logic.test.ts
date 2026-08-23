import { describe, expect, it } from "vitest";
import type { Block, ChainEvent, Extrinsic } from "@/lib/metagraphed/types";
import {
  TARGET_BLOCK_MS,
  blockRows,
  blocksFacts,
  boundedTotal,
  cadenceTint,
  callLabel,
  eventLabel,
  eventsFacts,
  extrinsicsFacts,
  pageFacet,
  pageOf,
  topBy,
  withoutNoise,
} from "./chain-stream-logic";

const at = (ms: number) => new Date(ms).toISOString();
const T = 1_800_000_000_000;

// Newest first, as the feed returns them: 12s, 24s, then a pair sharing a
// timestamp (one poller pass caught up on two blocks).
const blocks: Block[] = [
  { block_number: 104, block_hash: "0xd", observed_at: at(T + 36_000) },
  { block_number: 103, block_hash: "0xc", observed_at: at(T + 24_000) },
  { block_number: 102, block_hash: "0xb", observed_at: at(T) },
  { block_number: 101, block_hash: "0xa", observed_at: at(T) },
];

describe("blockRows", () => {
  it("takes each gap from the row below, newest first", () => {
    expect(blockRows(blocks).map((r) => r.block_time_ms)).toEqual([12_000, 24_000, null, null]);
  });

  it("gives the oldest row on the page no block time at all", () => {
    // Its predecessor is on the NEXT page. Any number here would be invented.
    const rows = blockRows(blocks);
    expect(rows[rows.length - 1]!.block_time_ms).toBeNull();
  });

  it("drops a non-positive gap rather than showing 0s", () => {
    // Blocks 102 and 101 share an observed_at.
    expect(blockRows(blocks)[2]!.block_time_ms).toBeNull();
  });

  it("drops a gap wider than ten targets — that measures an outage", () => {
    const stalled: Block[] = [
      { block_number: 2, block_hash: "0x2", observed_at: at(T + 11 * TARGET_BLOCK_MS) },
      { block_number: 1, block_hash: "0x1", observed_at: at(T) },
    ];
    expect(blockRows(stalled)[0]!.block_time_ms).toBeNull();
  });

  it("survives a row with no observed_at, and an empty page", () => {
    expect(blockRows([{ block_number: 1, block_hash: "0x1" }])[0]!.block_time_ms).toBeNull();
    expect(blockRows([])).toEqual([]);
  });

  it("keeps every original field", () => {
    expect(blockRows(blocks)[0]!.block_hash).toBe("0xd");
  });
});

describe("cadenceTint", () => {
  it("puts the target at the centre, not at an end", () => {
    expect(cadenceTint(TARGET_BLOCK_MS)).toBe(0.5);
  });

  it("clamps at half and double the target", () => {
    expect(cadenceTint(TARGET_BLOCK_MS / 2)).toBe(0);
    expect(cadenceTint(TARGET_BLOCK_MS / 4)).toBe(0);
    expect(cadenceTint(TARGET_BLOCK_MS * 2)).toBe(1);
    expect(cadenceTint(TARGET_BLOCK_MS * 9)).toBe(1);
  });

  it("is monotonic across the whole range", () => {
    const samples = [6_000, 9_000, 12_000, 15_000, 18_000, 24_000].map(cadenceTint);
    for (let i = 1; i < samples.length; i += 1) {
      expect(samples[i]!).toBeGreaterThanOrEqual(samples[i - 1]!);
    }
  });

  it("has no tint for an absent or impossible reading", () => {
    expect(cadenceTint(null)).toBeNull();
    expect(cadenceTint(undefined)).toBeNull();
    expect(cadenceTint(0)).toBeNull();
    expect(cadenceTint(-1)).toBeNull();
    expect(cadenceTint(Number.NaN)).toBeNull();
  });
});

describe("callLabel / eventLabel", () => {
  it("joins the two halves", () => {
    expect(callLabel("SubtensorModule", "serve_axon")).toBe("SubtensorModule.serve_axon");
    expect(eventLabel({ pallet: "Balances", method: "Transfer" })).toBe("Balances.Transfer");
  });

  it("returns the half that exists rather than a dangling dot", () => {
    expect(callLabel("Balances", null)).toBe("Balances");
    expect(callLabel(null, "Transfer")).toBe("Transfer");
    expect(callLabel("  ", "Transfer")).toBe("Transfer");
  });

  it("is null when neither half exists", () => {
    expect(callLabel(null, undefined)).toBeNull();
    expect(callLabel("", "  ")).toBeNull();
  });
});

describe("pageFacet", () => {
  const rows = [{ m: "B" }, { m: "A" }, { m: "B" }, { m: null }, { m: "  " }, { m: " A " }];

  it("is the sorted distinct set, trimmed", () => {
    expect(pageFacet(rows, (r) => r.m)).toEqual(["A", "B"]);
  });

  it("is empty on empty input", () => {
    expect(pageFacet([], () => "x")).toEqual([]);
  });
});

describe("boundedTotal / pageOf", () => {
  it("promises one more page only while the page is full", () => {
    expect(boundedTotal(0, 50, 50)).toBe(100);
    expect(boundedTotal(100, 50, 50)).toBe(200);
  });

  it("settles exactly on a short page — no Next in front of nothing", () => {
    expect(boundedTotal(100, 17, 50)).toBe(117);
    expect(boundedTotal(0, 0, 50)).toBe(0);
  });

  it("numbers pages from one", () => {
    expect(pageOf(0, 50)).toBe(1);
    expect(pageOf(50, 50)).toBe(2);
    expect(pageOf(120, 50)).toBe(3);
    expect(pageOf(0, 0)).toBe(1);
  });
});

const fmt = { count: (n: number) => String(n), seconds: (s: number) => `${s}s` };

describe("blocksFacts", () => {
  it("reports the head, the cadence, the throughput and the Nakamoto coefficient", () => {
    expect(
      blocksFacts(
        {
          block_time: { mean_ms: 12_000 },
          throughput: { mean_extrinsics_per_block: 19.63 },
          author_concentration: { nakamoto_coefficient: 83 },
        },
        8_905_456,
        fmt,
      ).map((f) => [f.key, f.value]),
    ).toEqual([
      ["head", `#${8_905_456}`],
      ["cadence", "12s"],
      ["throughput", "19.6"],
      ["authors", "83"],
    ]);
  });

  it("falls back to the summary's own last block when the page is empty", () => {
    expect(blocksFacts({ last_block: 7 }, null, fmt)[0]).toEqual({
      key: "head",
      label: "head",
      value: "#7",
    });
  });

  it("omits every fact the summary does not state, rather than printing a dash", () => {
    expect(blocksFacts(null, null, fmt)).toEqual([]);
    expect(blocksFacts({ block_time: { mean_ms: 0 } }, null, fmt)).toEqual([]);
  });
});

describe("extrinsicsFacts", () => {
  // Three SubtensorModule to two Balances -- a clear winner, so this asserts
  // "most common" and not the alphabetical tie-break (which topBy owns).
  const rows = [
    { call_module: "SubtensorModule", success: true },
    { call_module: "SubtensorModule", success: true },
    { call_module: "SubtensorModule", success: null },
    { call_module: "Balances", success: false },
    { call_module: "Balances", success: null },
  ] as unknown as Extrinsic[];

  it("counts the success rate over the rows that STATE a result", () => {
    // 2 of 3 stated, not 2 of 4 — `success == null` is missing coverage, not
    // a failure, and counting it would make the rate fall as coverage falls.
    const ok = extrinsicsFacts(rows, fmt).find((f) => f.key === "ok");
    expect(ok?.value).toBe("66.7%");
  });

  it("names the page's most common module", () => {
    expect(extrinsicsFacts(rows, fmt).find((f) => f.key === "module")?.value).toBe(
      "SubtensorModule",
    );
  });

  it("says the count is of the page, never of a window it cannot see", () => {
    expect(extrinsicsFacts(rows, fmt)[0]).toEqual({
      key: "rows",
      label: "on this page",
      value: "5",
    });
  });

  it("drops the rate entirely when nothing states a result", () => {
    const blind = [{ call_module: "X", success: null }] as unknown as Extrinsic[];
    expect(extrinsicsFacts(blind, fmt).some((f) => f.key === "ok")).toBe(false);
  });

  it("survives an empty page", () => {
    expect(extrinsicsFacts([], fmt).map((f) => f.key)).toEqual(["rows"]);
  });
});

describe("eventsFacts", () => {
  const stats = {
    window_blocks: 1000,
    groups: 54,
    activity: [
      { pallet: "Balances", method: "Deposit", count: 114_553 },
      { pallet: "System", method: "ExtrinsicSuccess", count: 17_003 },
    ],
  };

  it("states the window the count is over", () => {
    expect(eventsFacts(stats, fmt)[0]).toEqual({
      key: "events",
      label: "events in 1000 blocks",
      value: "131556",
    });
  });

  it("names the most frequent kind and how many kinds there are", () => {
    const facts = eventsFacts(stats, fmt);
    expect(facts.find((f) => f.key === "top")?.value).toBe("Balances.Deposit");
    expect(facts.find((f) => f.key === "kinds")?.value).toBe("54");
  });

  it("is empty when the stats endpoint has nothing", () => {
    expect(eventsFacts(null, fmt)).toEqual([]);
    expect(eventsFacts({ activity: [] }, fmt)).toEqual([]);
  });
});

describe("topBy", () => {
  it("breaks a tie on the name so the fact does not flicker", () => {
    expect(topBy([{ m: "B" }, { m: "A" }], (r) => r.m)).toEqual({ key: "A", count: 1 });
  });

  it("ignores empty values and returns null when nothing is left", () => {
    expect(topBy([{ m: null }, { m: " " }], (r) => r.m)).toBeNull();
  });
});

describe("withoutNoise", () => {
  const events = [
    { pallet: "System", method: "ExtrinsicSuccess" },
    { pallet: "Balances", method: "Transfer" },
    { pallet: "TransactionPayment", method: "TransactionFeePaid" },
    { pallet: "SubtensorModule", method: "WeightsSet" },
    { pallet: "System", method: "ExtrinsicFailed" },
  ] as unknown as ChainEvent[];

  it("hides the three per-extrinsic plumbing events and says how many", () => {
    const { rows, hidden } = withoutNoise(events, false);
    expect(rows.map((r) => r.method)).toEqual(["Transfer", "WeightsSet"]);
    expect(hidden).toBe(3);
  });

  it("returns everything, and hides nothing, when the reader asks for it", () => {
    const { rows, hidden } = withoutNoise(events, true);
    expect(rows).toHaveLength(events.length);
    expect(hidden).toBe(0);
  });

  it("reports hidden 0 when there was no plumbing to hide", () => {
    // The distinction the caller needs: "we hid them all" and "there are none"
    // are different empty tables and only one of them is the feed's fault.
    const clean = [{ pallet: "Balances", method: "Transfer" }] as unknown as ChainEvent[];
    expect(withoutNoise(clean, false)).toEqual({ rows: clean, hidden: 0 });
  });

  it("keeps an event whose pallet or method is missing", () => {
    // A half-decoded row is not plumbing; dropping it would hide a decode gap.
    const partial = [{ pallet: null, method: "ExtrinsicSuccess" }] as unknown as ChainEvent[];
    expect(withoutNoise(partial, false).hidden).toBe(0);
  });

  it("does not mutate its input", () => {
    const copy = [...events];
    withoutNoise(events, false);
    expect(events).toEqual(copy);
  });
});
