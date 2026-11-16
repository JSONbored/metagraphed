import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { gzipSync } from "node:zlib";

export const RAW_CAPTURE_CHUNK_BYTES = 65_536;
const MAX_RAW = 32 * 1024 * 1024;
const KEY = /^chain\/raw\/(testnet\/)?blocks\/(\d{12})-(\d{12})\.ndjson$/;
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** Both durable stores admit the same exact capture bytes and descriptor. */
export function prepareRawCapture(key: string, value: string) {
  const match = KEY.exec(key);
  if (!match || typeof value !== "string" || !value.endsWith("\n"))
    throw new Error("Invalid raw capture object");
  const first = Number(match[2]),
    last = Number(match[3]);
  const raw = Buffer.from(value);
  if (
    !raw.length ||
    raw.length > MAX_RAW ||
    last < first ||
    last - first >= 4096
  )
    throw new Error("Raw capture exceeds its storage budget");
  const rows = value.trimEnd().split("\n");
  let capturedAt = 0;
  if (rows.length !== last - first + 1)
    throw new Error("Raw capture range differs from its records");
  for (let index = 0; index < rows.length; index++) {
    const row = JSON.parse(rows[index]!);
    if (
      row?.block_number !== first + index ||
      !Number.isSafeInteger(row.captured_at) ||
      row.captured_at <= 0
    )
      throw new Error("Raw capture identity differs");
    capturedAt = Math.max(capturedAt, row.captured_at);
  }
  const compressed = gzipSync(raw, { level: 6 });
  const digest = hash(raw),
    compressedDigest = hash(compressed);
  const parts = Math.ceil(compressed.length / RAW_CAPTURE_CHUNK_BYTES);
  const network = match[1] ? "testnet" : "mainnet";
  const descriptor = {
    key,
    sha256: digest,
    network,
    first_block: first,
    last_block: last,
    raw_bytes: raw.length,
    compressed_bytes: compressed.length,
    compressed_sha256: compressedDigest,
    parts,
    captured_at: capturedAt,
  };
  return { descriptor, compressed, digest, compressedDigest, parts, network };
}
