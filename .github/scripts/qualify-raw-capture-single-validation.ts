import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  copyFileSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

async function main() {
  interface RunReceipt {
    observed_test_summaries: {
      kind: string;
      tests?: number;
      passed?: number;
      failed?: number;
      skipped?: number;
    }[];
  }
  if (process.argv[2] === "selfcheck") {
    console.log(JSON.stringify(diagnosticControls()));
    return;
  }
  function focusedFailureClasses(material: string): string[] {
    const lines = material.split(/\r?\n/).map((line) => stripVTControlCharacters(line));
    const errors = lines.filter((line) => /^\s*(?:Error|TypeError|ReferenceError|RangeError|SyntaxError|CACError|MiniflareCoreError)(?:\s+\[[A-Z0-9_]+\])?:/.test(line));
    const rules: [string, RegExp][] = [
      ["file_missing", /\bENOENT\b/],
      ["module_missing", /\b(?:ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND)\b|cannot find (?:module|package)/i],
      ["cli_unknown_option", /^\s*CACError:\s*Unknown option\b/],
      ["type_error", /^\s*TypeError:/],
      ["syntax_error", /^\s*SyntaxError:/],
      ["runtime_startup", /\bERR_RUNTIME_FAILURE\b/],
    ];
    const classes = rules.filter(([, pattern]) => errors.some((line) => pattern.test(line))).map(([name]) => name);
    if (lines.some((line) => /^\s*failed to load config from\b/i.test(line))) classes.push("config_load");
    return classes;
  }

  function actualUnhandledLine(clean: string) {
    return (
      /^\s*(?:\((?:node|bun):\d+\)\s*)?(?:UnhandledPromiseRejection(?:Warning)?|Unhandled Rejection|Uncaught Exception)(?::|\s+(?:at|in)\b|\s*$)/i.test(
        clean,
      ) ||
      /^\s*(?:(?:✘|×)\s*)?(?:\[ERROR\]\s*)?Uncaught(?:\s+\(in promise\))?\s+(?:[A-Za-z]*Error|Exception):/i.test(
        clean,
      ) ||
      /^[\s\u23af-]*Unhandled (?:Errors?|Rejection|Exception)[\s\u23af-]*$/.test(
        clean,
      )
    );
  }
  function diagnosticObserver() {
    let vitestUnhandled = 0,
      unhandledBanner = false,
      actualUnhandled = false;
    const testSummaries: RunReceipt["observed_test_summaries"] = [];
    const unfinished = { stdout: "", stderr: "" };
    const observe = (line: string) => {
      const clean = stripVTControlCharacters(line);
      if (actualUnhandledLine(clean)) actualUnhandled = true;
      if (/^[\s\u23af-]*Unhandled Errors[\s\u23af-]*$/.test(clean))
        unhandledBanner = true;
      const summary = /^\s*Vitest caught ([1-9]\d*) unhandled errors?\b/.exec(
        clean,
      );
      if (unhandledBanner && summary)
        vitestUnhandled = Math.max(vitestUnhandled, integer(summary[1]));
      const unittest = /^\s*Ran (\d+) tests? in /.exec(clean);
      if (unittest && testSummaries.length < 8)
        testSummaries.push({
          kind: "unittest_observed",
          tests: integer(unittest[1]),
        });
      const vitest = /^\s*Tests\s+(.+)$/.exec(clean);
      if (vitest && testSummaries.length < 8) {
        const row: {
          kind: string;
          passed?: number;
          failed?: number;
          skipped?: number;
        } = { kind: "vitest_observed" };
        for (const metric of ["passed", "failed", "skipped"] as const) {
          const count = new RegExp("(\\d+) " + metric + "\\b").exec(vitest[1]);
          if (count) row[metric] = integer(count[1]);
        }
        if (Object.keys(row).length > 1) testSummaries.push(row);
      }
    };
    return {
      push(stream: "stdout" | "stderr", text: string) {
        const complete = (unfinished[stream] + text).split("\n");
        unfinished[stream] = complete.pop()!.slice(0, 8192);
        for (const line of complete) observe(line);
      },
      finish() {
        observe(unfinished.stdout);
        observe(unfinished.stderr);
        unfinished.stdout = "";
        unfinished.stderr = "";
        return { actualUnhandled, vitestUnhandled, testSummaries };
      },
    };
  }
  function diagnosticControls() {
    const positives = [
      "Unhandled Rejection: synthetic diagnostic\n",
      "\u001b]8;;https://example.invalid/fixture\u0007Unhandled Rejection: synthetic diagnostic\u001b]8;;\u0007\n",
      "Uncaught Exception: synthetic diagnostic\n",
      "(node:123) UnhandledPromiseRejectionWarning: synthetic diagnostic\n",
      "Uncaught Error: synthetic diagnostic\n",
      "✘ [ERROR] Uncaught (in promise) TypeError: synthetic diagnostic\n",
      "\u001b[31m⎯⎯⎯ Unhandled Errors ⎯⎯⎯\u001b[39m\nVitest caught 2 unhandled errors during the test run.\n",
    ];
    const negatives = [
      ' ✓ refuses "Unhandled Rejection" inputs\n',
      '\u001b]8;;https://example.invalid/fixture\u0007 ✓ handles "Uncaught Exception" fixture text\u001b]8;;\u0007\n',
      ' ✓ handles "Uncaught Exception" fixture text\n',
      ' ✓ recognizes "⎯⎯⎯ Unhandled Errors ⎯⎯⎯"\n',
      'stdout | test.ts > named "Unhandled Rejection"\n',
      '"Unhandled Rejection: quoted fixture"\n',
      "normal diagnostic mentions Uncaught Exception as data\n",
      "Tests 12 passed (12)\n",
    ];
    for (const input of positives) {
      for (const cut of [
        0,
        1,
        Math.floor(input.length / 2),
        input.length - 1,
      ]) {
        const observer = diagnosticObserver();
        observer.push("stderr", input.slice(0, cut));
        observer.push("stderr", input.slice(cut).trimEnd());
        observer.push("stdout", "later benign text\n");
        assert.equal(observer.finish().actualUnhandled, true);
      }
    }
    for (const input of negatives) {
      const observer = diagnosticObserver();
      observer.push("stdout", input);
      assert.equal(observer.finish().actualUnhandled, false);
    }
    const counter = diagnosticObserver();
    counter.push(
      "stderr",
      "⎯ Unhandled Errors ⎯\nVitest caught 3 unhandled errors during the test run.",
    );
    const actual = counter.finish();
    assert.equal(actual.actualUnhandled, true);
    assert.equal(actual.vitestUnhandled, 3);
    const sticky = diagnosticObserver();
    sticky.push("stderr", positives[0]);
    sticky.push("stdout", "Tests 99 passed (99)\nall later output is benign\n");
    assert.equal(sticky.finish().actualUnhandled, true);
    const focusedControls: [string, string[]][] = [
      ["Error: ENOENT: synthetic secret", ["file_missing"]],
      ["Error [ERR_MODULE_NOT_FOUND]: synthetic secret", ["module_missing"]],
      ["CACError: Unknown option synthetic-secret", ["cli_unknown_option"]],
      ["failed to load config from synthetic-secret", ["config_load"]],
      ['"Error: ENOENT quoted fixture"', []],
      [' ✓ handles "Error: ENOENT" fixture', []],
      ["stdout | case > TypeError: fixture", []],
    ];
    for (const [input, expected] of focusedControls) {
      const projected = focusedFailureClasses(input);
      assert.deepEqual(projected, expected);
      assert.equal(JSON.stringify(projected).includes("synthetic"), false);
    }
    return {
      diagnostic_controls_passed: positives.length * 4 + negatives.length + 2,
      focused_failure_controls_passed: focusedControls.length,
      raw_output_retained: false,
    };
  }

  function integer(value: string): number {
    assert.match(value, /^\d+$/);
    const result = Number(value);
    assert.ok(Number.isSafeInteger(result));
    return result;
  }
  const fixture = ".github/fixtures/raw-capture-single-validation/";
  const scratch = "tmp/raw-capture-single-validation";
  const digest = (value: Uint8Array) =>
    createHash("sha256").update(value).digest("hex");
  const read = (file: string, maximum = 131_072) => {
    const size = statSync(file).size;
    assert.ok(size > 0 && size <= maximum);
    return readFileSync(file);
  };
  const json = (file: string, maximum = 131_072): unknown =>
    JSON.parse(read(file, maximum).toString("utf8"));
  const manifestBytes = read(fixture + "manifest.json");
  assert.equal(digest(manifestBytes), process.env.COMPARISON_MANIFEST_SHA256);
  interface File {
    path: string;
    bytes: number;
    sha256: string;
  }
  interface Variant {
    id: string;
    single_validation: boolean;
    number_layer: boolean;
    overrides: Record<string, File>;
  }
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as {
    base_commit: string;
    q8_files: File[];
    variants: Variant[];
    frozen_focused_tests: string[];
    frozen_focused_case_count: number;
    numeric_tests: File;
    v3_alias_tests: File;
    helper_pins: File[];
  };
  assert.deepEqual(
    manifest.helper_pins.map((item) => item.path),
    [
      ".github/scripts/apply-raw-capture-single-validation.ts",
      ".github/scripts/qualify-raw-capture-single-validation.ts",
      ".github/vitest.raw-single-validation.config.ts",
    ],
  );
  for (const item of manifest.helper_pins) {
    const actual = read(item.path, 131_072);
    assert.equal(actual.length, item.bytes);
    assert.equal(digest(actual), item.sha256);
  }
  assert.equal(manifest.helper_pins.length, 3);
  assert.equal(manifest.frozen_focused_case_count, 338);
  assert.equal(manifest.frozen_focused_tests.length, 11);
  const ids = ["q8", "q8-number", "v3", "v3-number"];
  assert.deepEqual(
    manifest.variants.map((item) => item.id),
    ids,
  );
  const phase = process.env.COMPARISON_PHASE;
  assert.ok(phase === "format" || phase === "qualify");
  const mode = process.argv[2];
  const helperFiles = [
    ".github/scripts/apply-raw-capture-single-validation.ts",
    ".github/scripts/qualify-raw-capture-single-validation.ts",
    ".github/vitest.raw-single-validation.config.ts",
    ".github/workflows/raw-capture-single-validation.yml",
    fixture + "manifest.json",
  ];
  const pins = (files: string[]) =>
    files.map((file) => {
      const data = read(file, 256 * 1024);
      return { path: file, bytes: data.length, sha256: digest(data) };
    });
  function readFocusedReport(file: string): unknown {
    const maximum = 1024 * 1024;
    const descriptor = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const info = fstatSync(descriptor);
      assert.ok(info.isFile() && info.size > 0 && info.size <= maximum);
      const bytes = Buffer.alloc(maximum + 1);
      let length = 0;
      while (length < bytes.length) {
        const count = readSync(descriptor, bytes, length, bytes.length - length, length);
        if (count === 0) break;
        length += count;
      }
      assert.ok(length > 0 && length <= maximum);
      return JSON.parse(bytes.subarray(0, length).toString("utf8")) as unknown;
    } finally {
      closeSync(descriptor);
    }
  }
  let focusedFailure: unknown = null;
  function focusedFailureReceipt(stdout: string, stderr: string) {
    let material = (stdout.slice(0, 8192) + "\n" + stderr.slice(0, 8192)).slice(0, 16384);
    let reportState = "absent_or_unreadable";
    const counts: Record<string, number> = {};
    try {
      const file = path.join(scratch, "vitest.json");
      const size = statSync(file);
      if (!size.isFile() || size.size <= 0 || size.size > 1024 * 1024) {
        reportState = "refused_size_or_type";
      } else {
        const value: unknown = readFocusedReport(file);
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          reportState = "refused_shape";
        } else {
          const report = value as Record<string, unknown>;
          reportState = "parsed";
          for (const name of ["numFailedTests", "numPassedTests", "numPendingTests", "numTodoTests", "numTotalTests"]) {
            const count = report[name];
            if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0 && count <= 1000000) counts[name] = count;
          }
          if (Array.isArray(report.testResults) && report.testResults.length <= 13) {
            for (const item of report.testResults) {
              if (item && typeof item === "object" && "message" in item && typeof item.message === "string") material += ("\n" + item.message).slice(0, 16384 - material.length);
            }
          }
        }
      }
    } catch {
      reportState = "absent_unreadable_or_malformed";
    }
    const lines = material.split(/\r?\n/).map((line) => stripVTControlCharacters(line));
    const classes = focusedFailureClasses(material);
    const frameFile = "tests/raw-capture-retry-d1.test.ts";
    const frameSha = "ff16bb920270693f0a686fa9f79bc10a6a5b495640cf50ffe436ecb3cd75f906";
    const frames: { file: string; sha256: string; line: number; column: number }[] = [];
    let sourceHashVerified = false;
    try {
      const source = read(frameFile, 256 * 1024);
      sourceHashVerified = digest(source) === frameSha;
      if (sourceHashVerified) {
        const sourceLines = source.toString("utf8").split("\n");
        for (const match of lines.join("\n").matchAll(/(?:file:\/\/)?[^\s()]*tests\/raw-capture-retry-d1\.test\.ts:(\d+):(\d+)/g)) {
          const location = match[0].slice(0, -(":" + match[1] + ":" + match[2]).length).replace(/^file:\/\//, "");
          const line = Number(match[1]), column = Number(match[2]);
          if (![frameFile, path.resolve(frameFile)].includes(location) || !Number.isSafeInteger(line) || line <= 0 || line > sourceLines.length || !Number.isSafeInteger(column) || column <= 0 || column > sourceLines[line - 1].length + 1) continue;
          if (!frames.some((item) => item.line === line && item.column === column)) frames.push({ file: frameFile, sha256: frameSha, line, column });
          if (frames.length === 8) break;
        }
      }
    } catch {
      sourceHashVerified = false;
    }
    return { report_state: reportState, counts, classes, frames, source_hash_verified: sourceHashVerified, raw_output_retained: false };
  }
  const nativeReceipts: {
    step: string;
    exit_code: number | null;
    signal: string | null;
    actual_unhandled_diagnostic: boolean;
    vitest_unhandled_errors: number;
    output_bytes: number;
  }[] = [];
  const native = (
    step: string,
    command: string,
    args: string[],
    allowNonzero = false,
  ) => {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: 600_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        FORCE_COLOR: "0",
        WRANGLER_SEND_METRICS: "false",
        WRANGLER_WRITE_LOGS: "false",
        RAW_CAPTURE_QUALIFY_DIAGNOSTICS: "1",
      },
    });
    const observer = diagnosticObserver();
    observer.push("stdout", result.stdout ?? "");
    observer.push("stderr", result.stderr ?? "");
    const observed = observer.finish();
    if (step === "focused_tests" && result.status !== 0) focusedFailure = focusedFailureReceipt(result.stdout ?? "", result.stderr ?? "");
    nativeReceipts.push({
      step,
      exit_code: result.status,
      signal: result.signal,
      actual_unhandled_diagnostic: observed.actualUnhandled,
      vitest_unhandled_errors: observed.vitestUnhandled,
      output_bytes:
        Buffer.byteLength(result.stdout ?? "") +
        Buffer.byteLength(result.stderr ?? ""),
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(observed.actualUnhandled, false);
    assert.equal(observed.vitestUnhandled, 0);
    if (!allowNonzero) assert.equal(result.status, 0);
    return { status: result.status, stdout: result.stdout ?? "" };
  };
  if (mode === "compare") {
    assert.equal(phase, "qualify");
    const directory = path.join(scratch, "downloaded");
    const prefix =
      "raw-capture-single-qualify-" + process.env.GITHUB_RUN_ATTEMPT + "-";
    assert.deepEqual(
      readdirSync(directory).sort(),
      ids.map((id) => prefix + id).sort(),
    );
    let original: unknown;
    for (const id of ids) {
      const receipt = json(
        path.join(directory, prefix + id, "comparison-receipt.json"),
      ) as {
        variant: string;
        phase: string;
        source_head: string;
        run_id: string;
        run_attempt: string;
        manifest_sha256: string;
        actual_manifest_sha256: string;
        status: string;
        files: File[];
        files_before: File[];
        helpers: File[];
        helpers_before: File[];
        frozen_cases: number;
        boundary_exit_code: number;
        observer_controls_passed: number;
        helper_inputs_confirmed: number;
        passed_cases: number;
        test_files: number;
        coverage: {
          path: string;
          metrics: Record<string, { total: number; covered: number }>;
        }[];
        native_steps: typeof nativeReceipts;
      };
      assert.equal(receipt.variant, id);
      assert.equal(receipt.phase, phase);
      assert.equal(receipt.source_head, process.env.GITHUB_SHA);
      assert.equal(receipt.run_id, process.env.GITHUB_RUN_ID);
      assert.equal(String(receipt.run_attempt), process.env.GITHUB_RUN_ATTEMPT);
      assert.equal(receipt.manifest_sha256, digest(manifestBytes));
      assert.equal(receipt.actual_manifest_sha256, digest(manifestBytes));
      assert.equal(receipt.frozen_cases, 338);
      assert.equal(receipt.observer_controls_passed, 38);
      assert.equal(receipt.helper_inputs_confirmed, 3);
      const variant = manifest.variants.find((item) => item.id === id)!;
      assert.equal(receipt.passed_cases, variant.single_validation ? 341 : 339);
      assert.equal(receipt.test_files, variant.single_validation ? 13 : 12);
      assert.deepEqual(
        receipt.coverage.map((item) => item.path),
        manifest.q8_files
          .filter((item) => item.path.startsWith("src/"))
          .map((item) => item.path),
      );
      for (const item of receipt.coverage) {
        assert.deepEqual(Object.keys(item.metrics).sort(), [
          "branches",
          "functions",
          "lines",
          "statements",
        ]);
        for (const metric of Object.values(item.metrics)) {
          assert.ok(Number.isSafeInteger(metric.total) && metric.total > 0);
          assert.equal(metric.covered, metric.total);
        }
      }
      assert.equal(
        receipt.status,
        variant.number_layer
          ? "focused_passed_full_pending"
          : "comparison_control_boundary_nonzero_unattributed",
      );
      assert.ok(
        variant.number_layer
          ? receipt.boundary_exit_code === 0
          : Number.isSafeInteger(receipt.boundary_exit_code) &&
              receipt.boundary_exit_code !== 0,
      );
      const expected = [
        ...manifest.q8_files.map((item) => ({
          ...item,
          ...(variant.overrides[item.path] ?? {}),
        })),
        manifest.numeric_tests,
        ...(variant.single_validation ? [manifest.v3_alias_tests] : []),
      ].map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }));
      assert.deepEqual(receipt.files, expected);
      assert.deepEqual(receipt.files_before, expected);
      assert.deepEqual(receipt.helpers, pins(helperFiles));
      assert.deepEqual(receipt.helpers_before, pins(helperFiles));
      const appliedReceipt = json(
        path.join(directory, prefix + id, "applied-receipt.json"),
      ) as {
        variant: string;
        source_head: string;
        manifest_sha256: string;
        run_id: string;
        run_attempt: string;
        files: File[];
      };
      assert.equal(appliedReceipt.variant, id);
      assert.equal(appliedReceipt.source_head, process.env.GITHUB_SHA);
      assert.equal(appliedReceipt.manifest_sha256, digest(manifestBytes));
      assert.equal(appliedReceipt.run_id, process.env.GITHUB_RUN_ID);
      assert.equal(
        String(appliedReceipt.run_attempt),
        process.env.GITHUB_RUN_ATTEMPT,
      );
      assert.deepEqual(appliedReceipt.files, expected);
      assert.deepEqual(
        receipt.native_steps.map((item) => item.step),
        [
          "format",
          "lint",
          "helper_types",
          "observer_controls",
          "workflow_policy",
          "cold_types",
          "build",
          "focused_tests",
          "startup_budget",
          "worker_dry_run",
          "worker_bundle_budget",
          "boundary_policy",
        ],
      );
      assert.equal(
        receipt.native_steps.at(-1)!.exit_code,
        receipt.boundary_exit_code,
      );
      for (const item of receipt.native_steps) {
        assert.equal(item.signal, null);
        assert.equal(item.actual_unhandled_diagnostic, false);
        assert.equal(item.vitest_unhandled_errors, 0);
        assert.ok(
          Number.isSafeInteger(item.output_bytes) &&
            item.output_bytes >= 0 &&
            item.output_bytes <= 64 * 1024 * 1024,
        );
        if (item.step === "boundary_policy" && !variant.number_layer)
          assert.ok(
            Number.isSafeInteger(item.exit_code) && item.exit_code !== 0,
          );
        else assert.equal(item.exit_code, 0);
      }
      for (const item of [...receipt.files, ...receipt.helpers]) {
        const actual = read(
          path.join(directory, prefix + id, "source", item.path),
          256 * 1024,
        );
        assert.equal(actual.length, item.bytes);
        assert.equal(digest(actual), item.sha256);
      }
      const oracleBytes = read(
        path.join(directory, prefix + id, "numeric-oracle.json"),
        65_536,
      );
      const oracle = JSON.parse(oracleBytes.toString("utf8")) as {
        version: number;
        cases: unknown[];
      };
      assert.equal(oracle.version, 1);
      assert.equal(oracle.cases.length, 18);
      if (original === undefined) original = oracle;
      else assert.deepEqual(oracle, original);
    }
    const output = path.join(scratch, "upload/proof");
    mkdirSync(output, { recursive: true });
    const proof = {
      status: "compatibility_equal_full_and_resource_pending",
      run_id: process.env.GITHUB_RUN_ID,
      run_attempt: process.env.GITHUB_RUN_ATTEMPT,
      source_head: process.env.GITHUB_SHA,
      manifest_sha256: digest(manifestBytes),
      variants: ids,
      frozen_cases_each: 338,
      exact_synthetic_gzip_oracles_each: 18,
      codecov_verdict: "unavailable",
      resource_result: "separate_gate_not_run",
      production_actions: false,
      raw_output_retained: false,
    };
    writeFileSync(
      path.join(output, "comparison-proof.json"),
      JSON.stringify(proof, null, 2) + "\n",
    );
    console.log(JSON.stringify(proof));
    return;
  }
  assert.equal(mode, "run");
  const variant = manifest.variants.find((item) => item.id === process.argv[3]);
  assert.ok(variant);
  const applied = json(path.join(scratch, "applied.json")) as {
    variant: string;
    source_head: string;
    manifest_sha256: string;
    run_id: string;
    run_attempt: string;
    files: File[];
  };
  assert.equal(applied.variant, variant.id);
  assert.equal(applied.source_head, process.env.GITHUB_SHA);
  assert.equal(applied.manifest_sha256, digest(manifestBytes));
  assert.equal(applied.run_id, process.env.GITHUB_RUN_ID);
  assert.equal(String(applied.run_attempt), process.env.GITHUB_RUN_ATTEMPT);
  const sourceFiles = applied.files.map((item) => item.path);
  const helperPinsBefore = pins(helperFiles);
  assert.deepEqual(pins(sourceFiles), applied.files);
  const output = path.join(scratch, "upload", variant.id);
  mkdirSync(output, { recursive: true });
  let stage = "format",
    status = "failed",
    frozenCases = 0,
    boundaryExit: number | null = null;
  let coverage: unknown = null,
    observerControlsPassed = 0,
    helperInputsConfirmed = 0,
    passedCases = 0,
    testFiles = 0;
  try {
    const formatting = [...sourceFiles, ...helperFiles];
    native("format", "npx", [
      "prettier",
      phase === "format" ? "--write" : "--check",
      ...formatting,
    ]);
    if (phase === "format") {
      assert.deepEqual(json(fixture + "manifest.json"), manifest);
      const currentManifestHash = digest(read(fixture + "manifest.json"));
      const file = helperFiles[3];
      const workflow = read(file).toString("utf8");
      const needle = "COMPARISON_MANIFEST_SHA256: " + digest(manifestBytes);
      assert.equal(workflow.split(needle).length, 2);
      writeFileSync(
        file,
        workflow.replace(
          needle,
          "COMPARISON_MANIFEST_SHA256: " + currentManifestHash,
        ),
      );
      native("workflow_reformat", "npx", ["prettier", "--write", file]);
    }
    for (const original of manifest.q8_files.filter(
      (item) => !variant.overrides[item.path],
    )) {
      const actual = read(original.path, 256 * 1024);
      assert.equal(actual.length, original.bytes);
      assert.equal(digest(actual), original.sha256);
    }
    stage = "lint";
    native("lint", "npx", [
      "eslint",
      "--max-warnings=0",
      ...sourceFiles,
      ...helperFiles.filter((item) => item.endsWith(".ts")),
    ]);
    stage = "helper_types";
    const tsconfig = path.join(scratch, "helpers.tsconfig.json");
    writeFileSync(
      tsconfig,
      JSON.stringify({
        extends: "../../tsconfig.json",
        compilerOptions: { incremental: false },
        include: helperFiles
          .filter((item) => item.endsWith(".ts"))
          .map((item) => "../../" + item),
      }),
    );
    const listed = native("helper_types", "npx", [
      "tsc",
      "--noEmit",
      "--listFiles",
      "--project",
      tsconfig,
    ])
      .stdout.split(/\r?\n/)
      .map((item) => item.trim());
    helperInputsConfirmed = helperFiles
      .filter((item) => item.endsWith(".ts"))
      .filter((item) => listed.includes(path.resolve(item))).length;
    assert.equal(helperInputsConfirmed, 3);
    stage = "observer_controls";
    const controls = JSON.parse(
      native("observer_controls", process.execPath, [
        helperFiles[1],
        "selfcheck",
      ]).stdout.trim(),
    ) as { diagnostic_controls_passed: number; focused_failure_controls_passed: number };
    assert.equal(controls.diagnostic_controls_passed, 38);
    assert.equal(controls.focused_failure_controls_passed, 7);
    observerControlsPassed = controls.diagnostic_controls_passed;
    stage = "workflow_policy";
    native("workflow_policy", "npm", ["run", "validate:workflows"]);
    if (phase === "format") {
      status = "native_format_readback_only_comparison_not_run";
    } else {
      assert.deepEqual(pins(sourceFiles), applied.files);
      assert.deepEqual(pins(helperFiles), helperPinsBefore);
      stage = "cold_types";
      native("cold_types", "npm", [
        "run",
        "typecheck",
        "--",
        "--incremental",
        "false",
      ]);
      stage = "build";
      native("build", "npm", ["run", "build"]);
      stage = "focused_tests";
      mkdirSync("raw-capture-retry-reports", { recursive: true });
      const reportPath = path.join(scratch, "vitest.json");
      const tests = [
        ...manifest.frozen_focused_tests,
        manifest.numeric_tests.path,
        ...(variant.single_validation ? [manifest.v3_alias_tests.path] : []),
      ];
      native("focused_tests", process.execPath, [
        "node_modules/vitest/vitest.mjs",
        "run",
        ...tests,
        "--retry=0",
        "--config",
        ".github/vitest.raw-single-validation.config.ts",
        "--coverage",
        "--reporter=json",
        "--outputFile=" + reportPath,
      ]);
      stage = "focused_report";
      const report = json(reportPath, 32 * 1024 * 1024) as {
        numFailedTests: number;
        numPassedTests: number;
        testResults: {
          name: string;
          message: string;
          assertionResults: { status: string; failureMessages: string[] }[];
        }[];
      };
      assert.equal(report.numFailedTests, 0);
      assert.equal(
        report.numPassedTests,
        339 + (variant.single_validation ? 2 : 0),
      );
      assert.equal(report.testResults.length, tests.length);
      for (const test of tests)
        assert.equal(
          report.testResults.filter((item) => item.name.endsWith("/" + test))
            .length,
          1,
        );
      for (const file of report.testResults) {
        assert.equal(file.message, "");
        assert.ok(
          file.assertionResults.every(
            (item) =>
              item.status === "passed" && item.failureMessages.length === 0,
          ),
        );
      }
      for (const test of manifest.frozen_focused_tests) {
        const selected = report.testResults.filter((item) =>
          item.name.endsWith("/" + test),
        );
        assert.equal(selected.length, 1);
        frozenCases += selected[0].assertionResults.length;
      }
      assert.equal(frozenCases, 338);
      passedCases = report.numPassedTests;
      testFiles = report.testResults.length;
      stage = "focused_coverage";
      const rawCoverage = json(
        "coverage/coverage-summary.json",
        32 * 1024 * 1024,
      ) as Record<string, Record<string, { total: number; covered: number }>>;
      coverage = manifest.q8_files
        .filter((item) => item.path.startsWith("src/"))
        .map((item) => {
          const selected = Object.entries(rawCoverage).filter(([name]) =>
            name.endsWith("/" + item.path),
          );
          assert.equal(selected.length, 1);
          const metrics = Object.fromEntries(
            ["lines", "branches", "functions", "statements"].map((metric) => {
              const value = selected[0][1][metric];
              assert.ok(Number.isSafeInteger(value.total) && value.total > 0);
              assert.equal(value.covered, value.total);
              return [metric, { total: value.total, covered: value.covered }];
            }),
          );
          return { path: item.path, metrics };
        });
      stage = "bundle_budgets";
      native("startup_budget", "npm", ["run", "validate:startup-budget"]);
      native("worker_dry_run", "npm", ["run", "worker:deploy:dry-run"]);
      native("worker_bundle_budget", "npm", ["run", "worker:bundle:budget"]);
      stage = "boundary_policy";
      boundaryExit = native(
        "boundary_policy",
        "npm",
        ["run", "validate:boundary-casts"],
        !variant.number_layer,
      ).status;
      assert.ok(
        variant.number_layer
          ? boundaryExit === 0
          : Number.isSafeInteger(boundaryExit) && boundaryExit !== 0,
      );
      assert.deepEqual(pins(sourceFiles), applied.files);
      assert.deepEqual(pins(helperFiles), helperPinsBefore);
      read(path.join(scratch, "numeric-oracle.json"), 65_536);
      status = variant.number_layer
        ? "focused_passed_full_pending"
        : "comparison_control_boundary_nonzero_unattributed";
    }
    stage = "complete";
  } finally {
    const retained = [...sourceFiles, ...helperFiles];
    let retainedBytes = 0;
    for (const file of retained) {
      const data = read(file, 256 * 1024);
      retainedBytes += data.length;
      assert.ok(retainedBytes <= 1024 * 1024);
      const target = path.join(output, "source", file);
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(file, target);
    }
    read(path.join(scratch, "applied.json"));
    copyFileSync(
      path.join(scratch, "applied.json"),
      path.join(output, "applied-receipt.json"),
    );
    if (phase === "qualify" && status !== "failed")
      copyFileSync(
        path.join(scratch, "numeric-oracle.json"),
        path.join(output, "numeric-oracle.json"),
      );
    const receipt = {
      status,
      phase,
      stage,
      variant: variant.id,
      source_head: process.env.GITHUB_SHA,
      run_id: process.env.GITHUB_RUN_ID,
      run_attempt: process.env.GITHUB_RUN_ATTEMPT,
      manifest_sha256: digest(manifestBytes),
      actual_manifest_sha256: digest(read(fixture + "manifest.json")),
      files: pins(sourceFiles),
      files_before: applied.files,
      helpers: pins(helperFiles),
      helpers_before: helperPinsBefore,
      frozen_cases: frozenCases,
      boundary_exit_code: boundaryExit,
      observer_controls_passed: observerControlsPassed,
      helper_inputs_confirmed: helperInputsConfirmed,
      passed_cases: passedCases,
      test_files: testFiles,
      coverage,
      focused_failure_summary: focusedFailure,
      native_steps: nativeReceipts,
      retained_public_bytes: retainedBytes,
      full_gates: "pending",
      resource_result: "separate_gate_not_run",
      raw_output_retained: false,
      production_actions: false,
    };
    const encoded = JSON.stringify(receipt, null, 2) + "\n";
    assert.ok(Buffer.byteLength(encoded) <= 131_072);
    writeFileSync(path.join(output, "comparison-receipt.json"), encoded);
    console.log(
      JSON.stringify({
        status,
        phase,
        stage,
        variant: variant.id,
        frozen_cases: frozenCases,
      }),
    );
  }
}

await main().catch(() => {
  console.error(
    JSON.stringify({
      status: "failed",
      phase: "bounded_comparison_contract",
      raw_output_retained: false,
    }),
  );
  process.exitCode = 1;
});
