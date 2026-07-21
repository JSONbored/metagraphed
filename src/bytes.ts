// Server-side mirror of apps/ui/src/lib/metagraphed/bytes.ts (#4689) -- the
// same raw byte-blob (Vec<u8> / BoundedVec<u8> / Bytes) shape reconciliation
// between D1 (fetch-events.py) and Postgres (indexer-rs) call_args, needed
// here too for #4691's nested-call decode: a nested call's own byte-blob
// fields (a Proxy.proxy-wrapped commit/ciphertext, a nested call_hash, ...)
// need the identical unwrap+hex treatment the client already applies to
// top-level fields, but server-side so every consumer of the Postgres tier
// (REST, MCP once wired, third-party SDKs) sees it, not just the one React
// route that imports bytes.ts. Kept as a duplicate file (not a shared import)
// because apps/ui is a separate TypeScript toolchain the Workers runtime
// can't import from directly -- same split already established for
// ss58.ts/ss58.mjs and chain-event-args.ts/chain-event-args.mjs.

function isIntArray(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.every(
      (n) => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 255,
    )
  );
}

/** Recursively peels indexer-rs's newtype-wrap array layers -- while the
 * value is a single-element array wrapping another array, unwrap one level
 * -- until it bottoms out at a flat array of byte values, or returns null if
 * it never resolves to one. Depth-agnostic: handles both a flat `[u8; N]`
 * field with zero wraps (e.g. Multisig's raw `call_hash`) and a
 * newtype-wrapped `Hash`/`H256`/`BoundedVec<u8>` field with one or more
 * wraps (e.g. a `commit_hash`, or `commit`/`ciphertext`'s variable-length
 * payload) with the same function. */
export function unwrapByteArray(value: unknown): number[] | null {
  let current = value;
  while (
    Array.isArray(current) &&
    current.length === 1 &&
    Array.isArray(current[0])
  ) {
    current = current[0];
  }
  return isIntArray(current) ? current : null;
}

/** Canonical lowercase `0x`-prefixed hex, matching D1's existing convention
 * for opaque byte blobs. */
export function bytesToHex(bytes: number[]): string {
  return "0x" + bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** `(callModule, callFunction, fieldName)` triples D1 renders as UTF-8 text
 * rather than hex -- kept in sync with apps/ui/src/lib/metagraphed/bytes.ts's
 * TEXTUAL_FIELDS (#4689); see that module for the verified-against-real-data
 * provenance of this exact allowlist, and why SubtensorModule.set_identity/
 * set_subnet_identity's textual fields are deliberately NOT yet included. */
const TEXTUAL_FIELDS = new Set([
  "System.remark.remark",
  "System.remark_with_event.remark",
]);

/** Decodes a byte-blob call-arg field to its canonical representation: UTF-8
 * text for the small, verified allowlist of genuinely textual fields above,
 * hex for everything else (the safe default for opaque payloads, and the
 * same fix for D1's own Ethereum.transact.input mojibake bug that field is
 * deliberately NOT in the allowlist). */
export function decodeBytesField(
  callModule: string | null | undefined,
  callFunction: string | null | undefined,
  fieldName: string,
  bytes: number[],
): string {
  const key = `${callModule ?? ""}.${callFunction ?? ""}.${fieldName}`;
  if (TEXTUAL_FIELDS.has(key)) {
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
        Uint8Array.from(bytes),
      );
    } catch {
      // Malformed UTF-8 for a field expected to be textual -- fall back to
      // hex rather than producing mojibake (the exact class of bug this
      // module exists to avoid reproducing).
      return bytesToHex(bytes);
    }
  }
  return bytesToHex(bytes);
}
