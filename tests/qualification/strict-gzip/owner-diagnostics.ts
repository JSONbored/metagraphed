import { parseOwnerProofReasonMarker } from "./owner-proof-reasons.ts";
import { types } from "node:util";
import {
  OWNER_BUILD_STAGES,
  ownerBuildDiagnosticMarkers,
} from "./owner-build-stages.ts";
import {
  OPTIONAL_PROOF_STAGES,
  OPTIONAL_IMPORT_CATEGORIES,
  parseOptionalPgInputKeyCountsMarker,
} from "./optional-pg-import.ts";
import { OWNER_REFUSED_IMPORTS } from "./owner-resource-policy.ts";
import { publicInputIdentityDiagnostics } from "./owner-input-diagnostics.ts";
// Optional bounded diagnostics only. Never participates in acceptance decisions.
import assert from "node:assert/strict";
import path from "node:path";
import { OWNER_TESTS, OWNER_TITLES } from "./owner-test-evidence.ts";
import { FOCUSED_TESTS } from "./verify-candidate.ts";
export const OWNER_FRAME_PATHS = [
  ...OWNER_TESTS,
  "tests/qualification/strict-gzip/raw-owner-fixture.ts",
  "tests/qualification/strict-gzip/queue-owner-bundle.ts",
  "tests/qualification/strict-gzip/postgres-owner-fixture.ts",
  "tests/qualification/strict-gzip/owner-build-evidence.ts",
  "tests/qualification/strict-gzip/owner-resource-fixture.ts",
  "tests/qualification/strict-gzip/owner-native-evidence.ts",
  "tests/qualification/strict-gzip/owner-resource-policy.ts",
  "tests/qualification/strict-gzip/owner-pg-identity.ts",
  "tests/qualification/strict-gzip/owner-deadline.ts",
  "tests/qualification/strict-gzip/optional-pg-import.ts",
] as const;
// Only the failed required assertion can supply these optional diagnostics.
// A malformed, missing, duplicate or conflicting marker set supplies no report.
export function publicBuildProofDiagnostics(value: unknown) {
  if (types.isProxy(value) || !Array.isArray(value) || value.length > 19)
    return null;
  const messages: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      !descriptor ||
      !Object.hasOwn(descriptor, "value") ||
      typeof descriptor.value !== "string" ||
      descriptor.value.length > 65536
    )
      return null;
    messages.push(descriptor.value);
  }
  const reasonMessages = messages.filter((message) =>
    message.includes("[owner-proof-reason"),
  );
  if (reasonMessages.length > 1) return null;
  const reason = reasonMessages.length
    ? parseOwnerProofReasonMarker(reasonMessages[0])
    : null;
  if (reasonMessages.length && reason === null) return null;
  const keyMessages = messages.filter((message) =>
    message.includes("[owner-optional-input-key-counts"),
  );
  if (keyMessages.length > 1) return null;
  const inputKeys = keyMessages.length
    ? parseOptionalPgInputKeyCountsMarker(keyMessages[0])
    : null;
  if (keyMessages.length && inputKeys === null) return null;
  const extras = {
    ...(reason ? { reason } : {}),
    ...(inputKeys ? { inputKeys } : {}),
  };
  const markers: string[] = [];
  const prefix =
    /\[owner-(?:optional-proof-failed|optional-import-counts|build-proof-failed):/g;
  for (const message of messages) {
    if (typeof message !== "string" || message.length > 65536) return null;
    const starts = [...message.matchAll(prefix)];
    const matches = [
      ...message.matchAll(
        /\[owner-(?:optional-proof-failed|optional-import-counts|build-proof-failed):[^\]\r\n]{0,512}\]/g,
      ),
    ];
    if (starts.length !== matches.length) return null;
    markers.push(...matches.map((match) => match[0]));
    if (markers.length > 3) return null;
  }
  if (markers.length === 1) {
    if (inputKeys) return null;
    const match = /^\[owner-build-proof-failed:([a-z-]+):([a-z-]+)\]$/.exec(
      markers[0]!,
    );
    if (!match || !Object.hasOwn(OWNER_BUILD_STAGES, match[1]!)) return null;
    const scope = match[1] as keyof typeof OWNER_BUILD_STAGES;
    const stages = OWNER_BUILD_STAGES[scope] as readonly string[];
    const index = stages.indexOf(match[2]!);
    return index < 0
      ? null
      : { scope, stage: stages[index]!, imports: [], ...extras };
  }
  if (markers.length !== 3) return null;
  const stageMarkers = markers.filter((marker) =>
    marker.startsWith("[owner-optional-proof-failed:"),
  );
  if (stageMarkers.length !== 1) return null;
  const stageMatch = /^\[owner-optional-proof-failed:([a-z-]+)\]$/.exec(
    stageMarkers[0]!,
  );
  if (!stageMatch) return null;
  const stageIndex = (OPTIONAL_PROOF_STAGES as readonly string[]).indexOf(
    stageMatch[1]!,
  );
  if (stageIndex < 0) return null;
  const imports = [];
  for (const scope of ["input", "output"] as const) {
    const rows = markers.filter((marker) =>
      marker.startsWith(`[owner-optional-import-counts:${scope}:`),
    );
    if (rows.length !== 1) return null;
    const match =
      /^\[owner-optional-import-counts:(input|output):([01]):(0|[1-9][0-9]{0,4}):(0|[1-9][0-9]{0,4}):(0|[1-9][0-9]{0,4}):(0|[1-9][0-9]{0,4}):(0|[1-9][0-9]{0,4}):(0|[1-9][0-9]{0,4})\]$/.exec(
        rows[0]!,
      );
    if (!match) return null;
    const counts = match.slice(3).map(Number);
    const total = counts.reduce((sum, count) => sum + count, 0);
    if (
      counts.some((count) => !Number.isSafeInteger(count) || count > 65536) ||
      total > 65536 ||
      (match[2] === "0" && total !== 0)
    )
      return null;
    imports.push({
      scope,
      complete: match[2] === "1",
      counts: Object.fromEntries(
        OPTIONAL_IMPORT_CATEGORIES.map((category, index) => [
          category,
          counts[index]!,
        ]),
      ),
    });
  }
  return {
    scope: "optional-pg",
    stage: OPTIONAL_PROOF_STAGES[stageIndex]!,
    imports,
    ...extras,
  };
}
export function publicBuildProofFailure(error: unknown) {
  const markers = ownerBuildDiagnosticMarkers(error);
  return markers ? publicBuildProofDiagnostics([markers]) : null;
}
export function publicInputIdentityFailure(error: unknown) {
  const markers = ownerBuildDiagnosticMarkers(error);
  return markers ? publicInputIdentityDiagnostics([markers]) : null;
}
function refusedBuildImports(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 20) return [];
  return OWNER_REFUSED_IMPORTS.filter((label) =>
    value.some(
      (message) =>
        typeof message === "string" &&
        message.length <= 65536 &&
        message.includes(`[owner-import-refused:${label}]`),
    ),
  );
}
function frames(value: unknown, root: string) {
  const result: { fileIndex: number; line: number; column: number }[] = [];
  if (!Array.isArray(value) || value.length > 20) return result;
  for (const message of value) {
    if (typeof message !== "string" || message.length > 65536) continue;
    for (const [fileIndex, file] of OWNER_FRAME_PATHS.entries())
      for (const prefix of [
        path.join(root, file) + ":",
        "file://" + path.join(root, file) + ":",
      ]) {
        let from = 0;
        for (;;) {
          const at = message.indexOf(prefix, from);
          if (at < 0) break;
          from = at + prefix.length;
          if (at > 0 && !/[\s(]/.test(message[at - 1]!)) continue;
          const match = /^([1-9][0-9]{0,4}):([1-9][0-9]{0,3})(?:\)|\s|$)/.exec(
            message.slice(from),
          );
          if (!match) continue;
          const row = {
            fileIndex,
            line: Number(match[1]),
            column: Number(match[2]),
          };
          if (
            !result.some(
              (v) =>
                v.fileIndex === row.fileIndex &&
                v.line === row.line &&
                v.column === row.column,
            )
          )
            result.push(row);
          if (result.length === 5) return result;
        }
      }
  }
  return result;
}
export function publicOwnerProgress(input: unknown, root: string) {
  assert.ok(path.isAbsolute(root));
  assert.ok(input && typeof input === "object");
  const suites = (input as any).testResults;
  assert.ok(Array.isArray(suites) && suites.length <= 12);
  const seen = new Set<string>(),
    known = [...FOCUSED_TESTS, ...OWNER_TESTS] as readonly string[];
  for (const suite of suites) {
    assert.ok(
      suite &&
        typeof suite === "object" &&
        typeof suite.name === "string" &&
        path.isAbsolute(suite.name),
    );
    const file = path.relative(root, suite.name);
    assert.ok(known.includes(file) && !seen.has(file));
    seen.add(file);
  }
  return OWNER_TESTS.map((file, index) => {
    const suite = suites.find((s) => path.relative(root, s.name) === file);
    if (!suite)
      return {
        path: file,
        status: "missing",
        passed: 0,
        failed: 0,
        skipped: 0,
        requiredCase: "missing",
        frames: [],
        refusedBuildImports: [],
        buildProof: null,
        inputOnlyPublicIdentities: null,
      };
    assert.ok(
      ["passed", "failed", "pending", "skipped"].includes(suite.status),
    );
    assert.ok(
      Array.isArray(suite.assertionResults) &&
        suite.assertionResults.length <= 100,
    );
    let passed = 0,
      failed = 0,
      skipped = 0;
    for (const item of suite.assertionResults) {
      assert.ok(item && typeof item === "object");
      if (item.status === "passed") passed++;
      else if (item.status === "failed") failed++;
      else {
        assert.ok(
          ["pending", "skipped", "todo", "disabled"].includes(item.status),
        );
        skipped++;
      }
    }
    const matches = suite.assertionResults.filter(
      (item: any) => item.title === OWNER_TITLES[index],
    );
    const requiredCase =
      matches.length === 0
        ? "missing"
        : matches.length > 1
          ? "ambiguous"
          : matches[0].status === "passed"
            ? "passed"
            : matches[0].status === "failed"
              ? "failed"
              : "skipped";
    const status =
      suite.status === "failed" || failed > 0
        ? "failed"
        : suite.status === "passed" &&
            passed === 1 &&
            skipped === 0 &&
            requiredCase === "passed"
          ? "passed"
          : "incomplete";
    const messages =
      matches.length === 1 && Array.isArray(matches[0].failureMessages)
        ? matches[0].failureMessages
        : [];
    const diagnosticMessages =
      messages.length <= 19 ? [...messages, suite.message] : [];
    return {
      path: file,
      status,
      passed,
      failed,
      skipped,
      requiredCase,
      frames: status === "passed" ? [] : frames(diagnosticMessages, root),
      buildProof:
        status === "failed" && requiredCase === "failed"
          ? publicBuildProofDiagnostics(messages)
          : null,
      inputOnlyPublicIdentities:
        status === "failed" &&
        requiredCase === "failed" &&
        publicBuildProofDiagnostics(messages)?.scope === "optional-pg"
          ? publicInputIdentityDiagnostics(messages)
          : null,
      refusedBuildImports:
        status === "passed" ? [] : refusedBuildImports(diagnosticMessages),
    };
  });
}
