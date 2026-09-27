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
