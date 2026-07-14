import { describe, expect, it } from "vitest";

import { resolveValidatorCard } from "./validator-card-fields";
import type { GlobalValidator } from "./types";

function validator(overrides: Partial<GlobalValidator> = {}): GlobalValidator {
  return {
    hotkey: "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty",
    featured: false,
    coldkey: "5GNJqTPyNqANBkUVMN1LPPrxXnFouWXoe2wNSmmEoLctxiZY",
    coldkey_identity: null,
    coldkey_count: 1,
    subnet_count: 12,
    uid_count: 12,
    take: 0.18,
    total_stake_tao: 1234567,
    root_stake_tao: 0,
    alpha_stake_tao: 0,
    total_emission_tao: 42,
    nominator_count: 340,
    apy_estimate: 0.1834,
    apy_estimate_eligible_subnet_count: 10,
    avg_validator_trust: null,
    max_validator_trust: null,
    stake_dominance: 0.05263,
    latest_captured_at: null,
    latest_block_number: null,
    subnets: [],
    ...overrides,
  };
}

describe("resolveValidatorCard", () => {
  it("shortens hotkey and coldkey", () => {
    const f = resolveValidatorCard(validator());
    expect(f.hotkeyShort.length).toBeLessThan(48);
    expect(f.coldkeyShort).not.toBeNull();
    expect(f.coldkeyShort!.length).toBeLessThan(48);
  });

  it("returns a null coldkey label when the row has no coldkey", () => {
    expect(resolveValidatorCard(validator({ coldkey: null })).coldkeyShort).toBeNull();
  });

  it("formats dominance as a 2-dp percentage, em dash when null", () => {
    expect(resolveValidatorCard(validator({ stake_dominance: 0.05263 })).dominanceLabel).toBe(
      "5.26%",
    );
    expect(resolveValidatorCard(validator({ stake_dominance: null })).dominanceLabel).toBe("—");
  });

  it("formats APY as a 1-dp percentage, em dash when null", () => {
    expect(resolveValidatorCard(validator({ apy_estimate: 0.1834 })).apyLabel).toBe("18.3%");
    expect(resolveValidatorCard(validator({ apy_estimate: null })).apyLabel).toBe("—");
  });

  it("shows an em dash for a missing nominator count", () => {
    expect(resolveValidatorCard(validator({ nominator_count: null })).nominatorsLabel).toBe("—");
    expect(resolveValidatorCard(validator({ nominator_count: 340 })).nominatorsLabel).toBe("340");
  });

  it("formats the subnet and UID counts", () => {
    const f = resolveValidatorCard(validator({ subnet_count: 12, uid_count: 34 }));
    expect(f.subnetsLabel).toBe("12");
    expect(f.uidsLabel).toBe("34");
  });
});
