import { createHash } from "node:crypto";
import type { AccountPageEntry } from "./account-page-encoding.ts";

/** Reuse one bounded buffer for the existing typed digest of validated pages.
 * Hash updates consume bytes synchronously; no page or field buffers survive
 * a call. UTF-16 code units and IEEE-754 bits retain the original digest format. */
export function createAccountPageDigest() {
  const bytes = Buffer.allocUnsafe(64 * 1024);
  return (entries: readonly AccountPageEntry[]): string => {
    const hash = createHash("sha256");
    let offset = 0;
    function flush() {
      hash.update(bytes.subarray(0, offset));
      offset = 0;
    }
    function reserve(length: number) {
      if (offset + length > bytes.length) flush();
    }
    for (const entry of entries) {
      reserve(166);
      offset += bytes.write(entry.token, offset, "ascii");
      for (const value of entry.values) {
        if (value === null) {
          reserve(1);
          bytes[offset++] = 0x4e;
        } else if (typeof value === "string") {
          reserve(5);
          bytes[offset++] = 0x53;
          bytes.writeUInt32LE(value.length * 2, offset);
          offset += 4;
          for (let start = 0; start < value.length;) {
            reserve(2);
            const count = Math.min(
              Math.floor((bytes.length - offset) / 2),
              value.length - start,
            );
            offset += bytes.write(
              value.slice(start, start + count),
              offset,
              count * 2,
              "utf16le",
            );
            start += count;
          }
        } else {
          reserve(9);
          bytes[offset++] = 0x44;
          bytes.writeDoubleLE(value, offset);
          offset += 8;
        }
      }
    }
    flush();
    return hash.digest("hex");
  };
}
