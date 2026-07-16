import { describe, expect, it } from "vitest";
import { NUMERIC_FIELDS } from "./neuron-table";

/**
 * Disclosure guard for the sponsored-validator pin (#5166): the objective
 * validator/miner ranking must never be sortable by `featured` (or any future
 * sponsor field) — a paid placement can never distort the neutral comparison.
 * `NUMERIC_FIELDS` is the single point NeuronTable consults to decide which
 * columns are sortable, so pinning this set is the actual enforcement, not
 * just documentation of intent.
 */
describe("NeuronTable sort-field invariant", () => {
  it("never makes the sponsored-placement pin sortable", () => {
    expect(NUMERIC_FIELDS.has("featured" as never)).toBe(false);
  });

  it("never makes any other likely sponsor/partnership field sortable", () => {
    for (const field of ["sponsored", "partner", "partnership", "promoted"]) {
      expect(NUMERIC_FIELDS.has(field as never)).toBe(false);
    }
  });

  it("still sorts on the objective metrics it's meant to", () => {
    for (const field of [
      "uid",
      "stake_tao",
      "emission_tao",
      "rank",
      "trust",
      "consensus",
      "dividends",
      "validator_trust",
      "take",
    ]) {
      expect(NUMERIC_FIELDS.has(field as never)).toBe(true);
    }
  });
});
