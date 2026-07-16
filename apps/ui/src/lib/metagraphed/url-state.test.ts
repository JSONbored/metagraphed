import { describe, it, expect } from "vitest";
import { joinEconomics, joinHealth, matchesQuery, sortBy } from "./url-state";

describe("matchesQuery", () => {
  it("matches everything for an empty needle", () => {
    expect(matchesQuery(["a"], "")).toBe(true);
    expect(matchesQuery([], "")).toBe(true);
  });

  it("is case-insensitive and skips nullish haystacks", () => {
    expect(matchesQuery(["Hello", null, undefined], "ell")).toBe(true);
    expect(matchesQuery([null, undefined], "x")).toBe(false);
  });

  it("coerces non-string haystacks", () => {
    expect(matchesQuery([12345], "234")).toBe(true);
    expect(matchesQuery([false], "fal")).toBe(true);
  });

  it("returns false when nothing contains the needle", () => {
    expect(matchesQuery(["alpha", "beta"], "zzz")).toBe(false);
  });
});

interface Row {
  name?: string | null;
  n?: number | null;
}
const accessor = (row: Row, key: string) => (row as Record<string, unknown>)[key];

describe("sortBy", () => {
  it("returns the array as-is when no key is given", () => {
    const rows: Row[] = [{ name: "b" }, { name: "a" }];
    expect(sortBy(rows, "", "asc", accessor)).toBe(rows);
  });

  it("sorts numbers numerically respecting order", () => {
    const rows: Row[] = [{ n: 10 }, { n: 2 }, { n: 30 }];
    expect(sortBy(rows, "n", "asc", accessor).map((r) => r.n)).toEqual([2, 10, 30]);
    expect(sortBy(rows, "n", "desc", accessor).map((r) => r.n)).toEqual([30, 10, 2]);
  });

  it("uses a numeric-aware localeCompare for strings", () => {
    const rows: Row[] = [{ name: "item10" }, { name: "item2" }];
    expect(sortBy(rows, "name", "asc", accessor).map((r) => r.name)).toEqual(["item2", "item10"]);
  });

  it("pushes null / missing values to the end regardless of order", () => {
    const rows: Row[] = [{ n: 2 }, { n: null }, { n: 1 }];
    expect(sortBy(rows, "n", "asc", accessor).map((r) => r.n)).toEqual([1, 2, null]);
    // null still sinks to the end even when sorting descending.
    expect(sortBy(rows, "n", "desc", accessor).map((r) => r.n)).toEqual([2, 1, null]);
  });

  it("treats two nullish values as equal", () => {
    const rows: Row[] = [{ name: null }, { name: undefined }];
    expect(sortBy(rows, "name", "asc", accessor)).toHaveLength(2);
  });

  it("does not mutate the input array", () => {
    const rows: Row[] = [{ n: 3 }, { n: 1 }];
    const sorted = sortBy(rows, "n", "asc", accessor);
    expect(sorted).not.toBe(rows);
    expect(rows.map((r) => r.n)).toEqual([3, 1]);
  });
});

describe("joinHealth", () => {
  it("overlays health from the map onto matching rows", () => {
    const rows = [{ netuid: 1 }, { netuid: 2 }];
    const out = joinHealth(rows, { 1: { health: "ok" } });
    expect(out[0]).toMatchObject({ netuid: 1, health: "ok" });
  });

  it("back-fills updated_at from last_checked only when the row lacks one", () => {
    const rows = [
      { netuid: 1, updated_at: "row-time" },
      { netuid: 2, updated_at: null },
      { netuid: 3 },
    ];
    const map = {
      1: { health: "ok", last_checked: "probe-time" },
      2: { health: "warn", last_checked: "probe-time" },
      3: { health: "down", last_checked: "probe-time" },
    };
    const out = joinHealth(rows, map);
    // Row's own updated_at wins.
    expect(out[0]).toMatchObject({ updated_at: "row-time", health: "ok" });
    // null/missing falls back to the probe's last_checked.
    expect(out[1]).toMatchObject({ updated_at: "probe-time", health: "warn" });
    expect(out[2]).toMatchObject({ updated_at: "probe-time", health: "down" });
  });

  it("passes rows without a health entry through by reference (unchanged)", () => {
    const rows = [{ netuid: 9, updated_at: "x" }];
    const out = joinHealth(rows, { 1: { health: "ok" } });
    expect(out[0]).toBe(rows[0]);
  });

  it("does not mutate the input rows", () => {
    const rows = [{ netuid: 1, updated_at: null as string | null }];
    joinHealth(rows, { 1: { health: "ok", last_checked: "probe-time" } });
    expect(rows[0].updated_at).toBeNull();
  });
});

describe("joinEconomics", () => {
  it("attaches registration cost + allowed flag from a matching entry", () => {
    const rows = [{ netuid: 1 }, { netuid: 2 }];
    const out = joinEconomics(rows, {
      1: { registration_cost_tao: 256, registration_allowed: true },
    });
    expect(out[0]).toMatchObject({
      netuid: 1,
      registration_cost_tao: 256,
      registration_allowed: true,
    });
  });

  it("carries a closed (registration_allowed: false) entry through", () => {
    const rows = [{ netuid: 5 }];
    const out = joinEconomics(rows, {
      5: { registration_cost_tao: 0.5, registration_allowed: false },
    });
    expect(out[0]).toMatchObject({ registration_cost_tao: 0.5, registration_allowed: false });
  });

  it("passes rows with no economics entry through by reference (unchanged)", () => {
    const rows = [{ netuid: 9 }];
    const out = joinEconomics(rows, { 1: { registration_cost_tao: 10 } });
    // No entry for netuid 9 → same object reference, so its cell renders "—".
    expect(out[0]).toBe(rows[0]);
    expect(out[0]).not.toHaveProperty("registration_cost_tao");
  });

  it("attaches undefined fields when the entry exists but omits them", () => {
    const rows = [{ netuid: 3 }];
    const out = joinEconomics(rows, { 3: {} });
    // The row is cloned (entry present) but both fields are undefined — the
    // column must not misread this as "registration open".
    expect(out[0]).not.toBe(rows[0]);
    expect((out[0] as { registration_cost_tao?: number }).registration_cost_tao).toBeUndefined();
    expect((out[0] as { registration_allowed?: boolean }).registration_allowed).toBeUndefined();
  });

  it("does not mutate the input rows", () => {
    const rows = [{ netuid: 1 }];
    joinEconomics(rows, { 1: { registration_cost_tao: 42, registration_allowed: true } });
    expect(rows[0]).not.toHaveProperty("registration_cost_tao");
  });

  it("#3363: also attaches emission_share from the same matching entry", () => {
    const rows = [{ netuid: 1 }, { netuid: 2 }];
    const out = joinEconomics(rows, {
      1: { registration_cost_tao: 256, registration_allowed: true, emission_share: 0.0125 },
    });
    expect(out[0]).toMatchObject({ emission_share: 0.0125 });
    // No entry for netuid 2 → passes through unchanged, "—" in the cell.
    expect(out[1]).toBe(rows[1]);
  });
});
