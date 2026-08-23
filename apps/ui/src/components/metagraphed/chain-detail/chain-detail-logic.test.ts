import { describe, expect, it } from "vitest";
import type { Block, ChainEvent, Extrinsic } from "@/lib/metagraphed/types";
import {
  CADENCE_SPAN,
  argRows,
  blockFacts,
  cadencePoints,
  cadenceRange,
  eventsByPallet,
  extrinsicFacts,
  extrinsicTitle,
  neighbourHrefs,
} from "./chain-detail-logic";

const at = (ms: number) => new Date(ms).toISOString();
const T = 1_800_000_000_000;

describe("cadenceRange", () => {
  it("spans the block either side", () => {
    expect(cadenceRange(1000)).toEqual([1000 - CADENCE_SPAN, 1000 + CADENCE_SPAN]);
  });

  it("clamps at genesis rather than asking for a negative block", () => {
    expect(cadenceRange(10, 50)).toEqual([0, 60]);
  });
});

describe("cadencePoints", () => {
  // Deliberately out of order, as the newest-first feed returns them.
  const blocks: Block[] = [
    { block_number: 103, block_hash: "0xc", observed_at: at(T + 36_000) },
    { block_number: 101, block_hash: "0xa", observed_at: at(T + 12_000) },
    { block_number: 102, block_hash: "0xb", observed_at: at(T + 24_000) },
    { block_number: 100, block_hash: "0x0", observed_at: at(T) },
  ];

  it("plots against the BLOCK NUMBER, ascending", () => {
    // Not against wall time: the x axis would then be spaced by the very
    // quantity the y axis measures, and a slow block would say it twice.
    expect(cadencePoints(blocks).map((p) => p.t)).toEqual([101, 102, 103]);
    expect(cadencePoints(blocks).every((p) => p.t === p.block)).toBe(true);
  });

  it("reports seconds", () => {
    expect(cadencePoints(blocks).map((p) => p.v)).toEqual([12, 12, 12]);
  });

  it("skips a gap in the feed rather than drawing one very slow block", () => {
    // 100 -> 103 is missing 101 and 102: the 36s difference is the indexer's,
    // not the chain's, and plotting it would be a claim about the chain.
    const sparse: Block[] = [
      { block_number: 100, block_hash: "0x0", observed_at: at(T) },
      { block_number: 103, block_hash: "0xc", observed_at: at(T + 36_000) },
    ];
    expect(cadencePoints(sparse)).toEqual([]);
  });

  it("drops a non-positive gap and a row with no timestamp", () => {
    const odd: Block[] = [
      { block_number: 1, block_hash: "0x1", observed_at: at(T) },
      { block_number: 2, block_hash: "0x2", observed_at: at(T) },
      { block_number: 3, block_hash: "0x3" },
    ];
    expect(cadencePoints(odd)).toEqual([]);
  });

  it("is empty for zero or one block", () => {
    expect(cadencePoints([])).toEqual([]);
    expect(cadencePoints([{ block_number: 1, block_hash: "0x1", observed_at: at(T) }])).toEqual([]);
  });
});

describe("eventsByPallet", () => {
  const events = [
    { pallet: "Balances", method: "Deposit" },
    { pallet: "System", method: "ExtrinsicSuccess" },
    { pallet: "Balances", method: "Transfer" },
    { pallet: "Balances", method: "Withdraw" },
    { pallet: null, method: "Orphan" },
    { pallet: "  ", method: "Blank" },
  ] as unknown as ChainEvent[];

  it("groups by pallet, largest first", () => {
    expect(eventsByPallet(events)).toEqual([
      { key: "Balances", label: "Balances", value: 3 },
      { key: "System", label: "System", value: 1 },
    ]);
  });

  it("breaks a tie on the name so the order does not flicker", () => {
    const tied = [{ pallet: "Zed" }, { pallet: "Alpha" }] as unknown as ChainEvent[];
    expect(eventsByPallet(tied).map((s) => s.key)).toEqual(["Alpha", "Zed"]);
  });

  it("is empty for no events", () => {
    expect(eventsByPallet([])).toEqual([]);
  });
});

describe("argRows", () => {
  it("keeps name, type and a stringified value", () => {
    expect(
      argRows([
        { name: "netuid", type: "NetUid", value: 32 },
        { name: "hotkey", type: "AccountId32", value: "5Dyir2" },
      ] as Extrinsic["call_args"]),
    ).toEqual([
      { key: "0-netuid", name: "netuid", type: "NetUid", value: "32" },
      { key: "1-hotkey", name: "hotkey", type: "AccountId32", value: "5Dyir2" },
    ]);
  });

  it("renders a structured argument as one compact JSON value", () => {
    // One argument, one row: splitting it would invent structure the call
    // does not have.
    const rows = argRows([{ name: "weights", value: [1, 2, 3] }] as Extrinsic["call_args"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toBe("[1,2,3]");
  });

  it("names an unnamed argument by position rather than leaving it blank", () => {
    expect(argRows([{ value: 7 }] as Extrinsic["call_args"])[0]).toMatchObject({
      name: "arg 0",
      type: null,
      value: "7",
    });
  });

  it('shows an absent value as an em-dash, not as "undefined"', () => {
    expect(argRows([{ name: "a" }] as Extrinsic["call_args"])[0]!.value).toBe("—");
    expect(argRows([{ name: "b", value: null }] as Extrinsic["call_args"])[0]!.value).toBe("—");
  });

  it("keeps a false and a zero, which are values", () => {
    const rows = argRows([
      { name: "flag", value: false },
      { name: "n", value: 0 },
    ] as Extrinsic["call_args"]);
    expect(rows.map((r) => r.value)).toEqual(["false", "0"]);
  });

  it("is empty when the tier decoded no arguments", () => {
    expect(argRows(undefined)).toEqual([]);
    expect(argRows([] as Extrinsic["call_args"])).toEqual([]);
  });
});

const fmt = { count: (n: number) => String(n), tao: (n: number) => `${n} τ` };

describe("blockFacts", () => {
  it("states the counts and the spec version", () => {
    expect(
      blockFacts(
        {
          block_number: 1,
          block_hash: "0x1",
          extrinsic_count: 21,
          event_count: 164,
          spec_version: 448,
        } as Block,
        fmt,
      ).map((f) => [f.key, f.value]),
    ).toEqual([
      ["extrinsics", "21"],
      ["events", "164"],
      ["spec", "448"],
    ]);
  });

  it("never invents a size — the endpoint publishes none", () => {
    expect(blockFacts({ block_number: 1, block_hash: "0x1" } as Block, fmt)).toEqual([]);
  });

  it("keeps a genuine zero", () => {
    const facts = blockFacts(
      { block_number: 1, block_hash: "0x1", extrinsic_count: 0 } as Block,
      fmt,
    );
    expect(facts).toEqual([{ key: "extrinsics", label: "extrinsics", value: "0" }]);
  });

  it("is empty for no block", () => {
    expect(blockFacts(null, fmt)).toEqual([]);
  });
});

describe("extrinsicFacts", () => {
  it("states block, result and fee", () => {
    expect(
      extrinsicFacts(
        { block_number: 8_713_384, success: false, fee_tao: 0.0021, tip_tao: 0 } as Extrinsic,
        fmt,
      ).map((f) => [f.key, f.value]),
    ).toEqual([
      ["block", `#${8_713_384}`],
      ["result", "failed"],
      ["fee", "0.0021 τ"],
    ]);
  });

  it("omits the result when the tier has no reading, rather than saying failed", () => {
    const facts = extrinsicFacts({ block_number: 1, success: null } as Extrinsic, fmt);
    expect(facts.some((f) => f.key === "result")).toBe(false);
  });

  it("shows a tip only when there is one", () => {
    expect(
      extrinsicFacts({ tip_tao: 0.5 } as Extrinsic, fmt).find((f) => f.key === "tip")?.value,
    ).toBe("0.5 τ");
    expect(extrinsicFacts({ tip_tao: 0 } as Extrinsic, fmt).some((f) => f.key === "tip")).toBe(
      false,
    );
  });
});

describe("extrinsicTitle", () => {
  it("is module.function when both are known", () => {
    expect(
      extrinsicTitle(
        { call_module: "SubtensorModule", call_function: "register_limit" } as Extrinsic,
        "0xab",
      ),
    ).toBe("SubtensorModule.register_limit");
  });

  it("falls back to the caller's string when the call is undecoded", () => {
    expect(extrinsicTitle(undefined, "0xab…cd")).toBe("0xab…cd");
    expect(extrinsicTitle({} as Extrinsic, "0xab…cd")).toBe("0xab…cd");
  });
});

describe("neighbourHrefs", () => {
  it("builds both hrefs when both neighbours exist", () => {
    expect(neighbourHrefs(9, 11)).toEqual({ prev: "/blocks/9", next: "/blocks/11" });
  });

  it("returns null rather than /blocks/null at the head and at genesis", () => {
    expect(neighbourHrefs(null, 11).prev).toBeNull();
    expect(neighbourHrefs(9, undefined).next).toBeNull();
  });

  it("keeps block 0", () => {
    expect(neighbourHrefs(0, 1).prev).toBe("/blocks/0");
  });
});
