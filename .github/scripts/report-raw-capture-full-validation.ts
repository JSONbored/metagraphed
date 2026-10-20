import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

async function main() {
  const MAX_REPORT_BYTES = 32 * 1024 * 1024;
  const JOBS = [
    "changes",
    "bundle-source",
    "validate",
    "python",
    "ui",
    "unsharded",
    "test-shared-1",
    "test-shared-2",
    "test-shared-3",
    "test-mocked-1",
    "test-mocked-2",
  ];
  if (process.argv[2] === "selfcheck") {
    console.log(
      JSON.stringify({
        ...diagnosticControls(),
        ...receiptControls(),
        ...branchHitControls(),
        ...presubmitFailureControls(),
      }),
    );
    return;
  }
  if (process.argv[2] === "receipt-selfcheck") {
    console.log(JSON.stringify(receiptControls()));
    return;
  }
  const ROOT = realpathSync(process.env.GITHUB_WORKSPACE ?? process.cwd());
  const FIXTURES = ".github/fixtures/raw-capture-full-validation/";
  const SCRATCH = path.join(ROOT, "tmp/raw-capture-full-validation");
  const OUTPUT = path.join(SCRATCH, "upload");
  const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
  const MAX_RECORDS = 2_000_000;
  const LEGS = ["shared-1", "shared-2", "shared-3", "mocked-1", "mocked-2"];
  const hash = (value: Uint8Array) =>
    createHash("sha256").update(value).digest("hex");
  function safeId(value: string | undefined): string {
    assert.match(value ?? "", /^[a-z][a-z0-9-]{0,63}$/);
    return value!;
  }
  function bytes(file: string, maximum = MAX_REPORT_BYTES): Buffer {
    assert.ok(statSync(file).isFile());
    assert.ok(statSync(file).size > 0 && statSync(file).size <= maximum);
    return readFileSync(file);
  }
  function json(file: string, maximum = MAX_REPORT_BYTES): unknown {
    return JSON.parse(bytes(file, maximum).toString("utf8"));
  }
  function save(file: string, value: unknown) {
    const encoded = JSON.stringify(value, null, 2) + "\n";
    assert.ok(Buffer.byteLength(encoded) <= MAX_REPORT_BYTES);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, encoded);
  }
  interface SourceFile {
    path: string;
    sha256: string;
    bytes: number;
    git_blob_sha: string;
  }
  interface Manifest {
    payload_version: string;
    base_commit: string;
    files: SourceFile[];
  }
  interface Overlay {
    source_head: string;
    canonical_base: string;
    candidate_virtual_commit: string;
    candidate_tree: string;
    manifest_sha256: string;
    runtime_patch_sha256: string;
    run_id: string;
    run_attempt: string;
    files: SourceFile[];
  }
  interface Command {
    id: string;
    job: string;
    native_name: string;
    script_path: string;
    sha256: string;
    working_directory: string;
    counts_as_native_gate: boolean;
  }
  interface Commands {
    force_full_qualification: true;
    commands: Command[];
  }
  interface RunReceipt {
    command_id: string;
    job: string;
    exit_code: number | null;
    signal: string | null;
    classification: string;
    elapsed_ms: number;
    stdout_bytes: number;
    stderr_bytes: number;
    output_withheld: true;
    presubmit_pipeline_failure?: ReturnType<typeof presubmitFailureProjection>;
    vitest_unhandled_errors: number;
    actual_unhandled_diagnostic: boolean;
    observed_test_summaries: {
      kind: string;
      tests?: number;
      passed?: number;
      failed?: number;
      skipped?: number;
    }[];
  }
  const manifestBytes = bytes(
    path.join(ROOT, FIXTURES, "manifest.json"),
    65_536,
  );
  assert.match(
    process.env.FULL_VALIDATION_MANIFEST_SHA256 ?? "",
    /^[a-f0-9]{64}$/,
  );
  assert.equal(
    hash(manifestBytes),
    process.env.FULL_VALIDATION_MANIFEST_SHA256,
  );
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as Manifest;
  const commandBytes = bytes(
    path.join(ROOT, FIXTURES, "commands.json"),
    131_072,
  );
  assert.match(
    process.env.FULL_VALIDATION_COMMANDS_SHA256 ?? "",
    /^[a-f0-9]{64}$/,
  );
  assert.equal(hash(commandBytes), process.env.FULL_VALIDATION_COMMANDS_SHA256);
  const commands = JSON.parse(commandBytes.toString("utf8")) as Commands;
  assert.equal(commands.force_full_qualification, true);
  assert.equal(process.env.FORCE_FULL_QUALIFICATION, "true");
  const overlay = json(
    path.join(SCRATCH, "overlay-receipt.json"),
    65_536,
  ) as Overlay;
  assert.equal(
    overlay.manifest_sha256,
    process.env.FULL_VALIDATION_MANIFEST_SHA256,
  );
  assert.equal(overlay.canonical_base, manifest.base_commit);
  assert.equal(overlay.run_id, process.env.GITHUB_RUN_ID);
  assert.equal(String(overlay.run_attempt), process.env.GITHUB_RUN_ATTEMPT);
  function sourcePins() {
    return manifest.files.map((item) => {
      const actual = bytes(path.join(ROOT, item.path), 131_072);
      assert.equal(actual.byteLength, item.bytes);
      assert.equal(hash(actual), item.sha256);
      return {
        path: item.path,
        sha256: item.sha256,
        bytes: item.bytes,
        git_blob_sha: item.git_blob_sha,
      };
    });
  }
  function runDirectory(job: string) {
    return path.join(SCRATCH, "runs", safeId(job));
  }
  function outputDirectory(job: string) {
    return path.join(OUTPUT, safeId(job));
  }
  function fixedClassification(text: string) {
    if (/MF-Proxy-Shared-Secret/i.test(text)) return "provider_detail_withheld";
    if (/Unhandled Errors|Unhandled Rejection|Uncaught Exception/i.test(text))
      return "unhandled";
    if (/Hook timed out|timed out|timeout/i.test(text)) return "timeout";
    if (/no such table|SQLITE_|D1_ERROR/i.test(text)) return "storage";
    if (/AssertionError|expected .* to |FAIL\s/i.test(text)) return "assertion";
    if (/error TS[0-9]+/.test(text)) return "typecheck";
    if (/prettier|eslint|code style/i.test(text)) return "lint_or_format";
    return "command_failure";
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

  function pipelineCheckScripts(): string[] {
    return [
      "artifacts:prepare-local",
      "sync:subnets:dry-run",
      "discover:candidates:dry-run",
      "verify:candidates:dry-run",
      "curate:baseline:dry-run",
      "review:promote:dry-run",
      "schemas:snapshot:dry-run",
      "adapters:snapshot:dry-run",
      "openapi:generate:dry-run",
      "r2:manifest:dry-run",
      "validate",
      "validate:schemas",
      "validate:api",
      "validate:mcp",
      "validate:startup-budget",
      "validate:mcp-route-map",
      "validate:operations",
      "validate:type-duplicates",
      "validate:nullable-overpromises",
      "validate:no-passthrough",
      "validate:boundary-casts",
      "validate:double-assertions",
      "validate:schema-shape-duplicates",
      "validate:mcp-input-parity",
      "validate:tool-route-divergence",
      "validate:query-vocabulary",
      "validate:route-query-parity",
      "validate:ai",
      "validate:openapi",
      "validate:types",
      "validate:contract-drift",
      "validate:db-types-drift",
      "validate:lane-topology",
      "validate:coverage-scoping",
      "validate:lakehouse-types-drift",
      "validate:lakehouse-readers",
      "validate:store-type-parity",
      "validate:featured-validators-drift",
      "validate:rpc-usage-slots-drift",
      "validate:retired-storage",
      "validate:archive-policy",
      "validate:client-sdk-sync",
      "validate:schema-enums",
      "validate:openapi-examples",
      "validate:generated-client",
      "validate:graphql-types-drift",
      "validate:worker-types-parity",
      "validate:graphql-route-parity",
      "validate:graphql-hand-written-checks",
      "validate:graphql-component-parity",
      "validate:graphql-query-arguments",
      "validate:published-names",
      "validate:graphql-tier-parity",
      "validate:committed-seed",
      "validate:artifact-budgets",
      "validate:logo-thumbnails",
      "validate:docs",
      "validate:contract-doc-sync",
      "validate:ui-docs-drift",
      "validate:ui-route-coverage",
      "validate:untyped-db-reads",
      "validate:declared-tables-exist",
      "validate:readme-catalog",
      "validate:adapters",
      "validate:intake",
      "validate:surface",
      "validate:revenue-provenance",
      "validate:operational-surface-parity",
      "validate:workflows",
      "validate:migrations",
      "worker:test",
      "worker:deploy:dry-run",
      "scan:public-safety",
      "validate:no-hand-written-mjs",
      "validate:single-schema-source",
      "validate:schema-opacity",
      "validate:schema-vocabularies",
      "validate:unreferenced-modules",
      "validate:unreferenced-exports",
      "validate:module-state-resets",
      "validate:pg-json-binds",
      "validate:retired-store-vocabulary",
      "validate:subnet-slot-cap",
      "validate:private-boundary",
      "test",
    ];
  }
  function presubmitStderrTail(before: Buffer, incoming: Buffer): Buffer {
    return Buffer.concat([before.subarray(-65_536), incoming.subarray(-65_536)]).subarray(-65_536);
  }
  function presubmitFailureProjection(stderr: string) {
    if (Buffer.byteLength(stderr) > 65_536) return null;
    const clean = stripVTControlCharacters(stderr).trimEnd();
    const boundary = clean.lastIndexOf("\n{");
    const terminal = boundary >= 0 ? clean.slice(boundary + 1) : clean;
    if (!terminal.startsWith('{\n  "failed_script": ')) return null;
    let value: unknown;
    try {
      value = JSON.parse(terminal);
    } catch {
      return null;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const report = value as Record<string, unknown>;
    if (
      Object.keys(report).sort().join(",") !== "failed_script,mode,results" ||
      report.mode !== "check" ||
      !Array.isArray(report.results)
    ) return null;
    const scripts = pipelineCheckScripts();
    const results = report.results;
    if (results.length < 1 || results.length > scripts.length) return null;
    let elapsed = 0;
    for (const [index, item] of results.entries()) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const row = item as Record<string, unknown>;
      if (
        Object.keys(row).sort().join(",") !== "elapsed_ms,script,status" ||
        row.script !== scripts[index] ||
        row.status !== (index === results.length - 1 ? "failed" : "passed") ||
        typeof row.elapsed_ms !== "number" ||
        !Number.isSafeInteger(row.elapsed_ms) ||
        row.elapsed_ms < 0 ||
        row.elapsed_ms > 35 * 60 * 1000
      ) return null;
      elapsed += row.elapsed_ms;
    }
    if (elapsed > 35 * 60 * 1000 || report.failed_script !== scripts[results.length - 1]) return null;
    return {
      kind: "reported_pinned_pipeline_failure" as const,
      failed_script: scripts[results.length - 1],
      failed_ordinal: results.length,
      passed_steps: results.length - 1,
      observed_steps: results.length,
      total_steps: scripts.length,
      elapsed_ms: elapsed,
      raw_output_retained: false as const,
    };
  }
  function presubmitFailureControls() {
    const scripts = pipelineCheckScripts();
    assert.equal(scripts.length, 85);
    const report = (length: number) => ({
      failed_script: scripts[length - 1],
      mode: "check",
      results: scripts.slice(0, length).map((script, index) => ({
        elapsed_ms: index,
        script,
        status: index === length - 1 ? "failed" : "passed",
      })),
    });
    const encode = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
    let checked = 0;
    for (const length of [1, 4, 85]) {
      const projected = presubmitFailureProjection(encode(report(length)));
      assert.deepEqual(projected, {
        kind: "reported_pinned_pipeline_failure",
        failed_script: scripts[length - 1],
        failed_ordinal: length,
        passed_steps: length - 1,
        observed_steps: length,
        total_steps: 85,
        elapsed_ms: length * (length - 1) / 2,
        raw_output_retained: false,
      });
      checked++;
    }
    const valid = report(4);
    const expected = presubmitFailureProjection(encode(valid));
    for (const prefix of ["previous command output\n", "\u001b[31mprevious\u001b[0m\n"]) {
      assert.deepEqual(presubmitFailureProjection(prefix + encode(valid)), expected);
      checked++;
    }
    const badRows = (index: number, changes: Record<string, unknown>) => valid.results.map((row, at) => at === index ? { ...row, ...changes } : row);
    const refusals = [
      encode({ ...valid, failed_script: "not-a-pipeline-script" }),
      encode({ ...valid, mode: "refresh" }),
      encode({ ...valid, extra: "withheld" }),
      encode({ ...valid, results: [] }),
      encode({ ...valid, results: "not-an-array" }),
      encode({ ...valid, results: [...report(85).results, report(1).results[0]] }),
      encode({ ...valid, results: badRows(1, { script: scripts[2] }) }),
      encode({ ...valid, results: badRows(1, { status: "failed" }) }),
      encode({ ...valid, results: badRows(3, { status: "passed" }) }),
      encode({ ...valid, results: badRows(3, { elapsed_ms: -1 }) }),
      encode({ ...valid, results: badRows(3, { elapsed_ms: 0.5 }) }),
      encode({ ...valid, results: badRows(3, { elapsed_ms: "1" }) }),
      encode({ ...valid, results: badRows(3, { elapsed_ms: null }) }),
      encode({ ...valid, results: badRows(3, { elapsed_ms: 35 * 60 * 1000 + 1 }) }),
      encode({ ...valid, results: badRows(3, { elapsed_ms: 35 * 60 * 1000 }) }),
      encode({ ...valid, results: badRows(3, { extra: "withheld" }) }),
      encode({ ...valid, results: valid.results.map((row, index) => index === 1 ? null : row) }),
      encode({ ...valid, results: badRows(3, { script: scripts[0] }) }),
      encode({ ...valid, failed_script: scripts[0] }),
      encode({ mode: "check", results: valid.results }),
      encode(valid).slice(0, -3),
      encode(valid).slice(1),
      encode(valid) + "later nonterminal output\n",
      encode({ unrelated: true }),
      JSON.stringify(valid),
      "x".repeat(65_537) + encode(valid),
    ];
    assert.equal(refusals.length, 26);
    for (const value of refusals) {
      assert.equal(presubmitFailureProjection(value), null);
      checked++;
    }
    const first = Buffer.from("earlier-prefix");
    assert.equal(presubmitStderrTail(first, Buffer.from("later")).toString(), "earlier-prefixlater");
    checked++;
    const large = presubmitStderrTail(Buffer.alloc(65_536, 120), Buffer.from("\n" + encode(valid)));
    assert.equal(large.length, 65_536);
    assert.deepEqual(presubmitFailureProjection(large.toString()), expected);
    checked++;
    assert.equal(presubmitStderrTail(Buffer.alloc(0), Buffer.alloc(80_000, 121)).length, 65_536);
    checked++;
    assert.equal(checked, 34);
    return { presubmit_failure_controls_passed: checked, presubmit_pipeline_steps: scripts.length };
  }

  async function run(id: string) {
    const job = safeId(process.env.QUALIFICATION_JOB_ID);
    const command = commands.commands.find((item) => item.id === id);
    assert.ok(command);
    assert.equal(command.job, job.startsWith("test-") ? "test" : job);
    assert.ok(command.script_path.startsWith(FIXTURES + "commands/"));
    assert.ok(command.script_path.endsWith(".sh.payload"));
    const script = bytes(path.join(ROOT, command.script_path), 131_072);
    assert.equal(hash(script), command.sha256);
    const cwd = realpathSync(path.join(ROOT, command.working_directory));
    assert.ok(cwd === ROOT || cwd.startsWith(ROOT + path.sep));
    const presubmit = command.id === "validate-presubmit-check";
    if (presubmit) assert.equal(hash(bytes(path.join(ROOT, "scripts/pipeline.ts"), 65_536)), "33f3afcf125f4aad4b3ebe2e84c52299b4240886679f0fe740735366628d9410");
    let presubmitStderr: Buffer = Buffer.alloc(0);
    const started = Date.now();
    let stdoutBytes = 0,
      stderrBytes = 0,
      rolling = "",
      category = "none",
      exceeded = false;
    const diagnostics = diagnosticObserver();
    const child = spawn(
      "/bin/bash",
      [
        "--noprofile",
        "--norc",
        "-eo",
        "pipefail",
        path.join(ROOT, command.script_path),
      ],
      {
        cwd,
        env: {
          ...process.env,
          WRANGLER_SEND_METRICS: "false",
          WRANGLER_WRITE_LOGS: "false",
        },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      },
    );
    const terminate = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* already stopped */
        }
      }
    };
    const timer = setTimeout(
      () => {
        exceeded = true;
        terminate();
      },
      35 * 60 * 1000,
    );
    const consume = (data: Buffer, stream: "stdout" | "stderr") => {
      if (stream === "stdout") stdoutBytes += data.byteLength;
      else stderrBytes += data.byteLength;
      if (stdoutBytes + stderrBytes > MAX_OUTPUT_BYTES) {
        exceeded = true;
        terminate();
      }
      rolling = (rolling + data.toString("utf8")).slice(-8192);
      if (presubmit && stream === "stderr") presubmitStderr = presubmitStderrTail(presubmitStderr, data);
      diagnostics.push(stream, data.toString("utf8"));
      const projected = fixedClassification(rolling);
      if (projected !== "command_failure") category = projected;
    };
    child.stdout.on("data", (data: Buffer) => consume(data, "stdout"));
    child.stderr.on("data", (data: Buffer) => consume(data, "stderr"));
    const result = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => {
      child.once("error", () => {
        category = "spawn_failure";
        resolve({ code: null, signal: null });
      });
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    clearTimeout(timer);
    const diagnostic = diagnostics.finish();
    rolling = "";
    const successful =
      result.code === 0 &&
      result.signal === null &&
      !exceeded &&
      diagnostic.vitestUnhandled === 0 &&
      !diagnostic.actualUnhandled;
    const receipt: RunReceipt = {
      command_id: command.id,
      job,
      exit_code: result.code,
      signal: result.signal,
      classification: exceeded
        ? "bounded_execution_limit"
        : successful
          ? "none"
          : category === "none"
            ? "command_failure"
            : category,
      elapsed_ms: Date.now() - started,
      stdout_bytes: stdoutBytes,
      stderr_bytes: stderrBytes,
      vitest_unhandled_errors: diagnostic.vitestUnhandled,
      actual_unhandled_diagnostic: diagnostic.actualUnhandled,
      observed_test_summaries: diagnostic.testSummaries,
      output_withheld: true,
      ...(presubmit ? { presubmit_pipeline_failure: result.code !== 0 ? presubmitFailureProjection(presubmitStderr.toString("utf8")) : null } : {}),
    };
    save(path.join(runDirectory(job), command.id + ".json"), receipt);
    console.log(JSON.stringify(receipt));
    if (!successful) process.exitCode = 1;
  }
  interface LcovFile {
    lines: Map<number, number>;
    branches: Map<string, number>;
  }
  function integer(value: string): number {
    assert.match(value, /^\d+$/);
    const result = Number(value);
    assert.ok(Number.isSafeInteger(result));
    return result;
  }
  // The pinned Istanbul emitter can preserve negative implicit-else hit counts.
  // Positions remain unsigned; only strictly positive branch counts are covered.
  function branchHits(value: string): number {
    if (value === "-") return 0;
    assert.match(value, /^-?\d+$/);
    const result = Number(value);
    assert.ok(Number.isSafeInteger(result));
    return result;
  }
  function branchHitControls() {
    let controls = 0;
    const accepted: [string, number][] = [
      ["-", 0],
      ["0", 0],
      ["1", 1],
      ["-1", -1],
      ["-42", -42],
      ["9007199254740991", Number.MAX_SAFE_INTEGER],
      ["-9007199254740991", Number.MIN_SAFE_INTEGER],
    ];
    for (const [value, expected] of accepted) {
      assert.equal(branchHits(value), expected);
      controls++;
    }
    for (const value of [
      "",
      "1.5",
      "1e2",
      " 1",
      "1 ",
      "+1",
      "--1",
      "NaN",
      "Infinity",
      "9007199254740992",
      "-9007199254740992",
    ]) {
      assert.throws(() => branchHits(value));
      controls++;
    }
    assert.throws(() => integer("-1"));
    controls++;
    const fixture = new Map([
      [
        "src/raw-capture-d1.ts",
        {
          lines: new Map([[1, 1]]),
          branches: new Map([
            ["1,0,0", branchHits("-42")],
            ["1,0,1", branchHits("0")],
            ["1,0,2", branchHits("1")],
          ]),
        },
      ],
    ]);
    const normalized = normalizeLcov(fixture);
    assert.equal(
      normalized,
      "SF:src/raw-capture-d1.ts\nDA:1,1\nBRDA:1,0,0,-42\nBRDA:1,0,1,0\nBRDA:1,0,2,1\nLF:1\nLH:1\nBRF:3\nBRH:1\nend_of_record\n",
    );
    controls++;
    assert.equal(controls, 20);
    return { lcov_branch_controls_passed: controls };
  }
  function sourcePath(value: string) {
    assert.ok(value.length < 512 && !/[\0\r\n]/.test(value));
    const relative = path.isAbsolute(value)
      ? path.relative(ROOT, value)
      : value;
    assert.ok(!relative.includes("\\") && !relative.split("/").includes(".."));
    assert.match(
      relative,
      /^(?:src|workers|scripts|schemas-src)\/[A-Za-z0-9_./-]+\.(?:ts|mjs)$/,
    );
    assert.ok(existsSync(path.join(ROOT, relative)));
    return relative;
  }
  function parseLcov(file: string): Map<string, LcovFile> {
    const rows = bytes(file).toString("utf8").split("\n");
    assert.ok(rows.length < MAX_RECORDS);
    const output = new Map<string, LcovFile>();
    let current: LcovFile | undefined;
    for (const row of rows) {
      if (!row || row.startsWith("TN:") || row.startsWith("VER:")) continue;
      if (row.startsWith("SF:")) {
        assert.equal(current, undefined);
        const source = sourcePath(row.slice(3));
        assert.ok(!output.has(source));
        current = { lines: new Map(), branches: new Map() };
        output.set(source, current);
      } else if (row === "end_of_record") {
        assert.ok(current);
        current = undefined;
      } else {
        assert.ok(current);
        if (row.startsWith("DA:")) {
          const fields = row.slice(3).split(",");
          assert.ok(fields.length === 2 || fields.length === 3);
          const line = integer(fields[0]),
            hits = integer(fields[1]);
          assert.ok(line > 0 && !current.lines.has(line));
          current.lines.set(line, hits);
        } else if (row.startsWith("BRDA:")) {
          const fields = row.slice(5).split(",");
          assert.equal(fields.length, 4);
          const line = integer(fields[0]),
            block = integer(fields[1]),
            branch = integer(fields[2]);
          assert.ok(line > 0);
          const key = [line, block, branch].join(",");
          assert.ok(!current.branches.has(key));
          current.branches.set(key, branchHits(fields[3]));
        } else {
          assert.match(row, /^(?:FN|FNDA|FNF|FNH|LF|LH|BRF|BRH):/);
        }
      }
    }
    assert.equal(current, undefined);
    assert.ok(output.size > 0);
    return output;
  }
  function normalizeLcov(data: Map<string, LcovFile>) {
    const records: string[] = [];
    for (const [file, item] of [...data].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      records.push("SF:" + file);
      for (const [line, hits] of [...item.lines].sort(([a], [b]) => a - b))
        records.push("DA:" + line + "," + hits);
      for (const [key, hits] of [...item.branches].sort(([a], [b]) =>
        a.localeCompare(b),
      ))
        records.push("BRDA:" + key + "," + hits);
      records.push(
        "LF:" + item.lines.size,
        "LH:" + [...item.lines.values()].filter((hits) => hits > 0).length,
        "BRF:" + item.branches.size,
        "BRH:" + [...item.branches.values()].filter((hits) => hits > 0).length,
        "end_of_record",
      );
    }
    const result = records.join("\n") + "\n";
    assert.ok(Buffer.byteLength(result) <= MAX_REPORT_BYTES);
    return result;
  }
  function junitCounts(file: string) {
    const raw = bytes(file).toString("utf8");
    const tests = [...raw.matchAll(/<testcase(?:\s|>)/g)].length;
    const failed = [...raw.matchAll(/<failure(?:\s|>)/g)].length;
    const errors = [...raw.matchAll(/<error(?:\s|>)/g)].length;
    const skipped = [...raw.matchAll(/<skipped(?:\s|\/|>)/g)].length;
    assert.ok(tests > 0 && failed + errors + skipped <= tests);
    return {
      tests,
      passed: tests - failed - errors - skipped,
      failed,
      errors,
      skipped,
    };
  }
  function summaryCounts(directory: string) {
    const summary = json(
      path.join(ROOT, directory, "coverage-summary.json"),
    ) as {
      total: Record<
        string,
        { total: number; covered: number; skipped: number; pct: number }
      >;
    };
    const selected = Object.fromEntries(
      ["lines", "statements", "functions", "branches"].map((key) => {
        const item = summary.total[key];
        assert.ok(item && Number.isSafeInteger(item.total) && item.total > 0);
        assert.ok(
          Number.isSafeInteger(item.covered) &&
            item.covered >= 0 &&
            item.covered <= item.total,
        );
        return [
          key,
          {
            total: item.total,
            covered: item.covered,
            skipped: item.skipped,
            pct: item.pct,
          },
        ];
      }),
    );
    return selected;
  }
  function e2eCounts() {
    return e2eReportCounts(
      json(path.join(ROOT, "apps/ui/test-results/e2e-results.json")),
    );
  }
  function e2eReportCounts(value: unknown) {
    const report = value as Record<string, unknown>;
    const stats = report.stats as Record<string, number>;
    const counts = Object.fromEntries(
      ["expected", "unexpected", "flaky", "skipped"].map((metric) => {
        const count = stats[metric];
        assert.ok(Number.isSafeInteger(count) && count >= 0);
        return [metric, count];
      }),
    );
    const array = (value: unknown, maximum: number): unknown[] => {
      if (value === undefined) return [];
      assert.ok(Array.isArray(value) && value.length <= maximum);
      return value;
    };
    const cases: {
      index: number;
      outcome: string;
      attempts: { retry: number; status: string; errors: number }[];
    }[] = [];
    let resultCount = 0,
      retryCount = 0,
      failedAttempts = 0,
      errorCount = 0;
    const visit = (value: unknown, depth = 0) => {
      assert.ok(depth <= 32);
      for (const suite of array(value, 4096)) {
        assert.ok(suite && typeof suite === "object");
        const record = suite as Record<string, unknown>;
        for (const spec of array(record.specs, 4096)) {
          assert.ok(spec && typeof spec === "object");
          for (const test of array(
            (spec as Record<string, unknown>).tests,
            4096,
          )) {
            assert.ok(test && typeof test === "object" && cases.length < 4096);
            const candidate = test as Record<string, unknown>;
            assert.ok(
              typeof candidate.status === "string" &&
                ["expected", "unexpected", "flaky", "skipped"].includes(
                  candidate.status,
                ),
            );
            const attempts = array(candidate.results, 32).map((item) => {
              assert.ok(item && typeof item === "object");
              const result = item as Record<string, unknown>;
              assert.ok(
                Number.isSafeInteger(result.retry) &&
                  (result.retry as number) >= 0 &&
                  (result.retry as number) <= 31 &&
                  typeof result.status === "string" &&
                  [
                    "passed",
                    "failed",
                    "timedOut",
                    "skipped",
                    "interrupted",
                  ].includes(result.status),
              );
              const errors = array(result.errors, 1024).length;
              resultCount++;
              assert.ok(resultCount <= 16_384);
              if ((result.retry as number) > 0) retryCount++;
              if (["failed", "timedOut", "interrupted"].includes(result.status))
                failedAttempts++;
              errorCount += errors;
              return {
                retry: result.retry as number,
                status: result.status,
                errors,
              };
            });
            cases.push({
              index: cases.length,
              outcome: candidate.status,
              attempts,
            });
          }
        }
        visit(record.suites, depth + 1);
      }
    };
    visit(report.suites);
    assert.ok(cases.length > 0);
    assert.ok(resultCount > 0);
    assert.equal(
      cases.length,
      Object.values(counts).reduce((sum, count) => sum + count, 0),
    );
    for (const [outcome, count] of Object.entries(counts))
      assert.equal(
        cases.filter((item) => item.outcome === outcome).length,
        count,
      );
    const globalErrors = array(report.errors, 1024).length;
    return {
      stats: counts,
      cases,
      attempts: resultCount,
      retry_attempts: retryCount,
      failed_attempts: failedAttempts,
      attempt_errors: errorCount,
      global_errors: globalErrors,
      raw_messages_or_attachments_retained: false,
    };
  }
  function finalize(job: string) {
    assert.ok(JOBS.includes(job));
    const directory = outputDirectory(job);
    mkdirSync(directory, { recursive: true });
    const pins = sourcePins();
    const available = existsSync(runDirectory(job))
      ? readdirSync(runDirectory(job)).sort()
      : [];
    const receipts = available.map((name) => {
      assert.match(name, /^[a-z0-9-]+\.json$/);
      const item = json(
        path.join(runDirectory(job), name),
        65_536,
      ) as RunReceipt;
      assert.equal(item.job, job);
      assert.ok(
        commands.commands.some((command) => command.id === item.command_id),
      );
      save(path.join(directory, "steps", name), item);
      return item;
    });
    const expected = commands.commands
      .filter(
        (command) =>
          command.job === (job.startsWith("test-") ? "test" : job) &&
          command.counts_as_native_gate,
      )
      .map((command) => command.id);
    const executed = receipts.filter((item) =>
      expected.includes(item.command_id),
    );
    const missing = expected.filter(
      (id) => !executed.some((item) => item.command_id === id),
    );
    let coverage: unknown = null,
      tests: unknown = null,
      e2e: unknown = null;
    if (job.startsWith("test-") || job === "unsharded") {
      const leg = job === "unsharded" ? "unsharded" : job.slice(5);
      const coverageDirectory = job.startsWith("test-mocked-")
        ? "coverage-mocked"
        : "coverage";
      coverage = summaryCounts(coverageDirectory);
      const normalized = normalizeLcov(
        parseLcov(path.join(ROOT, coverageDirectory, "lcov.info")),
      );
      writeFileSync(path.join(directory, "lcov-" + leg + ".info"), normalized);
      const junit = job.startsWith("test-mocked-")
        ? "reports/junit/vitest-mocked.xml"
        : job === "unsharded"
          ? "reports/junit/vitest-full.xml"
          : "reports/junit/vitest.xml";
      tests = junitCounts(path.join(ROOT, junit));
    }
    if (job === "ui" && executed.some((item) => item.command_id === "ui-25"))
      e2e = e2eCounts();
    const actualTests = tests as { failed: number; errors: number } | null;
    const actualE2e = e2e as {
      stats: { unexpected: number };
      global_errors: number;
    } | null;
    const okay =
      process.env.QUALIFICATION_JOB_STATUS === "success" &&
      missing.length === 0 &&
      (!actualTests ||
        (actualTests.failed === 0 && actualTests.errors === 0)) &&
      (!actualE2e ||
        (actualE2e.stats.unexpected === 0 && actualE2e.global_errors === 0)) &&
      executed.length === expected.length &&
      receipts.every(
        (item) =>
          item.exit_code === 0 &&
          item.signal === null &&
          item.vitest_unhandled_errors === 0 &&
          !item.actual_unhandled_diagnostic,
      );
    const receipt = {
      status: okay ? "passed" : "failed_or_incomplete",
      job,
      force_full_qualification: true,
      source_head: overlay.source_head,
      canonical_base: manifest.base_commit,
      candidate_virtual_commit: overlay.candidate_virtual_commit,
      candidate_tree: overlay.candidate_tree,
      manifest_sha256: overlay.manifest_sha256,
      commands_sha256: process.env.FULL_VALIDATION_COMMANDS_SHA256,
      run_id: overlay.run_id,
      run_attempt: overlay.run_attempt,
      files: pins,
      commands_expected: expected.length,
      commands_executed: executed.length,
      actual_unhandled_diagnostic: receipts.some(
        (item) => item.actual_unhandled_diagnostic,
      ),
      vitest_unhandled_errors: receipts.reduce(
        (sum, item) => sum + item.vitest_unhandled_errors,
        0,
      ),
      missing_commands: missing,
      failed_commands: receipts
        .filter((item) => item.exit_code !== 0 || item.signal !== null)
        .map((item) => item.command_id),
      tests,
      e2e,
      coverage,
      observed_test_summaries: receipts.flatMap((item) =>
        item.observed_test_summaries.map((counts) => ({
          command_id: item.command_id,
          ...counts,
        })),
      ),
      real_codecov_pr_status: "unavailable",
      real_codecov_project_status: "unavailable",
      raw_output_retained: false,
      production_actions: false,
    };
    save(path.join(directory, "job-receipt.json"), receipt);
    save(path.join(directory, "overlay-receipt.json"), overlay);
    console.log(
      JSON.stringify({
        job,
        status: receipt.status,
        commands_expected: expected.length,
        commands_executed: executed.length,
        missing: missing.length,
        tests,
      }),
    );
    if (!okay) process.exitCode = 1;
  }
  function mergedLcov(reports: Map<string, LcovFile>[]) {
    const result = new Map<string, LcovFile>();
    const universe = [...reports[0].keys()].sort();
    for (const report of reports)
      assert.deepEqual([...report.keys()].sort(), universe);
    for (const file of universe) {
      const first = reports[0].get(file)!;
      const lines = new Map(first.lines),
        branches = new Map(first.branches);
      for (const report of reports.slice(1)) {
        const next = report.get(file)!;
        assert.deepEqual(
          [...next.lines.keys()].sort((a, b) => a - b),
          [...lines.keys()].sort((a, b) => a - b),
        );
        assert.deepEqual(
          [...next.branches.keys()].sort(),
          [...branches.keys()].sort(),
        );
        for (const [key, hits] of next.lines)
          lines.set(key, Math.max(lines.get(key)!, hits));
        for (const [key, hits] of next.branches)
          branches.set(key, Math.max(branches.get(key)!, hits));
      }
      result.set(file, { lines, branches });
    }
    return result;
  }
  interface JobReceipt {
    actual_unhandled_diagnostic: boolean;
    vitest_unhandled_errors: number;
    status: string;
    job: string;
    force_full_qualification: boolean;
    source_head: string;
    canonical_base: string;
    candidate_tree: string;
    candidate_virtual_commit: string;
    manifest_sha256: string;
    commands_sha256: string;
    run_id: string;
    run_attempt: string;
    files: SourceFile[];
    tests?: {
      tests: number;
      passed: number;
      failed: number;
      errors: number;
      skipped: number;
    };
    coverage?: Record<string, { total: number; covered: number }>;
    e2e?: {
      stats: Record<string, number>;
      attempts: number;
      retry_attempts: number;
      failed_attempts: number;
      attempt_errors: number;
      global_errors: number;
    };
  }
  function readJobReceipt(file: string): JobReceipt {
    return json(file, MAX_REPORT_BYTES) as JobReceipt;
  }
  function sourceArtifacts(entries: string[], attempt: string | undefined) {
    assert.match(attempt ?? "", /^[1-9]\d{0,8}$/);
    const prefix = "raw-capture-full-source-" + attempt + "-";
    assert.deepEqual(
      [...entries].sort(),
      JOBS.map((job) => prefix + job).sort(),
    );
    return prefix;
  }
  function receiptControls() {
    const directory = mkdtempSync(
      path.join(tmpdir(), "raw-capture-full-receipt-controls-"),
    );
    const file = path.join(directory, "job-receipt.json");
    let controls = 0;
    const check = (operation: () => void) => {
      operation();
      controls++;
    };
    const report = (outcomes: string[]) => ({
      stats: Object.fromEntries(
        ["expected", "unexpected", "flaky", "skipped"].map((outcome) => [
          outcome,
          outcomes.filter((item) => item === outcome).length,
        ]),
      ),
      suites: [
        {
          specs: [
            {
              tests: outcomes.map((status) => ({
                status,
                results: [
                  {
                    retry: 0,
                    status: status === "skipped" ? "skipped" : "passed",
                    errors: [],
                  },
                ],
              })),
            },
          ],
        },
      ],
      errors: [],
    });
    let largeReceiptBytes = 0;
    try {
      const large = {
        status: "passed",
        job: "ui",
        e2e: e2eReportCounts(report(Array(768).fill("expected"))),
      };
      check(() => {
        save(file, large);
        largeReceiptBytes = statSync(file).size;
        assert.ok(
          largeReceiptBytes > 131_072 && largeReceiptBytes < MAX_REPORT_BYTES,
        );
        assert.throws(() => json(file, 131_072), { code: "ERR_ASSERTION" });
        assert.deepEqual(readJobReceipt(file), large);
      });
      check(() => {
        truncateSync(file, MAX_REPORT_BYTES + 1);
        assert.equal(statSync(file).size, MAX_REPORT_BYTES + 1);
        assert.throws(() => readJobReceipt(file), { code: "ERR_ASSERTION" });
      });
      check(() => {
        writeFileSync(file, "{malformed");
        assert.throws(() => readJobReceipt(file), { name: "SyntaxError" });
      });
      check(() => {
        writeFileSync(file, "");
        assert.throws(() => readJobReceipt(file), { code: "ERR_ASSERTION" });
      });
      check(() => {
        const balanced = e2eReportCounts(
          report(["expected", "unexpected", "flaky", "skipped"]),
        );
        assert.deepEqual(balanced.stats, {
          expected: 1,
          unexpected: 1,
          flaky: 1,
          skipped: 1,
        });
        assert.equal(balanced.cases.length, 4);
        assert.equal(balanced.attempts, 4);
      });
      check(() => {
        const mismatch = report(Array(768).fill("expected"));
        mismatch.stats.expected--;
        mismatch.stats.flaky++;
        assert.throws(() => e2eReportCounts(mismatch));
      });
      check(() => {
        const mismatch = report(["expected"]);
        mismatch.stats.expected++;
        assert.throws(() => e2eReportCounts(mismatch));
      });
      for (const malformedStats of [
        undefined,
        null,
        "invalid",
        { expected: 1, unexpected: 0, flaky: 0 },
        { expected: -1, unexpected: 0, flaky: 0, skipped: 0 },
        { expected: 1.5, unexpected: 0, flaky: 0, skipped: 0 },
        { expected: "1", unexpected: 0, flaky: 0, skipped: 0 },
        {
          expected: Number.MAX_SAFE_INTEGER + 1,
          unexpected: 0,
          flaky: 0,
          skipped: 0,
        },
      ])
        check(() =>
          assert.throws(() =>
            e2eReportCounts({ ...report(["expected"]), stats: malformedStats }),
          ),
        );
      for (const status of ["passed", "Expected", "unknown"])
        check(() => assert.throws(() => e2eReportCounts(report([status]))));
      check(() => assert.throws(() => e2eReportCounts(report([]))));
      check(() => {
        const noAttempts = report(["expected"]);
        noAttempts.suites[0].specs[0].tests[0].results = [];
        assert.throws(() => e2eReportCounts(noAttempts));
      });
      const names = JOBS.map((job) => "raw-capture-full-source-2-" + job);
      check(() =>
        assert.equal(sourceArtifacts(names, "2"), "raw-capture-full-source-2-"),
      );
      check(() => assert.throws(() => sourceArtifacts(names, "1")));
      check(() => assert.throws(() => sourceArtifacts(names.slice(1), "2")));
      check(() =>
        assert.throws(() =>
          sourceArtifacts([...names, "raw-capture-full-proof-2"], "2"),
        ),
      );
      check(() =>
        assert.throws(() =>
          sourceArtifacts(
            [...names.slice(1), "raw-capture-full-source-2-impostor"],
            "2",
          ),
        ),
      );
      check(() =>
        assert.throws(() =>
          sourceArtifacts([...names.slice(1), names[1]], "2"),
        ),
      );
      for (const attempt of [undefined, "0", "01", "-1", "2/x", "1000000000"])
        check(() => assert.throws(() => sourceArtifacts(names, attempt)));
      assert.equal(controls, 32);
      return {
        status: "receipt_selfcheck_passed",
        receipt_controls_passed: controls,
        large_receipt_bytes: largeReceiptBytes,
        former_reader_maximum: 131_072,
        reader_writer_maximum: MAX_REPORT_BYTES,
        source_artifacts_required: JOBS.length,
        raw_output_retained: false,
        production_actions: false,
      };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  function merge() {
    const directory = path.join(SCRATCH, "downloaded");
    const entries = readdirSync(directory).sort();
    const artifactPrefix = sourceArtifacts(
      entries,
      process.env.GITHUB_RUN_ATTEMPT,
    );
    const byJob = new Map<string, { receipt: JobReceipt; directory: string }>();
    for (const name of entries) {
      const artifactDirectory = path.join(directory, name);
      const receipt = readJobReceipt(
        path.join(artifactDirectory, "job-receipt.json"),
      );
      assert.equal(name, artifactPrefix + receipt.job);
      assert.ok(JOBS.includes(receipt.job) && !byJob.has(receipt.job));
      assert.equal(receipt.status, "passed");
      assert.equal(receipt.actual_unhandled_diagnostic, false);
      assert.equal(receipt.vitest_unhandled_errors, 0);
      assert.equal(receipt.force_full_qualification, true);
      assert.equal(receipt.source_head, overlay.source_head);
      assert.equal(receipt.canonical_base, manifest.base_commit);
      assert.equal(receipt.candidate_tree, overlay.candidate_tree);
      assert.equal(
        receipt.candidate_virtual_commit,
        overlay.candidate_virtual_commit,
      );
      assert.equal(receipt.manifest_sha256, overlay.manifest_sha256);
      assert.equal(
        receipt.commands_sha256,
        process.env.FULL_VALIDATION_COMMANDS_SHA256,
      );
      assert.equal(receipt.run_id, process.env.GITHUB_RUN_ID);
      assert.equal(String(receipt.run_attempt), process.env.GITHUB_RUN_ATTEMPT);
      assert.deepEqual(receipt.files, sourcePins());
      byJob.set(receipt.job, { receipt, directory: artifactDirectory });
    }
    const full = byJob.get("unsharded")!.receipt;
    assert.ok(full.tests && full.tests.tests > 0);
    assert.equal(full.tests.failed, 0);
    assert.equal(full.tests.errors, 0);
    for (const [metric, floor] of Object.entries({
      branches: 85,
      functions: 90,
      lines: 92,
      statements: 92,
    })) {
      const item = full.coverage?.[metric];
      assert.ok(item && item.total > 0);
      assert.ok(item.covered * 100 >= item.total * floor);
    }
    const legs = LEGS.map((leg) => {
      const item = byJob.get("test-" + leg)!;
      assert.ok(item.receipt.tests && item.receipt.tests.tests > 0);
      assert.equal(item.receipt.tests.failed, 0);
      assert.equal(item.receipt.tests.errors, 0);
      return parseLcov(path.join(item.directory, "lcov-" + leg + ".info"));
    });
    const union = mergedLcov(legs);
    const unsharded = parseLcov(
      path.join(byJob.get("unsharded")!.directory, "lcov-unsharded.info"),
    );
    // A separate unsharded map is also required for every changed obligation;
    // disagreements are reported conservatively rather than silently merged.
    const changed = new Map<string, Set<number>>();
    const patch = bytes(
      path.join(SCRATCH, "runtime.patch"),
      1024 * 1024,
    ).toString("utf8");
    assert.equal(hash(Buffer.from(patch)), overlay.runtime_patch_sha256);
    let current = "";
    for (const line of patch.split("\n")) {
      if (line.startsWith("+++ b/")) {
        current = sourcePath(line.slice(6));
        assert.match(current, /^(?:src|workers)\//);
        changed.set(current, new Set());
      } else if (line.startsWith("@@")) {
        const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
        assert.ok(match && current);
        const first = Number(match[1]),
          count = match[2] === undefined ? 1 : Number(match[2]);
        assert.ok(count < 100_000);
        for (let i = 0; i < count; i++) changed.get(current)!.add(first + i);
      }
    }
    assert.ok(changed.size > 0);
    let linesTotal = 0,
      linesCovered = 0,
      branchesTotal = 0,
      branchesCovered = 0;
    const uncovered: {
      file: string;
      line: number;
      kind: string;
      branch?: string;
    }[] = [];
    for (const [file, changedLines] of changed) {
      const shared = union.get(file),
        whole = unsharded.get(file);
      assert.ok(
        shared && whole && shared.lines.size > 0 && whole.lines.size > 0,
      );
      assert.deepEqual(
        [...shared.lines.keys()].sort((a, b) => a - b),
        [...whole.lines.keys()].sort((a, b) => a - b),
      );
      assert.deepEqual(
        [...shared.branches.keys()].sort(),
        [...whole.branches.keys()].sort(),
      );
      for (const [line, hits] of shared.lines) {
        if (!changedLines.has(line)) continue;
        linesTotal++;
        if (hits > 0 && whole.lines.get(line)! > 0) linesCovered++;
        else uncovered.push({ file, line, kind: "line" });
      }
      for (const [branch, hits] of shared.branches) {
        const line = Number(branch.split(",")[0]);
        if (!changedLines.has(line)) continue;
        branchesTotal++;
        if (hits > 0 && whole.branches.get(branch)! > 0) branchesCovered++;
        else uncovered.push({ file, line, kind: "branch", branch });
      }
    }
    assert.ok(linesTotal > 0 && branchesTotal > 0 && uncovered.length <= 4096);
    const covered = linesCovered + branchesCovered,
      total = linesTotal + branchesTotal;
    const passed = covered * 100 >= total * 99;
    const proof = path.join(OUTPUT, "proof");
    mkdirSync(proof, { recursive: true });
    writeFileSync(path.join(proof, "merged-lcov.info"), normalizeLcov(union));
    for (const item of manifest.files) {
      const destination = path.join(proof, "source", item.path);
      mkdirSync(path.dirname(destination), { recursive: true });
      copyFileSync(path.join(ROOT, item.path), destination);
    }
    const receipt = {
      status: passed
        ? "native_full_and_offline_patch_passed"
        : "offline_patch_failed",
      scope:
        "Actual native commands plus unsharded native backstops; conservative changed LCOV line-plus-branch obligations, not an authenticated Codecov service verdict",
      run_id: process.env.GITHUB_RUN_ID,
      run_attempt: process.env.GITHUB_RUN_ATTEMPT,
      source_head: overlay.source_head,
      canonical_base: manifest.base_commit,
      candidate_virtual_commit: overlay.candidate_virtual_commit,
      candidate_tree: overlay.candidate_tree,
      manifest_sha256: overlay.manifest_sha256,
      commands_sha256: process.env.FULL_VALIDATION_COMMANDS_SHA256,
      files: sourcePins(),
      jobs: [...byJob].map(([job, item]) => ({
        job,
        tests: item.receipt.tests ?? null,
        coverage: item.receipt.coverage ?? null,
        actual_unhandled_diagnostic: item.receipt.actual_unhandled_diagnostic,
        vitest_unhandled_errors: item.receipt.vitest_unhandled_errors,
        e2e: item.receipt.e2e
          ? {
              stats: item.receipt.e2e.stats,
              attempts: item.receipt.e2e.attempts,
              retry_attempts: item.receipt.e2e.retry_attempts,
              failed_attempts: item.receipt.e2e.failed_attempts,
              attempt_errors: item.receipt.e2e.attempt_errors,
              global_errors: item.receipt.e2e.global_errors,
            }
          : null,
      })),
      offline_patch: {
        target: 99,
        slack: 0,
        lines: { covered: linesCovered, total: linesTotal },
        branches: { covered: branchesCovered, total: branchesTotal },
        combined: { covered, total },
        uncovered,
        formula:
          "(covered changed instrumented lines + covered associated branches) / all such obligations; each must be hit in both the complete shard union and unsharded run",
      },
      real_codecov_pr_status:
        "unavailable_without_authorized_canonical_runtime_PR",
      real_codecov_project_status:
        "unavailable_without_authenticated_base_comparison",
      production_actions: false,
      raw_output_retained: false,
    };
    save(path.join(proof, "full-validation-receipt.json"), receipt);
    console.log(
      JSON.stringify({
        status: receipt.status,
        jobs: byJob.size,
        lines: receipt.offline_patch.lines,
        branches: receipt.offline_patch.branches,
        real_codecov_pr_status: receipt.real_codecov_pr_status,
      }),
    );
    if (!passed) process.exitCode = 1;
  }
  const mode = process.argv[2];
  try {
    if (mode === "selfcheck") diagnosticControls();
    else if (mode === "run") await run(safeId(process.argv[3]));
    else if (mode === "finalize")
      finalize(safeId(process.env.QUALIFICATION_JOB_ID));
    else if (mode === "merge") merge();
    else throw new Error("unsupported mode");
  } catch {
    const job = safeId(process.env.QUALIFICATION_JOB_ID);
    const failure = {
      status: "failed_or_incomplete",
      phase:
        mode === "run"
          ? "command_wrapper"
          : mode === "finalize"
            ? "job_curation"
            : "offline_aggregation",
      job,
      run_id: process.env.GITHUB_RUN_ID,
      run_attempt: process.env.GITHUB_RUN_ATTEMPT,
      manifest_sha256: process.env.FULL_VALIDATION_MANIFEST_SHA256,
      commands_sha256: process.env.FULL_VALIDATION_COMMANDS_SHA256,
      error_class: "bounded_contract_failure",
      raw_output_retained: false,
      production_actions: false,
    };
    save(path.join(outputDirectory(job), "failure-receipt.json"), failure);
    console.error(JSON.stringify(failure));
    process.exitCode = 1;
  }
}

await main().catch(() => {
  console.error(
    JSON.stringify({
      status: "failed_or_incomplete",
      phase: "carrier_initialization",
      error_class: "bounded_contract_failure",
      raw_output_retained: false,
      production_actions: false,
    }),
  );
  process.exitCode = 1;
});
