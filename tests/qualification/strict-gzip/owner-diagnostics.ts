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
] as const;
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
    };
  });
}
