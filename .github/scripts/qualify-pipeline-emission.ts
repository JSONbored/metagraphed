import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const base = "0a65fcffd51b0a6a2b9757905be02c1d8b859e6c";
const expectedParent = "29ffa6cf321ee20c2da5bd11a7783c722614aaff";
const originalSha =
  "33f3afcf125f4aad4b3ebe2e84c52299b4240886679f0fe740735366628d9410";
const originalBlob = "166fa028808963551b3cb109591eb5deaa6ec16f";
const helper = ".github/scripts/qualify-pipeline-emission.ts";
const workflow = ".github/workflows/pipeline-emission-source-qualification.yml";
const manifestPath = ".github/fixtures/pipeline-emission/manifest.json";
const paths = [
  "scripts/pipeline.ts",
  "tests/fixtures/pipeline-emission-original.ts.payload",
  "tests/pipeline-emission.test.ts",
];
const reports = "tmp/pipeline-emission/";
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const git = (...args: string[]) =>
  execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
interface SourceFile {
  path: string;
  payload: string;
  sha256: string;
  bytes: number;
  git_blob_sha: string;
  expected_base_blob_sha: string | null;
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
  version: number;
  base_commit: string;
  carrier_files: string[];
  files: SourceFile[];
};
const source = git("rev-parse", "HEAD");
assert.equal(process.env.GITHUB_SHA, source);
assert.equal(process.platform, "linux");
assert.equal(process.version, "v22.23.2");
assert.equal(manifest.version, 1);
assert.equal(manifest.base_commit, base);
assert.deepEqual(
  manifest.files.map((file) => file.path),
  paths,
);
const carrier = [
  helper,
  workflow,
  manifestPath,
  ...paths.map(
    (file) => ".github/fixtures/pipeline-emission/" + file + ".payload",
  ),
].sort();
assert.deepEqual(manifest.carrier_files, carrier);
const identity = {
  source_commit: source,
  canonical_base: base,
  run_id: process.env.GITHUB_RUN_ID,
  run_attempt: process.env.GITHUB_RUN_ATTEMPT,
  production_actions: false,
  raw_output_retained: false,
};
const pins = () =>
  Object.fromEntries(
    [...paths, helper, workflow, manifestPath].map((file) => {
      const bytes = readFileSync(file);
      assert.ok(bytes.byteLength > 0 && bytes.byteLength < 131_072);
      return [file, { bytes: bytes.byteLength, sha256: digest(bytes) }];
    }),
  );
function receipt(name: string, value: unknown) {
  mkdirSync(reports, { recursive: true });
  const bytes = JSON.stringify(value, null, 2) + "\n";
  assert.ok(Buffer.byteLength(bytes) < 131_072);
  writeFileSync(reports + name + "-receipt.json", bytes);
}
function apply() {
  assert.equal(git("status", "--porcelain", "--untracked-files=no"), "");
  git("merge-base", "--is-ancestor", base, "HEAD");
  // Exact failed-terminal parent; all main-relative deltas remain fixed .github paths.
  assert.equal(git("rev-parse", "HEAD^"), expectedParent);
  assert.deepEqual(
    git("diff", "--name-only", base + "...HEAD")
      .split("\n")
      .sort(),
    carrier,
  );
  const original = readFileSync(paths[0]);
  assert.equal(digest(original), originalSha);
  assert.equal(git("rev-parse", base + ":" + paths[0]), originalBlob);
  let total = 0;
  const verified = manifest.files.map((file) => {
    assert.equal(
      file.payload,
      ".github/fixtures/pipeline-emission/" + file.path + ".payload",
    );
    assert.ok(
      lstatSync(file.payload).isFile() &&
        !lstatSync(file.payload).isSymbolicLink(),
    );
    assert.ok(
      Number.isSafeInteger(file.bytes) &&
        file.bytes > 0 &&
        file.bytes < 131_072,
    );
    assert.match(file.sha256, /^[a-f0-9]{64}$/);
    const bytes = readFileSync(file.payload);
    assert.equal(bytes.byteLength, file.bytes);
    assert.equal(digest(bytes), file.sha256);
    assert.equal(
      createHash("sha1")
        .update("blob " + bytes.byteLength + "\0")
        .update(bytes)
        .digest("hex"),
      file.git_blob_sha,
    );
    if (file.path === paths[0])
      assert.equal(file.expected_base_blob_sha, originalBlob);
    else {
      assert.equal(file.expected_base_blob_sha, null);
      assert.equal(existsSync(file.path), false);
    }
    if (file.path === paths[1]) {
      assert.equal(digest(bytes), originalSha);
      assert.ok(bytes.equals(original));
    }
    total += bytes.byteLength;
    return { file, bytes };
  });
  assert.ok(total < 131_072);
  for (const { file, bytes } of verified) {
    mkdirSync(path.dirname(file.path), { recursive: true });
    writeFileSync(file.path, bytes);
    assert.equal(digest(readFileSync(file.path)), file.sha256);
  }
  assert.equal(git("rev-parse", "HEAD"), source);
  receipt("applied", {
    ...identity,
    status: "runner_only_sources_applied",
    before_format: pins(),
    source_payload_bytes: total,
    canonical_git_runtime_changed: false,
    remote_refs_changed: false,
  });
}
const titles = [
  "drains both streams and retains failure at ordinal 1",
  "drains both streams and retains failure at ordinal 2",
  "detects terminal loss from the exact pinned immediate-exit original",
  "keeps the full 85-command success path and summary",
];
interface TestReport {
  success: boolean;
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
  numPendingTests: number;
  numTodoTests: number;
  testResults: {
    name: string;
    message: string;
    assertionResults: {
      title: string;
      fullName: string;
      ancestorTitles: string[];
      status: string;
      failureMessages: string[];
    }[];
  }[];
}
interface FailureFrameSource {
  file: string;
  relative_file: string;
  sha256: string;
  line_lengths: number[];
}
function projectFailureFrames(messages: string[], approved: FailureFrameSource) {
  const frames: { source_id: number; source_sha256: string; line: number; column: number }[] = [];
  let oversizedMessages = 0;
  let otherSourceFrames = 0;
  let refusedPositions = 0;
  let overflowFrames = 0;
  for (const message of messages) {
    if (Buffer.byteLength(message) > 65_536) {
      oversizedMessages++;
      continue;
    }
    for (const line of message.split(/\r?\n/)) {
      const match = /^\s*at (?:[A-Za-z0-9_.$<> /-]{1,128} \()?(.+):(\d+):(\d+)\)?$/.exec(line);
      if (!match) continue;
      const file = match[1].startsWith("file://") ? match[1].slice(7) : match[1];
      if (file !== approved.file && file !== approved.relative_file) {
        otherSourceFrames++;
        continue;
      }
      const row = Number(match[2]);
      const column = Number(match[3]);
      if (!Number.isSafeInteger(row) || row < 1 || row > approved.line_lengths.length ||
          !Number.isSafeInteger(column) || column < 1 || column > approved.line_lengths[row - 1] + 1) {
        refusedPositions++;
        continue;
      }
      if (frames.length === 16) {
        overflowFrames++;
        continue;
      }
      frames.push({ source_id: 2, source_sha256: approved.sha256, line: row, column });
    }
  }
  return { frames, oversized_messages: oversizedMessages, other_source_frames: otherSourceFrames,
    refused_positions: refusedPositions, overflow_frames: overflowFrames, raw_messages_retained: false };
}
function failureFrameControls() {
  const approved = { file: "/fixed/source.ts", relative_file: "source.ts", sha256: "a".repeat(64), line_lengths: [2, 10] };
  let checked = 0;
  const check = (condition: boolean) => { assert.equal(condition, true); checked++; };
  const plain = projectFailureFrames(["    at /fixed/source.ts:1:3"], approved);
  check(plain.frames.length === 1 && plain.frames[0].column === 3 && plain.frames[0].source_sha256 === approved.sha256);
  check(projectFailureFrames([" at caseName (file:///fixed/source.ts:2:11)"], approved).frames.length === 1);
  check(projectFailureFrames([" at source.ts:1:1"], approved).frames.length === 1);
  check(projectFailureFrames([" at /other/source.ts:1:1"], approved).other_source_frames === 1);
  check(projectFailureFrames([" at /fixed/source.ts:0:1"], approved).refused_positions === 1);
  check(projectFailureFrames([" at /fixed/source.ts:3:1"], approved).refused_positions === 1);
  check(projectFailureFrames([" at /fixed/source.ts:1:4"], approved).refused_positions === 1);
  check(projectFailureFrames([" at /fixed/source.ts:1:9007199254740992"], approved).refused_positions === 1);
  check(projectFailureFrames(["fake message /fixed/source.ts:1:1"], approved).frames.length === 0);
  check(projectFailureFrames(["x".repeat(65_537)], approved).oversized_messages === 1);
  const overflow = projectFailureFrames([Array(17).fill(" at /fixed/source.ts:1:1").join("\n")], approved);
  check(overflow.frames.length === 16 && overflow.overflow_frames === 1);
  check(projectFailureFrames([" at /fixed/source.ts:1:no"], approved).frames.length === 0);
  check(projectFailureFrames([], approved).raw_messages_retained === false);
  return checked;
}
function qualify() {
  const applied = JSON.parse(
    readFileSync(reports + "applied-receipt.json", "utf8"),
  );
  assert.equal(applied.source_commit, source);
  assert.equal(applied.run_id, process.env.GITHUB_RUN_ID);
  assert.equal(applied.run_attempt, process.env.GITHUB_RUN_ATTEMPT);
  assert.deepEqual(pins(), applied.before_format);
  const format = [paths[0], paths[2], helper, workflow, manifestPath];
  const phases: {
    phase: string;
    exit_code: number | null;
    signal: string | null;
    process_error: boolean;
    elapsed_ms: number;
    stdout_bytes: number;
    stderr_bytes: number;
    ts_codes: string[];
    unhandled_failure_marker: boolean;
  }[] = [];
  const lint: {
    source_id: number;
    rule_id: string | null;
    severity: number;
    line: number | null;
    column: number | null;
  }[] = [];
  let lintSources: {
    source_id: number;
    sha256: string;
    bytes: number;
    line_lengths: number[];
  }[] = [];
  let cases: { case_id: number; status: string; failure_count: number }[] = [];
  const failureFrames: { case_id: number; projection: ReturnType<typeof projectFailureFrames> }[] = [];
  let failureFrameControlsPassed = 0;
  let category = "native_format";
  let status = "failed";
  let helperIncluded = false;
  function native(
    phase: string,
    executable: string,
    args: string[],
    timeout = 120_000,
  ) {
    category = phase;
    const start = Date.now();
    const result = spawnSync(executable, args, {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    const output = (result.stdout ?? "") + "\n" + (result.stderr ?? "");
    const unhandled =
      /Unhandled Errors|Vitest caught \d+ unhandled errors?|Source Errors|Unhandled Rejection|Uncaught Exception/i.test(
        output,
      );
    phases.push({
      phase,
      exit_code: result.status,
      signal: result.signal,
      process_error: result.error !== undefined,
      elapsed_ms: Date.now() - start,
      stdout_bytes: Buffer.byteLength(result.stdout ?? ""),
      stderr_bytes: Buffer.byteLength(result.stderr ?? ""),
      ts_codes: [...new Set(output.match(/\bTS\d+\b/g) ?? [])].slice(0, 32),
      unhandled_failure_marker: unhandled,
    });
    if (phase === "native_lint") {
      const items = JSON.parse(result.stdout) as {
        filePath: string;
        messages: {
          ruleId: string | null;
          severity: number;
          line?: number;
          column?: number;
        }[];
      }[];
      assert.ok(Array.isArray(items) && items.length === 3);
      for (const item of items) {
        const id = [paths[0], paths[2], helper].findIndex(
          (file) => path.resolve(file) === item.filePath,
        );
        assert.ok(
          id >= 0 &&
            Array.isArray(item.messages) &&
            item.messages.length <= 128,
        );
        const approved = lintSources[id];
        assert.equal(approved.source_id, id + 1);
        assert.equal(
          digest(readFileSync([paths[0], paths[2], helper][id])),
          approved.sha256,
        );
        for (const message of item.messages) {
          assert.ok(
            message.ruleId === null ||
              /^[A-Za-z0-9_@/-]{1,128}$/.test(message.ruleId),
          );
          assert.ok(message.severity === 1 || message.severity === 2);
          if (message.line === undefined || message.column === undefined) {
            assert.equal(message.line, undefined);
            assert.equal(message.column, undefined);
          } else {
            assert.ok(
              Number.isSafeInteger(message.line) &&
                message.line >= 1 &&
                message.line <= approved.line_lengths.length,
            );
            assert.ok(
              Number.isSafeInteger(message.column) &&
                message.column >= 1 &&
                message.column <= approved.line_lengths[message.line - 1] + 1,
            );
          }
          lint.push({
            source_id: id + 1,
            rule_id: message.ruleId,
            severity: message.severity,
            line: message.line ?? null,
            column: message.column ?? null,
          });
        }
      }
    }
    if (phase === "focused_causal_tests") {
      const report = JSON.parse(result.stdout.trim()) as TestReport;
      assert.ok(
        Array.isArray(report.testResults) && report.testResults.length === 1,
      );
      const file = report.testResults[0];
      assert.equal(file.name, path.resolve(paths[2]));
      assert.equal(file.message, "");
      assert.ok(
        Array.isArray(file.assertionResults) &&
          file.assertionResults.length === 4,
      );
      cases = file.assertionResults.map((row) => {
        const id = titles.indexOf(row.title);
        assert.ok(id >= 0);
        assert.deepEqual(row.ancestorTitles, ["pipeline POSIX pipe emission"]);
        assert.equal(row.fullName, "pipeline POSIX pipe emission " + row.title);
        assert.ok(
          ["passed", "failed", "pending", "skipped", "todo"].includes(
            row.status,
          ),
        );
        assert.ok(
          Array.isArray(row.failureMessages) &&
            row.failureMessages.length <= 16,
        );
        assert.ok(row.failureMessages.every((message) => typeof message === "string"));
        if (row.failureMessages.length) {
          const approved = lintSources[1];
          assert.equal(digest(readFileSync(paths[2])), approved.sha256);
          failureFrames.push({ case_id: id + 1, projection: projectFailureFrames(row.failureMessages,
            { file: path.resolve(paths[2]), relative_file: paths[2], sha256: approved.sha256, line_lengths: approved.line_lengths }) });
        }
        return {
          case_id: id + 1,
          status: row.status,
          failure_count: row.failureMessages.length,
        };
      });
      assert.deepEqual(cases.map((row) => row.case_id).sort(), [1, 2, 3, 4]);
      assert.equal(report.success, true);
      assert.equal(report.numTotalTests, 4);
      assert.equal(report.numPassedTests, 4);
      assert.equal(report.numFailedTests, 0);
      assert.equal(report.numPendingTests, 0);
      assert.equal(report.numTodoTests, 0);
      assert.ok(
        cases.every(
          (row) => row.status === "passed" && row.failure_count === 0,
        ),
      );
    }
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0);
    assert.equal(unhandled, false);
    return result.stdout;
  }
  try {
    failureFrameControlsPassed = failureFrameControls();
    assert.equal(failureFrameControlsPassed, 13);
    native("native_format", process.execPath, [
      "node_modules/prettier/bin/prettier.cjs",
      "--write",
      ...format,
    ]);
    native("native_format_check", process.execPath, [
      "node_modules/prettier/bin/prettier.cjs",
      "--check",
      ...format,
    ]);
    lintSources = [paths[0], paths[2], helper].map((file, index) => {
      const bytes = readFileSync(file);
      assert.ok(bytes.byteLength > 0 && bytes.byteLength < 131_072);
      return {
        source_id: index + 1,
        sha256: digest(bytes),
        bytes: bytes.byteLength,
        line_lengths: bytes
          .toString("utf8")
          .split(/\r\n|[\n\r\u2028\u2029]/u)
          .map((line) => line.length),
      };
    });
    native("native_lint", process.execPath, [
      "node_modules/eslint/bin/eslint.js",
      "--max-warnings=0",
      "--format=json",
      paths[0],
      paths[2],
      helper,
    ]);
    native("native_cold_types", "npm", [
      "run",
      "typecheck",
      "--",
      "--incremental",
      "false",
    ]);
    mkdirSync(reports, { recursive: true });
    writeFileSync(
      reports + "helper.tsconfig.json",
      JSON.stringify({
        extends: "../../tsconfig.json",
        compilerOptions: { incremental: false },
        include: ["../../" + helper],
      }),
    );
    const compiled = native("native_helper_types", process.execPath, [
      "node_modules/typescript/bin/tsc",
      "--noEmit",
      "--listFiles",
      "--project",
      reports + "helper.tsconfig.json",
    ]);
    helperIncluded = compiled.split(/\r?\n/).includes(path.resolve(helper));
    assert.equal(helperIncluded, true);
    native(
      "focused_causal_tests",
      process.execPath,
      ["node_modules/vitest/vitest.mjs", "run", paths[2], "--reporter=json"],
      180_000,
    );
    category = "source_semantics";
    assert.equal(digest(readFileSync(paths[1])), originalSha);
    const repaired = readFileSync(paths[0], "utf8");
    const original = readFileSync(paths[1], "utf8");
    const marker = "function checkCommands()";
    assert.ok(repaired.indexOf(marker) > 0 && original.indexOf(marker) > 0);
    assert.equal(
      repaired.slice(repaired.indexOf(marker)),
      original.slice(original.indexOf(marker)),
    );
    assert.deepEqual(JSON.parse(readFileSync(manifestPath, "utf8")), manifest);
    assert.equal(git("rev-parse", "HEAD"), source);
    assert.deepEqual(
      git("diff", "--name-only").split("\n").filter(Boolean).sort(),
      [paths[0], helper, workflow, manifestPath]
        .filter((file) => git("diff", "--name-only", "--", file) !== "")
        .sort(),
    );
    status = "native_source_and_causal_controls_passed_not_wrapper_acceptance";
    category = "none";
  } catch {
    process.exitCode = 1;
  } finally {
    receipt("qualification", {
      ...identity,
      status,
      category,
      native_phases: phases,
      lint_diagnostics: lint,
      focused_cases: cases,
      failure_frame_controls_passed: failureFrameControlsPassed,
      failure_frames: failureFrames,
      helper_type_input_confirmed: helperIncluded,
      lint_sources: lintSources.map((item) => ({
        source_id: item.source_id,
        sha256: item.sha256,
        bytes: item.bytes,
        line_count: item.line_lengths.length,
      })),
      actual_files: pins(),
      raw_test_report_retained: false,
      exact_wrapper_executed: false,
      real_project_pipeline_commands_executed_by_controls: false,
      production_acceptance: false,
    });
  }
}
if (
  process.argv.length !== 3 ||
  !["apply", "qualify"].includes(process.argv[2])
)
  throw new Error("Invalid fixed qualification mode");
if (process.argv[2] === "apply") apply();
else qualify();
