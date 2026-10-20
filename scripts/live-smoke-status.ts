import assert from "node:assert/strict";

const PUBLIC_ERROR_CODES = new Set([
  "history_unavailable",
  "account_summary_unavailable",
  "data_tier_unavailable",
]);

function ownDataProperty(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const property = Object.getOwnPropertyDescriptor(value, key);
  return property && "value" in property ? property.value : undefined;
}

// Inspect only two own data fields, never stringify the body or invoke getters.
// This bounds diagnostic extraction, not the caller's HTTP response decoding.
export function assertLiveApiStatus(result: {
  status: unknown;
  body?: unknown;
}): void {
  const status =
    typeof result.status === "number" &&
    Number.isInteger(result.status) &&
    result.status >= 100 &&
    result.status <= 599
      ? result.status
      : "invalid";
  if (status === 200) return;

  const code = ownDataProperty(ownDataProperty(result.body, "error"), "code");
  const category =
    typeof code === "string" &&
    code.length <= 64 &&
    PUBLIC_ERROR_CODES.has(code)
      ? code
      : "unclassified";
  assert.equal(
    status,
    200,
    `expected HTTP 200 (status=${status}; error_code=${category})`,
  );
}
