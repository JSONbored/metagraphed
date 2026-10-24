// Failure-only diagnostics. Error objects, causes, messages and stacks are never read.
import { types } from "node:util";
import {
  FAILURE_REPLAY_REASON_CODES,
  type FailureReplayReasonCode,
} from "./failure-replay-reason-codes.ts";
import { OWNER_PROOF_REASON_CODES } from "./owner-proof-reason-codes.ts";
import {
  ownerProofReasonMarker,
  parseOwnerProofReasonMarker,
} from "./owner-proof-reasons.ts";
export const FAILURE_REPLAY_STAGE_CODES = Object.freeze({
  "thread-lifecycle": "replay-thread-lifecycle",
  variant: "replay-variant",
  "test-evidence": "replay-test-evidence",
  "owner-evidence": "replay-owner-evidence",
  "receipt-directory": "replay-receipt-directory",
  completion: "replay-completion",
  publication: "replay-publication",
  "runner-setup": "replay-runner-setup",
  "diagnostic-cross-check": "replay-diagnostic-cross-check",
} as const);
export type FailureReplayStage = keyof typeof FAILURE_REPLAY_STAGE_CODES;
export type FailureReplayCode =
  | FailureReplayReasonCode
  | (typeof FAILURE_REPLAY_STAGE_CODES)[FailureReplayStage];
export interface FailureReplayDiagnostic {
  readonly stage: FailureReplayStage;
  readonly family: "failure-replay" | "owner-proof";
  readonly code: string;
}
const stages: ReadonlySet<string> = new Set(
  Object.keys(FAILURE_REPLAY_STAGE_CODES),
);
const codes: ReadonlySet<string> = new Set([
  ...FAILURE_REPLAY_REASON_CODES,
  ...Object.values(FAILURE_REPLAY_STAGE_CODES),
]);
const ownerCodes: ReadonlySet<string> = new Set(OWNER_PROOF_REASON_CODES);
const reasons = new WeakMap<
  object,
  { family: "failure-replay" | "owner-proof"; code: string }
>();
const isKey = (value: unknown): value is object =>
  (typeof value === "object" && value !== null) || typeof value === "function";
function known(
  error: unknown,
): { family: "failure-replay" | "owner-proof"; code: string } | null {
  if (!isKey(error)) return null;
  const local = reasons.get(error);
  if (local !== undefined) return local;
  // Both existing helper calls operate only on their private WeakMap and a
  // bounded generated marker. They do not inspect any field on the exception.
  const owner = parseOwnerProofReasonMarker(ownerProofReasonMarker(error));
  return owner === null ? null : { family: "owner-proof", code: owner };
}
export function failureReplayFailure<T>(error: T, code: FailureReplayCode): T {
  try {
    if (
      typeof code === "string" &&
      codes.has(code) &&
      isKey(error) &&
      known(error) === null
    )
      reasons.set(error, { family: "failure-replay", code });
  } catch {
    // Diagnostic work must never replace the original thrown value.
  }
  return error;
}
export function inheritFailureReplayReason<T>(error: T, cause: unknown): T {
  try {
    const reason = known(cause);
    if (reason !== null && isKey(error) && known(error) === null)
      reasons.set(error, reason);
  } catch {
    /* Keep the original thrown value. */
  }
  return error;
}
export function withFailureReplayReason<T>(
  code: FailureReplayCode,
  action: () => T,
): T {
  try {
    return action();
  } catch (error) {
    throw failureReplayFailure(error, code);
  }
}
export async function withFailureReplayReasonAsync<T>(
  code: FailureReplayCode,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throw failureReplayFailure(error, code);
  }
}
export function failureReplayDiagnostic(
  error: unknown,
  stage: FailureReplayStage,
): FailureReplayDiagnostic | null {
  if (typeof stage !== "string" || !stages.has(stage)) return null;
  const reason = known(error) ?? {
    family: "failure-replay" as const,
    code: FAILURE_REPLAY_STAGE_CODES[stage],
  };
  return Object.freeze({ stage, family: reason.family, code: reason.code });
}
export const FAILURE_REPLAY_DIAGNOSTIC_LIMIT = 8;
function ownData(
  value: unknown,
  keys: readonly string[],
  array = false,
): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || types.isProxy(value)) return null;
  if (
    Object.getPrototypeOf(value) !==
    (array ? Array.prototype : Object.prototype)
  )
    return null;
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    return null;
  const data: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      !("value" in descriptor) ||
      (key !== "length" && !descriptor.enumerable)
    )
      return null;
    data[key] = descriptor.value;
  }
  return data;
}
/** Fixed enum projection only. Never trusts caller fields, accessors or proxies. */
export function parseFailureReplayDiagnostics(
  input: unknown,
): readonly FailureReplayDiagnostic[] | null {
  try {
    if (
      !input ||
      typeof input !== "object" ||
      types.isProxy(input) ||
      !Array.isArray(input)
    )
      return null;
    const length = Object.getOwnPropertyDescriptor(input, "length");
    if (
      !length ||
      !("value" in length) ||
      !Number.isSafeInteger(length.value) ||
      length.value < 0 ||
      length.value > FAILURE_REPLAY_DIAGNOSTIC_LIMIT
    )
      return null;
    const count: number = length.value;
    const array = ownData(
      input,
      ["length", ...Array.from({ length: count }, (_, index) => String(index))],
      true,
    );
    if (array === null) return null;
    const seen = new Set<string>();
    const result: FailureReplayDiagnostic[] = [];
    for (let index = 0; index < count; index++) {
      const row = ownData(array[index], ["stage", "family", "code"]);
      if (
        !row ||
        typeof row.stage !== "string" ||
        !stages.has(row.stage) ||
        seen.has(row.stage) ||
        typeof row.code !== "string" ||
        row.code.length > 96
      )
        return null;
      if (
        row.family === "failure-replay"
          ? !codes.has(row.code)
          : row.family === "owner-proof"
            ? !ownerCodes.has(row.code)
            : true
      )
        return null;
      seen.add(row.stage);
      result.push(
        Object.freeze({
          stage: row.stage as FailureReplayStage,
          family: row.family as FailureReplayDiagnostic["family"],
          code: row.code,
        }),
      );
    }
    return Object.freeze(result);
  } catch {
    return null;
  }
}
/** The caller supplies results of fresh replay, never proof from the receipt.
 * A runner mismatch emits one fixed code and cannot change acceptance. */
export function projectFailureReplayDiagnostics(
  recorded: unknown,
  revalidated: unknown,
  status: unknown,
): readonly FailureReplayDiagnostic[] {
  if (status !== "failed") return Object.freeze([]);
  const fresh = parseFailureReplayDiagnostics(revalidated);
  if (fresh === null) return Object.freeze([]);
  const claimed = parseFailureReplayDiagnostics(recorded);
  const mismatch =
    recorded !== undefined &&
    (claimed === null ||
      claimed.some(
        (row) =>
          !fresh.some(
            (other) =>
              other.stage === row.stage &&
              other.family === row.family &&
              other.code === row.code,
          ),
      ));
  if (!mismatch) return fresh;
  return Object.freeze([
    ...fresh
      .filter((row) => row.stage !== "diagnostic-cross-check")
      .slice(0, FAILURE_REPLAY_DIAGNOSTIC_LIMIT - 1),
    failureReplayDiagnostic(null, "diagnostic-cross-check")!,
  ]);
}
