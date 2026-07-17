import { describe, expect, it } from "vitest";
import { orderRuntimeUpgradesNewestFirst } from "./runtime-upgrade-card-list";
import type { RuntimeTransition } from "@/lib/metagraphed/types";

const tx = (spec_version: number, block_number: number): RuntimeTransition => ({
  spec_version,
  block_number,
  observed_at: null,
});

describe("orderRuntimeUpgradesNewestFirst", () => {
  it("reverses the backend's ascending order so the newest upgrade is first", () => {
    // /api/v1/runtime returns transitions ascending by block_number.
    const ascending = [tx(100, 1_000), tx(150, 5_000), tx(432, 8_636_190)];
    const ordered = orderRuntimeUpgradesNewestFirst(ascending);
    expect(ordered.map((r) => r.block_number)).toEqual([8_636_190, 5_000, 1_000]);
  });

  it("does not mutate the source array (it is a shared React Query cache value)", () => {
    // The regression this guards: an in-place `.reverse()` would flip the cache
    // array for the desktop table view and every other reader on re-render.
    const source = [tx(100, 1_000), tx(150, 5_000)];
    const snapshot = [...source];
    orderRuntimeUpgradesNewestFirst(source);
    expect(source).toEqual(snapshot);
  });

  it("returns an empty array unchanged", () => {
    expect(orderRuntimeUpgradesNewestFirst([])).toEqual([]);
  });
});
