import { describe, it, expect } from "vitest";
import { VALIDATOR_COLUMNS } from "./validator-columns";
import type { GlobalValidator } from "@/lib/metagraphed/types";

// A fully-populated row so every column's cell renderer resolves a real value
// rather than its null fallback.
const SAMPLE: GlobalValidator = {
  hotkey: "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty",
  featured: true,
  coldkey: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
  coldkey_identity: {
    has_identity: true,
    name: "Foundry",
    url: null,
    github: null,
    image: null,
    discord: null,
    description: null,
    additional: null,
    captured_at: null,
  },
  coldkey_count: 1,
  subnet_count: 12,
  uid_count: 34,
  take: 0.18,
  total_stake_tao: 56_260_000,
  root_stake_tao: 40_000_000,
  alpha_stake_tao: 16_260_000,
  total_emission_tao: 1234.5,
  nominator_count: 512,
  apy_estimate: 0.1423,
  apy_estimate_eligible_subnet_count: 10,
  avg_validator_trust: 0.9,
  max_validator_trust: 1,
  stake_dominance: 0.0812,
  latest_captured_at: null,
  latest_block_number: null,
  subnets: [],
};

describe("VALIDATOR_COLUMNS", () => {
  // #5307: the table shipped with 12 headers over 9 cells (columns showing
  // another column's data, a duplicated "Est. APY" header). Both <thead> and
  // every <tbody> row now map over this single array, so these invariants keep
  // header count === per-row cell count and forbid the duplicate-header class of
  // regression at the source.
  it("has at least one column", () => {
    expect(VALIDATOR_COLUMNS.length).toBeGreaterThan(0);
  });

  it("has no duplicate headers (guards the duplicate 'Est. APY')", () => {
    const headers = VALIDATOR_COLUMNS.map((c) => c.header);
    expect(new Set(headers).size).toBe(headers.length);
  });

  it("gives every header exactly one cell renderer (header count === cell count)", () => {
    for (const col of VALIDATOR_COLUMNS) {
      expect(col.header.trim()).not.toBe("");
      expect(typeof col.cell).toBe("function");
      // Each header maps 1:1 to a defined cell for a populated row.
      expect(col.cell(SAMPLE)).toBeDefined();
    }
  });

  // #8251 column diet: Hotkey/Coldkey/UIDs/Total emission left the directory
  // (the Operator cell now carries the detail link + short hotkey; coldkey
  // and per-subnet emission live on the detail page). The diet is now the
  // DEFAULT rather than the whole set -- every column is toggleable, and the
  // fields the API returns but the table never showed (emission, trust,
  // realized return, the root/alpha stake split) are available opt-in instead
  // of being unreachable. This pins what a reader sees without touching
  // anything.
  it("defaults to the #8251 directory column set", () => {
    const headers = VALIDATOR_COLUMNS.filter((c) => c.defaultVisible).map((c) => c.header);
    expect(headers).toEqual([
      "Operator",
      "Take",
      "Est. APY",
      "Active subnets",
      "Nominators",
      "Dominance",
      "Total stake",
      "30d Δ",
    ]);
  });

  it("offers the rest of the payload as opt-in columns", () => {
    // Each of these is a field GET /api/v1/validators has always returned.
    // Off by default, so the directory reads the same until asked otherwise.
    const optIn = VALIDATOR_COLUMNS.filter((c) => !c.defaultVisible).map((c) => c.header);
    expect(optIn).toEqual(["Emission", "Avg trust", "Realized 7d", "Root stake", "Alpha stake"]);
  });

  it("gives every column a stable id and a width for the colgroup", () => {
    // Both are load-bearing: the id keys column visibility, and the width
    // feeds TableColGroup, without which `table-layout: fixed` splits the
    // table evenly and the watch checkbox gets as much room as the operator.
    const ids = VALIDATOR_COLUMNS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(VALIDATOR_COLUMNS.every((c) => c.width > 0)).toBe(true);
  });
});
