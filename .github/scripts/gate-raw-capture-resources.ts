import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
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
    return {
      diagnostic_controls_passed: positives.length * 4 + negatives.length + 2,
      raw_output_retained: false,
    };
  }

  function integer(value: string): number {
    assert.match(value, /^\d+$/);
    const result = Number(value);
    assert.ok(Number.isSafeInteger(result));
    return result;
  }
  const fixture = ".github/fixtures/raw-capture-number-candidates/";
  const manifestPath = fixture + "manifest.json";
  const base = "0a65fcffd51b0a6a2b9757905be02c1d8b859e6c";
  const variants = ["q8-number", "v3-number"];
  const runtimeFiles = [
    "src/raw-capture-d1.ts",
    "src/raw-chain-capture.ts",
    "src/raw-capture-retry-intent.ts",
    "src/raw-capture-retry-store.ts",
  ];
  const helperFiles = [
    ".github/scripts/qualify-raw-capture-resources.ts",
    ".github/fixtures/raw-capture-resource-worker.ts",
    ".github/scripts/gate-raw-capture-resources.ts",
    ".github/tsconfig.raw-capture-resources.json",
  ];
  const workflowPath =
    ".github/workflows/raw-capture-resource-qualification.yml";
  const carrierFiles = [
    ...helperFiles,
    workflowPath,
    manifestPath,
    ...variants.flatMap((id) =>
      runtimeFiles.map((file) => fixture + id + "/" + file),
    ),
  ].sort();
  const runtimeInputs = [
    "src",
    "workers",
    "schemas-src",
    "schemas",
    "generated",
    "db",
    "migrations",
    "package.json",
    "package-lock.json",
    "wrangler.jsonc",
    "wrangler.data.jsonc",
    "scripts/build-api-worker.ts",
    "scripts/lib.ts",
  ];
  const digest = (bytes: Uint8Array) =>
    createHash("sha256").update(bytes).digest("hex");
  const blob = (bytes: Uint8Array) =>
    createHash("sha1")
      .update("blob " + bytes.length + "\0")
      .update(bytes)
      .digest("hex");
  const read = (file: string, limit = 131072) => {
    const info = lstatSync(file);
    assert.ok(
      info.isFile() &&
        !info.isSymbolicLink() &&
        info.size > 0 &&
        info.size <= limit,
    );
    return readFileSync(file);
  };
  const git = (args: string[], limit = 2097152) =>
    execFileSync("git", args, {
      maxBuffer: limit,
      stdio: ["ignore", "pipe", "pipe"],
    });
  const lines = (bytes: Uint8Array) =>
    Buffer.from(bytes)
      .toString("utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .sort();
  interface Pin {
    path: string;
    bytes: number;
    sha256: string;
    blob: string;
  }
  interface RuntimePin {
    blob: string | null;
    sha256: string | null;
  }
  interface NativeQualification {
    runId: number | null;
    runAttempt: number | null;
    sourceCommit: string | null;
    artifactId: number | null;
    zipSha256: string | null;
    comparisonProofSha256: string | null;
  }
  interface Manifest {
    status: string;
    base: string;
    files: string[];
    variants: Record<
      string,
      {
        nativeQualification: NativeQualification;
        files: Record<string, RuntimePin>;
      }
    >;
    resource_gate: {
      helper_pins: Pin[];
      native_format_readback: {
        runId: number;
        runAttempt: number;
        sourceCommit: string;
        artifactIds: number[];
        zipSha256: string[];
        readbackProofSha256: string;
        formattedHelperPins: Pin[];
      } | null;
    };
  }
  const manifestBytes = read(manifestPath, 65536);
  const manifestHash = digest(manifestBytes);
  assert.equal(manifestHash, process.env.RESOURCE_CANDIDATE_MANIFEST_SHA256);
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as Manifest;
  // Format-only readback is deliberately insufficient to resolve candidate pins.
  assert.equal(manifest.status, "artifact_verified_native_compatibility_pins");
  assert.equal(manifest.base, base);
  assert.deepEqual(manifest.files, runtimeFiles);
  assert.deepEqual(Object.keys(manifest.variants), variants);
  for (const id of variants) {
    const candidate = manifest.variants[id];
    assert.deepEqual(Object.keys(candidate.files), runtimeFiles);
    for (const file of runtimeFiles) {
      assert.match(String(candidate.files[file].blob), /^[a-f0-9]{40}$/);
      assert.match(String(candidate.files[file].sha256), /^[a-f0-9]{64}$/);
    }
    for (const key of ["runId", "runAttempt", "artifactId"] as const)
      assert.ok(
        Number.isSafeInteger(candidate.nativeQualification[key]) &&
          Number(candidate.nativeQualification[key]) > 0,
      );
    assert.match(
      String(candidate.nativeQualification.sourceCommit),
      /^[a-f0-9]{40}$/,
    );
    for (const key of ["zipSha256", "comparisonProofSha256"] as const)
      assert.match(
        String(candidate.nativeQualification[key]),
        /^[a-f0-9]{64}$/,
      );
  }
  const left = manifest.variants[variants[0]],
    right = manifest.variants[variants[1]];
  for (const key of [
    "runId",
    "runAttempt",
    "sourceCommit",
    "comparisonProofSha256",
  ] as const)
    assert.equal(left.nativeQualification[key], right.nativeQualification[key]);
  assert.notEqual(
    left.nativeQualification.artifactId,
    right.nativeQualification.artifactId,
  );
  for (const file of runtimeFiles.slice(0, 2))
    assert.deepEqual(left.files[file], right.files[file]);
  const phase = process.env.RESOURCE_GATE_PHASE;
  assert.ok(phase === "format" || phase === "qualify");
  const mode = process.argv[2],
    scenario = process.argv[3],
    variant = process.argv[4];
  assert.ok(mode === "check-source" || mode === "run");
  assert.ok(variants.includes(variant));
  assert.ok(
    phase === "format"
      ? scenario === "format-only"
      : ["fresh-compressible", "retry-high-entropy"].includes(scenario),
  );
  assert.equal(
    process.env.GITHUB_REF,
    "refs/heads/ci/raw-capture-number-resource-20261020",
  );
  assert.match(String(process.env.GITHUB_SHA), /^[a-f0-9]{40}$/);
  for (const key of ["GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT"])
    assert.match(String(process.env[key]), /^[1-9][0-9]*$/);
  assert.equal(
    git(["rev-parse", "HEAD"]).toString("utf8").trim(),
    process.env.GITHUB_SHA,
  );
  git(["merge-base", "--is-ancestor", base, "HEAD"]);
  assert.deepEqual(
    lines(git(["diff", "--name-only", base, "HEAD"])),
    carrierFiles,
  );
  assert.equal(carrierFiles.length, 14);
  assert.equal(
    git(["diff", "--name-only", "HEAD"]).length,
    0,
    "tracked checkout must be clean before native formatting",
  );
  assert.equal(git(["diff", "--cached", "--name-only"]).length, 0);
  git(["diff", "--exit-code", base, "HEAD", "--", ...runtimeInputs]);
  const canonicalManifest = digest(
    git(["ls-tree", "-r", base, "--", ...runtimeInputs]),
  );
  assert.equal(
    digest(git(["ls-tree", "-r", "HEAD", "--", ...runtimeInputs])),
    canonicalManifest,
  );
  const pins = (files: string[]): Pin[] =>
    files.map((file) => {
      const bytes = read(file);
      return {
        path: file,
        bytes: bytes.length,
        sha256: digest(bytes),
        blob: blob(bytes),
      };
    });
  const helperPinsBefore = pins(helperFiles);
  assert.deepEqual(manifest.resource_gate.helper_pins, helperPinsBefore);
  if (phase === "qualify") {
    const formatted = manifest.resource_gate.native_format_readback;
    assert.ok(formatted);
    for (const key of ["runId", "runAttempt"] as const)
      assert.ok(Number.isSafeInteger(formatted[key]) && formatted[key] > 0);
    assert.match(formatted.sourceCommit, /^[a-f0-9]{40}$/);
    assert.equal(formatted.artifactIds.length, 2);
    assert.equal(new Set(formatted.artifactIds).size, 2);
    for (const id of formatted.artifactIds)
      assert.ok(Number.isSafeInteger(id) && id > 0);
    assert.equal(formatted.zipSha256.length, 2);
    for (const hash of [...formatted.zipSha256, formatted.readbackProofSha256])
      assert.match(hash, /^[a-f0-9]{64}$/);
    assert.deepEqual(formatted.formattedHelperPins, helperPinsBefore);
  }
  for (const file of carrierFiles) {
    const bytes = read(file);
    const entry = git(["ls-tree", "HEAD", "--", file]).toString("utf8").trim();
    assert.equal(entry, "100644 blob " + blob(bytes) + "\t" + file);
  }
  for (const id of variants)
    for (const file of runtimeFiles) {
      const bytes = read(fixture + id + "/" + file);
      assert.equal(digest(bytes), manifest.variants[id].files[file].sha256);
      assert.equal(blob(bytes), manifest.variants[id].files[file].blob);
    }
  const workflowBefore = read(workflowPath);
  assert.equal(
    workflowBefore.toString("utf8").split("RESOURCE_GATE_PHASE: " + phase)
      .length,
    2,
  );
  assert.ok(!workflowBefore.toString("utf8").includes("workflow_dispatch"));
  if (mode === "check-source") {
    console.log(
      JSON.stringify({
        status: "pinned_source_only_no_resource_run",
        source_head: process.env.GITHUB_SHA,
        manifest_sha256: manifestHash,
        phase,
        scenario,
        variant,
      }),
    );
    return;
  }
  const checkout = realpathSync(process.cwd());
  const sourceParent = path.join(checkout, "src");
  assert.ok(
    lstatSync(sourceParent).isDirectory() &&
      !lstatSync(sourceParent).isSymbolicLink(),
  );
  assert.equal(realpathSync(sourceParent), sourceParent);
  for (const file of runtimeFiles)
    assert.equal(realpathSync(path.dirname(path.resolve(file))), sourceParent);
  const scratchParent = path.join(checkout, "tmp");
  if (!existsSync(scratchParent)) mkdirSync(scratchParent);
  assert.ok(
    lstatSync(scratchParent).isDirectory() &&
      !lstatSync(scratchParent).isSymbolicLink(),
  );
  assert.equal(realpathSync(scratchParent), scratchParent);
  const scratch = path.join(scratchParent, "raw-capture-resource-native");
  assert.equal(existsSync(scratch), false, "fresh job-owned scratch only");
  mkdirSync(scratch);
  assert.equal(realpathSync(scratch), scratch);
  const upload = path.join(scratch, "upload");
  mkdirSync(upload);
  const boundedJson = (file: string, value: unknown) => {
    const bytes = Buffer.from(JSON.stringify(value, null, 2) + "\n");
    assert.ok(bytes.length <= 65536);
    writeFileSync(file, bytes);
    return bytes;
  };
  const nativeReceipts: {
    step: string;
    exit_code: number | null;
    signal: string | null;
    actual_unhandled_diagnostic: boolean;
    vitest_unhandled_errors: number;
    output_bytes: number;
  }[] = [];
  const lintDiagnostics: {
    helper_id: number;
    rule_id: string | null;
    severity: number;
    line: number | null;
    column: number | null;
    ignored_file: boolean;
  }[] = [];
  const native = (
    step: string,
    command: string,
    args: string[],
    maximumSeconds = 180,
  ) => {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      timeout: maximumSeconds * 1000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        FORCE_COLOR: "0",
        WRANGLER_SEND_METRICS: "false",
        WRANGLER_WRITE_LOGS: "false",
      },
    });
    const observer = diagnosticObserver();
    observer.push("stdout", result.stdout ?? "");
    observer.push("stderr", result.stderr ?? "");
    const observed = observer.finish();
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
    if (step === "lint") {
      const reports = JSON.parse(result.stdout) as {
        filePath: string;
        messages: {
          ruleId: string | null;
          severity: number;
          line?: number;
          column?: number;
          message: string;
        }[];
      }[];
      assert.ok(Array.isArray(reports) && reports.length === 3);
      const helpers = helperFiles.filter((file) => file.endsWith(".ts"));
      const seenHelpers = new Set<number>();
      for (const report of reports) {
        const helperId = helpers.findIndex(
          (file) => path.resolve(file) === report.filePath,
        );
        assert.ok(helperId >= 0 && !seenHelpers.has(helperId));
        seenHelpers.add(helperId);
        assert.ok(
          Array.isArray(report.messages) && report.messages.length <= 128,
        );
        for (const item of report.messages) {
          assert.ok(lintDiagnostics.length < 128);
          assert.ok(
            item.ruleId === null ||
              (typeof item.ruleId === "string" &&
                /^[A-Za-z0-9_@/-]{1,128}$/.test(item.ruleId)),
          );
          assert.ok(item.severity === 1 || item.severity === 2);
          for (const value of [item.line, item.column])
            assert.ok(
              value === undefined ||
                (Number.isSafeInteger(value) && value >= 0),
            );
          lintDiagnostics.push({
            helper_id: helperId,
            rule_id: item.ruleId,
            severity: item.severity,
            line: item.line ?? null,
            column: item.column ?? null,
            ignored_file: /^File ignored\b/i.test(item.message),
          });
        }
      }
      assert.equal(seenHelpers.size, 3);
    }
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(observed.actualUnhandled, false);
    assert.equal(observed.vitestUnhandled, 0);
    assert.equal(result.status, 0);
    return result.stdout ?? "";
  };
  const local = (step: string, command: string, args: string[]) =>
    native(step, "npx", ["--no-install", command, ...args]);
  const candidate = manifest.variants[variant];
  const originals = runtimeFiles.map((file) => {
    const entry = git(["ls-tree", "HEAD", "--", file]).toString("utf8").trim();
    if (!entry) {
      assert.equal(existsSync(file), false);
      return { file, bytes: null, mode: null };
    }
    const actual = read(file);
    assert.equal(entry, "100644 blob " + blob(actual) + "\t" + file);
    return { file, bytes: actual, mode: lstatSync(file).mode & 0o777 };
  });
  let stage = "format",
    restored = false,
    observerControls = 0,
    typeInputsConfirmed = 0;
  let status: string;
  let preflightSha256: string | null = null;
  try {
    local("format", "prettier", [
      phase === "format" ? "--write" : "--check",
      ...helperFiles,
      workflowPath,
      manifestPath,
    ]);
    if (phase === "format") {
      assert.deepEqual(
        JSON.parse(read(manifestPath).toString("utf8")),
        manifest,
      );
      const needle = "RESOURCE_CANDIDATE_MANIFEST_SHA256: " + manifestHash;
      const workflow = read(workflowPath).toString("utf8");
      assert.equal(workflow.split(needle).length, 2);
      writeFileSync(
        workflowPath,
        workflow.replace(
          needle,
          "RESOURCE_CANDIDATE_MANIFEST_SHA256: " + digest(read(manifestPath)),
        ),
      );
      local("workflow_reformat", "prettier", ["--write", workflowPath]);
    }
    stage = "candidate_typecheck_overlay";
    for (const file of runtimeFiles)
      writeFileSync(file, read(fixture + variant + "/" + file));
    for (const file of runtimeFiles)
      assert.equal(digest(read(file)), candidate.files[file].sha256);
    stage = "lint";
    const typeInputs = helperFiles.filter((file) => file.endsWith(".ts"));
    local("lint", "eslint", [
      "--format=json",
      "--max-warnings=0",
      ...typeInputs,
    ]);
    stage = "helper_types";
    const listed = local("helper_types", "tsc", [
      "--noEmit",
      "--listFiles",
      "--project",
      helperFiles[3],
    ])
      .split(/\r?\n/)
      .map((file) => file.trim());
    typeInputsConfirmed = typeInputs.filter((file) =>
      listed.includes(path.resolve(file)),
    ).length;
    assert.equal(typeInputsConfirmed, 3);
    stage = "observer_controls";
    observerControls = diagnosticControls().diagnostic_controls_passed;
    assert.equal(observerControls, 38);
    stage = "workflow_policy";
    native("workflow_policy", "npm", ["run", "validate:workflows"]);
    // No runtime formatter, native builder or capture is invoked by this gate.
    for (const file of runtimeFiles)
      assert.equal(digest(read(file)), candidate.files[file].sha256);
    if (phase === "qualify") {
      assert.deepEqual(pins(helperFiles), helperPinsBefore);
      assert.equal(digest(read(manifestPath)), manifestHash);
      assert.equal(digest(read(workflowPath)), digest(workflowBefore));
    }
    status =
      phase === "format"
        ? "native_format_readback_only_resource_not_run"
        : "native_checks_passed_resource_not_run";
  } catch {
    status = "failed";
    process.exitCode = 1;
  } finally {
    try {
      for (const original of originals) {
        if (original.bytes === null) {
          if (existsSync(original.file)) {
            assert.ok(
              lstatSync(original.file).isFile() &&
                !lstatSync(original.file).isSymbolicLink(),
            );
            unlinkSync(original.file);
          }
          assert.equal(existsSync(original.file), false);
        } else {
          writeFileSync(original.file, original.bytes);
          assert.equal(digest(read(original.file)), digest(original.bytes));
          assert.equal(lstatSync(original.file).mode & 0o777, original.mode);
        }
      }
      git(["diff", "--exit-code", "HEAD", "--", ...runtimeInputs]);
      assert.equal(
        digest(git(["ls-tree", "-r", "HEAD", "--", ...runtimeInputs])),
        canonicalManifest,
      );
      const drift = lines(git(["diff", "--name-only", "HEAD"]));
      assert.ok(
        drift.every((file) =>
          [...helperFiles, workflowPath, manifestPath].includes(file),
        ),
      );
      if (phase === "qualify") assert.deepEqual(drift, []);
      restored = true;
    } catch {
      status = "failed";
      stage = "canonical_restore_failed";
      process.exitCode = 1;
    }
  }
  const sourcePinsAfter = pins([...helperFiles, workflowPath, manifestPath]);
  const retainSources = () => {
    for (const pin of sourcePinsAfter) {
      const destination = path.join(upload, "source", pin.path);
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, read(pin.path));
    }
  };
  retainSources();
  if (status === "native_checks_passed_resource_not_run" && restored) {
    const preflight = {
      status,
      phase,
      scenario,
      variant,
      source_head: process.env.GITHUB_SHA,
      run_id: process.env.GITHUB_RUN_ID,
      run_attempt: process.env.GITHUB_RUN_ATTEMPT,
      manifest_sha256: manifestHash,
      native_qualification: candidate.nativeQualification,
      native_format_readback: manifest.resource_gate.native_format_readback,
      helper_pins: pins(helperFiles),
      canonical_runtime_restored: true,
      canonical_runtime_manifest_sha256: canonicalManifest,
      native_steps: nativeReceipts,
      observer_controls_passed: observerControls,
      type_inputs_confirmed: typeInputsConfirmed,
      production_actions: false,
    };
    const bytes = boundedJson(path.join(scratch, "preflight.json"), preflight);
    writeFileSync(path.join(upload, "preflight.json"), bytes);
    preflightSha256 = digest(bytes);
    stage = "resource_child";
    boundedJson(path.join(upload, "native-gate-receipt.json"), {
      status: "incomplete",
      stage,
      phase,
      scenario,
      variant,
      source_head: process.env.GITHUB_SHA,
      run_id: process.env.GITHUB_RUN_ID,
      run_attempt: process.env.GITHUB_RUN_ATTEMPT,
      manifest_sha256_before: manifestHash,
      manifest_sha256_after: digest(read(manifestPath)),
      source_pins_before: [
        ...helperPinsBefore,
        {
          path: workflowPath,
          bytes: workflowBefore.length,
          sha256: digest(workflowBefore),
          blob: blob(workflowBefore),
        },
        {
          path: manifestPath,
          bytes: manifestBytes.length,
          sha256: manifestHash,
          blob: blob(manifestBytes),
        },
      ],
      source_pins_after: sourcePinsAfter,
      executed_gate_sha256: helperPinsBefore[2].sha256,
      native_qualification: candidate.nativeQualification,
      canonical_runtime_restored_before_resource_child: restored,
      canonical_runtime_manifest_sha256: canonicalManifest,
      native_steps: nativeReceipts,
      observer_controls_passed: observerControls,
      type_inputs_confirmed: typeInputsConfirmed,
      project_resource_run_started: null,
      resource_child_start_attempted: false,
      preflight_sha256: preflightSha256,
      raw_output_retained: false,
      production_actions: false,
      memory_gate: "open;incomplete checkpoint never qualifies resources",
    });
    try {
      // One child owns the same fresh workerd/D1 and unchanged sampling semantics.
      const prior = process.env.RESOURCE_NATIVE_PREFLIGHT_SHA256;
      process.env.RESOURCE_NATIVE_PREFLIGHT_SHA256 = preflightSha256;
      try {
        native(
          "resource_child",
          process.execPath,
          [helperFiles[0], scenario, variant],
          600,
        );
      } finally {
        if (prior === undefined)
          delete process.env.RESOURCE_NATIVE_PREFLIGHT_SHA256;
        else process.env.RESOURCE_NATIVE_PREFLIGHT_SHA256 = prior;
      }
      status = "native_checks_and_resource_child_passed";
    } catch {
      status = "failed";
      process.exitCode = 1;
    }
  }
  // Retain fixed public source only; never retain child stdout/stderr or stacks.
  retainSources();
  const receipt = {
    status,
    stage,
    phase,
    scenario,
    variant,
    source_head: process.env.GITHUB_SHA,
    run_id: process.env.GITHUB_RUN_ID,
    run_attempt: process.env.GITHUB_RUN_ATTEMPT,
    manifest_sha256_before: manifestHash,
    manifest_sha256_after: digest(read(manifestPath)),
    source_pins_before: [
      ...helperPinsBefore,
      {
        path: workflowPath,
        bytes: workflowBefore.length,
        sha256: digest(workflowBefore),
        blob: blob(workflowBefore),
      },
      {
        path: manifestPath,
        bytes: manifestBytes.length,
        sha256: manifestHash,
        blob: blob(manifestBytes),
      },
    ],
    source_pins_after: sourcePinsAfter,
    executed_gate_sha256: helperPinsBefore[2].sha256,
    native_qualification: candidate.nativeQualification,
    canonical_runtime_restored_before_resource_child: restored,
    canonical_runtime_manifest_sha256: canonicalManifest,
    native_steps: nativeReceipts,
    lint_diagnostics: lintDiagnostics,
    observer_controls_passed: observerControls,
    type_inputs_confirmed: typeInputsConfirmed,
    project_resource_run_started:
      status === "native_checks_and_resource_child_passed"
        ? true
        : phase === "format"
          ? false
          : null,
    resource_child_start_attempted: preflightSha256 !== null,
    preflight_sha256: preflightSha256,
    raw_output_retained: false,
    production_actions: false,
    memory_gate:
      "open; sparse observations cannot qualify128 MB or whole-owner resource acceptance",
  };
  boundedJson(path.join(upload, "native-gate-receipt.json"), receipt);
  console.log(
    JSON.stringify({
      status,
      phase,
      scenario,
      variant,
      stage,
      raw_output_retained: false,
    }),
  );
}
main().catch(() => {
  console.log(
    JSON.stringify({
      status: "failed",
      failure_class: "resource_native_gate_refused",
      raw_output_retained: false,
    }),
  );
  process.exitCode = 1;
});
