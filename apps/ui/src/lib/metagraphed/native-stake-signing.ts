import type { ApiPromise } from "@polkadot/api";
import type { UseTxStatusResult } from "@/hooks/use-tx-status";
import type { NativeStakeQuote } from "./native-stake-quote";
import { prepareNativeStakeCall, nativeStakeParams } from "./native-stake-quote";
import { guardNativeSigner, previewNativeCall, revalidateNativeCall } from "./native-call-wallet";
import { buildExtrinsic, getFreeBalance } from "./chain-connection";
import { getSigner } from "./wallet-injected";
import { computeIdempotencyKey } from "./broadcast";

export interface ReviewedNativeStake {
  params: ReturnType<typeof nativeStakeParams>;
  quote: NativeStakeQuote;
  address: string;
  source: string;
  sessionId: string;
  context: string;
}

/** The reviewed amount and limit must survive server preparation, SDK decoding
 * and the wallet prompt. Every async continuation can be cancelled by its UI. */
export async function submitReviewedNativeStake(
  api: ApiPromise,
  review: ReviewedNativeStake,
  feeRao: bigint,
  assertCurrent: () => void,
  submit: UseTxStatusResult["submit"],
) {
  assertCurrent();
  const artifact = await prepareNativeStakeCall(review.quote, review.params);
  assertCurrent();
  const preview = await previewNativeCall(api, artifact, 0, review.address);
  assertCurrent();
  if (preview.callData !== buildExtrinsic(api, review.params).method.toHex())
    throw new Error(
      "The prepared staking arguments differ from the reviewed amount and price limit.",
    );
  if (feeRao < 0n || preview.feeRao > feeRao + (feeRao + 9n) / 10n)
    throw new Error("The transaction fee changed. Review this stake again.");
  if (
    review.params.call === "add_stake_limit" &&
    preview.balanceRao < review.params.amountStaked + preview.maxFeeRao
  )
    throw new Error("The spendable balance cannot cover this stake and its fee.");
  const connected = await getSigner(review.source);
  assertCurrent();
  const recheck = async () => {
    await revalidateNativeCall(api, preview);
    if (
      review.params.call === "add_stake_limit" &&
      (await getFreeBalance(api, review.address)) < review.params.amountStaked + preview.maxFeeRao
    )
      throw new Error("The spendable balance changed. Review this stake again.");
  };
  await recheck();
  assertCurrent();
  const signer = guardNativeSigner(connected, preview, assertCurrent, recheck);
  await submit(api, preview.extrinsic, {
    signerAddress: review.address,
    signer,
    nonce: preview.nonce,
    idempotencyKey: computeIdempotencyKey(
      {
        callData: preview.callData,
        address: review.address,
        genesisHash: preview.source.network_genesis_hash,
      },
      preview.nonce,
      review.sessionId,
    ),
  });
}
