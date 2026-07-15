import { describe, it, expect, vi, afterEach } from "vitest";
import { taoToRao, alphaToRawAlpha } from "./units";
import {
  buildAddStakeLimitParams,
  buildRemoveStakeLimitParams,
  buildSwapStakeLimitParams,
  buildMoveStakeParams,
} from "./stake-extrinsics";
import { getApi, buildExtrinsic, getNextNonce } from "./chain-connection";
import type { ApiPromise } from "@polkadot/api";

const HOTKEY_A = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const HOTKEY_B = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";

afterEach(() => {
  vi.unstubAllGlobals();
});

// getApi's real connection path (WsProvider + ApiPromise.create) is
// deliberately NOT exercised here -- it would trigger @polkadot/util-crypto's
// real WASM init and open a live network connection, both undesirable in a
// fast unit suite. The only assertion worth making without a live chain is
// the SSR guard; the connection itself is exercised by manual QA (see the PR
// description), same posture as wallet-injected.test.ts's connectWallet().
describe("getApi (SSR safety only)", () => {
  it("rejects when called during SSR (no window)", async () => {
    // No window stubbed at all -- matches how this would actually be invoked
    // during server rendering, where `window` is genuinely undefined.
    await expect(getApi()).rejects.toThrow(/client-only/i);
  });
});

// A minimal fake ApiPromise that only implements the one surface
// buildExtrinsic touches -- api.tx.subtensorModule.<method>(...args) -- and
// records exactly what was called with what, in order. This lets the
// fund-safety-critical parameter ORDER be asserted directly, without needing
// a live chain connection or the real @polkadot/api package at all.
function makeFakeApi() {
  const calls: Record<string, unknown[]> = {};
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls[method] = args;
      return { method, args };
    };
  const api = {
    tx: {
      subtensorModule: {
        addStakeLimit: record("addStakeLimit"),
        removeStakeLimit: record("removeStakeLimit"),
        swapStakeLimit: record("swapStakeLimit"),
        moveStake: record("moveStake"),
      },
    },
  } as unknown as ApiPromise;
  return { api, calls };
}

describe("buildExtrinsic", () => {
  it("calls addStakeLimit with (hotkey, netuid, amountStaked, limitPrice, allowPartial), in order", () => {
    const { api, calls } = makeFakeApi();
    const params = buildAddStakeLimitParams({
      hotkey: HOTKEY_A,
      netuid: 4,
      amountStaked: taoToRao("10"),
      limitPrice: taoToRao("1.05"),
      allowPartial: true,
    });
    buildExtrinsic(api, params);
    expect(calls.addStakeLimit).toEqual([HOTKEY_A, 4, taoToRao("10"), taoToRao("1.05"), true]);
  });

  it("calls removeStakeLimit with (hotkey, netuid, amountUnstaked, limitPrice, allowPartial), in order", () => {
    const { api, calls } = makeFakeApi();
    const params = buildRemoveStakeLimitParams({
      hotkey: HOTKEY_A,
      netuid: 4,
      amountUnstaked: alphaToRawAlpha("5"),
      limitPrice: taoToRao("9.5"),
      allowPartial: false,
    });
    buildExtrinsic(api, params);
    expect(calls.removeStakeLimit).toEqual([
      HOTKEY_A,
      4,
      alphaToRawAlpha("5"),
      taoToRao("9.5"),
      false,
    ]);
  });

  it("calls swapStakeLimit with (hotkey, originNetuid, destinationNetuid, alphaAmount, limitPrice, allowPartial), in order", () => {
    const { api, calls } = makeFakeApi();
    const params = buildSwapStakeLimitParams({
      hotkey: HOTKEY_A,
      originNetuid: 4,
      destinationNetuid: 7,
      alphaAmount: alphaToRawAlpha("2"),
      limitPrice: taoToRao("9.5"),
      allowPartial: true,
    });
    buildExtrinsic(api, params);
    expect(calls.swapStakeLimit).toEqual([
      HOTKEY_A,
      4,
      7,
      alphaToRawAlpha("2"),
      taoToRao("9.5"),
      true,
    ]);
  });

  it("calls moveStake with (originHotkey, destinationHotkey, netuid, netuid, alphaAmount) -- same netuid twice, matching the on-chain origin/destination pair for the same-subnet-only case", () => {
    const { api, calls } = makeFakeApi();
    const params = buildMoveStakeParams({
      originHotkey: HOTKEY_A,
      destinationHotkey: HOTKEY_B,
      netuid: 4,
      alphaAmount: alphaToRawAlpha("3"),
    });
    buildExtrinsic(api, params);
    expect(calls.moveStake).toEqual([HOTKEY_A, HOTKEY_B, 4, 4, alphaToRawAlpha("3")]);
  });
});

describe("getNextNonce", () => {
  it("returns the accountNextIndex RPC result as a plain number", async () => {
    const accountNextIndex = vi.fn(async (_ss58: string) => ({ toNumber: () => 7 }));
    const api = { rpc: { system: { accountNextIndex } } } as unknown as ApiPromise;
    await expect(getNextNonce(api, HOTKEY_A)).resolves.toBe(7);
    expect(accountNextIndex).toHaveBeenCalledWith(HOTKEY_A);
  });
});
