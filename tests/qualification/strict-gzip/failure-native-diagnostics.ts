// Failure-only host diagnostics. Exceptions remain private; no error field is read.
import { types } from "node:util";
import path from "node:path";
import {
  FAILURE_NATIVE_REASON_CODES,
  type FailureNativeReasonCode,
} from "./failure-native-reason-codes.ts";
import { FAILURE_REPLAY_REASON_CODES } from "./failure-replay-reason-codes.ts";
import { OWNER_PROOF_REASON_CODES } from "./owner-proof-reason-codes.ts";
import {
  failureReplayDiagnostic,
  FAILURE_REPLAY_STAGE_CODES,
} from "./failure-replay-diagnostics.ts";
import {
  FAILURE_TEST_FILE,
  FAILURE_REQUIRED_TITLES,
  FAILURE_CONTROL_TITLE,
} from "./failure-test-evidence.ts";
export const FAILURE_NATIVE_BOUNDARIES = Object.freeze([
  "module",
  "before-all",
  "after-all",
  "auth-rejection",
  "query-cancellation",
  "decoder-refusal",
  "auth-unfixed-control",
] as const);
export type FailureNativeBoundary = (typeof FAILURE_NATIVE_BOUNDARIES)[number];
type Role = "primary" | "cleanup";
type Family = "failure-native" | "failure-replay" | "owner-proof";
interface Reason {
  readonly location: FailureNativeReasonCode;
  readonly role: Role;
  readonly family: Family;
  readonly code: string;
}
export interface FailureNativeDiagnostic extends Reason {
  readonly boundary: FailureNativeBoundary;
}
const nativeCodes: ReadonlySet<string> = new Set(FAILURE_NATIVE_REASON_CODES);
const replayCodes: ReadonlySet<string> = new Set([
  ...FAILURE_REPLAY_REASON_CODES,
  ...Object.values(FAILURE_REPLAY_STAGE_CODES),
]);
const ownerCodes: ReadonlySet<string> = new Set(OWNER_PROOF_REASON_CODES);
const boundaries: ReadonlySet<string> = new Set(FAILURE_NATIVE_BOUNDARIES);
const reasons = new WeakMap<object, readonly Reason[]>();
// Only this closure retains originals, including primitives and AggregateErrors.
// They are never attached to an error that crosses the reporter boundary.
const originals = new WeakMap<object, unknown>();
const isKey = (value: unknown): value is object =>
  (typeof value === "object" && value !== null) || typeof value === "function";
export const FAILURE_NATIVE_REASON_LIMIT = 8;
export const FAILURE_NATIVE_DIAGNOSTIC_LIMIT = 48;
const MARKER_PREFIX = "[failure-native-v1:";
const MARKER_LIMIT = 16384;
function reason(
  error: unknown,
  location: FailureNativeReasonCode,
  role: Role = "primary",
): Reason {
  const existing = failureReplayDiagnostic(error, "test-evidence");
  return Object.freeze(
    existing && existing.code !== "replay-test-evidence"
      ? { location, role, family: existing.family, code: existing.code }
      : { location, role, family: "failure-native", code: location },
  );
}
function bounded(input: readonly Reason[]): readonly Reason[] {
  if (input.length <= FAILURE_NATIVE_REASON_LIMIT)
    return Object.freeze([...input]);
  return Object.freeze([
    ...input.slice(0, FAILURE_NATIVE_REASON_LIMIT - 1),
    Object.freeze({
      location: "qnf-reasons-truncated" as const,
      role: "cleanup" as const,
      family: "failure-native" as const,
      code: "qnf-reasons-truncated",
    }),
  ]);
}
export function failureNativeFailure<T>(
  error: T,
  location: FailureNativeReasonCode,
): T {
  try {
    if (nativeCodes.has(location) && isKey(error) && !reasons.has(error))
      reasons.set(error, Object.freeze([reason(error, location)]));
  } catch {
    /* Diagnostics never replace the thrown value. */
  }
  return error;
}
export function inheritFailureNativeFailures<T>(
  error: T,
  captured: readonly {
    error: unknown;
    role: Role;
    location: FailureNativeReasonCode;
  }[],
): T {
  try {
    if (!isKey(error) || reasons.has(error)) return error;
    const combined: Reason[] = [];
    // captured is a locally constructed list, never an exception's errors/cause.
    for (const item of captured) {
      if (
        !nativeCodes.has(item.location) ||
        !["primary", "cleanup"].includes(item.role)
      )
        continue;
      const known = isKey(item.error) ? reasons.get(item.error) : undefined;
      for (const row of known ?? [reason(item.error, item.location, item.role)])
        combined.push(
          Object.freeze({
            ...row,
            role: item.role === "cleanup" ? "cleanup" : row.role,
          }),
        );
    }
    if (combined.length) reasons.set(error, bounded(combined));
  } catch {
    /* Keep the exact AggregateError and its original private values. */
  }
  return error;
}
export function withFailureNativeReason<T>(
  location: FailureNativeReasonCode,
  action: () => T,
): T {
  try {
    return action();
  } catch (error) {
    throw failureNativeFailure(error, location);
  }
}
export function withFailureNativeReasonAsync<T>(
  location: FailureNativeReasonCode,
  action: () => Promise<T>,
): Promise<T> {
  try {
    const result = action();
    // Observe the same Promise; do not add an awaited settlement or substitute it.
    try {
      Promise.prototype.then.call(result, undefined, (error: unknown) => {
        failureNativeFailure(error, location);
      });
    } catch {
      /* An unavailable diagnostic observer cannot affect the operation. */
    }
    return result;
  } catch (error) {
    throw failureNativeFailure(error, location);
  }
}
export function failureNativeBoundaryError(
  error: unknown,
  boundary: FailureNativeBoundary,
): Error {
  // Callers pass only fixed source literals; no supplied exception is reflected.
  const safeBoundary = boundaries.has(boundary) ? boundary : "module";
  const location = `qnf-boundary-${safeBoundary}` as FailureNativeReasonCode;
  const rows = isKey(error) ? reasons.get(error) : undefined;
  const marker =
    MARKER_PREFIX +
    JSON.stringify({
      boundary: safeBoundary,
      reasons: bounded(rows ?? [reason(error, location)]),
    }) +
    "]";
  const safe = new Error(marker);
  Object.defineProperty(safe, "stack", {
    value: marker,
    writable: true,
    configurable: true,
  });
  originals.set(safe, error);
  return safe;
}
export function withFailureNativeBoundary<T>(
  boundary: FailureNativeBoundary,
  action: () => T,
): T {
  try {
    return action();
  } catch (error) {
    throw failureNativeBoundaryError(error, boundary);
  }
}
function record(
  value: unknown,
  allowed: readonly string[],
): Record<string, unknown> | null {
  if (
    !value ||
    typeof value !== "object" ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return null;
  const result: Record<string, unknown> = Object.create(null);
  const keys = Reflect.ownKeys(value);
  if (keys.length > allowed.length) return null;
  for (const key of keys) {
    if (typeof key !== "string" || !allowed.includes(key)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      return null;
    result[key] = descriptor.value;
  }
  return result;
}
function array(value: unknown, max: number): readonly unknown[] | null {
  if (
    !value ||
    typeof value !== "object" ||
    types.isProxy(value) ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  )
    return null;
  const length = Object.getOwnPropertyDescriptor(value, "length");
  if (
    !length ||
    !("value" in length) ||
    !Number.isSafeInteger(length.value) ||
    length.value < 0 ||
    length.value > max ||
    Reflect.ownKeys(value).length !== length.value + 1
  )
    return null;
  const output: unknown[] = [];
  for (let index = 0; index < length.value; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      return null;
    output.push(descriptor.value);
  }
  return output;
}
/** Exact marker-only message/stack. Arbitrary text and nested markers are refused. */
export function parseFailureNativeMarker(
  input: unknown,
): readonly FailureNativeDiagnostic[] | null {
  try {
    if (
      typeof input !== "string" ||
      input.length > MARKER_LIMIT ||
      !input.startsWith(MARKER_PREFIX) ||
      !input.endsWith("]") ||
      input.indexOf(MARKER_PREFIX, MARKER_PREFIX.length) !== -1
    )
      return null;
    const raw = record(JSON.parse(input.slice(MARKER_PREFIX.length, -1)), [
      "boundary",
      "reasons",
    ]);
    if (
      !raw ||
      Object.keys(raw).length !== 2 ||
      typeof raw.boundary !== "string" ||
      !boundaries.has(raw.boundary)
    )
      return null;
    const values = array(raw.reasons, FAILURE_NATIVE_REASON_LIMIT);
    if (!values || values.length === 0) return null;
    const result: FailureNativeDiagnostic[] = [];
    for (const value of values) {
      const row = record(value, ["location", "role", "family", "code"]);
      if (
        !row ||
        Object.keys(row).length !== 4 ||
        typeof row.location !== "string" ||
        !nativeCodes.has(row.location) ||
        !["primary", "cleanup"].includes(row.role as string) ||
        typeof row.code !== "string" ||
        row.code.length > 96
      )
        return null;
      const codes =
        row.family === "failure-native"
          ? nativeCodes
          : row.family === "failure-replay"
            ? replayCodes
            : row.family === "owner-proof"
              ? ownerCodes
              : null;
      if (!codes?.has(row.code)) return null;
      if (row.family === "failure-native" && row.code !== row.location)
        return null;
      if (
        row.location.startsWith("qnf-boundary-") &&
        row.location !== `qnf-boundary-${raw.boundary}`
      )
        return null;
      if (row.location === "qnf-reasons-truncated" && row.role !== "cleanup")
        return null;
      result.push(
        Object.freeze({
          boundary: raw.boundary as FailureNativeBoundary,
          location: row.location as FailureNativeReasonCode,
          role: row.role as Role,
          family: row.family as Family,
          code: row.code,
        }),
      );
    }
    const canonical =
      MARKER_PREFIX +
      JSON.stringify({
        boundary: raw.boundary,
        reasons: result.map(({ boundary: _boundary, ...row }) => row),
      }) +
      "]";
    if (input !== canonical) return null;
    return Object.freeze(result);
  } catch {
    return null;
  }
}
/** Optional first-reported evidence only. JSON reporter can omit later hook errors.
 * Never changes acceptance. root/file/title data is validated but never projected. */
export function publicFailureNativeDiagnostics(
  input: unknown,
  root: string,
  phase: string,
  status: unknown,
): readonly FailureNativeDiagnostic[] {
  const none = Object.freeze([]) as readonly FailureNativeDiagnostic[];
  try {
    if (
      status !== "failed" ||
      !["uninstrumented", "instrumented", "unfixed-instrumented"].includes(
        phase,
      ) ||
      typeof root !== "string" ||
      !path.isAbsolute(root)
    )
      return none;
    const report = record(input, [
      "numTotalTestSuites",
      "numPassedTestSuites",
      "numFailedTestSuites",
      "numPendingTestSuites",
      "numTotalTests",
      "numPassedTests",
      "numFailedTests",
      "numPendingTests",
      "numTodoTests",
      "snapshot",
      "startTime",
      "success",
      "testResults",
      "coverageMap",
    ]);
    if (
      !report ||
      report.success !== false ||
      report.numTotalTestSuites !== 1 ||
      report.numFailedTestSuites !== 1 ||
      report.numPassedTestSuites !== 0 ||
      report.numPendingTestSuites !== 0 ||
      report.numTodoTests !== 0
    )
      return none;
    const suites = array(report.testResults, 1);
    if (!suites || suites.length !== 1) return none;
    const suite = record(suites[0], [
      "assertionResults",
      "startTime",
      "endTime",
      "status",
      "message",
      "name",
    ]);
    if (
      !suite ||
      suite.name !== path.join(root, FAILURE_TEST_FILE) ||
      suite.status !== "failed" ||
      typeof suite.message !== "string" ||
      suite.message.length > 65536
    )
      return none;
    const titles =
      phase === "unfixed-instrumented"
        ? [FAILURE_CONTROL_TITLE]
        : FAILURE_REQUIRED_TITLES;
    const tests = array(suite.assertionResults, titles.length);
    if (!tests || report.numTotalTests !== tests.length) return none;
    const output: FailureNativeDiagnostic[] = [];
    const seenMarkers = new Set<string>();
    const consume = (
      message: unknown,
      allowed: readonly FailureNativeBoundary[],
    ) => {
      if (typeof message !== "string" || message.length > 65536) return false;
      if (!message.includes("[failure-native")) return true;
      const rows = parseFailureNativeMarker(message);
      if (
        !rows ||
        seenMarkers.has(message) ||
        rows.some((row) => !allowed.includes(row.boundary))
      )
        return false;
      seenMarkers.add(message);
      output.push(...rows);
      return output.length <= FAILURE_NATIVE_DIAGNOSTIC_LIMIT;
    };
    if (!consume(suite.message, ["module", "before-all", "after-all"]))
      return none;
    if (tests.length === 0) {
      if (
        report.numPassedTests !== 0 ||
        report.numFailedTests !== 0 ||
        report.numPendingTests !== 0 ||
        output.length === 0 ||
        output.some((row) => row.boundary !== "module")
      )
        return none;
      return Object.freeze(output);
    }
    if (
      tests.length !== titles.length ||
      output.some((row) => row.boundary === "module")
    )
      return none;
    const seen = new Set<string>();
    let passed = 0,
      failed = 0,
      pending = 0;
    for (const item of tests) {
      const test = record(item, [
        "ancestorTitles",
        "fullName",
        "status",
        "title",
        "duration",
        "failureMessages",
        "location",
        "meta",
        "tags",
      ]);
      if (
        !test ||
        typeof test.title !== "string" ||
        !titles.includes(test.title) ||
        seen.has(test.title) ||
        test.fullName !== test.title
      )
        return none;
      const ancestors = array(test.ancestorTitles, 0);
      if (!ancestors || ancestors.length !== 0) return none;
      seen.add(test.title);
      const messages = array(test.failureMessages, 8);
      if (!messages) return none;
      if (test.status === "passed") passed++;
      else if (test.status === "failed") failed++;
      else if (test.status === "pending" || test.status === "skipped")
        pending++;
      else return none;
      if (test.status !== "failed" && messages.length !== 0) return none;
      const boundary =
        phase === "unfixed-instrumented"
          ? "auth-unfixed-control"
          : FAILURE_NATIVE_BOUNDARIES[3 + titles.indexOf(test.title)];
      for (const message of messages)
        if (!consume(message, [boundary])) return none;
    }
    if (
      report.numPassedTests !== passed ||
      report.numFailedTests !== failed ||
      report.numPendingTests !== pending ||
      seen.size !== titles.length
    )
      return none;
    return Object.freeze(output);
  } catch {
    return none;
  }
}
