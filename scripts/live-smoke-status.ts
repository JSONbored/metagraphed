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
// `declaredDegradation` is this route's row in DECLARED_LIVE_DEGRADATIONS: the
// route must then answer exactly 503 with exactly that error code — a 200 is a
// STALE declaration (the route recovered; the row must go), anything else is a
// new defect. Undeclared routes keep the plain 200 contract.
export function assertLiveApiStatus(
  result: {
    status: unknown;
    body?: unknown;
  },
  declaredDegradation?: string,
): void {
  const status =
    typeof result.status === "number" &&
    Number.isInteger(result.status) &&
    result.status >= 100 &&
    result.status <= 599
      ? result.status
      : "invalid";
  // A 200 never reads the diagnostic body: for an undeclared route it is the
  // pass, and for a declared one it is the stale-declaration failure -- both
  // decided on status alone.
  if (declaredDegradation) {
    assert.notEqual(
      status,
      200,
      `stale degradation declaration: the route answers 200 again -- remove it from DECLARED_LIVE_DEGRADATIONS`,
    );
  } else if (status === 200) {
    return;
  }
  const code = ownDataProperty(ownDataProperty(result.body, "error"), "code");
  const category =
    typeof code === "string" &&
    code.length <= 64 &&
    PUBLIC_ERROR_CODES.has(code)
      ? code
      : "unclassified";
  if (declaredDegradation) {
    assert.equal(
      status,
      503,
      `declared degraded (${declaredDegradation}) but got status=${status}; error_code=${category}`,
    );
    assert.equal(
      code,
      declaredDegradation,
      `declared degraded with ${declaredDegradation} but the 503 carries error_code=${category}`,
    );
    return;
  }
  assert.equal(
    status,
    200,
    `expected HTTP 200 (status=${status}; error_code=${category})`,
  );
}
