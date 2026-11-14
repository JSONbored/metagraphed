import { z } from "zod";
import {
  V2AccountStakeCursorSchema,
  type V2AccountStakeEntry,
} from "../../schemas-src/v2/stake.ts";

export type V2AccountStakeCursor = z.infer<typeof V2AccountStakeCursorSchema>;
export function encodeAccountStakeCursor(value: V2AccountStakeCursor): string {
  const bytes = new TextEncoder().encode(
    JSON.stringify(V2AccountStakeCursorSchema.parse(value)),
  );
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
export function decodeAccountStakeCursor(value: string): V2AccountStakeCursor {
  try {
    if (!value.length || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value))
      throw new Error();
    const bytes = Uint8Array.from(
      atob(value.replaceAll("-", "+").replaceAll("_", "/")),
      (character) => character.charCodeAt(0),
    );
    const parsed = V2AccountStakeCursorSchema.parse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
          bytes,
        ),
      ),
    );
    if (encodeAccountStakeCursor(parsed) !== value) throw new Error();
    return parsed;
  } catch {
    throw new Error("Invalid account stake cursor");
  }
}

export function accountStakeKey(entry: V2AccountStakeEntry) {
  return entry.kind === "position"
    ? {
        kind: entry.kind,
        hotkey: entry.position.hotkey,
        netuid: entry.position.netuid,
      }
    : { kind: entry.kind, hotkey: entry.entitlement.key.hotkey, netuid: null };
}
export function compareAccountStakeKeys(
  left: Pick<V2AccountStakeCursor, "kind" | "hotkey" | "netuid">,
  right: Pick<V2AccountStakeCursor, "kind" | "hotkey" | "netuid">,
): number {
  if (left.hotkey !== right.hotkey) return left.hotkey < right.hotkey ? -1 : 1;
  if (left.kind !== right.kind) return left.kind === "position" ? -1 : 1;
  return (left.netuid ?? 0) - (right.netuid ?? 0);
}
