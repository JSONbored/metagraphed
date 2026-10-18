import { createHash } from "node:crypto";

/** Preserve exact UTF-8 strings and byte views used by immutable history keys. */
export function historySha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Canonical identity JSON, preserving the established history key encoding. */
export function historyJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(historyJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${historyJson(record[key])}`).join(",")}}`;
}

/**
 * Stream the same canonical bytes as historyJson, with a newline per value.
 * Refuse the whole digest on exhaustion; never return a hash of a prefix.
 * Strings are escaped in small chunks without splitting surrogate pairs, so
 * one oversized row cannot allocate an oversized canonical payload first.
 */
export function boundedHistoryJsonSha256(
  values: Iterable<unknown>,
  maxBytes: number,
  maxDepth: number,
): string | null {
  const digest = createHash("sha256");
  const encoder = new TextEncoder();
  let remaining = maxBytes;
  function emit(text: string): boolean {
    const bytes = encoder.encode(text).byteLength;
    if (bytes > remaining) return false;
    remaining -= bytes;
    digest.update(text);
    return true;
  }
  function string(value: string): boolean {
    if (value.length + 2 > remaining || !emit('"')) return false;
    for (let start = 0; start < value.length;) {
      let end = Math.min(start + 8192, value.length);
      const last = value.charCodeAt(end - 1);
      const next = value.charCodeAt(end);
      if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff)
        end += 1;
      if (!emit(JSON.stringify(value.slice(start, end)).slice(1, -1)))
        return false;
      start = end;
    }
    return emit('"');
  }
  function write(value: unknown, depth: number, inArray = false): boolean {
    if (depth > maxDepth) return false;
    if (typeof value === "string") return string(value);
    if (value === null || typeof value !== "object") {
      return emit(JSON.stringify(value) ?? (inArray ? "" : "undefined"));
    }
    if (Array.isArray(value)) {
      if (!emit("[") || value.length > remaining) return false;
      for (let i = 0; i < value.length; i += 1) {
        if (i && !emit(",")) return false;
        // Match historyJson's map/join encoding for sparse arrays too.
        if (i in value && !write(value[i], depth + 1, true)) return false;
      }
      return emit("]");
    }
    if (!emit("{")) return false;
    const keys = Object.keys(value);
    // Each member needs at least two quotes, a colon and one value byte.
    if (keys.length * 4 > remaining) return false;
    keys.sort();
    for (let i = 0; i < keys.length; i += 1) {
      if (i && !emit(",")) return false;
      if (
        !string(keys[i]) ||
        !emit(":") ||
        !write((value as Record<string, unknown>)[keys[i]], depth + 1)
      )
        return false;
    }
    return emit("}");
  }
  for (const value of values) {
    if (!write(value, 0) || !emit("\n")) return null;
  }
  return digest.digest("hex");
}
