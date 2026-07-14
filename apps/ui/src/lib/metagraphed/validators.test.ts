import { describe, expect, it } from "vitest";

import { normalizeGlobalValidators, validatorsQuery } from "./queries";

describe("normalizeGlobalValidators", () => {
  it("normalizes a representative global validators payload", () => {
    const out = normalizeGlobalValidators({
      schema_version: 1,
      sort: "subnet_count",
      limit: 20,
      validator_count: 1,
      captured_at: "2026-01-01T00:00:00Z",
      block_number: 100,
      validators: [
        {
          hotkey: "5Hotkey",
          coldkey: "5Coldkey",
          coldkey_identity: {
            has_identity: true,
            name: "TensorOps",
            image: "https://example.com/logo.png",
          },
          take: 0.18,
          root_stake_tao: 10,
          alpha_stake_tao: 90.5,
          nominator_count: 42,
          coldkey_count: 1,
          subnet_count: 2,
          uid_count: 3,
          total_stake_tao: 100.5,
          total_emission_tao: 1.25,
          avg_validator_trust: 0.99,
          max_validator_trust: 1,
          stake_dominance: 0.05,
          latest_captured_at: "2026-01-01T00:00:00Z",
          latest_block_number: 100,
          subnets: [
            {
              netuid: 1,
              uid: 0,
              stake_tao: 50,
              emission_tao: 0.5,
              validator_trust: 1,
            },
          ],
        },
      ],
    });

    expect(out).toMatchObject({
      schema_version: 1,
      sort: "subnet_count",
      limit: 20,
      validator_count: 1,
      captured_at: "2026-01-01T00:00:00Z",
      block_number: 100,
    });
    expect(out.validators).toHaveLength(1);
    expect(out.validators[0]).toMatchObject({
      hotkey: "5Hotkey",
      coldkey: "5Coldkey",
      take: 0.18,
      root_stake_tao: 10,
      alpha_stake_tao: 90.5,
      nominator_count: 42,
      coldkey_identity: { has_identity: true, name: "TensorOps" },
      subnet_count: 2,
      uid_count: 3,
      subnets: [{ netuid: 1, uid: 0, stake_tao: 50, emission_tao: 0.5, validator_trust: 1 }],
    });
  });

  it("drops validator rows with a missing hotkey", () => {
    const out = normalizeGlobalValidators({
      sort: "uid_count",
      limit: 10,
      validators: [{ coldkey: "5Coldkey", subnet_count: 1, uid_count: 1, subnets: [] }],
    });

    expect(out.validators).toHaveLength(0);
    expect(out.validator_count).toBe(0);
  });

  it("defaults an unsupported sort to subnet_count", () => {
    const out = normalizeGlobalValidators({ sort: "bogus", limit: 5, validators: [] });
    expect(out.sort).toBe("subnet_count");
  });

  it("carries the `featured` flag through (#5166), defaulting false when absent", () => {
    const out = normalizeGlobalValidators({
      sort: "subnet_count",
      limit: 20,
      validators: [
        { hotkey: "hk-featured", featured: true, subnet_count: 1, uid_count: 1, subnets: [] },
        { hotkey: "hk-plain", subnet_count: 1, uid_count: 1, subnets: [] },
      ],
    });

    expect(out.validators[0].featured).toBe(true);
    expect(out.validators[1].featured).toBe(false);
  });

  it("coerces string numerics from live API payloads", () => {
    const out = normalizeGlobalValidators({
      sort: "total_stake",
      limit: "3",
      validator_count: "1",
      validators: [
        {
          hotkey: "hk",
          subnet_count: "2",
          uid_count: "4",
          total_stake_tao: "10.5",
          subnets: [{ netuid: "7", uid: "1", stake_tao: "10.5", emission_tao: "0" }],
        },
      ],
    });

    expect(out.limit).toBe(3);
    expect(out.validator_count).toBe(1);
    expect(out.validators[0].subnet_count).toBe(2);
    expect(out.validators[0].subnets[0].netuid).toBe(7);
  });
});

describe("validatorsQuery", () => {
  it("includes sort and limit in the query key", () => {
    const options = validatorsQuery({ sort: "uid_count", limit: 50 });
    expect(options.queryKey).toContain("global-validators");
    expect(options.queryKey).toContain("uid_count");
    expect(options.queryKey).toContain(50);
  });

  it("defaults sort and limit when omitted", () => {
    const options = validatorsQuery();
    expect(options.queryKey).toContain("subnet_count");
    expect(options.queryKey).toContain(20);
  });
});
