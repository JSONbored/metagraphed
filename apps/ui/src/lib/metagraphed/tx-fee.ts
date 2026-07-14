// Fee dry-run for the pre-sign confirmation screen (#5239, native-staking
// epic #5229). `extrinsic.paymentInfo()` is @polkadot/api's own convenience
// wrapper around the standard `TransactionPaymentApi::query_info` runtime
// call (a standard FRAME API, not a subtensor-custom one -- unlike
// chain-connection.ts's consts/query calls, this one has real, non-generic
// TypeScript types out of the box).

import type { SubmittableExtrinsic } from "@polkadot/api/types";
import { asRao, type Rao } from "./units";

/** Estimate the fee (rao) for a constructed extrinsic, as if signed and submitted by signerAddress -- does not sign or submit anything. */
export async function estimateFee(
  extrinsic: SubmittableExtrinsic<"promise">,
  signerAddress: string,
): Promise<Rao> {
  const info = await extrinsic.paymentInfo(signerAddress);
  return asRao(info.partialFee.toBigInt());
}
