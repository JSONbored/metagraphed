// Failure-only diagnostic branding. No error property is read or coerced.
import {
  OWNER_PROOF_REASON_CODES,
  type OwnerProofReasonCode,
} from "./owner-proof-reason-codes.ts";
const codes: ReadonlySet<string> = new Set(OWNER_PROOF_REASON_CODES);
const reasons = new WeakMap<object, OwnerProofReasonCode>();
function key(value: unknown): value is object {
  return (
    (typeof value === "object" && value !== null) || typeof value === "function"
  );
}
export function ownerProofFailure<T>(error: T, code: OwnerProofReasonCode): T {
  try {
    if (
      typeof code === "string" &&
      codes.has(code) &&
      key(error) &&
      !reasons.has(error)
    )
      reasons.set(error, code);
  } catch {
    // Diagnostic failure cannot replace the original exception.
  }
  return error;
}
export function inheritOwnerProofReason<T>(error: T, cause: unknown): T {
  try {
    if (key(cause)) {
      const code = reasons.get(cause);
      if (code !== undefined) return ownerProofFailure(error, code);
    }
  } catch {
    // Keep the exact original error even if branding cannot be retained.
  }
  return error;
}
export function ownerProofReasonMarker(error: unknown): string {
  if (!key(error)) return "";
  const code = reasons.get(error);
  return code === undefined ? "" : `[owner-proof-reason:${code}]`;
}
export function withOwnerProofReason<T>(
  code: OwnerProofReasonCode,
  action: () => T,
): T {
  try {
    return action();
  } catch (error) {
    throw ownerProofFailure(error, code);
  }
}
export async function withOwnerProofReasonAsync<T>(
  code: OwnerProofReasonCode,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throw ownerProofFailure(error, code);
  }
}
/** Public fixed-enum reduction; repeated, malformed, or unknown markers fail. */
export function parseOwnerProofReasonMarker(
  text: unknown,
): OwnerProofReasonCode | null {
  if (typeof text !== "string" || text.length > 65536) return null;
  const broadPrefix = "[owner-proof-reason";
  const prefix = broadPrefix + ":";
  const firstPrefix = text.indexOf(broadPrefix);
  if (
    firstPrefix < 0 ||
    text.indexOf(broadPrefix, firstPrefix + broadPrefix.length) !== -1 ||
    !text.startsWith(prefix, firstPrefix)
  )
    return null;
  const start = text.indexOf(prefix);
  if (start < 0 || text.indexOf(prefix, start + prefix.length) !== -1)
    return null;
  const end = text.indexOf("]", start + prefix.length);
  if (end < 0 || end - start > 160) return null;
  const code = text.slice(start + prefix.length, end);
  return codes.has(code) ? (code as OwnerProofReasonCode) : null;
}
