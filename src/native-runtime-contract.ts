import { createHash } from "node:crypto";
import { registerModuleStateReset } from "./module-state-registry.ts";
import {
  NativeScaleReader,
  decodeNativeMetadata,
  unwrapNativeMetadata,
  NATIVE_RUNTIME_LIMITS,
  type NativeMetadata,
} from "./native-runtime-metadata.ts";
import type { BasketRpc } from "./root-basket-runtime.ts";

interface Contract {
  metadata: NativeMetadata;
  sha256: string;
}
// Two compact contracts per isolate, with no persistent writes. Runtime code
// identity, rather than a version label or TTL, binds every hit to this block.
const contracts = new Map<string, Contract>();
registerModuleStateReset("src/native-runtime-contract.ts", () =>
  contracts.clear(),
);
export async function loadNativeContract(
  read: BasketRpc,
  at: string,
  genesis: string,
  spec: number,
  transaction: number,
  runtimeSignatures = false,
) {
  let codeHash: string | null = null;
  try {
    const value = await read("state_getStorageHash", ["0x3a636f6465", at]);
    if (typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value))
      codeHash = value;
  } catch {
    /* Older RPC providers can still read without contract reuse. */
  }
  const key =
    codeHash === null
      ? null
      : JSON.stringify([genesis, codeHash, spec, transaction]);
  let fallback: Contract | undefined;
  if (key !== null) {
    const cached = contracts.get(key);
    if (cached) {
      contracts.delete(key);
      contracts.set(key, cached);
      if (cached.metadata.version === 15 || !runtimeSignatures)
        return { ...cached, codeHash };
      // V14 describes storage and calls, but lacks runtime API signatures.
      // A provider's earlier negotiation failure must not hide signatures
      // when a later typed request can negotiate V15 for the same code.
      fallback = cached;
    }
  }
  let hex: string | null;
  try {
    hex = unwrapNativeMetadata(
      await read("state_call", [
        "Metadata_metadata_at_version",
        "0x0f000000",
        at,
      ]),
    );
  } catch {
    hex = null;
  }
  if (hex === null && fallback) return { ...fallback, codeHash };
  const reader = new NativeScaleReader(
    hex ?? (await read("state_getMetadata", [at])),
    NATIVE_RUNTIME_LIMITS.metadataBytes,
  );
  const metadata = decodeNativeMetadata(reader);
  const contract = {
    metadata,
    sha256: `0x${createHash("sha256").update(reader.bytes).digest("hex")}`,
  };
  // Bound retained projections as well as their wire input. Documentation is
  // discarded during parsing and never enters the retained contract.
  if (key !== null) {
    const bytes = Buffer.byteLength(
      JSON.stringify({ ...metadata, types: [...metadata.types.values()] }),
    );
    if (bytes <= 524_288) {
      if (!contracts.has(key) && contracts.size === 2)
        contracts.delete(contracts.keys().next().value!);
      contracts.set(key, contract);
    }
  }
  return { ...contract, codeHash };
}
