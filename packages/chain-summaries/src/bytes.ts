// Raw byte-blob (Vec<u8> / BoundedVec<u8> / Bytes) shape reconciliation
// between D1 (fetch-events.py) and Postgres (indexer-rs) call_args (#4669,
// #4689). D1 is itself inconsistent for this Rust type family -- hex string
// for opaque payloads (PoW work, weight commits), UTF-8-decoded text for a
// few known textual fields (System.remark) -- while Postgres always emits a
// flat or newtype-wrapped integer array with no type metadata to tell them
// apart generically. This picks ONE canonical target per named field (a
// curated allowlist, defaulting to hex for everything not explicitly
// listed) rather than sniffing byte content, which risks exactly the kind
// of silent corruption already found in D1's own Ethereum.transact.input
// field (force-decoded as UTF-8/Latin1 today, producing mojibake with
// embedded control characters on every occurrence -- fixed here by NOT
// adding `input` to the textual allowlist, so it renders as clean hex
// instead of reproducing that bug).

function isIntArray(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.every((n) => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 255)
  );
}

/** Recursively peels indexer-rs's newtype-wrap array layers -- while the
 * value is a single-element array wrapping another array, unwrap one level
 * -- until it bottoms out at a flat array of byte values, or returns null
 * if it never resolves to one. Depth-agnostic: handles both a flat `[u8; N]`
 * field with zero wraps (e.g. Multisig's raw `call_hash`) and a
 * newtype-wrapped `Hash`/`H256`/`BoundedVec<u8>` field with one or more
 * wraps (e.g. a `commit_hash`, or `commit`/`ciphertext`'s variable-length
 * payload) with the same function, rather than a hardcoded wrap-depth
 * assumption tuned to only one of the two. */
export function unwrapByteArray(value: unknown): number[] | null {
  let current = value;
  while (Array.isArray(current) && current.length === 1 && Array.isArray(current[0])) {
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
 * rather than hex -- verified against real production data (System.
 * remark_with_event, block 8512299/extrinsic_index 12: D1 `remark:
 * "module-test-5f758613"`, Postgres the same bytes undecoded). NOT YET
 * covered: SubtensorModule.set_identity/set_subnet_identity's textual
 * fields (name/url/discord/description-style) -- D1's exact behavior and
 * field names for these are unverified (no occurrence in either store's
 * current retention window as of this writing), so they default to hex
 * below rather than guessing; add them here once confirmed against a real
 * example. */
const TEXTUAL_FIELDS = new Set(["System.remark.remark", "System.remark_with_event.remark"]);

/** Decodes a byte-blob call-arg field to its canonical representation: UTF-8
 * text for the small, verified allowlist of genuinely textual fields above,
 * hex for everything else (the safe default for opaque payloads, and the
 * fix for D1's own Ethereum.transact.input mojibake bug -- that field is
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
      return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
    } catch {
      // Malformed UTF-8 for a field expected to be textual -- fall back to
      // hex rather than producing mojibake (the exact class of bug this
      // module exists to avoid reproducing).
      return bytesToHex(bytes);
    }
  }
  return bytesToHex(bytes);
}
