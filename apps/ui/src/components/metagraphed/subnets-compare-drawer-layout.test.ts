import { describe, expect, it } from "vitest";
import {
  COMPARE_GRID_OUTER_CLASS,
  COMPARE_SUBNET_COLUMN_CLASS,
  COMPARE_TABLE_CLASS,
  COMPARE_TABLE_SCROLL_CLASS,
} from "./subnets-compare-drawer-layout";

describe("subnets compare drawer layout tokens (#3933)", () => {
  it("keeps vertical scroll on the outer shell", () => {
    expect(COMPARE_GRID_OUTER_CLASS).toContain("max-h-[55vh]");
    expect(COMPARE_GRID_OUTER_CLASS).toContain("overflow-y-auto");
  });

  it("enables horizontal scroll via a dedicated inner wrapper", () => {
    expect(COMPARE_TABLE_SCROLL_CLASS).toBe("overflow-x-auto");
  });

  it("lets the table grow past the drawer instead of pinning w-full", () => {
    expect(COMPARE_TABLE_CLASS).toContain("w-max");
    expect(COMPARE_TABLE_CLASS).toContain("min-w-full");
    expect(COMPARE_TABLE_CLASS.split(/\s+/)).not.toContain("w-full");
  });

  it("reserves minimum width per subnet column", () => {
    expect(COMPARE_SUBNET_COLUMN_CLASS).toContain("min-w-[8.5rem]");
    expect(COMPARE_SUBNET_COLUMN_CLASS).toContain("whitespace-nowrap");
  });
});
