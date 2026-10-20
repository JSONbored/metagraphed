import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

const BASE = "0a65fcffd51b0a6a2b9757905be02c1d8b859e6c";
const DIRECTORY = "queue-architecture-reports";
const MANIFEST = ".github/fixtures/queue-memory-architecture/manifest.json";
const SELF = ".github/scripts/check-queue-memory-architecture.ts";
const MODES = ["apply", "controls", "format", "lint", "types", "helper_types", "boundary", "workflow", "tests"] as const;
type Mode = typeof MODES[number];
interface Payload {
  path: string; payload: string; bytes: number; sha256: string;
  expected_base_blob_sha: string | null;
}
interface Manifest {
  version: number; base_commit: string; fixed_branch: string; scope: string;
  files: Payload[]; carrier_files: string[]; tests: string[];
  required_phases: Mode[]; format_files: string[]; lint_files: string[];
  source_ids: string[];
  helper_sha256: string;
}
interface Source {
  source_id: number; path: string; sha256: string; bytes: number;
  line_lengths: number[];
}
type Frame = { source_id: number; sha256: string; line: number; column: number };
const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const record = (value: unknown): Record<string, unknown> => {
  assert(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
};
const array = (value: unknown): unknown[] => { assert(Array.isArray(value)); return value; };
const integer = (value: unknown, maximum = Number.MAX_SAFE_INTEGER): number => {
  assert(typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum);
  return value;
};
const text = (value: unknown, maximum = 1024 * 1024): string => {
  assert(typeof value === "string" && Buffer.byteLength(value) <= maximum);
  return value;
};
const git = (...args: string[]) => execFileSync("git", args, {
  encoding: "utf8", stdio: "pipe", maxBuffer: 1024 * 1024, timeout: 30000,
}).trim();
const readJSON = (path: string, maximum: number): unknown => {
  const info = statSync(path); assert(info.isFile() && info.size > 0 && info.size <= maximum);
  const bytes = readFileSync(path); assert.equal(bytes.length, info.size);
  return JSON.parse(bytes.toString("utf8")) as unknown;
};
const pin = (path: string, source_id: number): Source => {
  const info = statSync(path);
  assert(info.isFile() && info.size > 0 && info.size <= 1024 * 1024);
  const bytes = readFileSync(path); assert.equal(bytes.length, info.size);
  return {source_id, path, sha256: digest(bytes), bytes: bytes.length,
    line_lengths: bytes.toString("utf8").split(/\r?\n/).map((line) => line.length)};
};
const publicPins = (sources: Source[]) => sources.map((source) => ({
  source_id: source.source_id, path: source.path, sha256: source.sha256,
  bytes: source.bytes, lines: source.line_lengths.length,
}));
function frame(source: Source, line: unknown, column: unknown): Frame | null {
  if (typeof line !== "number" || !Number.isSafeInteger(line) || line < 1 ||
      line > source.line_lengths.length || typeof column !== "number" ||
      !Number.isSafeInteger(column) || column < 1 || column > source.line_lengths[line - 1]! + 1) return null;
  return {source_id: source.source_id, sha256: source.sha256, line, column};
}
function sourceFor(path: string, sources: Source[]) {
  return sources.find((source) => [source.path, "./" + source.path, resolve(source.path)].includes(path));
}
function nativeMarkers(stdout: string, stderr: string) {
  return /Unhandled Errors|Vitest caught \d+ unhandled errors?|Source Errors|Unhandled Rejection|Uncaught Exception/i.test(stdout + "\n" + stderr);
}
function typeProjection(stdout: string, stderr: string, sources: Source[]) {
  const maximum = 1024 * 1024;
  let truncated = Buffer.byteLength(stdout) > maximum || Buffer.byteLength(stderr) > maximum;
  const prefix = (value: string) => Buffer.from(value.slice(0, maximum)).subarray(0, maximum).toString("utf8");
  const lines = (prefix(stdout) + "\n" + prefix(stderr)).split(/\r?\n/);
  if (lines.length > 8192) truncated = true;
  const codeCounts: Record<string, number> = {};
  const frames: (Frame & {code: string})[] = [];
  let diagnostics = 0, unknownSources = 0, refusedLocations = 0, globalDiagnostics = 0;
  for (const raw of lines.slice(0, 8192)) {
    const line = stripVTControlCharacters(raw);
    const located = /^(.*)\((\d+),(\d+)\): (?:error|warning) (TS\d{3,6}):/.exec(line);
    const global = /^error (TS\d{3,6}):/.exec(line);
    if (!located && !global) continue;
    diagnostics++;
    const code = located ? located[4]! : global![1]!;
    if (code in codeCounts || Object.keys(codeCounts).length < 32) codeCounts[code] = (codeCounts[code] ?? 0) + 1;
    else truncated = true;
    if (!located) { globalDiagnostics++; continue; }
    const source = sourceFor(located[1]!, sources);
    if (!source) { unknownSources++; continue; }
    const at = frame(source, Number(located[2]), Number(located[3]));
    if (!at) { refusedLocations++; continue; }
    if (frames.some((item) => item.source_id === at.source_id && item.code === code && item.line === at.line && item.column === at.column)) continue;
    if (frames.length === 64) { truncated = true; continue; }
    frames.push({...at, code});
  }
  return {diagnostic_count: diagnostics, code_counts: codeCounts, frames,
    unknown_source_diagnostics: unknownSources, refused_locations: refusedLocations,
    global_diagnostics: globalDiagnostics, projection_truncated: truncated,
    original_unhandled_marker: nativeMarkers(stdout, stderr), raw_output_retained: false};
}
function lintProjection(raw: unknown, sources: Source[]) {
  const rows = array(raw); assert.equal(rows.length, sources.length);
  const seen = new Set<number>();
  const diagnostics: (Frame & {severity: number; rule_id: string | null; fatal: boolean})[] = [];
  let errors = 0, warnings = 0, total = 0, refused = 0, truncated = false;
  for (const item of rows) {
    const row = record(item);
    const source = sourceFor(text(row.filePath), sources);
    assert(source && !seen.has(source.source_id)); seen.add(source.source_id);
    const messages = array(row.messages); assert(messages.length <= 8192);
    errors += integer(row.errorCount); warnings += integer(row.warningCount);
    for (const member of messages) {
      total++;
      const message = record(member);
      const severity = integer(message.severity, 2); assert(severity === 1 || severity === 2);
      const rule = message.ruleId;
      assert(rule === null || (typeof rule === "string" && /^[A-Za-z0-9@_/-]{1,128}$/.test(rule)));
      const at = frame(source, message.line, message.column);
      if (!at) { refused++; continue; }
      assert(message.fatal === undefined || typeof message.fatal === "boolean");
      if (diagnostics.length === 128) { truncated = true; continue; }
      diagnostics.push({...at, severity, rule_id: rule, fatal: message.fatal === true});
    }
  }
  assert.equal(seen.size, sources.length);
  assert.equal(errors + warnings, total);
  return {errors, warnings, diagnostic_count: total, refused_locations: refused,
    projection_truncated: truncated, diagnostics, raw_output_retained: false};
}
function classification(message: string): string {
  if (/Hook timed out|hook timeout/i.test(message)) return "hook_timeout";
  if (/timeout|timed out/i.test(message)) return "timeout";
  if (/no such table/i.test(message)) return "missing_table";
  if (/constraint/i.test(message)) return "constraint";
  if (/D1_ERROR|D1_EXEC_ERROR|SQLITE_ERROR/.test(message)) return "d1_error";
  if (/cannot find (?:module|package)|ERR_MODULE_NOT_FOUND/i.test(message)) return "missing_module";
  if (/AssertionError|expected .* to /i.test(message)) return "assertion";
  if (/TypeError/.test(message)) return "type_error";
  if (/RangeError/.test(message)) return "range_error";
  if (/ReferenceError/.test(message)) return "reference_error";
  if (/ENOENT/.test(message)) return "file_missing";
  if (/Failed to load (?:url|module)|failed to resolve/i.test(message)) return "module_load";
  if (/runtime failed to start|ERR_RUNTIME_FAILURE/i.test(message)) return "runtime_startup";
  if (/Outbound network call/i.test(message)) return "outbound_refusal";
  return "unclassified";
}
function testProjection(raw: unknown, sources: Source[], tests: string[]) {
  const report = record(raw);
  const rows = array(report.testResults); assert.equal(rows.length, tests.length);
  const seen = new Set<string>();
  const failures: {source_id: number; case_index: number; name_sha256: string; classification: string}[] = [];
  const files: {source_id: number; passed: number; failed: number; pending: number; file_error: boolean; classification: string | null}[] = [];
  let passed = 0, failed = 0, pending = 0, cases = 0, truncated = false;
  for (const member of rows) {
    const row = record(member);
    const source = sourceFor(text(row.name), sources);
    assert(source && tests.includes(source.path) && !seen.has(source.path)); seen.add(source.path);
    const assertions = array(row.assertionResults); assert(assertions.length <= 10000);
    let filePassed = 0, fileFailed = 0, filePending = 0;
    const message = text(row.message);
    for (const [caseIndex, value] of assertions.entries()) {
      const item = record(value), status = text(item.status, 32);
      const name = text(item.fullName);
      const messages = array(item.failureMessages).map((entry) => text(entry));
      if (status === "passed") { filePassed++; assert.equal(messages.length, 0); }
      else if (status === "failed") {
        fileFailed++; assert(messages.length > 0);
        if (failures.length < 128) failures.push({source_id: source.source_id, case_index: caseIndex,
          name_sha256: digest(name), classification: classification(messages.join("\n"))});
        else truncated = true;
      } else { assert(["pending", "skipped", "todo", "disabled"].includes(status)); filePending++; }
    }
    passed += filePassed; failed += fileFailed; pending += filePending; cases += assertions.length;
    files.push({source_id: source.source_id, passed: filePassed, failed: fileFailed, pending: filePending,
      file_error: message !== "", classification: message === "" ? null : classification(message)});
  }
  assert.equal(seen.size, tests.length); assert(cases <= 10000);
  assert.equal(integer(report.numPassedTests), passed);
  assert.equal(integer(report.numFailedTests), failed);
  assert.equal(integer(report.numPendingTests), pending);
  assert.equal(integer(report.numTotalTests), cases);
  return {passed, failed, pending, cases, files, failures, projection_truncated: truncated,
    reported_success: report.success === true, raw_output_retained: false};
}
function controls() {
  const sources = Array.from({length: 16}, (_, source_id) => ({
    source_id, path: "src/control" + source_id + ".ts", sha256: "0".repeat(64), bytes: 12,
    line_lengths: [4, 100],
  }));
  let checked = 0;
  const one = (value: string) => typeProjection(value, "", sources);
  for (const path of [sources[0]!.path, "./" + sources[0]!.path, resolve(sources[0]!.path)]) {
    assert.deepEqual(one(path + "(1,5): error TS2345: withheld").frames,
      [{source_id: 0, sha256: sources[0]!.sha256, line: 1, column: 5, code: "TS2345"}]); checked++;
  }
  for (const position of ["0,1", "3,1", "1,0", "1,6", "9007199254740992,1"]) {
    const value = one(sources[0]!.path + "(" + position + "): error TS2345: withheld");
    assert.equal(value.frames.length, 0); assert.equal(value.refused_locations, 1); checked++;
  }
  assert.equal("a😀b".length, 4); checked++;
  const unknown = one("private/secret.ts(1,1): error TS2304: withheld");
  assert.equal(unknown.unknown_source_diagnostics, 1); assert(!JSON.stringify(unknown).includes("secret")); checked++;
  assert.equal(one("error TS18003: withheld").global_diagnostics, 1); checked++;
  assert.equal(one("\u001b[31m" + sources[15]!.path + "(1,1): error TS2322: withheld\u001b[0m").frames[0]!.source_id, 15); checked++;
  assert.equal(one((sources[0]!.path + "(1,1): error TS2345: withheld\n").repeat(3)).frames.length, 1); checked++;
  for (const value of ["TS2345 data", "stdout | error TS1234: data", "src/a.ts(1,1): data TS2345: data", "error TS12: data"]) {
    assert.equal(one(value).diagnostic_count, 0); checked++;
  }
  for (const value of ["Unhandled Errors", "Vitest caught 2 unhandled errors", "Source Errors", "Unhandled Rejection", "Uncaught Exception"]) {
    assert.equal(one(value).original_unhandled_marker, true); checked++;
  }
  assert.equal(one("ordinary output").original_unhandled_marker, false); checked++;
  assert.equal(one("x".repeat(1024 * 1024 + 1)).projection_truncated, true); checked++;
  assert.equal(one("\n".repeat(8193)).projection_truncated, true); checked++;
  const codes = one(Array.from({length:33}, (_, i) => "error TS" + (1000 + i) + ": withheld").join("\n"));
  assert.equal(Object.keys(codes.code_counts).length, 32); assert(codes.projection_truncated); checked++;
  const crowded = one(Array.from({length:65}, (_, i) => sources[i % 16]!.path + "(2," + (1 + Math.floor(i / 16)) + "): error TS2345: withheld").join("\n"));
  assert.equal(crowded.frames.length, 64); assert(crowded.projection_truncated); checked++;
  assert.equal(typeProjection("", sources[0]!.path + "(1,1): error TS2345: withheld", sources).frames.length, 1); checked++;
  const lint = (messages: unknown[]) => lintProjection([{filePath:sources[0]!.path, messages,
    errorCount:messages.length, warningCount:0}], [sources[0]!]);
  assert.equal(lint([{severity:2, ruleId:"@typescript-eslint/no-explicit-any", line:1, column:5}]).diagnostic_count, 1); checked++;
  assert.equal(lint(Array.from({length:129}, () => ({severity:2, ruleId:"no-unused-vars", line:1, column:1}))).diagnostics.length, 128); checked++;
  assert(lint(Array.from({length:129}, () => ({severity:2, ruleId:"no-unused-vars", line:1, column:1}))).projection_truncated); checked++;
  assert.throws(() => lint([{severity:2, ruleId:{toString(){return "unsafe";}}, line:1, column:1}])); checked++;
  assert.equal(lint([{severity:2, ruleId:null, line:1, column:6}]).refused_locations, 1); checked++;
  const tests = [sources[0]!.path];
  const report = (status: string, message = "") => ({numPassedTests:status==="passed"?1:0,
    numFailedTests:status==="failed"?1:0,numPendingTests:status==="pending"?1:0,numTotalTests:1,
    success:status==="passed",testResults:[{name:tests[0],message,assertionResults:[
      {fullName:"private test content",status,failureMessages:status==="failed"?["TypeError: private"]:[]}]}]});
  assert.equal(testProjection(report("passed"), sources, tests).passed, 1); checked++;
  const failure = testProjection(report("failed"), sources, tests);
  assert.equal(failure.failures[0]!.classification, "type_error");
  assert(!JSON.stringify(failure).includes("private")); checked++;
  assert.equal(testProjection(report("pending"), sources, tests).pending, 1); checked++;
  assert.equal(testProjection(report("passed", "missing table"), sources, tests).files[0]!.file_error, true); checked++;
  assert.throws(() => testProjection({...report("passed"),testResults:[]}, sources, tests)); checked++;
  assert.equal(checked, 38);
  return checked;
}
function readManifest(): Manifest {
  const manifest = readJSON(MANIFEST, 65536) as Manifest;
  assert.equal(manifest.version, 1); assert.equal(manifest.base_commit, BASE);
  assert.equal(manifest.scope, "initial_hosted_diagnostics_only");
  assert.equal(manifest.files.length, 16); assert.equal(new Set(manifest.files.map((file) => file.path)).size, 16);
  assert.deepEqual(manifest.required_phases, [...MODES]);
  for (const paths of [manifest.carrier_files, manifest.format_files, manifest.lint_files, manifest.tests, manifest.source_ids]) {
    assert(paths.length > 0 && paths.length <= 64 && new Set(paths).size === paths.length);
    assert(paths.every((path) => typeof path === "string" && !path.includes("..") && !path.startsWith("/")));
  }
  assert.equal(manifest.tests.length, 6);
  assert.equal(manifest.source_ids.length, 21);
  assert(manifest.format_files.every((path) => manifest.source_ids.includes(path)));
  assert(manifest.lint_files.every((path) => manifest.source_ids.includes(path)));
  assert(manifest.files.every((file) => manifest.source_ids.includes(file.path)));
  assert(manifest.files.every((file) => /^(?:src|workers|tests)\/[a-zA-Z0-9/_.-]+$/.test(file.path) && !file.path.includes("..")));
  assert(manifest.carrier_files.every((path) => path.startsWith(".github/")));
  return manifest;
}
function apply(manifest: Manifest) {
  assert.equal(process.env.GITHUB_REF, "refs/heads/" + manifest.fixed_branch);
  git("merge-base", "--is-ancestor", BASE, "HEAD");
  assert.deepEqual(git("diff", "--name-only", BASE + "...HEAD").split("\n").filter(Boolean).sort(),
    [...manifest.carrier_files].sort());
  const head = git("rev-parse", "HEAD"); assert.equal(process.env.GITHUB_SHA, head);
  assert.deepEqual(git("diff", "--name-only", BASE).split("\n").filter(Boolean).sort(),
    [...manifest.carrier_files].sort());
  assert.equal(digest(readFileSync(SELF)), manifest.helper_sha256);
  let total = 0;
  const verified = manifest.files.map((file) => {
    assert.equal(file.payload, ".github/fixtures/queue-memory-architecture/" + file.path + ".payload");
    assert(/^[a-f0-9]{64}$/.test(file.sha256));
    assert(Number.isSafeInteger(file.bytes) && file.bytes > 0 && file.bytes <= 1024 * 1024);
    const bytes = readFileSync(file.payload); assert.equal(bytes.length, file.bytes); assert.equal(digest(bytes), file.sha256);
    total += bytes.length;
    if (file.expected_base_blob_sha === null) assert.equal(existsSync(file.path), false);
    else {
      assert(/^[a-f0-9]{40}$/.test(file.expected_base_blob_sha));
      assert.equal(git("rev-parse", BASE + ":" + file.path), file.expected_base_blob_sha);
      const canonical = readFileSync(file.path);
      assert.equal(createHash("sha1").update("blob " + canonical.length + "\0").update(canonical).digest("hex"), file.expected_base_blob_sha);
    }
    return {file, bytes};
  });
  assert(total <= 1024 * 1024);
  for (const {file, bytes} of verified) {
    mkdirSync(dirname(file.path), {recursive:true}); writeFileSync(file.path, bytes);
    assert.equal(digest(readFileSync(file.path)), file.sha256);
  }
  git("add", "--", ...manifest.files.map((file) => file.path));
  const indexTree = git("write-tree"); assert.equal(git("rev-parse", "HEAD"), head);
  return {payload_bytes: total, runner_index_tree: indexTree, canonical_git_runtime_changed:false,
    runner_index_has_candidate:true, remote_refs_changed:false};
}
interface NativeResult {
  exit: number | null; signal: string | null; process_error: boolean;
  elapsed_ms: number; stdout_bytes: number; stderr_bytes: number; unhandled: boolean;
}
function run(mode: Mode, manifest: Manifest, save: (value: unknown) => void) {
  const candidatePaths = manifest.files.map((file) => file.path);
  const sourcePaths = mode === "lint" ? manifest.lint_files :
    mode === "format" ? manifest.format_files :
    mode === "helper_types" ? [SELF, ".github/vitest.queue-memory-architecture.config.ts", ".github/tsconfig.queue-memory-architecture.json"] :
    mode === "types" ? candidatePaths.filter((path) => path.endsWith(".ts")) : candidatePaths;
  const sources = sourcePaths.map((path) => pin(path, manifest.source_ids.indexOf(path)));
  assert(sources.reduce((sum, source) => sum + source.bytes, 0) <= 2 * 1024 * 1024);
  const reportPath = DIRECTORY + "/native-tests.json";
  const commands: Partial<Record<Mode, string[]>> = {
    format:["npx", "--no-install", "prettier", "--write", ...manifest.format_files],
    lint:["npx", "--no-install", "eslint", "--max-warnings=0", "--format=json", ...manifest.lint_files],
    types:["npm", "run", "typecheck", "--", "--incremental", "false"],
    helper_types:["npx", "--no-install", "tsc", "--noEmit", "--incremental", "false", "--project", ".github/tsconfig.queue-memory-architecture.json"],
    boundary:["npm", "run", "validate:boundary-casts"],
    workflow:["npm", "run", "validate:workflows"],
    tests:[process.execPath, "node_modules/vitest/vitest.mjs", "run", ...manifest.tests,
      "--config", ".github/vitest.queue-memory-architecture.config.ts", "--retry=0", "--reporter=json", "--outputFile=" + reportPath],
  };
  const command = commands[mode]; assert(command);
  if (mode === "tests" && existsSync(reportPath)) unlinkSync(reportPath);
  save({stage:"native_start",command,source_pins:publicPins(sources)});
  const started = Date.now();
  const result = spawnSync(command[0]!, command.slice(1), {
    encoding:"utf8", maxBuffer:8*1024*1024,
    timeout:mode==="types" ? 15*60*1000 : mode==="tests" ? 10*60*1000 : 180000,
    env:{...process.env, FORCE_COLOR:"0", WRANGLER_SEND_METRICS:"false", WRANGLER_WRITE_LOGS:"false"},
  });
  const stdout = result.stdout ?? "", stderr = result.stderr ?? "";
  const native: NativeResult = {exit:result.status,signal:result.signal,process_error:result.error!==undefined,
    elapsed_ms:Date.now()-started,stdout_bytes:Buffer.byteLength(stdout),stderr_bytes:Buffer.byteLength(stderr),
    unhandled:nativeMarkers(stdout,stderr)};
  let projection: unknown = null;
  save({stage:"native_result",command,native,source_pins:publicPins(sources),projection});
  if (mode === "types" || mode === "helper_types") projection = typeProjection(stdout, stderr, sources);
  if (mode === "lint") { assert(Buffer.byteLength(stdout) <= 1024*1024); projection = lintProjection(JSON.parse(stdout) as unknown, sources); }
  if (mode === "tests" && existsSync(reportPath)) {
    const raw = readFileSync(reportPath); assert(raw.length <= 16*1024*1024);
    assert(!raw.includes("MF-Proxy-Shared-Secret"));
    projection = testProjection(JSON.parse(raw.toString("utf8")) as unknown, sources, manifest.tests);
  }
  const after = sourcePaths.map((path) => pin(path, manifest.source_ids.indexOf(path)));
  if (mode !== "format") assert.deepEqual(publicPins(after), publicPins(sources));
  save({stage:"projected",command,native,source_pins:publicPins(mode==="format"?after:sources),projection});
  assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, 0);
  assert.equal(native.unhandled, false);
  if (mode === "types" || mode === "helper_types") {
    const value = projection as ReturnType<typeof typeProjection>;
    assert.equal(value.projection_truncated, false); assert.equal(value.diagnostic_count, 0);
  }
  if (mode === "lint") {
    const value = projection as ReturnType<typeof lintProjection>;
    assert.equal(value.projection_truncated, false); assert.equal(value.refused_locations, 0);
    assert.equal(value.errors, 0); assert.equal(value.warnings, 0);
  }
  if (mode === "tests") {
    assert(projection);
    const value = projection as ReturnType<typeof testProjection>;
    assert.equal(value.projection_truncated, false); assert.equal(value.reported_success, true);
    assert(value.passed > 0); assert.equal(value.failed, 0); assert.equal(value.pending, 0);
    assert(value.files.every((file) => !file.file_error && file.passed > 0));
  }
}
function main(): number {
  mkdirSync(DIRECTORY, {recursive:true});
  const mode = process.argv[2];
  assert(mode === "summary" || MODES.includes(mode as Mode));
  const selected = mode as Mode | "summary";
  let stage = "initial", status = "failed";
  let details: unknown = null;
  const save = (next?: unknown) => {
    if (next !== undefined) { details = next; stage = "details"; }
    const receipt = {version:1,phase:selected,stage,status,
      source_commit:process.env.GITHUB_SHA,run_id:process.env.GITHUB_RUN_ID,
      run_attempt:process.env.GITHUB_RUN_ATTEMPT,canonical_base:BASE,
      scope:"initial_hosted_diagnostics_only",details,
      full_suite_acceptance:false,source_budget_acceptance:false,bundle_budget_acceptance:false,
      patch_coverage_acceptance:false,patch_target_percent:99,patch_slack_percent:0,
      actual_codecov_acceptance:false,resource_acceptance:false,production_activation:false,
      raw_output_retained:false};
    const encoded = JSON.stringify(receipt,null,2) + "\n"; assert(Buffer.byteLength(encoded) <= 131072);
    const path = DIRECTORY + "/" + selected + "-receipt.json";
    writeFileSync(path + ".tmp", encoded); renameSync(path + ".tmp", path);
  };
  save();
  try {
    const manifest = readManifest();
    if (selected === "apply") save(apply(manifest));
    else if (selected === "controls") save({controls_passed:controls()});
    else if (selected === "summary") {
      const phases = MODES.map((phase) => {
        const receipt = record(readJSON(DIRECTORY + "/" + phase + "-receipt.json", 131072));
        assert.equal(receipt.phase, phase); assert.equal(receipt.source_commit, process.env.GITHUB_SHA);
        assert.equal(receipt.run_id, process.env.GITHUB_RUN_ID); assert.equal(receipt.run_attempt, process.env.GITHUB_RUN_ATTEMPT);
        return {phase,status:receipt.status};
      });
      save({required_phases:[...MODES],phases,source_pins:publicPins(manifest.source_ids.map(pin))});
      assert(phases.every((phase) => phase.status === "passed"));
    }
    else run(selected, manifest, save);
    stage = "complete"; status = "passed"; save();
    console.log(JSON.stringify({phase:selected,status,raw_output_retained:false}));
    return 0;
  } catch {
    stage = "failed"; save();
    console.error(JSON.stringify({phase:selected,status,raw_output_retained:false}));
    return 1;
  }
}
process.exit(main());
