import { sha256Hex } from "./sha256-hex.ts";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// Solana's compact signature count frames 64-byte signature slots, followed by
// the signed message. The fee-payer slot is usually unsigned here. Hashing only
// a signature or the outer JSON would permit collisions or metadata replays.
function solanaMessage(transaction: string): string | null {
  let bytes: string;
  try {
    bytes = atob(transaction);
  } catch {
    return null;
  }
  if (bytes.length > 1_232) return null;
  let count = 0;
  let offset = 0;
  for (; offset < 3; offset++) {
    if (offset >= bytes.length) return null;
    const byte = bytes.charCodeAt(offset);
    count += (byte & 0x7f) * 2 ** (offset * 7);
    if ((byte & 0x80) === 0) break;
  }
  if (offset === 3 || count < 1 || count > 32) return null;
  const start = offset + 1 + count * 64;
  if (start >= bytes.length) return null;
  return [...bytes.slice(start)]
    .map((byte) => byte.charCodeAt(0).toString(16).padStart(2, "0"))
    .join("");
}

/** The signed transfer identity, excluding unsigned resource and offer metadata. */
export async function x402PaymentIdentity(
  payload: unknown,
): Promise<string | null> {
  const value = record(payload);
  const accepted = record(value?.accepted);
  const payment = record(value?.payload);
  const network = accepted?.network;
  const asset = accepted?.asset;
  if (typeof network !== "string" || typeof asset !== "string" || !payment)
    return null;
  let identity: string;
  if (network.startsWith("eip155:")) {
    const authorization = record(payment.authorization);
    const from = authorization?.from;
    const nonce = authorization?.nonce;
    if (
      typeof from !== "string" ||
      !/^0x[0-9a-fA-F]{40}$/.test(from) ||
      typeof nonce !== "string" ||
      !/^0x[0-9a-fA-F]{64}$/.test(nonce)
    )
      return null;
    identity = `${from.toLowerCase()}:${nonce.toLowerCase()}`;
  } else if (network.startsWith("solana:")) {
    const transaction = payment.transaction;
    if (typeof transaction !== "string") return null;
    const message = solanaMessage(transaction);
    if (message === null) return null;
    identity = message;
  } else {
    return null;
  }
  const normalizedAsset = network.startsWith("eip155:")
    ? asset.toLowerCase()
    : asset;
  return sha256Hex(JSON.stringify([network, normalizedAsset, identity]));
}

/** Bind a payment to the exact route, query, method and bounded request body. */
export async function x402RequestFingerprint(
  request: Request,
): Promise<string | null> {
  if (Number(request.headers.get("content-length")) > 65_536) return null;
  const body = request.clone().body;
  let hex = "";
  if (body) {
    const reader = body.getReader();
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 65_536) {
          // This is a cloned tee; awaiting cancellation can wait indefinitely
          // for the original branch that the rejected request will never read.
          void reader.cancel().catch(() => {});
          return null;
        }
        for (const byte of value) hex += byte.toString(16).padStart(2, "0");
      }
    } finally {
      reader.releaseLock();
    }
  }
  // Decode-free framing preserves even invalid UTF-8 and embedded BOM bytes.
  return sha256Hex(JSON.stringify([request.method, request.url, hex]));
}
