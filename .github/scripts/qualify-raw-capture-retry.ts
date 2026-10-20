import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";

const base = "7afb1a5fb1aa00eb0dd261861d9f56f59c3db80d";
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
const baselineFixture = readFileSync(".github/fixtures/raw-capture-retry-baseline.test.ts", "utf8");
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
function retainFailure(label: string, report: Report, status: number | null) {
  const setupPath = "raw-capture-retry-reports/native-setup.json";
  let nativeSetup: unknown = null;
  if (existsSync(setupPath)) {
    const stage = JSON.parse(readFileSync(setupPath,"utf8"));
    assert(["fixture_loaded","runtime_construct","database","migration_read","migration_statement","state_read","state_statement","ready"].includes(stage.stage));
    assert(Number.isSafeInteger(stage.migration) && stage.migration >= -1 && stage.migration < 3);
    assert(Number.isSafeInteger(stage.statement) && stage.statement >= -1 && stage.statement < 1000);
    nativeSetup = stage;
  }
  const receipt = {
    phase: label + "_failure", source_commit: process.env.GITHUB_SHA,
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
    native_setup: nativeSetup,
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
  assert.ok(candidate.report.numPassedTests>300);
  assert.ok(candidate.cases.every((row)=>row.status==="passed" && row.failureMessages.length===0));
  const coverage=JSON.parse(readFileSync("coverage/coverage-summary.json","utf8"));
  const summary=Object.fromEntries(files.filter((path)=>path.startsWith("src/")).map((path)=>{
    const item=Object.entries(coverage).find(([entry])=>entry.endsWith("/"+path));
    assert(item);
    return [path,item[1]];
  }));
  const receipt={
    source_commit:process.env.GITHUB_SHA,base_commit:base,
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

