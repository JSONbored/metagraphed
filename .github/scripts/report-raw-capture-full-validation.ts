import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

async function main() {
  if (process.argv[2] === "selfcheck") {
    diagnosticControls();
    return;
  }
  const ROOT = realpathSync(process.env.GITHUB_WORKSPACE ?? process.cwd());
  const FIXTURES = ".github/fixtures/raw-capture-full-validation/";
  const SCRATCH = path.join(ROOT, "tmp/raw-capture-full-validation");
  const OUTPUT = path.join(SCRATCH, "upload");
  const MAX_REPORT_BYTES = 32 * 1024 * 1024;
  const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
  const MAX_RECORDS = 2_000_000;
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
      const clean = line.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
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
      "Uncaught Exception: synthetic diagnostic\n",
      "(node:123) UnhandledPromiseRejectionWarning: synthetic diagnostic\n",
      "Uncaught Error: synthetic diagnostic\n",
      "✘ [ERROR] Uncaught (in promise) TypeError: synthetic diagnostic\n",
      "\u001b[31m⎯⎯⎯ Unhandled Errors ⎯⎯⎯\u001b[39m\nVitest caught 2 unhandled errors during the test run.\n",
    ];
    const negatives = [
      ' ✓ refuses "Unhandled Rejection" inputs\n',
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
    console.log(
      JSON.stringify({
        diagnostic_controls_passed: positives.length * 4 + negatives.length + 2,
        raw_output_retained: false,
      }),
    );
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
          current.branches.set(key, fields[3] === "-" ? 0 : integer(fields[3]));
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
    const report = json(
      path.join(ROOT, "apps/ui/test-results/e2e-results.json"),
    ) as Record<string, unknown>;
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
  function merge() {
    const directory = path.join(SCRATCH, "downloaded");
    const entries = readdirSync(directory).sort();
    assert.equal(entries.length, JOBS.length);
    const byJob = new Map<string, { receipt: JobReceipt; directory: string }>();
    for (const name of entries) {
      assert.match(name, /^raw-capture-full-[a-z0-9-]+$/);
      const artifactDirectory = path.join(directory, name);
      const receipt = json(
        path.join(artifactDirectory, "job-receipt.json"),
        131_072,
      ) as JobReceipt;
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
