/** Exact UTF-8 digests usable by Workers without Node compatibility. */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
