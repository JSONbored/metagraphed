// A capture timestamp as both epoch-ms and its serialized form (#10948).
//
// Extracted from the pair of "deliberate byte-for-byte copies" in
// src/concentration.ts and src/subnet-idle-stake.ts -- which were, in the
// tradition this issue exists to end, not byte-for-byte (formatting and
// annotation drift only; behaviour was identical, verified before the
// extraction). Accepts an epoch-ms number, a numeric-string epoch (Postgres
// hands a BIGINT column back as a string), or a parseable date string;
// anything else, or a non-positive / non-finite epoch, is not a real
// timestamp and reads as null.

export interface CaptureStamp {
  ms: number;
  value: string;
}

export function epochMsStamp(ms: number): CaptureStamp | null {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return null;
  return { ms, value: date.toISOString() };
}

export function captureStamp(value: unknown): CaptureStamp | null {
  if (value == null) return null;
  if (typeof value === "string") {
    if (/^\d+$/.test(value)) return epochMsStamp(Number(value));
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? { ms, value } : null;
  }
  if (typeof value === "number") return epochMsStamp(value);
  return null;
}
