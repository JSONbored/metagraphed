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
    console.log(
      JSON.stringify({
        ...diagnosticControls(),
        ...helperTypeControls(),
        ...inspectorMessageControls(),
      }),
    );
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

  interface HelperTypeSource {
    helper_id: number;
    file: string;
    sha256: string;
    bytes: number;
    line_lengths: number[];
  }
  function helperTypeFiles() {
    return [
      ".github/scripts/qualify-raw-capture-resources.ts",
      ".github/fixtures/raw-capture-resource-worker.ts",
      ".github/scripts/gate-raw-capture-resources.ts",
      ".github/fixtures/raw-capture-ws-declarations/index.d.mts",
    ];
  }
  interface HelperTypeOutcome {
    exit_code: number | null;
    signal: string | null;
    process_error: boolean;
  }
  function projectHelperTypes(
    stdout: string,
    stderr: string,
    sources: HelperTypeSource[],
    native: HelperTypeOutcome,
  ) {
    const maximum = 1024 * 1024;
    let truncated =
      Buffer.byteLength(stdout) > maximum ||
      Buffer.byteLength(stderr) > maximum;
    const prefix = (value: string) =>
      Buffer.from(value.slice(0, maximum))
        .subarray(0, maximum)
        .toString("utf8");
    const lines = (prefix(stdout) + "\n" + prefix(stderr)).split(/\r?\n/);
    if (lines.length > 8192) truncated = true;
    const codeCounts: Record<string, number> = {};
    const frames: {
      helper_id: number;
      sha256: string;
      code: string;
      line: number;
      column: number;
    }[] = [];
    let diagnostics = 0,
      unknownSources = 0,
      refusedLocations = 0,
      globalDiagnostics = 0,
      malformedDiagnostics = 0;
    const included = new Set<number>();
    for (const raw of lines.slice(0, 8192)) {
      const line = stripVTControlCharacters(raw);
      for (const source of sources)
        if (
          [source.file, "./" + source.file, path.resolve(source.file)].includes(
            line.trim(),
          )
        )
          included.add(source.helper_id);
      const located =
        /^(.*)\(([^,()]*),([^()]*)\): (?:error|warning) (TS[^\s:]{1,12}):/.exec(
          line,
        );
      const global = /^(?:error|warning) (TS[^\s:]{1,12}):/.exec(line);
      if (!located && !global) continue;
      diagnostics++;
      const code = located ? located[4] : global![1];
      if (!/^TS\d{3,6}$/.test(code)) {
        malformedDiagnostics++;
        continue;
      }
      if (code in codeCounts || Object.keys(codeCounts).length < 32)
        codeCounts[code] = (codeCounts[code] ?? 0) + 1;
      else truncated = true;
      if (!located) {
        globalDiagnostics++;
        continue;
      }
      const source = sources.find((item) =>
        [item.file, "./" + item.file, path.resolve(item.file)].includes(
          located[1],
        ),
      );
      if (!source) {
        unknownSources++;
        continue;
      }
      const at = Number(located[2]),
        column = Number(located[3]);
      if (
        !/^\d+$/.test(located[2]) ||
        !/^\d+$/.test(located[3]) ||
        !Number.isSafeInteger(at) ||
        at <= 0 ||
        at > source.line_lengths.length ||
        !Number.isSafeInteger(column) ||
        column <= 0 ||
        column > source.line_lengths[at - 1] + 1
      ) {
        refusedLocations++;
        continue;
      }
      if (
        frames.some(
          (item) =>
            item.helper_id === source.helper_id &&
            item.code === code &&
            item.line === at &&
            item.column === column,
        )
      )
        continue;
      if (frames.length === 64) {
        truncated = true;
        continue;
      }
      frames.push({
        helper_id: source.helper_id,
        sha256: source.sha256,
        code,
        line: at,
        column,
      });
    }
    return {
      native_exit_code: native.exit_code,
      native_signal: native.signal,
      process_error: native.process_error,
      native_success:
        native.exit_code === 0 &&
        native.signal === null &&
        !native.process_error &&
        !truncated &&
        diagnostics === 0,
      diagnostic_count: diagnostics,
      code_counts: codeCounts,
      frames,
      unknown_source_diagnostics: unknownSources,
      refused_locations: refusedLocations,
      global_diagnostics: globalDiagnostics,
      malformed_diagnostics: malformedDiagnostics,
      projection_truncated: truncated,
      included_helper_ids: [...included].sort((a, b) => a - b),
      helper_sources: sources.map((source) => ({
        helper_id: source.helper_id,
        sha256: source.sha256,
        bytes: source.bytes,
        lines: source.line_lengths.length,
      })),
      raw_output_retained: false,
    };
  }
  function helperTypeControls() {
    const sources = helperTypeFiles().map((file, helper_id) => ({
      helper_id,
      file,
      sha256: "0".repeat(64),
      bytes: 12,
      line_lengths: ["a😀b", "second"].map((line) => line.length),
    }));
    const good: HelperTypeOutcome = {
      exit_code: 0,
      signal: null,
      process_error: false,
    };
    const one = (text: string, native = good) =>
      projectHelperTypes(text, "", sources, native);
    let checked = 0;
    const declaration = one(
      sources[3].file + "(1,1): error TS2345: withheld\n" + sources[3].file,
    );
    assert.equal(declaration.frames[0].helper_id, 3);
    assert.equal(declaration.frames[0].sha256, sources[3].sha256);
    assert.deepEqual(declaration.included_helper_ids, [3]);
    checked++;
    for (const file of [
      sources[0].file,
      "./" + sources[0].file,
      path.resolve(sources[0].file),
    ]) {
      const value = one(
        file + "(2,7): error TS2345: withheld message\n" + file,
      );
      assert.deepEqual(value.frames, [
        {
          helper_id: 0,
          sha256: sources[0].sha256,
          code: "TS2345",
          line: 2,
          column: 7,
        },
      ]);
      assert.equal(value.diagnostic_count, 1);
      assert.equal(value.unknown_source_diagnostics, 0);
      assert.deepEqual(value.included_helper_ids, [0]);
      checked++;
    }
    for (const text of [
      sources[0].file + "(0,1): error TS2345: withheld",
      sources[0].file + "(3,1): error TS2345: withheld",
      sources[0].file + "(1,0): error TS2345: withheld",
      sources[0].file + "(1,7): error TS2345: withheld",
      sources[0].file + "(9007199254740992,1): error TS2345: withheld",
    ]) {
      const value = one(text);
      assert.equal(value.frames.length, 0);
      assert.equal(value.refused_locations, 1);
      checked++;
    }
    const unknown = one("other/private-file.ts(1,1): error TS2304: withheld");
    assert.equal(unknown.unknown_source_diagnostics, 1);
    assert.deepEqual(unknown.frames, []);
    checked++;
    const global = one("error TS18003: withheld path and message");
    assert.equal(global.global_diagnostics, 1);
    assert.deepEqual(global.frames, []);
    checked++;
    const ansi = one(
      "\u001b[31m" + sources[2].file + "(1,1): error TS2322: withheld\u001b[0m",
    );
    assert.equal(ansi.frames[0].helper_id, 2);
    checked++;
    const repeated = one(
      (sources[0].file + "(1,1): error TS2345: withheld\n").repeat(3),
    );
    assert.equal(repeated.frames.length, 1);
    assert.equal(repeated.code_counts.TS2345, 3);
    checked++;
    for (const text of [
      "TS2345 is data",
      "stdout | named error TS1234: data",
      "src/else.ts(1,1): message TS2345: data",
    ]) {
      assert.equal(one(text).diagnostic_count, 0);
      checked++;
    }
    const malformed = one("error TS12: withheld");
    assert.equal(malformed.malformed_diagnostics, 1);
    assert.equal(malformed.native_success, false);
    checked++;
    for (const native of [
      { exit_code: 2, signal: null, process_error: false },
      { exit_code: 0, signal: "SIGTERM", process_error: false },
      { exit_code: 0, signal: null, process_error: true },
      { exit_code: null, signal: null, process_error: false },
    ]) {
      const value = one("", native);
      assert.equal(value.native_success, false);
      assert.equal(value.native_exit_code, native.exit_code);
      assert.equal(value.native_signal, native.signal);
      checked++;
    }
    assert.equal(one("").native_success, true);
    checked++;
    assert.equal(
      one(sources[0].file + "(1,1): error TS2345: withheld").native_success,
      false,
    );
    checked++;
    assert.equal(
      one(sources[0].file + "(1,5): error TS2345: withheld").frames.length,
      1,
    );
    assert.equal(
      one(sources[0].file + "(1,6): error TS2345: withheld").refused_locations,
      1,
    );
    checked++;
    assert.equal(one("x".repeat(1024 * 1024 + 1)).projection_truncated, true);
    checked++;
    assert.equal(one("\n".repeat(8193)).projection_truncated, true);
    checked++;
    const codes = one(
      Array.from(
        { length: 33 },
        (_, index) => "error TS" + (1000 + index) + ": withheld",
      ).join("\n"),
    );
    assert.equal(Object.keys(codes.code_counts).length, 32);
    assert.equal(codes.projection_truncated, true);
    checked++;
    assert.equal(JSON.stringify(unknown).includes("private-file"), false);
    checked++;
    const crowdedSources = sources.map((source) => ({
      ...source,
      line_lengths: [100, 100],
    }));
    const crowded = projectHelperTypes(
      Array.from(
        { length: 65 },
        (_, index) =>
          sources[index % 3].file +
          "(1," +
          (1 + Math.floor(index / 3)) +
          "): error TS2345: withheld",
      ).join("\n"),
      "",
      crowdedSources,
      good,
    );
    assert.equal(crowded.frames.length, 64);
    assert.equal(crowded.projection_truncated, true);
    checked++;
    assert.equal(
      projectHelperTypes(
        "",
        sources[0].file + "(1,1): error TS2345: withheld",
        sources,
        good,
      ).frames[0].helper_id,
      0,
    );
    checked++;
    assert.equal(checked, 30);
    return {
      helper_type_controls_passed: checked,
      helper_type_sources: sources.length,
    };
  }

  function inspectorMessageControls() {
    const withinLimit = (raw: Buffer | Buffer[] | ArrayBuffer) =>
      "length" in raw && raw.length <= 65536;
    const buffer = Buffer.alloc(0);
    const cases: [Buffer | Buffer[] | ArrayBuffer, boolean][] = [
      [buffer, true],
      [Buffer.alloc(65536), true],
      [Buffer.alloc(65537), false],
      [Array<Buffer>(65536).fill(buffer), true],
      [Array<Buffer>(65537).fill(buffer), false],
      [new ArrayBuffer(1), false],
      [new ArrayBuffer(65536), false],
    ];
    for (const [raw, expected] of cases)
      assert.equal(withinLimit(raw), expected);
    return { inspector_message_controls_passed: cases.length };
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
  const typeDependencyFiles = [
    ".github/fixtures/raw-capture-ws-declarations/index.d.mts",
    ".github/fixtures/raw-capture-ws-declarations/LICENSE",
    ".github/fixtures/raw-capture-ws-declarations/provenance.json",
  ];
  const workflowPath =
    ".github/workflows/raw-capture-resource-qualification.yml";
  const carrierFiles = [
    ...helperFiles,
    ...typeDependencyFiles,
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
      type_dependency_pins: Pin[];
      required_native_steps: { format: string[]; qualify: string[] };
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
  assert.equal(carrierFiles.length, 17);
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
  const typeDependencyPinsBefore = pins(typeDependencyFiles);
  assert.deepEqual(manifest.resource_gate.helper_pins, helperPinsBefore);
  assert.deepEqual(
    manifest.resource_gate.type_dependency_pins,
    typeDependencyPinsBefore,
  );
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
  let helperTypeControlsPassed = 0;
  let helperTypeDiagnostics: ReturnType<typeof projectHelperTypes> | null =
    null;
  const native = (
    step: string,
    command: string,
    args: string[],
    maximumSeconds = 180,
  ) => {
    const helperTypeSources =
      step === "helper_types"
        ? helperTypeFiles().map((file, helper_id) => {
            const bytes = read(file);
            return {
              helper_id,
              file,
              sha256: digest(bytes),
              bytes: bytes.length,
              line_lengths: bytes
                .toString("utf8")
                .split(/\r?\n/)
                .map((line) => line.length),
            };
          })
        : null;
    if (helperTypeSources) {
      helperTypeControlsPassed =
        helperTypeControls().helper_type_controls_passed;
      assert.equal(helperTypeControlsPassed, 30);
      assert.deepEqual(
        helperTypeSources.map((source) => source.file),
        [
          ...helperFiles.filter((file) => file.endsWith(".ts")),
          typeDependencyFiles[0],
        ],
      );
    }
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
    if (helperTypeSources) {
      helperTypeDiagnostics = projectHelperTypes(
        result.stdout ?? "",
        result.stderr ?? "",
        helperTypeSources,
        {
          exit_code: result.status,
          signal: result.signal,
          process_error: result.error !== undefined,
        },
      );
      for (const source of helperTypeSources)
        assert.equal(digest(read(source.file)), source.sha256);
    }
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(observed.actualUnhandled, false);
    assert.equal(observed.vitestUnhandled, 0);
    assert.equal(result.status, 0);
    if (step === "helper_types") {
      assert.ok(helperTypeDiagnostics);
      assert.equal(helperTypeDiagnostics.projection_truncated, false);
      assert.equal(helperTypeDiagnostics.native_success, true);
      assert.deepEqual(helperTypeDiagnostics.included_helper_ids, [0, 1, 2, 3]);
    }
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
    typeInputsConfirmed = 0,
    declarationInputsConfirmed = 0,
    inspectorMessageControlsPassed = 0;
  let workspacePretypecheck: {
    command: string[];
    root_script: string;
    workspace_script: string;
    tracked_inputs_unchanged: boolean;
    source_manifest_sha256: string;
    declaration: Pin;
  } | null = null;
  const requiredNativeSteps =
    phase === "format"
      ? [
          "format",
          "workflow_reformat",
          "lint",
          "workspace_pretypecheck",
          "helper_types",
          "workflow_policy",
        ]
      : [
          "format",
          "lint",
          "workspace_pretypecheck",
          "helper_types",
          "workflow_policy",
        ];
  assert.deepEqual(
    manifest.resource_gate.required_native_steps[phase],
    requiredNativeSteps,
  );
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
    stage = "inspector_message_controls";
    inspectorMessageControlsPassed =
      inspectorMessageControls().inspector_message_controls_passed;
    assert.equal(inspectorMessageControlsPassed, 7);
    assert.equal(
      [
        ...read(helperFiles[0])
          .toString("utf8")
          .matchAll(
            /assert\.ok\(\s*"length" in raw && raw\.length <= 65536,\s*"bounded inspector message",?\s*\);/g,
          ),
      ].length,
      1,
    );
    stage = "workspace_pretypecheck";
    const rootScripts = JSON.parse(
      read("package.json").toString("utf8"),
    ).scripts;
    const workspaceScripts = JSON.parse(
      read("packages/chain-summaries/package.json").toString("utf8"),
    ).scripts;
    assert.equal(
      rootScripts.pretypecheck,
      "npm run build --workspace=packages/chain-summaries",
    );
    assert.equal(rootScripts.prepretypecheck, undefined);
    assert.equal(rootScripts.postpretypecheck, undefined);
    assert.equal(
      workspaceScripts.build,
      "tsup src/index.ts --format esm,cjs --dts --dts-resolve --clean --treeshake",
    );
    assert.equal(workspaceScripts.prebuild, undefined);
    assert.equal(workspaceScripts.postbuild, undefined);
    const workspaceInputs = [
      "package.json",
      "package-lock.json",
      "packages/chain-summaries",
    ];
    const sourceManifest = git([
      "ls-tree",
      "-r",
      "HEAD",
      "--",
      ...workspaceInputs,
    ]);
    native("workspace_pretypecheck", "npm", ["run", "pretypecheck"]);
    git(["diff", "--exit-code", "HEAD", "--", ...workspaceInputs]);
    assert.deepEqual(
      git(["ls-tree", "-r", "HEAD", "--", ...workspaceInputs]),
      sourceManifest,
    );
    const declarationPath = "packages/chain-summaries/dist/index.d.ts";
    assert.equal(
      git(["check-ignore", "--", declarationPath]).toString("utf8").trim(),
      declarationPath,
    );
    const declarationBytes = read(declarationPath, 1048576);
    workspacePretypecheck = {
      command: ["npm", "run", "pretypecheck"],
      root_script: rootScripts.pretypecheck,
      workspace_script: workspaceScripts.build,
      tracked_inputs_unchanged: true,
      source_manifest_sha256: digest(sourceManifest),
      declaration: {
        path: declarationPath,
        bytes: declarationBytes.length,
        sha256: digest(declarationBytes),
        blob: blob(declarationBytes),
      },
    };
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
    declarationInputsConfirmed = Number(
      listed.includes(path.resolve(typeDependencyFiles[0])),
    );
    assert.equal(declarationInputsConfirmed, 1);
    stage = "observer_controls";
    observerControls = diagnosticControls().diagnostic_controls_passed;
    assert.equal(observerControls, 38);
    stage = "workflow_policy";
    native("workflow_policy", "npm", ["run", "validate:workflows"]);
    // Only the canonical workspace declaration prerequisite builds in format mode;
    // no API Worker builder, runtime formatter or capture is invoked here.
    for (const file of runtimeFiles)
      assert.equal(digest(read(file)), candidate.files[file].sha256);
    assert.deepEqual(
      nativeReceipts.map((step) => step.step),
      requiredNativeSteps,
    );
    if (phase === "qualify") {
      assert.deepEqual(pins(helperFiles), helperPinsBefore);
      assert.deepEqual(pins(typeDependencyFiles), typeDependencyPinsBefore);
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
  const sourcePinsAfter = pins([
    ...helperFiles,
    ...typeDependencyFiles,
    workflowPath,
    manifestPath,
  ]);
  const retainSources = () => {
    for (const pin of sourcePinsAfter) {
      const destination = path.join(upload, "source", pin.path);
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, read(pin.path));
    }
  };
  retainSources();
  if (status === "native_checks_passed_resource_not_run" && restored) {
    assert.deepEqual(
      nativeReceipts.map((step) => step.step),
      requiredNativeSteps,
    );
    assert.ok(workspacePretypecheck);
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
      type_dependency_pins: pins(typeDependencyFiles),
      canonical_runtime_restored: true,
      canonical_runtime_manifest_sha256: canonicalManifest,
      native_steps: nativeReceipts,
      required_native_steps: requiredNativeSteps,
      workspace_pretypecheck: workspacePretypecheck,
      observer_controls_passed: observerControls,
      type_inputs_confirmed: typeInputsConfirmed,
      declaration_inputs_confirmed: declarationInputsConfirmed,
      inspector_message_controls_passed: inspectorMessageControlsPassed,
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
        ...typeDependencyPinsBefore,
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
      required_native_steps: requiredNativeSteps,
      workspace_pretypecheck: workspacePretypecheck,
      observer_controls_passed: observerControls,
      type_inputs_confirmed: typeInputsConfirmed,
      declaration_inputs_confirmed: declarationInputsConfirmed,
      inspector_message_controls_passed: inspectorMessageControlsPassed,
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
      ...typeDependencyPinsBefore,
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
    required_native_steps: requiredNativeSteps,
    workspace_pretypecheck: workspacePretypecheck,
    lint_diagnostics: lintDiagnostics,
    helper_type_controls_passed: helperTypeControlsPassed,
    helper_type_diagnostics: helperTypeDiagnostics,
    observer_controls_passed: observerControls,
    type_inputs_confirmed: typeInputsConfirmed,
    declaration_inputs_confirmed: declarationInputsConfirmed,
    inspector_message_controls_passed: inspectorMessageControlsPassed,
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
