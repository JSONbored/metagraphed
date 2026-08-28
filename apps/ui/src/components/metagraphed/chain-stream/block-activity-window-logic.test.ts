import { describe, expect, it } from "vitest";
import {
  arrivedBlock,
  blockActivityEntries,
  blockActivityLevel,
} from "./block-activity-window-logic";

describe("blockActivityLevel", () => {
  it("keeps absent counts distinct from a measured zero", () => {
    expect(blockActivityLevel(undefined, 12)).toBeNull();
    expect(blockActivityLevel(0, 12)).toBe(0);
  });

  it("uses the highest current result as the only scale anchor", () => {
    expect(blockActivityLevel(1, 16)).toBe(1);
    expect(blockActivityLevel(4, 16)).toBe(2);
    expect(blockActivityLevel(9, 16)).toBe(3);
    expect(blockActivityLevel(16, 16)).toBe(4);
  });

  it("does not invent a nonzero level when every measured block is quiet", () => {
    expect(blockActivityLevel(0, 0)).toBe(0);
  });
});

describe("blockActivityEntries", () => {
  it("retains API order and gives an unknown count no activity colour", () => {
    const entries = blockActivityEntries([
      { block_number: 12, block_hash: "0xc", extrinsic_count: 16 },
      { block_number: 11, block_hash: "0xb", extrinsic_count: 4 },
      { block_number: 10, block_hash: "0xa" },
    ]);

    expect(entries.map((entry) => entry.block.block_number)).toEqual([12, 11, 10]);
    expect(entries.map((entry) => entry.level)).toEqual([4, 2, null]);
  });
});

describe("arrivedBlock", () => {
  it("only treats a strictly newer, finite head as a new indexed arrival", () => {
    expect(arrivedBlock(null, 12)).toBeNull();
    expect(arrivedBlock(12, 12)).toBeNull();
    expect(arrivedBlock(12, 11)).toBeNull();
    expect(arrivedBlock(12, Number.NaN)).toBeNull();
    expect(arrivedBlock(12, 13)).toBe(13);
  });
});
