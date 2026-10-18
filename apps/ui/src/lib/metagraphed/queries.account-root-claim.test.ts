import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch, ApiError, type ApiResult } from "./client";
import { accountRootClaimQuery } from "./queries";
import { runQuery } from "./run-query";
import type { RootClaim } from "./types";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);
const ALICE = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const HOTKEY = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
const QUERIED_AT = "2026-09-05T12:00:00.000Z";
const BLOCK_HASH = `0x${"ab".repeat(32)}`;

// Schema-aligned synthetic v440 accounting, not an observed basket entitlement.
const LEGACY: RootClaim = {
  schema_version: 1,
  ss58: ALICE,
  claim_type: { kind: "KeepSubnets", subnets: [0, 19] },
  hotkeys: [
    {
      hotkey: HOTKEY,
      entries: [
        {
          netuid: 19,
          claimable_rate: 0.25,
          claimed: "340282366920938463463374607431768211455",
          threshold: 0,
        },
      ],
    },
  ],
  queried_at: QUERIED_AT,
  compatibility: {
    status: "legacy_supported",
    reason: null,
    spec_name: "node-subtensor",
    spec_version: 440,
    block_hash: BLOCK_HASH,
    claim_type_source: "storage",
  },
  field_sources: {
    claim_type: { kind: "reconstructed", storage: null },
    hotkeys: { kind: "reconstructed", storage: null },
    compatibility: { kind: "reconstructed", storage: null },
  },
};

function resolveWith(data: RootClaim): ApiResult<RootClaim> {
  const result: ApiResult<RootClaim> = {
    data,
    meta: { network: "mainnet", source: "live-rpc" },
    url: `/api/v1/accounts/${ALICE}/root-claim`,
  };
  mockedApiFetch.mockResolvedValue(result);
  return result;
}

describe("accountRootClaimQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("retains structured hotkeys, exact claimed strings and all source metadata", async () => {
    const response = resolveWith(LEGACY);
    const result = await runQuery(accountRootClaimQuery(ALICE));

    expect(result).toEqual(response);
    expect(result.data.claim_type).toEqual({
      kind: "KeepSubnets",
      subnets: [0, 19],
    });
    expect(result.data.hotkeys).toEqual(LEGACY.hotkeys);
    expect(result.data.hotkeys?.[0]?.entries[0]?.claimed).toBe(
      "340282366920938463463374607431768211455",
    );
    expect(result.data.hotkeys?.[0]?.entries[0]?.threshold).toBe(0);
    expect(result.data.compatibility).toEqual(LEGACY.compatibility);
    expect(result.data.field_sources).toEqual(LEGACY.field_sources);
    expect(result.data.queried_at).toBe(QUERIED_AT);
  });

  it.each([441, 450, 453, 454])(
    "retains null legacy fields and unsupported runtime %i instead of an empty position",
    async (specVersion) => {
      resolveWith({
        ...LEGACY,
        claim_type: null,
        hotkeys: null,
        compatibility: {
          ...LEGACY.compatibility,
          status: "unsupported",
          reason: "root_reborn",
          spec_version: specVersion,
          claim_type_source: null,
        },
      });
      const result = await runQuery(accountRootClaimQuery(ALICE));

      expect(result.data.claim_type).toBeNull();
      expect(result.data.hotkeys).toBeNull();
      expect(result.data.compatibility).toEqual({
        status: "unsupported",
        reason: "root_reborn",
        spec_name: "node-subtensor",
        spec_version: specVersion,
        block_hash: BLOCK_HASH,
        claim_type_source: null,
      });
    },
  );

  it.each([
    "unverified_runtime",
    "rpc_or_decode_failure",
    "legacy_limit_exceeded",
  ] as const)(
    "retains unavailable %s without fabricating zero accounting",
    async (reason) => {
      resolveWith({
        ...LEGACY,
        claim_type: null,
        hotkeys: null,
        compatibility: {
          status: "unavailable",
          reason,
          spec_name: null,
          spec_version: null,
          block_hash: null,
          claim_type_source: null,
        },
      });
      const result = await runQuery(accountRootClaimQuery(ALICE));

      expect(result.data.claim_type).toBeNull();
      expect(result.data.hotkeys).toBeNull();
      expect(result.data.compatibility).toEqual({
        status: "unavailable",
        reason,
        spec_name: null,
        spec_version: null,
        block_hash: null,
        claim_type_source: null,
      });
    },
  );

  it("preserves a supported empty result and its proven runtime default", async () => {
    resolveWith({
      ...LEGACY,
      claim_type: { kind: "Swap" },
      hotkeys: [],
      compatibility: {
        ...LEGACY.compatibility,
        claim_type_source: "runtime_default",
      },
    });
    const result = await runQuery(accountRootClaimQuery(ALICE));

    expect(result.data.hotkeys).toEqual([]);
    expect(result.data.claim_type).toEqual({ kind: "Swap" });
    expect(result.data.compatibility.status).toBe("legacy_supported");
    expect(result.data.compatibility.claim_type_source).toBe("runtime_default");
  });

  it("keeps a hotkey with explicitly empty accounting separate from no hotkeys", async () => {
    resolveWith({ ...LEGACY, hotkeys: [{ hotkey: HOTKEY, entries: [] }] });
    const result = await runQuery(accountRootClaimQuery(ALICE));

    expect(result.data.hotkeys).toEqual([{ hotkey: HOTKEY, entries: [] }]);
  });

  it("retains the existing request, cancellation and network-scoped cache key", async () => {
    resolveWith(LEGACY);
    const options = accountRootClaimQuery(ALICE);
    await runQuery(options);

    expect(options.queryKey).toEqual([
      "metagraphed",
      { network: "mainnet" },
      "account-root-claim",
      ALICE,
    ]);
    expect(accountRootClaimQuery(HOTKEY).queryKey).not.toEqual(options.queryKey);
    expect(mockedApiFetch).toHaveBeenCalledTimes(1);
    expect(mockedApiFetch).toHaveBeenCalledWith(
      `/api/v1/accounts/${ALICE}/root-claim`,
      { signal: expect.any(AbortSignal) },
    );
  });

  it("propagates API failures instead of fabricating a supported empty record", async () => {
    const failure = new ApiError("Unavailable", {
      status: 503,
      url: `/api/v1/accounts/${ALICE}/root-claim`,
    });
    mockedApiFetch.mockRejectedValue(failure);

    await expect(runQuery(accountRootClaimQuery(ALICE))).rejects.toBe(failure);
  });
});
