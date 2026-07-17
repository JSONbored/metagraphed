import { describe, it, expect } from "vitest";
import {
  isUnrecognizedValidator,
  type ValidatorRecognitionSignals,
} from "@/lib/metagraphed/validator-recognition";

/** A hotkey that was never seen validating: the zeroed aggregate the
 * schema-stable endpoint returns for any well-formed ss58 (#6430). */
const UNRECOGNIZED: ValidatorRecognitionSignals = {
  subnet_count: 0,
  total_stake_tao: 0,
  nominator_count: null,
};

describe("isUnrecognizedValidator", () => {
  it("flags the all-zero aggregate a never-registered hotkey resolves to", () => {
    expect(isUnrecognizedValidator(UNRECOGNIZED)).toBe(true);
  });

  it("treats an absent nominator_count the same as an explicit null", () => {
    // The low-frequency nominator source may omit the field entirely rather
    // than send null, which is why the check is `== null`.
    expect(
      isUnrecognizedValidator({
        ...UNRECOGNIZED,
        nominator_count: undefined as unknown as null,
      }),
    ).toBe(true);
  });

  // Each signal alone is a real state a genuine validator can be in, so none of
  // them may flag on its own -- that would slander a live validator.
  it("does not flag a registered validator that is fully unstaked", () => {
    expect(isUnrecognizedValidator({ ...UNRECOGNIZED, subnet_count: 3 })).toBe(false);
  });

  it("does not flag a deregistered validator that still holds stake", () => {
    expect(isUnrecognizedValidator({ ...UNRECOGNIZED, total_stake_tao: 1200.5 })).toBe(false);
  });

  it("does not flag a validator whose nominator count is a genuine zero", () => {
    expect(isUnrecognizedValidator({ ...UNRECOGNIZED, nominator_count: 0 })).toBe(false);
  });

  it("does not flag a fully populated validator", () => {
    expect(
      isUnrecognizedValidator({
        subnet_count: 12,
        total_stake_tao: 56_280_000,
        nominator_count: 41,
      }),
    ).toBe(false);
  });
});
