// Coerce a D1 captured_at cell (epoch-ms number/string or ISO string) to the
// `{ ms, value }` shape performance/concentration builders use when picking the
// newest snapshot stamp. D1 can return INTEGER columns as numeric strings; an
// out-of-range epoch-ms must degrade to null (never a RangeError). Shared by
// concentration.mjs (#2725), subnet-performance.mjs, and chain-performance.mjs.

function epochMsStamp(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return null;
  return { ms, value: date.toISOString() };
}

export function captureStamp(value) {
  if (value == null) return null;
  if (typeof value === "string") {
    if (/^\d+$/.test(value)) {
      return epochMsStamp(Number(value));
    }
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return { ms, value };
    return null;
  }
  if (typeof value === "number") {
    return epochMsStamp(value);
  }
  return null;
}
