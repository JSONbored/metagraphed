import { describe, expect, it } from "vitest";

import {
  normalizeGlobalValidators,
  normalizeValidatorOperatorDirectory,
  projectOperatorValidator,
  validatorOperatorDirectoryQuery,
  validatorsQuery,
} from "./queries";
import { deserializeOperatorRows } from "./validator-operators";

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

  it("keeps the operator projection in its own cache lane", () => {
    const options = validatorsQuery({ projection: "operator" });
    expect(options.queryKey).toContain("operator");
  });
});

describe("validatorOperatorDirectoryQuery", () => {
  it("preserves the source observation timestamp without publication-time fallback", () => {
    const captured_at = "2026-01-01T00:00:00Z";
    expect(
      normalizeValidatorOperatorDirectory({ captured_at, generated_at: "2026-01-02T00:00:00Z" })
        .captured_at,
    ).toBe(captured_at);
    for (const captured_at of [undefined, null, "", 123]) {
      expect(
        normalizeValidatorOperatorDirectory({ captured_at, generated_at: "2026-01-02T00:00:00Z" })
          .captured_at,
      ).toBeNull();
    }
  });

  it("preserves additive IDs through normalization and SSR while keeping display names separate", () => {
    const compact = normalizeValidatorOperatorDirectory({
      operators: [
        {
          operator_id: "coldkey:owner-a",
          ownership_basis: "single_coldkey",
          identity_name: "Shared Name",
          primary_hotkey: "first",
        },
        {
          operator_id: "coldkey:owner-b",
          ownership_basis: "single_coldkey",
          identity_name: "Shared Name",
          primary_hotkey: "second",
        },
        { identity_name: "Shared Name", primary_hotkey: "legacy" },
        { operator_id: 123, identity_name: "Shared Name", primary_hotkey: "malformed" },
      ],
    });
    const rows = deserializeOperatorRows(compact.operators);
    expect(rows.map((row) => row.key)).toEqual([
      "coldkey:owner-a",
      "coldkey:owner-b",
      "hotkey:legacy",
      "hotkey:malformed",
    ]);
    expect(rows.every((row) => row.name === "Shared Name")).toBe(true);
    expect(new Set(rows.map((row) => row.key)).size).toBe(4);
  });

  it("uses a dedicated cache lane for the already-grouped SSR result", () => {
    const options = validatorOperatorDirectoryQuery();
    expect(options.queryKey).toContain("validator-operator-directory");
    expect(options.queryKey).not.toContain(2000);
  });

  it("normalizes the compact API shape into the existing directory model", () => {
    const compact = normalizeValidatorOperatorDirectory({
      validator_count: 3,
      operators: [
        {
          identity_name: "Tensor Team",
          primary_hotkey: "hk-large",
          hotkeys: [
            { hotkey: "hk-large", total_stake_tao: 75, take: 0.1 },
            { hotkey: "hk-small", total_stake_tao: 25, take: 0.2 },
          ],
          hotkey_count: 2,
          coldkey: "ck-team",
          total_stake_tao: 100,
          total_emission_tao: 8,
          nominator_count: 10,
          membership_count: 6,
          uid_count: 8,
          take_min: 0.1,
          take_max: 0.2,
          apy_estimate: 0.25,
          stake_dominance: 0.8,
        },
        {
          identity_name: null,
          primary_hotkey: "anonymous-hotkey",
          hotkeys: [],
          hotkey_count: 1,
          coldkey: null,
          total_stake_tao: 25,
          total_emission_tao: 1,
          nominator_count: null,
          membership_count: 1,
          uid_count: 1,
          take_min: null,
          take_max: null,
          apy_estimate: null,
          stake_dominance: 0.2,
        },
      ],
    });
    const rows = deserializeOperatorRows(compact.operators);

    expect(compact.hotkey_count).toBe(3);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      key: "hotkey:hk-large",
      name: "Tensor Team",
      named: true,
      keyCount: 2,
      primaryHotkey: "hk-large",
      totalStakeTao: 100,
      totalEmissionTao: 8,
      nominators: null,
      memberships: 6,
      uidCount: 8,
      takeMin: 0.1,
      takeMax: 0.2,
      apyEstimate: 0.25,
      dominance: 0.8,
    });
    expect(rows[0]!.keys.map((key) => key.hotkey)).toEqual(["hk-large", "hk-small"]);
    expect(rows[1]).toMatchObject({
      key: "hotkey:anonymous-hotkey",
      named: false,
      keyCount: 1,
      takeMin: null,
      takeMax: null,
      apyEstimate: null,
      dominance: 0.2,
    });
  });
});

describe("projectOperatorValidator", () => {
  it("keeps only operator-ranking fields and narrows identity", () => {
    const validator = normalizeGlobalValidators({
      validators: [
        {
          hotkey: "hk",
          coldkey: "ck",
          coldkey_count: 1,
          coldkey_identity: {
            has_identity: true,
            name: "Operator",
            url: "https://example.com",
            description: "not used by the directory",
          },
          subnet_count: 2,
          uid_count: 3,
          take: 0.1,
          total_stake_tao: 42,
          total_emission_tao: 1,
          nominator_count: 4,
          apy_estimate: 0.2,
          stake_dominance: 0.3,
          subnets: [{ netuid: 1, uid: 2, stake_tao: 3, emission_tao: 4 }],
        },
      ],
    }).validators[0]!;

    expect(projectOperatorValidator(validator)).toEqual({
      hotkey: "hk",
      coldkey: "ck",
      coldkey_count: 1,
      coldkey_identity: { has_identity: true, name: "Operator" },
      subnet_count: 2,
      uid_count: 3,
      take: 0.1,
      total_stake_tao: 42,
      total_emission_tao: 1,
      nominator_count: 4,
      apy_estimate: 0.2,
      stake_dominance: 0.3,
      subnets: [],
    });
  });
});
