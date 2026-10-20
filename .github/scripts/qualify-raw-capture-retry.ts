import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import nodePath from "node:path";
import { stripVTControlCharacters } from "node:util";

if (process.argv[2] === "cold-type-controls") {
  console.log(JSON.stringify(coldTypeControls()));
  process.exit(0);
}
if (process.argv[2] === "cold-types") process.exit(runColdTypes());

const base = "7afb1a5fb1aa00eb0dd261861d9f56f59c3db80d";
const canonicalBase = "0a65fcffd51b0a6a2b9757905be02c1d8b859e6c";
const baseSources = new Map([
  ["src/raw-capture-d1.ts", "a2117ac28687f6e83b1c0c9f63d3c7996702cde1"],
  ["src/raw-chain-capture.ts", "ba70a0a49d560f013b5468cf022038f00dd58948"],
]);
const files = [
  "src/raw-capture-d1.ts", "src/raw-chain-capture.ts",
  "src/raw-capture-retry-intent.ts", "src/raw-capture-retry-store.ts",
  "tests/raw-capture-d1.test.ts", "tests/raw-chain-capture.test.ts",
  "tests/raw-capture-retry-intent.test.ts", "tests/raw-capture-retry-d1.test.ts",
  "tests/raw-capture-cron-wiring.test.ts",
];
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const candidates = new Map(files.map((path) => [path, readFileSync(path, "utf8")]));
const original = new Map<string, string>();
for (const [path, expected] of baseSources) {
  const blob = spawnSync("git", ["rev-parse", base + ":" + path], {encoding:"utf8"});
  assert.equal(blob.status, 0);
  assert.equal(blob.stdout.trim(), expected);
  const content = spawnSync("git", ["show", base + ":" + path], {encoding:"utf8"});
  assert.equal(content.status, 0);
  original.set(path, content.stdout);
  assert.notEqual(digest(content.stdout), digest(candidates.get(path)!));
}
const baselineFixture = readFileSync(".github/fixtures/raw-capture-retry/baseline.test.ts.payload", "utf8");
assert.equal(digest(baselineFixture), "8315db29336d73c8eba07b12770b1dcf211f40aa1a2a425ba0e8f6c2775a92a8");
mkdirSync("raw-capture-retry-reports", {recursive:true});
interface Case { fullName: string; status: string; failureMessages: string[]; duration?: number; }
interface Report { numFailedTests: number; numPassedTests: number; testResults: { name?: string; assertionResults: Case[]; message: string; }[]; }
const selected = new Map([
  ["fresh capture provenance resumes one incomplete reservation", "failed"],
  ["exact original replay completes its incomplete reservation", "passed"],
]);
let verifiedBaseline: unknown = null;
function classification(message: string): string {
  if (/incomplete input/i.test(message)) return "sql_incomplete_input";
  if (/not authorized|SQLITE_AUTH/i.test(message)) return "sql_not_authorized";
  if (/already exists/i.test(message)) return "sql_already_exists";
  if (/statement.*(?:prefix|prepare)|prepare.*statement/i.test(message)) return "sql_prepare";
  if (/SQLITE_ERROR|D1_ERROR|D1_EXEC_ERROR/.test(message)) return "d1_error";
  if (/Hook timed out|hook timeout/i.test(message)) return "hook_timeout";
  if (/syntax error/i.test(message)) return "sql_syntax";
  if (/no such table/i.test(message)) return "missing_table";
  if (/constraint/i.test(message)) return "constraint";
  if (/cannot find (?:module|package)|ERR_MODULE_NOT_FOUND/i.test(message)) return "missing_module";
  if (/timeout|timed out/i.test(message)) return "timeout";
  if (/AssertionError|expected .* to /i.test(message)) return "assertion";
  if (/TypeError/.test(message)) return "type_error";
  if (/ReferenceError/.test(message)) return "reference_error";
  if (/RangeError/.test(message)) return "range_error";
  if (/ENOENT/.test(message)) return "file_missing";
  if (/Failed to load (?:url|module)|failed to resolve/i.test(message)) return "module_load";
  if (/ERR_RUNTIME_FAILURE|runtime failed to start|workerd.*(?:failed|error)/i.test(message)) return "runtime_startup";
  if (/ERR_VALIDATION|invalid (?:options|configuration)|validation error/i.test(message)) return "invalid_options";
  if (/No test suite found/i.test(message)) return "no_tests";
  if (/Worker exited|worker.*unexpectedly/i.test(message)) return "worker_exit";
  if (/Outbound network call/i.test(message)) return "outbound_refusal";
  return "unclassified";
}
function frames(message: string) {
  return [...message.matchAll(/(?:src|tests)\/raw-[A-Za-z0-9.-]+\.ts:\d+:\d+/g)]
    .map((match) => match[0]).slice(0,12);
}
function readNativeSetup() {
  const setupPath = "raw-capture-retry-reports/native-setup.json";
  let nativeSetup: unknown = null;
  if (existsSync(setupPath)) {
    const stage = JSON.parse(readFileSync(setupPath,"utf8"));
    assert(["fixture_loaded","runtime_construct","database","migration_read","migration_statement","state_read","state_statement","ready"].includes(stage.stage));
    assert(Number.isSafeInteger(stage.migration) && stage.migration >= -1 && stage.migration < 3);
    assert(Number.isSafeInteger(stage.statement) && stage.statement >= -1 && stage.statement < 1000);
    if (stage.ddl_probe !== null) {
      const d = stage.ddl_probe;
      assert(/^[a-f0-9]{64}$/.test(d.exact_sha256) && /^[a-f0-9]{64}$/.test(d.logical_sha256));
      assert(Number.isSafeInteger(d.exact_bytes) && d.exact_bytes > 0 && d.exact_bytes < 10_000);
      assert(Number.isSafeInteger(d.logical_bytes) && d.logical_bytes > 0 && d.logical_bytes < d.exact_bytes);
      assert(d.error === null || ["sql_no_statement","sql_incomplete_input","sql_not_authorized","sql_no_such_table","sql_no_such_column","sql_multiple_statement","sql_syntax","sql_already_exists","unclassified"].includes(d.error));
      assert(typeof d.reconciled === "boolean");
    }
    nativeSetup = stage;
  }
  return nativeSetup;
}
function coverageState() {
  if (!existsSync("coverage/coverage-summary.json")) return null;
  const raw = JSON.parse(readFileSync("coverage/coverage-summary.json","utf8"));
  const selected = files.filter((path) => path.startsWith("src/"));
  const summary = Object.fromEntries(selected.map((path) => [path,Object.entries(raw).find(([key]) => key.endsWith("/"+path))?.[1] ?? null]));
  const missing: Record<string,{lines:number[];branches:{line:number;block:number;branch:number}[]}> = {};
  for (const path of selected) missing[path]={lines:[],branches:[]};
  let current: string | undefined;
  if (existsSync("coverage/lcov.info")) for (const line of readFileSync("coverage/lcov.info","utf8").split("\n")) {
    if (line.startsWith("SF:")) current=selected.find((path) => line.slice(3).endsWith(path));
    if (!current) continue;
    const da=/^DA:(\d+),0$/.exec(line);
    if (da) missing[current].lines.push(Number(da[1]));
    const branch=/^BRDA:(\d+),(\d+),(\d+),(?:0|-)$/.exec(line);
    if (branch) missing[current].branches.push({line:Number(branch[1]),block:Number(branch[2]),branch:Number(branch[3])});
  }
  for (const item of Object.values(missing)) assert(item.lines.length<2000 && item.branches.length<5000);
  return {summary,missing};
}
function retainFailure(label: string, report: Report, status: number | null) {
  const receipt = {
    phase: label + "_failure", source_commit: process.env.GITHUB_SHA,
    canonical_base: canonicalBase, baseline_control_commit: base,
    failed: report.numFailedTests, passed: report.numPassedTests, exit_code: status,
    files: report.testResults.filter((file) => file.message !== "").map((file) => ({
      file: typeof file.name === "string" ? file.name.split("/").at(-1)?.slice(0,120) : null,
      classification: classification(file.message), frames: frames(file.message),
      statuses: Object.fromEntries(["passed","failed","pending","skipped"].map((status) => [status,file.assertionResults.filter((row) => row.status === status).length])),
    })),
    cases: report.testResults.flatMap((file) => file.assertionResults)
      .filter((row) => row.status === "failed").map((row) => ({
        name: row.fullName.slice(0,240),
        classification: classification(row.failureMessages.join("\n")),
        frames: frames(row.failureMessages.join("\n")),
      })),
    baseline: verifiedBaseline,
    native_setup: readNativeSetup(),
    coverage: coverageState(),
    candidate_files: Object.fromEntries([...candidates].map(([path,content])=>[path,digest(content)])),
    raw_output_retained: false, production_actions: false,
  };
  writeFileSync("raw-capture-retry-reports/failure-receipt.json",JSON.stringify(receipt,null,2)+"\n");
  console.error(JSON.stringify(receipt));
}
function run(label: string, tests: string[], extra: string[] = []) {
  const path = "raw-capture-retry-reports/" + label + ".json";
  const rss = "raw-capture-retry-reports/" + label + "-rss.txt";
  const start = Date.now();
  const result = spawnSync("/usr/bin/time", ["-f", "%M", "-o", rss,
    process.execPath, "node_modules/vitest/vitest.mjs", "run", ...tests,
    "--retry=0", "--reporter=json", "--outputFile=" + path, ...extra],
    {encoding:"utf8",maxBuffer:8*1024*1024,timeout:300_000,
      env:{...process.env,FORCE_COLOR:"0",WRANGLER_SEND_METRICS:"false",WRANGLER_WRITE_LOGS:"false",RAW_CAPTURE_QUALIFY_DIAGNOSTICS:"1"}});
  assert.equal(result.error, undefined, label + " process starts and finishes in bound");
  assert.equal(result.signal, null);
  if (/Unhandled Errors|Vitest caught \d+ unhandled errors?|Source Errors|Unhandled Rejection|Uncaught Exception/i.test(result.stdout+"\n"+result.stderr))
    throw new Error(label + " unclassified native failure; raw output withheld");
  const raw = readFileSync(path,"utf8");
  assert.ok(!/MF-Proxy-Shared-Secret/i.test(raw));
  const report = JSON.parse(raw) as Report;
  if (report.testResults.some((file) => file.message !== "")) {
    retainFailure(label,report,result.status);
    throw new Error(label + " file/hook failure; raw output withheld");
  }
  const cases = report.testResults.flatMap((file) => file.assertionResults);
  const peak = Number(readFileSync(rss,"utf8").trim().split("\n").at(-1))*1024;
  assert.ok(Number.isSafeInteger(peak) && peak > 0);
  return {status:result.status,report,cases,elapsed_ms:Date.now()-start,gnu_time_max_rss_bytes:peak};
}
try {
  for (const [path, content] of original) writeFileSync(path,content);
  writeFileSync("tests/raw-capture-d1.test.ts",baselineFixture);
  const baseline = run("baseline",["tests/raw-capture-d1.test.ts"],[
    "--testNamePattern",[...selected.keys()].map((name) => "^"+name+"$").join("|"),
  ]);
  assert.equal(baseline.status,1);
  assert.equal(baseline.report.numFailedTests,1);
  assert.equal(baseline.report.numPassedTests,1);
  assert.equal(baseline.report.testResults.length,1);
  for (const [name, status] of selected) {
    const matches=baseline.cases.filter((row) => row.fullName===name);
    assert.equal(matches.length,1);
    assert.equal(matches[0].status,status);
    assert.equal(matches[0].failureMessages.length,status==="failed"?1:0);
  }
  assert.ok(baseline.cases.filter((row) => !selected.has(row.fullName))
    .every((row) => ["pending","skipped"].includes(row.status)));
  const state=JSON.parse(readFileSync("raw-capture-retry-reports/fresh-state.json","utf8"));
  assert.equal(state.before.objects,1);
  assert.equal(state.before.complete,0);
  assert.equal(state.after.objects,2);
  assert.equal(state.after.complete,0);
  assert.equal(state.budget.objects,2);
  assert.equal(state.budget.bytes,state.after.bytes);
  assert.ok(state.after.bytes>state.before.bytes && state.before.bytes>8*65_536);
  assert.equal(state.selected,null);
  assert.notEqual(state.originalSha,state.freshSha);
  assert.equal(state.chunks.length,2);
  assert.deepEqual(new Set(state.chunks.map((row:{sha256:string})=>row.sha256)),new Set([state.originalSha,state.freshSha]));
  for (const chunk of state.chunks) {
    assert.equal(chunk.parts,8);
    assert.equal(chunk.bytes,8*65_536);
  }
  verifiedBaseline = { failed: 1, passed: 1, actual_state: state,
    elapsed_ms: baseline.elapsed_ms, gnu_time_max_rss_bytes: baseline.gnu_time_max_rss_bytes };
  for (const [path, content] of candidates) writeFileSync(path,content);
  const tests = readdirSync("tests").filter((name) => /^raw-capture-.*\.test\.ts$/.test(name))
    .map((name) => "tests/"+name);
  tests.push("tests/raw-chain-capture.test.ts","tests/d1-capture-governance.test.ts","tests/data-api-bundle-boundary.test.ts");
  const candidate = run("candidate",tests,["--config",".github/vitest.raw-capture.config.ts","--coverage"]);
  const failures=candidate.cases.filter((row)=>row.status==="failed");
  if (candidate.status !== 0 || candidate.report.numFailedTests !== 0 || failures.length) {
    retainFailure("candidate",candidate.report,candidate.status);
    throw new Error("Candidate qualification failed; raw logs withheld");
  }
  assert.equal(candidate.report.numPassedTests,345);
  assert.equal(candidate.cases.length,345);
  assert.ok(candidate.cases.every((row)=>row.status==="passed" && row.failureMessages.length===0));
  const coverage=JSON.parse(readFileSync("coverage/coverage-summary.json","utf8"));
  const summary=Object.fromEntries(files.filter((path)=>path.startsWith("src/")).map((path)=>{
    const item=Object.entries(coverage).find(([entry])=>entry.endsWith("/"+path));
    assert(item);
    const metrics = item[1] as Record<string,{total:number;covered:number;skipped:number;pct:number}>;
    for (const metric of ["lines","functions","statements","branches"]) {
      const value = metrics[metric];
      assert(value);
      assert(Number.isSafeInteger(value.total) && value.total > 0);
      assert.equal(value.covered,value.total);
      assert.equal(value.skipped,0);
      assert.equal(value.pct,100);
    }
    return [path,item[1]];
  }));
  const receipt={
    source_commit:process.env.GITHUB_SHA,base_commit:base,
    canonical_base:canonicalBase,baseline_control_commit:base,
    runtime_source:"runner-only pinned overlay; canonical Git runtime unchanged",
    native_setup:readNativeSetup(),
    coverage_detail:coverageState(),
    files:Object.fromEntries(files.map((path)=>[path,digest(readFileSync(path))])),
    baseline:{failed:1,passed:1,filtered:baseline.cases.length-2,actual_state:state,
      elapsed_ms:baseline.elapsed_ms,gnu_time_max_rss_bytes:baseline.gnu_time_max_rss_bytes},
    candidate:{passed:candidate.report.numPassedTests,failed:0,files:tests,
      elapsed_ms:candidate.elapsed_ms,gnu_time_max_rss_bytes:candidate.gnu_time_max_rss_bytes,
      bounded_census_cases:candidate.cases.filter((row)=>/16384|16385|staging census cap/.test(row.fullName))
        .map((row)=>({name:row.fullName,duration_ms:row.duration??null})),coverage:summary},
    scope:"Hosted Node writer fixtures with actual Miniflare D1 storage and unchanged bundle boundary; process metrics include fixture setup and are not production isolate/headroom acceptance",
    production_actions:false,raw_output_retained:false,
  };
  writeFileSync("raw-capture-retry-reports/source-receipt.json",JSON.stringify(receipt,null,2)+"\n");
  console.log(JSON.stringify(receipt));
} finally {
  for (const [path,content] of candidates) writeFileSync(path,content);
}


interface ColdTypeSource {
  source_id: number;
  file: string;
  sha256: string;
  bytes: number;
  line_lengths: number[];
}
function coldTypeFiles() {
  return [
    "src/raw-capture-d1.ts", "src/raw-chain-capture.ts",
    "src/raw-capture-retry-intent.ts", "src/raw-capture-retry-store.ts",
    "tests/raw-capture-d1.test.ts", "tests/raw-chain-capture.test.ts",
    "tests/raw-capture-retry-intent.test.ts", "tests/raw-capture-retry-d1.test.ts",
    "tests/raw-capture-cron-wiring.test.ts",
  ];
}
function coldTypeProjection(stdout: string, stderr: string, sources: ColdTypeSource[]) {
  const maximum = 1024 * 1024;
  let truncated = Buffer.byteLength(stdout) > maximum || Buffer.byteLength(stderr) > maximum;
  const prefix = (value: string) => Buffer.from(value.slice(0, maximum)).subarray(0, maximum).toString("utf8");
  const lines = (prefix(stdout) + "\n" + prefix(stderr)).split(/\r?\n/);
  if (lines.length > 8192) truncated = true;
  const codeCounts: Record<string, number> = {};
  const frames: { source_id: number; sha256: string; code: string; line: number; column: number }[] = [];
  let diagnostics = 0, unknownSources = 0, refusedLocations = 0, globalDiagnostics = 0;
  let unhandled = false, vitestUnhandled = 0;
  for (const raw of lines.slice(0, 8192)) {
    const line = stripVTControlCharacters(raw);
    // Preserve the existing qualifier's fail-closed native marker grammar.
    if (/Unhandled Errors|Vitest caught \d+ unhandled errors?|Source Errors|Unhandled Rejection|Uncaught Exception/i.test(line)) unhandled = true;
    const count = /^\s*Vitest caught ([1-9]\d*) unhandled errors?\b/.exec(line);
    if (count) {
      const value = Number(count[1]);
      if (Number.isSafeInteger(value) && value <= 1_000_000) vitestUnhandled += value;
      else truncated = true;
    }
    const located = /^(.*)\((\d+),(\d+)\): (?:error|warning) (TS\d{3,6}):/.exec(line);
    const global = /^error (TS\d{3,6}):/.exec(line);
    if (!located && !global) continue;
    diagnostics++;
    const code = located ? located[4] : global![1];
    if (code in codeCounts || Object.keys(codeCounts).length < 32) codeCounts[code] = (codeCounts[code] ?? 0) + 1;
    else truncated = true;
    if (!located) { globalDiagnostics++; continue; }
    const source = sources.find((item) => [item.file, "./" + item.file, nodePath.resolve(item.file)].includes(located[1]));
    if (!source) { unknownSources++; continue; }
    const at = Number(located[2]), column = Number(located[3]);
    if (!Number.isSafeInteger(at) || at <= 0 || at > source.line_lengths.length ||
        !Number.isSafeInteger(column) || column <= 0 || column > source.line_lengths[at - 1] + 1) {
      refusedLocations++; continue;
    }
    if (frames.some((item) => item.source_id === source.source_id && item.code === code && item.line === at && item.column === column)) continue;
    if (frames.length === 64) { truncated = true; continue; }
    frames.push({ source_id: source.source_id, sha256: source.sha256, code, line: at, column });
  }
  return {
    diagnostic_count: diagnostics, code_counts: codeCounts, frames,
    unknown_source_diagnostics: unknownSources, refused_locations: refusedLocations,
    global_diagnostics: globalDiagnostics, projection_truncated: truncated,
    original_unhandled_marker: unhandled, vitest_unhandled_errors: vitestUnhandled,
    raw_output_retained: false,
  };
}
function coldTypeControls() {
  const sources = coldTypeFiles().map((file, source_id) => ({source_id, file, sha256: "0".repeat(64), bytes: 12, line_lengths: [5, 6]}));
  const one = (text: string) => coldTypeProjection(text, "", sources);
  let checked = 0;
  for (const file of [sources[0].file, "./" + sources[0].file, nodePath.resolve(sources[0].file)]) {
    const value = one(file + "(2,7): error TS2345: withheld message");
    assert.deepEqual(value.frames, [{source_id:0, sha256:sources[0].sha256, code:"TS2345", line:2, column:7}]);
    assert.equal(value.diagnostic_count, 1); assert.equal(value.unknown_source_diagnostics, 0); checked++;
  }
  for (const text of [
    sources[0].file + "(0,1): error TS2345: withheld",
    sources[0].file + "(3,1): error TS2345: withheld",
    sources[0].file + "(1,0): error TS2345: withheld",
    sources[0].file + "(1,7): error TS2345: withheld",
    sources[0].file + "(9007199254740992,1): error TS2345: withheld",
  ]) { const value = one(text); assert.equal(value.frames.length, 0); assert.equal(value.refused_locations, 1); checked++; }
  const unknown = one("other/private-file.ts(1,1): error TS2304: withheld");
  assert.equal(unknown.unknown_source_diagnostics, 1); assert.deepEqual(unknown.frames, []); checked++;
  const global = one("error TS18003: withheld path and message");
  assert.equal(global.global_diagnostics, 1); assert.deepEqual(global.frames, []); checked++;
  const ansi = one("\u001b[31m" + sources[8].file + "(1,1): error TS2322: withheld\u001b[0m");
  assert.equal(ansi.frames[0].source_id, 8); checked++;
  const repeated = one((sources[0].file + "(1,1): error TS2345: withheld\n").repeat(3));
  assert.equal(repeated.frames.length, 1); assert.equal(repeated.code_counts.TS2345, 3); checked++;
  for (const text of ["TS2345 is data", "stdout | named error TS1234: data", "src/else.ts(1,1): message TS2345: data", "error TS12: data"]) {
    assert.equal(one(text).diagnostic_count, 0); checked++;
  }
  for (const text of ["Unhandled Errors", "Vitest caught 2 unhandled errors", "Source Errors", "Unhandled Rejection", "Uncaught Exception"]) {
    assert.equal(one(text).original_unhandled_marker, true); checked++;
  }
  assert.equal(one("Vitest caught 2 unhandled errors").vitest_unhandled_errors, 2); checked++;
  assert.equal(one("ordinary output").original_unhandled_marker, false); checked++;
  assert.equal(one("x".repeat(1024 * 1024 + 1)).projection_truncated, true); checked++;
  assert.equal(one("\n".repeat(8193)).projection_truncated, true); checked++;
  const codes = one(Array.from({length:33}, (_,index) => "error TS" + (1000 + index) + ": withheld").join("\n"));
  assert.equal(Object.keys(codes.code_counts).length,32); assert.equal(codes.projection_truncated,true); checked++;
  assert.equal(JSON.stringify(unknown).includes("private-file"),false); checked++;
  const crowded=one(Array.from({length:65},(_,index)=>sources[index%9].file+"("+(index<54?1:2)+","+(1+Math.floor(index/9)%6)+"): error TS2345: withheld").join("\n"));
  assert.equal(crowded.frames.length,64);assert.equal(crowded.projection_truncated,true);checked++;
  assert.equal(coldTypeProjection("",sources[0].file+"(1,1): error TS2345: withheld",sources).frames[0].source_id,0);checked++;
  assert.equal(checked, 29);
  return {cold_type_controls_passed: checked, cold_type_sources: sources.length};
}
function runColdTypes(): number {
  const directory = "raw-capture-retry-reports";
  mkdirSync(directory, {recursive:true});
  const receiptPath = directory + "/cold-type-receipt.json";
  let stage = "source_pins", status = "failed";
  let nativeExit: number | null = null, nativeSignal: string | null = null;
  let processError = false, stdoutBytes = 0, stderrBytes = 0, elapsed = 0;
  let projection: ReturnType<typeof coldTypeProjection> | null = null;
  let controls = 0;
  let sourcePins: {source_id:number;sha256:string;bytes:number;lines:number}[] = [];
  function save() {
    const receipt = {phase:"cold_typecheck",stage,status,source_commit:process.env.GITHUB_SHA,
      canonical_base:"0a65fcffd51b0a6a2b9757905be02c1d8b859e6c",run_id:process.env.GITHUB_RUN_ID,run_attempt:process.env.GITHUB_RUN_ATTEMPT,
      command:["npm","run","typecheck","--","--incremental","false"],
      native_exit_code:nativeExit,native_signal:nativeSignal,process_error:processError,
      elapsed_ms:elapsed,stdout_bytes:stdoutBytes,stderr_bytes:stderrBytes,
      cold_type_controls_passed:controls,source_pins:sourcePins,projection,
      raw_output_retained:false,production_actions:false};
    const encoded = JSON.stringify(receipt,null,2)+"\n";
    assert.ok(Buffer.byteLength(encoded) <= 131072);
    writeFileSync(receiptPath + ".tmp",encoded); renameSync(receiptPath + ".tmp",receiptPath);
  }
  save();
  try {
    const control = coldTypeControls(); assert.equal(control.cold_type_controls_passed,29); assert.equal(control.cold_type_sources,9); controls=control.cold_type_controls_passed;
    const manifestBytes=readFileSync(".github/fixtures/raw-capture-retry/manifest.json"); assert.ok(manifestBytes.length <= 65536);
    const manifest=JSON.parse(manifestBytes.toString("utf8")) as {base_commit:string;files:{path:string}[]};
    assert.equal(manifest.base_commit,"0a65fcffd51b0a6a2b9757905be02c1d8b859e6c"); assert.deepEqual(manifest.files.map((file)=>file.path),coldTypeFiles());
    const sources=coldTypeFiles().map((file,source_id)=>{
      const info=statSync(file); assert.ok(info.isFile() && info.size > 0 && info.size < 256*1024);
      const bytes=readFileSync(file); assert.equal(bytes.length,info.size);
      return {source_id,file,sha256:createHash("sha256").update(bytes).digest("hex"),bytes:bytes.length,line_lengths:bytes.toString("utf8").split(/\r?\n/).map((line)=>line.length)};
    });
    assert.ok(sources.reduce((sum,item)=>sum+item.bytes,0)<1024*1024);
    sourcePins=sources.map((item)=>({source_id:item.source_id,sha256:item.sha256,bytes:item.bytes,lines:item.line_lengths.length}));
    stage="cold_typecheck";save();
    const started=Date.now();
    const result=spawnSync("npm",["run","typecheck","--","--incremental","false"],{encoding:"utf8",maxBuffer:8*1024*1024,timeout:15*60*1000});
    elapsed=Date.now()-started;nativeExit=result.status;nativeSignal=result.signal;processError=result.error!==undefined;
    stdoutBytes=Buffer.byteLength(result.stdout??"");stderrBytes=Buffer.byteLength(result.stderr??"");
    projection=coldTypeProjection(result.stdout??"",result.stderr??"",sources);
    stage="native_result";save();
    assert.equal(result.error,undefined);assert.equal(result.signal,null);assert.equal(result.status,0);
    assert.equal(projection.original_unhandled_marker,false);assert.equal(projection.vitest_unhandled_errors,0);assert.equal(projection.projection_truncated,false);
    assert.equal(projection.diagnostic_count,0);
    status="passed";stage="complete";save();return 0;
  } catch { save(); return nativeExit!==null && nativeExit>0 ? nativeExit : 1; }
}
