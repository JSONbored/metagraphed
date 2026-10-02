import { beforeEach, expect, test, vi } from "vitest";
import type { ApiPromise } from "@polkadot/api";
import type { NativeArtifact } from "./native-runtime";
import type { NativeCallPreview } from "./native-call-wallet";
import type { SignerPayloadJSON } from "@polkadot/types/types";
import type { UseTxStatusResult } from "@/hooks/use-tx-status";
import { submitReviewedNativeStake, type ReviewedNativeStake } from "./native-stake-signing";
import { decodeNativeStakeQuote, nativeStakeParams, prepareNativeStakeCall } from "./native-stake-quote";
import { previewNativeCall, revalidateNativeCall } from "./native-call-wallet";
import { buildExtrinsic, getFreeBalance } from "./chain-connection";
import { getSigner } from "./wallet-injected";
import { asRao } from "./units";

vi.mock("./native-stake-quote", async original => ({ ...await original<typeof import("./native-stake-quote")>(), prepareNativeStakeCall: vi.fn() }));
vi.mock("./native-call-wallet", async original => ({ ...await original<typeof import("./native-call-wallet")>(), previewNativeCall: vi.fn(), revalidateNativeCall: vi.fn() }));
vi.mock("./chain-connection", () => ({ buildExtrinsic: vi.fn(), getFreeBalance: vi.fn() }));
vi.mock("./wallet-injected", () => ({ getSigner: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
function fixture() {
  const artifact: NativeArtifact = {
    schema_version: 1, types: [],
    source: { network: "finney", network_genesis_hash: `0x${"44".repeat(32)}`, finalized_block_hash: `0x${"33".repeat(32)}`, finalized_block: "500", runtime_spec_version: 470, runtime_transaction_version: 1, runtime_code_hash: `0x${"55".repeat(32)}`, metadata_sha256: `0x${"66".repeat(32)}`, metadata_version: 15 },
    results: [{ kind: "runtime", api: "SwapRuntimeApi", member: "sim_swap_tao_for_alpha", contract: null, value: { tao_amount: "990", alpha_amount: "490", tao_fee: "10", alpha_fee: "0", tao_slippage: "0", alpha_slippage: "10" } }],
  };
  const quote = decodeNativeStakeQuote(artifact, 19, 1000n, "stake", 2000000000n, 0);
  const params = nativeStakeParams(quote, `0x${"11".repeat(32)}`, 5);
  const review: ReviewedNativeStake = { quote, params, address: "fixture-address", source: "fixture-extension", sessionId: "fixture-session", context: "fixture-context" };
  const api = {} as ApiPromise;
  const extrinsic = { method: { toHex: () => "0x0700" } } as unknown as NativeCallPreview["extrinsic"];
  const preview: NativeCallPreview = { source: quote.source, address: review.address, callData: "0x0700", pallet: "SubtensorModule", member: "add_stake_limit", arguments: [], nonce: "4294967295", feeRao: 100n, maxFeeRao: 110n, balanceRao: 2000n, extrinsic };
  const payload: SignerPayloadJSON = { address: review.address, method: preview.callData, genesisHash: quote.source.network_genesis_hash, specVersion: "0x01d6", transactionVersion: "0x01", nonce: "0xffffffff", era: "0x0500", blockHash: quote.source.finalized_block_hash, blockNumber: "0x01f4", tip: "0x00", signedExtensions: [], version: 4 };
  const signPayload = vi.fn(async () => ({ id: 1, signature: "0xaaaa" as const }));
  vi.mocked(prepareNativeStakeCall).mockResolvedValue(artifact);
  vi.mocked(previewNativeCall).mockResolvedValue(preview);
  vi.mocked(buildExtrinsic).mockReturnValue(extrinsic);
  vi.mocked(getFreeBalance).mockResolvedValue(asRao(2000n));
  vi.mocked(getSigner).mockResolvedValue({ signPayload });
  vi.mocked(revalidateNativeCall).mockResolvedValue(undefined);
  let current = true;
  const assertCurrent = () => { if (!current) throw new Error("The review was cancelled."); };
  const submit = vi.fn<UseTxStatusResult["submit"]>(async (_api, _extrinsic, options) => { await options.signer.signPayload!(payload); });
  return { api, artifact, review, preview, payload, signPayload, assertCurrent, submit, cancel: () => { current = false; } };
}
test("the guarded staking flow signs exact reviewed bytes with a pinned nonce", async () => {
  const f = fixture();
  await submitReviewedNativeStake(f.api, f.review, 100n, f.assertCurrent, f.submit);
  expect(prepareNativeStakeCall).toHaveBeenCalledWith(f.review.quote, f.review.params);
  expect(buildExtrinsic).toHaveBeenCalledWith(f.api, f.review.params);
  expect(f.submit.mock.calls[0]![2]).toMatchObject({ signerAddress: f.review.address, nonce: "4294967295" });
  expect(f.signPayload).toHaveBeenCalledWith(f.payload);
  expect(revalidateNativeCall).toHaveBeenCalledTimes(2);
});
test("changing or closing the review during server preparation stops before wallet access", async () => {
  const f = fixture();
  let finish!: (value: NativeArtifact) => void;
  vi.mocked(prepareNativeStakeCall).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const pending = submitReviewedNativeStake(f.api, f.review, 100n, f.assertCurrent, f.submit);
  f.cancel(); finish(f.artifact);
  await expect(pending).rejects.toThrow(/cancelled/);
  expect(getSigner).not.toHaveBeenCalled();
  expect(f.submit).not.toHaveBeenCalled();
});
test("a cancelled review after the extension returns never resumes broadcast", async () => {
  const f = fixture();
  f.signPayload.mockImplementation(async () => { f.cancel(); return { id: 1, signature: "0xaaaa" }; });
  await expect(submitReviewedNativeStake(f.api, f.review, 100n, f.assertCurrent, f.submit)).rejects.toThrow(/cancelled/);
  expect(revalidateNativeCall).toHaveBeenCalledTimes(1);
});
test("server-altered method bytes and larger fees cannot reach the wallet prompt", async () => {
  for (const change of ["call", "fee", "balance"] as const) {
    const f = fixture();
    if (change === "call") f.preview.callData = "0x0701";
    if (change === "fee") f.preview.feeRao = 111n;
    if (change === "balance") f.preview.balanceRao = 1109n;
    await expect(submitReviewedNativeStake(f.api, f.review, 100n, f.assertCurrent, f.submit)).rejects.toThrow();
    expect(f.signPayload).not.toHaveBeenCalled();
  }
});
test("balance loss while obtaining the signer and nonce changes after signing prevent broadcast", async () => {
  const f = fixture();
  vi.mocked(getFreeBalance).mockResolvedValue(asRao(1109n));
  await expect(submitReviewedNativeStake(f.api, f.review, 100n, f.assertCurrent, f.submit)).rejects.toThrow(/balance changed/);
  expect(f.signPayload).not.toHaveBeenCalled();
  const next = fixture();
  vi.mocked(revalidateNativeCall).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("The nonce changed."));
  await expect(submitReviewedNativeStake(next.api, next.review, 100n, next.assertCurrent, next.submit)).rejects.toThrow(/nonce changed/);
  expect(next.signPayload).toHaveBeenCalledTimes(1);
});
