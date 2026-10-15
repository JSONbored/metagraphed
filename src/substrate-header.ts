import { blake2b } from "@noble/hashes/blake2.js";
import { concatBytes, bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

export const SUBSTRATE_ZERO_HASH = `0x${"0".repeat(64)}`;

export function substrateHash(value: unknown): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value))
    throw new Error("Invalid Substrate hash");
  return value.toLowerCase();
}

/** Bittensor's Header number is Compact<u32>, not JSON text or a fixed u32. */
export function compactU32(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff)
    throw new Error("Invalid Substrate block number");
  if (value < 64) return Uint8Array.of(value * 4);
  const bytes = new Uint8Array(
    value < 16_384 ? 2 : value < 0x4000_0000 ? 4 : 5,
  );
  const view = new DataView(bytes.buffer);
  if (bytes.length === 2) view.setUint16(0, value * 4 + 1, true);
  else if (bytes.length === 4) view.setUint32(0, value * 4 + 2, true);
  else {
    bytes[0] = 3;
    view.setUint32(1, value, true);
  }
  return bytes;
}

/** Digest logs are already individual SCALE DigestItems in the RPC JSON form. */
export function substrateHeader(header: unknown): {
  height: number;
  parentHash: string;
  hash: string;
} {
  if (!header || typeof header !== "object")
    throw new Error("Invalid Substrate header");
  const h = header as Record<string, unknown>;
  if (typeof h.number !== "string" || !/^0x[0-9a-fA-F]{1,8}$/.test(h.number))
    throw new Error("Invalid Substrate block number");
  const height = Number.parseInt(h.number, 16);
  const number = compactU32(height);
  const parentHash = substrateHash(h.parentHash);
  const stateRoot = substrateHash(h.stateRoot);
  const extrinsicsRoot = substrateHash(h.extrinsicsRoot);
  const logs = (h.digest as { logs?: unknown } | null)?.logs;
  if (!Array.isArray(logs) || logs.length > 256)
    throw new Error("Invalid Substrate digest");
  let length = 0;
  const digest = logs.map((log: unknown) => {
    if (typeof log !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(log))
      throw new Error("Invalid Substrate digest");
    length += (log.length - 2) / 2;
    if (length > 1024 * 1024)
      throw new Error("Substrate digest exceeds budget");
    return hexToBytes(log.slice(2));
  });
  const encoded = concatBytes(
    hexToBytes(parentHash.slice(2)),
    number,
    hexToBytes(stateRoot.slice(2)),
    hexToBytes(extrinsicsRoot.slice(2)),
    compactU32(logs.length),
    ...digest,
  );
  return {
    height,
    parentHash,
    hash: `0x${bytesToHex(blake2b(encoded, { dkLen: 32 }))}`,
  };
}

/** Structural validation only; event/trie inclusion still relies on the RPC. */
export function canonicalRawBlock(
  row: {
    block_number: number;
    block_hash: unknown;
    parent_hash: unknown;
    header: unknown;
    extrinsics: unknown;
    events: unknown;
  },
  height: number,
  parentHash: string,
): string {
  const header = substrateHeader(row.header);
  if (
    header.height !== height ||
    row.block_number !== height ||
    header.hash !== substrateHash(row.block_hash) ||
    header.parentHash !== substrateHash(row.parent_hash) ||
    header.parentHash !== parentHash ||
    !Array.isArray(row.extrinsics) ||
    !row.extrinsics.every(
      (value: unknown) =>
        typeof value === "string" && /^0x(?:[0-9a-fA-F]{2})+$/.test(value),
    ) ||
    typeof row.events !== "string" ||
    !/^0x(?:[0-9a-fA-F]{2})+$/.test(row.events)
  )
    throw new Error("Raw capture canonical block differs");
  return header.hash;
}
