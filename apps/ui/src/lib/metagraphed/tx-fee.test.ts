import { describe, it, expect, vi } from "vitest";
import type { SubmittableExtrinsic } from "@polkadot/api/types";
import { estimateFee } from "./tx-fee";

function makeFakeExtrinsic(partialFeeRao: bigint) {
  return {
    paymentInfo: vi.fn(async (_signerAddress: string) => ({
      partialFee: { toBigInt: () => partialFeeRao },
    })),
  } as unknown as SubmittableExtrinsic<"promise">;
}

describe("estimateFee", () => {
  it("returns the partialFee as rao", async () => {
    const extrinsic = makeFakeExtrinsic(123_456n);
    await expect(
      estimateFee(extrinsic, "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY"),
    ).resolves.toBe(123_456n);
  });

  it("calls paymentInfo with the signer address, not a signed transaction", async () => {
    const extrinsic = makeFakeExtrinsic(1n);
    const address = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
    await estimateFee(extrinsic, address);
    expect(extrinsic.paymentInfo).toHaveBeenCalledWith(address);
  });
});
