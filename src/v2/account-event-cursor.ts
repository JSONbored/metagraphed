import { z } from "zod";
import { V2AccountEventCursorSchema } from "../../schemas-src/v2/contracts.ts";

export type V2AccountEventCursor = z.infer<typeof V2AccountEventCursorSchema>;

export function encodeAccountEventCursor(value: V2AccountEventCursor): string {
  const bytes = new TextEncoder().encode(
    JSON.stringify(V2AccountEventCursorSchema.parse(value)),
  );
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join(
    "",
  );
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/** Public read selectors, not authorization. Canonical spelling also prevents
 * two opaque cursors from identifying different continuations accidentally. */
export function decodeAccountEventCursor(value: string): V2AccountEventCursor {
  try {
    if (
      value.length === 0 ||
      value.length > 2048 ||
      !/^[A-Za-z0-9_-]+$/.test(value)
    )
      throw new Error();
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    const json = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false,
    }).decode(bytes);
    const cursor = V2AccountEventCursorSchema.parse(JSON.parse(json));
    if (encodeAccountEventCursor(cursor) !== value) throw new Error();
    return cursor;
  } catch {
    throw new Error("Invalid account event cursor");
  }
}
