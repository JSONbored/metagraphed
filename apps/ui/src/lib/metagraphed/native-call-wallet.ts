import type { ApiPromise } from "@polkadot/api";
import type { Signer, SubmittableExtrinsic } from "@polkadot/api/types";
import type { NativeArtifact } from "./native-runtime";
import { getFreeBalance } from "./chain-connection";

export interface NativeCallPreview {
  source: NativeArtifact["source"];
  address: string;
  callData: string;
  pallet: string;
  member: string;
  arguments: { name: string; value: string }[];
  nonce: string;
  feeRao: bigint;
  maxFeeRao: bigint;
  balanceRao: bigint;
  extrinsic: SubmittableExtrinsic<"promise">;
}

/** Runtime and canonical-source checks are repeated immediately before signing.
 * A method byte sequence has meaning only within its genesis and runtime code. */
export async function assertNativeCallRuntime(api: ApiPromise, source: NativeArtifact["source"]) {
  if (source.runtime_code_hash === null)
    throw new Error("Refresh the native contract with a runtime code identity before signing.");
  if (api.genesisHash.toHex() !== source.network_genesis_hash)
    throw new Error("The wallet connection belongs to another network.");
  const finalized = await api.rpc.chain.getFinalizedHead();
  const [header, version, code, canonical] = await Promise.all([
    api.rpc.chain.getHeader(finalized),
    api.rpc.state.getRuntimeVersion(finalized),
    api.rpc.state.getStorageHash("0x3a636f6465", finalized),
    api.rpc.chain.getBlockHash(source.finalized_block),
  ]);
  if (
    canonical.toHex() !== source.finalized_block_hash ||
    header.number.toBigInt() < BigInt(source.finalized_block)
  )
    throw new Error("The prepared source is no longer a canonical finalized block.");
  if (
    version.specVersion.toNumber() !== source.runtime_spec_version ||
    version.transactionVersion.toNumber() !== source.runtime_transaction_version ||
    code.toHex() !== source.runtime_code_hash ||
    api.runtimeVersion.specVersion.toNumber() !== source.runtime_spec_version ||
    api.runtimeVersion.transactionVersion.toNumber() !== source.runtime_transaction_version
  )
    throw new Error("The runtime changed. Prepare and review this call again.");
}

export async function previewNativeCall(
  api: ApiPromise,
  artifact: NativeArtifact,
  index: number,
  address: string,
): Promise<NativeCallPreview> {
  const result = artifact.results[index];
  if (result?.kind !== "prepare" || !result.call_data || !result.pallet || !result.member)
    throw new Error("Choose a prepared native call to review.");
  await assertNativeCallRuntime(api, artifact.source);
  // api.tx(string) decodes an entire extrinsic, not method bytes. A real Call
  // codec is the supported overload for the unsigned method our API returns.
  const call = api.registry.createType("Call", result.call_data);
  if (
    call.toHex() !== result.call_data ||
    call.meta.name.toString() !== result.member ||
    call.section.toLowerCase().replaceAll("_", "") !==
      result.pallet.toLowerCase().replaceAll("_", "")
  )
    throw new Error("Wallet metadata does not reproduce the prepared call exactly.");
  const extrinsic = api.tx(call);
  const [nonce, info, balanceRao] = await Promise.all([
    api.rpc.system.accountNextIndex(address),
    extrinsic.paymentInfo(address),
    getFreeBalance(api, address),
  ]);
  const feeRao = info.partialFee.toBigInt();
  if (feeRao < 0n) throw new Error("The runtime returned an invalid fee estimate.");
  const maxFeeRao = feeRao + (feeRao + 9n) / 10n;
  if (balanceRao < maxFeeRao)
    throw new Error("The spendable balance cannot cover the reviewed fee allowance.");
  return {
    source: { ...artifact.source },
    address,
    callData: result.call_data,
    pallet: result.pallet,
    member: result.member,
    arguments: call.argsEntries.map(([name, arg]) => ({
      name,
      value: arg.toString(),
    })),
    nonce: nonce.toString(),
    feeRao,
    maxFeeRao,
    balanceRao,
    extrinsic,
  };
}

/** Refresh fee and pending nonce without silently changing the approved intent. */
export async function revalidateNativeCall(api: ApiPromise, preview: NativeCallPreview) {
  await assertNativeCallRuntime(api, preview.source);
  const [nonce, info, balance] = await Promise.all([
    api.rpc.system.accountNextIndex(preview.address),
    preview.extrinsic.paymentInfo(preview.address),
    getFreeBalance(api, preview.address),
  ]);
  if (nonce.toString() !== preview.nonce)
    throw new Error("The account nonce changed. Review this call again.");
  if (preview.extrinsic.method.toHex() !== preview.callData)
    throw new Error("The call changed. Review it again.");
  if (info.partialFee.toBigInt() > preview.maxFeeRao || balance < preview.maxFeeRao)
    throw new Error("The fee or spendable balance changed. Review this call again.");
}

/** Check the actual wallet payload as well as the reviewed call. The second
 * check runs after the extension returns but before SDK broadcast resumes. */
export function guardNativeSigner(
  signer: Signer,
  preview: NativeCallPreview,
  assertCurrent: () => void,
  recheck: () => Promise<void>,
): Signer {
  const signPayload = signer.signPayload?.bind(signer);
  const signRaw = signer.signRaw?.bind(signer);
  if (!signPayload && !signRaw)
    throw new Error("Choose a wallet that supports native transaction signatures.");
  const finish = async <T>(signed: T) => {
    assertCurrent();
    await recheck();
    assertCurrent();
    return signed;
  };
  return {
    update: signer.update?.bind(signer),
    ...(signPayload
      ? {
          signPayload: async (payload: Parameters<NonNullable<Signer["signPayload"]>>[0]) => {
            assertCurrent();
            if (
              payload.address !== preview.address ||
              payload.method !== preview.callData ||
              payload.genesisHash !== preview.source.network_genesis_hash ||
              BigInt(payload.specVersion) !== BigInt(preview.source.runtime_spec_version) ||
              BigInt(payload.transactionVersion) !==
                BigInt(preview.source.runtime_transaction_version) ||
              BigInt(payload.nonce) !== BigInt(preview.nonce) ||
              payload.era === "0x00"
            )
              throw new Error("The wallet payload differs from the reviewed native call.");
            return finish(await signPayload(payload));
          },
        }
      : {}),
    ...(signRaw
      ? {
          signRaw: async (payload: Parameters<NonNullable<Signer["signRaw"]>>[0]) => {
            assertCurrent();
            if (payload.address !== preview.address || payload.type !== "bytes")
              throw new Error("The wallet payload differs from the reviewed native call.");
            // The SDK constructs these signing bytes from the same reviewed method
            // and pinned nonce. Large payloads may be hashed by the SDK, so validate
            // its source extrinsic and runtime before passing the opaque bytes on.
            await recheck();
            assertCurrent();
            return finish(await signRaw(payload));
          },
        }
      : {}),
  };
}
