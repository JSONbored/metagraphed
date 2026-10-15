/** Exact UTF-8 digests usable by Workers without Node compatibility. */
export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      typeof value === "string"
        ? new TextEncoder().encode(value)
        : new Uint8Array(value),
    ),
  );
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
