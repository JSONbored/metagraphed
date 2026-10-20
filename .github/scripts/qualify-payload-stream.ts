import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, lstatSync } from "node:fs";
import path from "node:path";
import { Miniflare, NoOpLog } from "miniflare";

let phase = "source";
try {
const base = "62a5a7a6dd55de5263d79028605ebdc2bbaed542";
const source = "src/chain-detail-payloads.ts";
const baselineBlob = "b087371c052d01079255a5ad72a72ac8196986f9";
const files = [source, "tests/chain-detail-payloads.test.ts"];
const directory = "payload-stream-reports";
const receiptPath = directory + "/source-receipt.json";
const nativePath = directory + "/native-equivalence.json";
const digest = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");
const nativeNames = ["maximum-ascii", "maximum-chunks", "unicode-bom", "escaped-json", "parallel-families"];
if (process.argv[2] === "--verify-uploaded") {
  const root = "payload-stream-artifact-readback";
  function walk(dir: string): string[] { return readdirSync(dir).flatMap(name => {
    const file = path.join(dir, name), info = lstatSync(file);
    assert.equal(info.isSymbolicLink(), false);
    return info.isDirectory() ? walk(file) : [file.slice(root.length + 1)];
  }); }
  assert.deepEqual(walk(root).sort(), [...files, receiptPath, nativePath].sort());
  for (const p of [receiptPath, nativePath]) assert.equal(readFileSync(root + "/" + p,"utf8"), readFileSync(p,"utf8"));
  const receipt = JSON.parse(readFileSync(receiptPath,"utf8"));
  for (const p of files) assert.equal(digest(readFileSync(root + "/" + p)), receipt.files[p]);
  assert.equal(receipt.productionActions, false);
  console.log(JSON.stringify({ stage: "persisted-readback", exactMembers: 4, hashesMatch: true }));
  process.exit(0);
}
mkdirSync(directory, {recursive:true});
const candidate = readFileSync(source,"utf8");
assert.equal(execFileSync("git",["rev-parse",base + ":" + source],{encoding:"utf8"}).trim(),baselineBlob);
const old = execFileSync("git",["show",base + ":" + source],{encoding:"utf8"});
const tests = ["tests/chain-detail-payloads.test.ts","tests/chain-detail-native-payloads.test.ts","tests/chain-detail-d1.test.ts","tests/data-api-sync-queue-consumer.test.ts","tests/sync-batch-decoded-limits.test.ts","tests/data-api-bundle-boundary.test.ts"];
const regression = "compression streams owned UTF-8 bytes while preserving exact values";
const control = "inline values pass unchanged and compressed native values need no R2";
function unit(label: string, baseline: boolean) {
  const reportFile = directory + "/" + label + ".json";
  const output = spawnSync(process.execPath,["node_modules/vitest/vitest.mjs","run",...tests,"--retry=0","--reporter=json","--outputFile="+reportFile,...(baseline?["--testNamePattern",regression+"|"+control]:[])],
    {encoding:"utf8",maxBuffer:20*1024*1024,timeout:300_000,env:{...process.env,FORCE_COLOR:"0"}});
  assert.equal(output.error,undefined,"test-process");
  assert.equal(output.signal,null,"test-termination");
  const text=readFileSync(reportFile,"utf8");
  if (/MF-Proxy-Shared-Secret|Unhandled Rejection|Uncaught Exception/.test(text + output.stdout + output.stderr)) throw new Error("Native output withheld");
  const report=JSON.parse(text);
  assert.ok(report.testResults.length === tests.length);
  assert.ok(report.testResults.every((f: {message:string}) => f.message === ""));
  const cases=report.testResults.flatMap((f:{assertionResults:unknown[]})=>f.assertionResults);
  if (baseline) {
    assert.equal(output.status,1);
    const failed=cases.filter((c:{status:string})=>c.status==="failed");
    assert.equal(failed.length,1);
    assert.ok(failed[0].fullName.endsWith(regression));
    assert.match(failed[0].failureMessages.join(" "),/Unexpected payload byte snapshot/);
    assert.equal(report.numPassedTests,1);
  } else {
    assert.equal(output.status,0);
    assert.equal(report.numFailedTests,0);
    assert.ok(cases.every((c:{status:string})=>c.status==="passed"));
  }
  return {passed:report.numPassedTests,failed:report.numFailedTests,tests:report.numTotalTests};
}
phase = "unit-regression";
let baseline, fixed;
try { writeFileSync(source,old); baseline=unit("baseline",true); }
finally { writeFileSync(source,candidate); }
fixed=unit("candidate",false);
phase = "native-equivalence";
const oldPath = "src/chain-detail-payloads.baseline.ts";
writeFileSync(oldPath,old);
const scratch=path.resolve(".payload-stream-qualification"), bundled=path.join(scratch,"bundle");
mkdirSync(bundled,{recursive:true});
const config=path.join(scratch,"wrangler.json");
const entry=path.resolve(".github/scripts/payload-stream-worker.ts");
writeFileSync(config,JSON.stringify({name:"payload-stream-equivalence",main:entry,compatibility_date:"2026-06-06",compatibility_flags:["nodejs_compat"]}));
let runtime:Miniflare|undefined;
let outbound=0,restarts=0;
const levels:Record<string,number>={info:0,warn:0,error:0,debug:0,other:0};
try {
  const bundle=spawnSync(process.execPath,["node_modules/wrangler/bin/wrangler.js","deploy","--dry-run","--config",config,"--outdir",bundled],
    {encoding:"utf8",timeout:90_000,maxBuffer:256*1024,env:{...process.env,WRANGLER_SEND_METRICS:"false",WRANGLER_WRITE_LOGS:"false",CI:"true",BROWSER:"false"}});
  assert.equal(bundle.error,undefined,"native-bundler");
  assert.equal(bundle.status,0,"native-bundle");
  const entries=readdirSync(bundled).filter(f=>f.endsWith(".js"));
  assert.equal(entries.length,1);
  const scriptPath=path.join(bundled,entries[0]);
  runtime=new Miniflare({modules:true,name:"payload-stream-equivalence",scriptPath,compatibilityDate:"2026-06-06",compatibilityFlags:["nodejs_compat"],log:new NoOpLog(),
    handleStructuredLogs:event=>{levels[Object.hasOwn(levels,event.level)?event.level:"other"]++;},
    unsafeHandleRuntimeRestart:()=>{restarts++;},
    outboundService:async()=>{outbound++;return new Response("blocked synthetic outbound",{status:503});}});
  await runtime.ready;
  const worker=await runtime.getWorker();
  const cases=[];
  for(const name of nativeNames) {
    const response=await worker.fetch("https://payload-stream.invalid/"+name,{signal:AbortSignal.timeout(45_000)});
    assert.equal(response.status,200,"native-case-"+name);
    const text=await response.text();
    assert.ok(Buffer.byteLength(text)<4096);
    const value=JSON.parse(text);
    assert.equal(value.name,name);
    for(const key of ["exactReferenceEquality","exactCompressedPlanEquality","exactRestore","sourceUnchanged"])assert.equal(value[key],true);
    cases.push(value);
  }
  assert.equal(outbound,0); assert.equal(restarts,0);
  writeFileSync(nativePath,JSON.stringify({status:"passed",base,baselineBlob,sourceSha256:digest(candidate),entrySha256:digest(readFileSync(entry)),driverSha256:digest(readFileSync(process.argv[1])),bundleSha256:digest(readFileSync(scriptPath)),cases,outbound,restarts,levels,scope:"Actual workerd old/new exact compression/reference/statement-plan equivalence and synthetic hydration; no SQL execution, production action or memory-limit claim"},null,2)+"\n");
} finally { await runtime?.dispose();rmSync(oldPath,{force:true});rmSync(scratch,{recursive:true,force:true}); }
const receipt={base,baselineBlob,files:Object.fromEntries(files.map(p=>[p,digest(readFileSync(p))])),baseline,candidate:fixed,nativeEquivalenceSha256:digest(readFileSync(nativePath)),productionActions:false};
writeFileSync(receiptPath,JSON.stringify(receipt,null,2)+"\n");
console.log(JSON.stringify({stage:"qualified",...receipt}));

} catch (error) {
  console.error(JSON.stringify({status:"failed",phase,errorClass:error instanceof Error ? error.name : "Unknown",rawOutputRetained:false}));
  process.exitCode=1;
}
