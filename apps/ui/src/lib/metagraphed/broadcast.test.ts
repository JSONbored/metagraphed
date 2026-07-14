import { describe, it, expect, vi } from "vitest";
import { taoToRao } from "./units";
import { buildAddStakeLimitParams } from "./stake-extrinsics";
import {
  computeIdempotencyKey,
  hasAlreadySubmitted,
  submitStakeExtrinsic,
  DEFAULT_MORTALITY_BLOCKS,
  type BroadcastEvent,
} from "./broadcast";
import type { ApiPromise } from "@polkadot/api";
import type { SubmittableExtrinsic } from "@polkadot/api/types";
import type { Signer } from "@polkadot/api/types";

const HOTKEY = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

const sampleParams = buildAddStakeLimitParams({
  hotkey: HOTKEY,
  netuid: 4,
  amountStaked: taoToRao("10"),
  limitPrice: taoToRao("1.05"),
  allowPartial: true,
});

describe("computeIdempotencyKey", () => {
  it("is deterministic for identical inputs", () => {
    const a = computeIdempotencyKey(sampleParams, 5, "session-1");
    const b = computeIdempotencyKey(sampleParams, 5, "session-1");
    expect(a).toBe(b);
  });

  it("differs when the nonce differs", () => {
    const a = computeIdempotencyKey(sampleParams, 5, "session-1");
    const b = computeIdempotencyKey(sampleParams, 6, "session-1");
    expect(a).not.toBe(b);
  });

  it("differs when the session differs", () => {
    const a = computeIdempotencyKey(sampleParams, 5, "session-1");
    const b = computeIdempotencyKey(sampleParams, 5, "session-2");
    expect(a).not.toBe(b);
  });

  it("differs when the call amount differs", () => {
    const other = buildAddStakeLimitParams({
      hotkey: HOTKEY,
      netuid: 4,
      amountStaked: taoToRao("20"), // different from sampleParams' 10
      limitPrice: taoToRao("1.05"),
      allowPartial: true,
    });
    const a = computeIdempotencyKey(sampleParams, 5, "session-1");
    const b = computeIdempotencyKey(other, 5, "session-1");
    expect(a).not.toBe(b);
  });

  it("handles bigint fields without throwing (JSON.stringify can't serialize bigint by default)", () => {
    expect(() => computeIdempotencyKey(sampleParams, 1, "s")).not.toThrow();
  });
});

describe("hasAlreadySubmitted", () => {
  it("is false for a key that has never been submitted", () => {
    const key = computeIdempotencyKey(sampleParams, 111, "unused-session");
    expect(hasAlreadySubmitted(key)).toBe(false);
  });
});

function makeFakeExtrinsic() {
  const listeners: Array<(result: { status: unknown; dispatchError?: unknown }) => void> = [];
  let capturedOptions: unknown;
  const unsubscribe = vi.fn();
  const extrinsic = {
    hash: { toHex: () => "0xdeadbeef" },
    signAndSend: vi.fn(async (_address: string, options: unknown, cb: (r: unknown) => void) => {
      capturedOptions = options;
      listeners.push(cb as (result: { status: unknown; dispatchError?: unknown }) => void);
      return unsubscribe;
    }),
  } as unknown as SubmittableExtrinsic<"promise">;
  return {
    extrinsic,
    unsubscribe,
    emit: (status: unknown, dispatchError?: unknown) =>
      listeners.forEach((cb) => cb({ status, dispatchError })),
    getCapturedOptions: () => capturedOptions,
  };
}

function makeStatus(overrides: Partial<Record<string, unknown>>) {
  return {
    isFuture: false,
    isReady: false,
    isBroadcast: false,
    isInBlock: false,
    isRetracted: false,
    isFinalityTimeout: false,
    isFinalized: false,
    isUsurped: false,
    isDropped: false,
    isInvalid: false,
    ...overrides,
  };
}

describe("submitStakeExtrinsic", () => {
  const fakeApi = {} as ApiPromise;
  const fakeSigner = {} as Signer;

  it("passes an explicit mortality era (never immortal) to signAndSend", async () => {
    const { extrinsic, getCapturedOptions } = makeFakeExtrinsic();
    const key = computeIdempotencyKey(sampleParams, 1, "mortality-test");
    await submitStakeExtrinsic(fakeApi, extrinsic, {
      signerAddress: HOTKEY,
      signer: fakeSigner,
      idempotencyKey: key,
    });
    expect(getCapturedOptions()).toEqual({ signer: fakeSigner, era: DEFAULT_MORTALITY_BLOCKS });
  });

  it("accepts a caller-supplied mortality override", async () => {
    const { extrinsic, getCapturedOptions } = makeFakeExtrinsic();
    const key = computeIdempotencyKey(sampleParams, 2, "mortality-override-test");
    await submitStakeExtrinsic(fakeApi, extrinsic, {
      signerAddress: HOTKEY,
      signer: fakeSigner,
      idempotencyKey: key,
      mortalityBlocks: 16,
    });
    expect(getCapturedOptions()).toEqual({ signer: fakeSigner, era: 16 });
  });

  it("marks the idempotency key as used and refuses a second submission with the same key", async () => {
    const { extrinsic } = makeFakeExtrinsic();
    const key = computeIdempotencyKey(sampleParams, 3, "double-submit-test");
    expect(hasAlreadySubmitted(key)).toBe(false);

    await submitStakeExtrinsic(fakeApi, extrinsic, {
      signerAddress: HOTKEY,
      signer: fakeSigner,
      idempotencyKey: key,
    });
    expect(hasAlreadySubmitted(key)).toBe(true);

    const { extrinsic: secondExtrinsic } = makeFakeExtrinsic();
    await expect(
      submitStakeExtrinsic(fakeApi, secondExtrinsic, {
        signerAddress: HOTKEY,
        signer: fakeSigner,
        idempotencyKey: key,
      }),
    ).rejects.toThrow(/already submitted/i);
  });

  it("maps every ExtrinsicStatus variant to the corresponding BroadcastStatus", async () => {
    const { extrinsic, emit } = makeFakeExtrinsic();
    const key = computeIdempotencyKey(sampleParams, 4, "status-map-test");
    const events: BroadcastEvent[] = [];
    await submitStakeExtrinsic(fakeApi, extrinsic, {
      signerAddress: HOTKEY,
      signer: fakeSigner,
      idempotencyKey: key,
      onStatus: (e) => events.push(e),
    });

    emit(makeStatus({ isReady: true }));
    emit(makeStatus({ isBroadcast: true }));
    emit(makeStatus({ isInBlock: true, asInBlock: { toHex: () => "0xblock1" } }));
    emit(makeStatus({ isFinalized: true, asFinalized: { toHex: () => "0xblock1" } }));
    emit(makeStatus({ isDropped: true }));
    emit(makeStatus({ isInvalid: true }));

    expect(events.map((e) => e.status)).toEqual([
      "ready",
      "broadcast",
      "in-block",
      "finalized",
      "dropped",
      "invalid",
    ]);
    expect(events.every((e) => e.txHash === "0xdeadbeef")).toBe(true);
    expect(events[2].blockHash).toBe("0xblock1");
    expect(events[3].blockHash).toBe("0xblock1");
  });

  it("returns the txHash and an unsubscribe handle", async () => {
    const { extrinsic, unsubscribe } = makeFakeExtrinsic();
    const key = computeIdempotencyKey(sampleParams, 5, "return-shape-test");
    const result = await submitStakeExtrinsic(fakeApi, extrinsic, {
      signerAddress: HOTKEY,
      signer: fakeSigner,
      idempotencyKey: key,
    });
    expect(result.txHash).toBe("0xdeadbeef");
    expect(result.unsubscribe).toBe(unsubscribe);
  });

  it("passes the raw dispatchError through untouched -- decoding it is tx-errors.ts's job, not this module's", async () => {
    const { extrinsic, emit } = makeFakeExtrinsic();
    const key = computeIdempotencyKey(sampleParams, 6, "dispatch-error-passthrough-test");
    const events: BroadcastEvent[] = [];
    await submitStakeExtrinsic(fakeApi, extrinsic, {
      signerAddress: HOTKEY,
      signer: fakeSigner,
      idempotencyKey: key,
      onStatus: (e) => events.push(e),
    });

    const fakeDispatchError = { isModule: true, asModule: { toU8a: () => new Uint8Array() } };
    emit(
      makeStatus({ isInBlock: true, asInBlock: { toHex: () => "0xblock1" } }),
      fakeDispatchError,
    );
    // A successful status update carries no dispatchError at all.
    emit(makeStatus({ isFinalized: true, asFinalized: { toHex: () => "0xblock1" } }));

    expect(events[0].dispatchError).toBe(fakeDispatchError);
    expect(events[1].dispatchError).toBeUndefined();
  });
});
