import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Miniflare, NoOpLog } from "miniflare";

let phase = "source";
try {
  const base = "0a65fcffd51b0a6a2b9757905be02c1d8b859e6c";
  const source = "src/chain-detail-native-payloads.ts";
  const baselineBlob = "f6c7a59928fc39ba9c402040393d34d37a4e2744";
  const helper = "src/chain-detail-payloads.ts";
  const helperBlob = "e112fe81cafd4e0efc204b6a12ae78f979925cbd";
  const files = [source, "tests/chain-detail-native-payloads.test.ts"];
  const fixtureFiles = [".github/fixtures/native-base64/chain-detail-native-payloads.ts", ".github/fixtures/native-base64/chain-detail-native-payloads.test.ts"];
  const fixtureHashes = ["d2598d3e93c3ebd079e34ccc98c625b8d7ae5f371eb5dbbddc3318887bca0799", "a51b1cf8d20566713323a653b3eff64af26e076e0cd061f0ccf60bd310d86f4c"];
  const directory = "native-base64-reports";
  const receiptPath = directory + "/source-receipt.json";
  const nativePath = directory + "/native-equivalence.json";
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (process.env.GITHUB_SHA) assert.equal(head, process.env.GITHUB_SHA);
  const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const nativeNames = ["golden-offsets", "all-octets", "inline-boundaries", "chunk-boundaries", "maximum-raw", "detached-empty", "maximum-ascii", "maximum-chunks", "unicode-bom"];
  const carrierFiles = [...fixtureFiles, ".github/scripts/qualify-native-base64.ts", ".github/scripts/native-base64-worker.ts", ".github/workflows/native-base64-qualification.yml"];
  const changes = execFileSync("git", ["diff", "--name-only", base, "HEAD"], { encoding: "utf8" }).trim().split("\n").sort();
  assert.deepEqual(changes, carrierFiles.slice().sort(), "only-github-carrier-files-committed");
  for (let index = 0; index < fixtureFiles.length; index++) assert.equal(digest(readFileSync(fixtureFiles[index])), fixtureHashes[index], "exact-candidate-fixture-hash");

  if (process.argv[2] === "--stage-candidate") {
    assert.equal(process.env.GITHUB_ACTIONS, "true", "hosted-actions-only-overlay");
    for (let index = 0; index < files.length; index++) {
      const canonical = execFileSync("git", ["show", base + ":" + files[index]]);
      assert.deepEqual(readFileSync(files[index]), canonical, "canonical-checkout-still-exact-main");
    }
    for (let index = 0; index < files.length; index++) writeFileSync(files[index], readFileSync(fixtureFiles[index]));
    console.log(JSON.stringify({ stage: "disposable-hosted-checkout-overlay", base, head, exactFixtureHashes: fixtureHashes, canonicalCarrierRuntimeUnchanged: true }));
    process.exit(0);
  }

  if (process.argv[2] === "--verify-uploaded") {
    const root = "native-base64-artifact-readback";
    function walk(directory: string): string[] {
      return readdirSync(directory).flatMap(name => {
        const file = path.join(directory, name), info = lstatSync(file);
        assert.equal(info.isSymbolicLink(), false);
        return info.isDirectory() ? walk(file) : [file.slice(root.length + 1)];
      });
    }
    assert.deepEqual(walk(root).sort(), [...files, receiptPath, nativePath].sort());
    for (const file of [receiptPath, nativePath]) assert.equal(readFileSync(root + "/" + file, "utf8"), readFileSync(file, "utf8"));
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    const native = JSON.parse(readFileSync(nativePath, "utf8"));
    assert.equal(receipt.base, base);
    assert.equal(receipt.head, head);
    assert.equal(receipt.baselineBlob, baselineBlob);
    assert.equal(receipt.helperBlob, helperBlob);
    assert.equal(receipt.productionActions, false);
    assert.equal(receipt.nativeEquivalenceSha256, digest(readFileSync(root + "/" + nativePath)));
    assert.equal(native.sourceSha256, receipt.files[source]);
    assert.equal(native.status, "passed");
    for (const file of files) assert.equal(digest(readFileSync(root + "/" + file)), receipt.files[file]);
    console.log(JSON.stringify({ stage: "persisted-readback", exactMembers: 4, hashesMatch: true, head }));
    process.exit(0);
  }

  mkdirSync(directory, { recursive: true });
  const candidate = readFileSync(source, "utf8");
  assert.equal(execFileSync("git", ["rev-parse", base + ":" + source], { encoding: "utf8" }).trim(), baselineBlob);
  assert.equal(execFileSync("git", ["rev-parse", "HEAD:" + helper], { encoding: "utf8" }).trim(), helperBlob);
  const old = execFileSync("git", ["show", base + ":" + source], { encoding: "utf8" });
  const helperSource = execFileSync("git", ["show", base + ":" + helper], { encoding: "utf8" });
  assert.equal(readFileSync(helper, "utf8"), helperSource);
  assert.equal(candidate.slice(candidate.indexOf("function decode(")), old.slice(old.indexOf("function decode(")), "unchanged-decoder-and-rest");
  assert.equal(candidate.slice(0, candidate.indexOf("function encode(")), 'import { Buffer } from "node:buffer";\n' + old.slice(0, old.indexOf("function encode(")), "only-new-import-before-encoder");
  const tests = ["tests/chain-detail-payloads.test.ts", "tests/chain-detail-native-payloads.test.ts", "tests/chain-detail-d1.test.ts", "tests/data-api-sync-queue-consumer.test.ts", "tests/sync-batch-decoded-limits.test.ts", "tests/data-api-bundle-boundary.test.ts"];
  for (const file of tests.filter(file => file !== files[1])) assert.equal(readFileSync(file, "utf8"), execFileSync("git", ["show", base + ":" + file], { encoding: "utf8" }), "unchanged-existing-suite");
  const compatibilityPattern = "native encoding preserves golden|native inline encoding preserves every|planned chunk encoding preserves sliced|native encoding retains the empty|inline bytes enforce canonical";
  function unit(label: string, baseline: boolean) {
    const reportFile = directory + "/" + label + ".json";
    const output = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", ...tests, "--retry=0", "--reporter=json", "--outputFile=" + reportFile, ...(baseline ? ["--testNamePattern", compatibilityPattern] : [])], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024, timeout: 300_000, env: { ...process.env, FORCE_COLOR: "0" } });
    assert.equal(output.error, undefined, "test-process");
    assert.equal(output.signal, null, "test-termination");
    const text = readFileSync(reportFile, "utf8");
    if (/MF-Proxy-Shared-Secret|Unhandled Rejection|Uncaught Exception/.test(text + output.stdout + output.stderr)) throw new Error("Native output withheld");
    const report = JSON.parse(text);
    assert.equal(report.testResults.length, tests.length);
    assert.ok(report.testResults.every((file: { message: string }) => file.message === ""));
    const cases = report.testResults.flatMap((file: { assertionResults: { status: string }[] }) => file.assertionResults);
    assert.equal(output.status, 0);
    assert.equal(report.numFailedTests, 0);
    if (baseline) assert.equal(report.numPassedTests, 5, "five-baseline-compatibility-invariants");
    else assert.ok(cases.every((test: { status: string }) => test.status === "passed"));
    return { passed: report.numPassedTests, failed: report.numFailedTests, skipped: report.numPendingTests, tests: report.numTotalTests };
  }
  phase = "unit-compatibility";
  let baseline;
  try { writeFileSync(source, old); baseline = unit("baseline", true); }
  finally { writeFileSync(source, candidate); }
  const fixed = unit("candidate", false);

  phase = "native-equivalence";
  const oldPath = "src/chain-detail-native-payloads.baseline.ts";
  const oldHelperPath = "src/chain-detail-payloads.native-baseline.ts";
  const nativeImport = '"./chain-detail-native-payloads.ts"';
  assert.equal(helperSource.split(nativeImport).length, 2, "one-baseline-native-import");
  writeFileSync(oldPath, old);
  writeFileSync(oldHelperPath, helperSource.replace(nativeImport, '"./chain-detail-native-payloads.baseline.ts"'));
  const scratch = path.resolve(".native-base64-qualification"), bundled = path.join(scratch, "bundle");
  mkdirSync(bundled, { recursive: true });
  const config = path.join(scratch, "wrangler.json"), entry = path.resolve(".github/scripts/native-base64-worker.ts");
  writeFileSync(config, JSON.stringify({ name: "native-base64-equivalence", main: entry, compatibility_date: "2026-06-06", compatibility_flags: ["nodejs_compat"] }));
  let runtime: Miniflare | undefined;
  let outbound = 0, restarts = 0;
  const levels: Record<string, number> = { info: 0, warn: 0, error: 0, debug: 0, other: 0 };
  let firstPartySourceBytes = 0;
  try {
    phase = "source-graph";
    const metafile = path.join(scratch, "data-api-metafile.json");
    execFileSync("npx", ["esbuild", "workers/data-api.ts", "--bundle", "--format=esm", "--platform=node", "--metafile=" + metafile, "--outfile=/dev/null", "--log-level=error", "--external:cloudflare:workers", "--external:node:*"], { encoding: "utf8", timeout: 90_000, maxBuffer: 256 * 1024 });
    const graph: Record<string, { bytes: number }> = JSON.parse(readFileSync(metafile, "utf8")).inputs;
    assert.ok(Object.keys(graph).length > 100 && graph["workers/data-api.ts"]);
    firstPartySourceBytes = Object.entries(graph).filter(([file]) => /^(src|workers|schemas-src|generated)\//.test(file)).reduce((total, [, input]) => total + input.bytes, 0);
    assert.ok(firstPartySourceBytes < 4_826_000, "unchanged-strict-source-budget");
    phase = "native-bundle";
    const bundle = spawnSync(process.execPath, ["node_modules/wrangler/bin/wrangler.js", "deploy", "--dry-run", "--config", config, "--outdir", bundled], { encoding: "utf8", timeout: 90_000, maxBuffer: 256 * 1024, env: { ...process.env, WRANGLER_SEND_METRICS: "false", WRANGLER_WRITE_LOGS: "false", CI: "true", BROWSER: "false" } });
    assert.equal(bundle.error, undefined, "native-bundler");
    assert.equal(bundle.status, 0, "native-bundle");
    const entries = readdirSync(bundled).filter(file => file.endsWith(".js"));
    assert.equal(entries.length, 1);
    const scriptPath = path.join(bundled, entries[0]);
    runtime = new Miniflare({ modules: true, name: "native-base64-equivalence", scriptPath, compatibilityDate: "2026-06-06", compatibilityFlags: ["nodejs_compat"], log: new NoOpLog(), handleStructuredLogs: event => { levels[Object.hasOwn(levels, event.level) ? event.level : "other"]++; }, unsafeHandleRuntimeRestart: () => { restarts++; }, outboundService: async () => { outbound++; return new Response("blocked synthetic outbound", { status: 503 }); } });
    await runtime.ready;
    const worker = await runtime.getWorker(), cases = [];
    phase = "native-cases";
    for (const name of nativeNames) {
      const response = await worker.fetch("https://native-base64.invalid/" + name, { signal: AbortSignal.timeout(45_000) });
      assert.equal(response.status, 200, "native-case-" + name);
      const text = await response.text();
      assert.ok(Buffer.byteLength(text) < 4096);
      const value = JSON.parse(text);
      assert.equal(value.name, name);
      for (const key of ["exactReferenceEquality", "exactPlanEquality", "crossReaderHydration", "sourceUnchanged"]) assert.equal(value[key], true);
      cases.push(value);
    }
    assert.equal(outbound, 0);
    assert.equal(restarts, 0);
    assert.equal(levels.error, 0);
    const versions = Object.fromEntries(["miniflare", "wrangler", "workerd"].map(name => [name, JSON.parse(readFileSync("node_modules/" + name + "/package.json", "utf8")).version]));
    writeFileSync(nativePath, JSON.stringify({ status: "passed", base, head, baselineBlob, helperBlob, sourceSha256: digest(candidate), helperSha256: digest(helperSource), entrySha256: digest(readFileSync(entry)), driverSha256: digest(readFileSync(process.argv[1])), bundleSha256: digest(readFileSync(scriptPath)), nodeVersion: process.version, versions, cases, outbound, restarts, levels, scope: "Actual workerd exact old/new base64 reference and statement-plan equivalence, unchanged source and cross-reader hydration. Synthetic SQL reader only; no SQL execution, production action or memory-limit claim." }, null, 2) + "\n");
  } finally {
    await runtime?.dispose();
    rmSync(oldPath, { force: true });
    rmSync(oldHelperPath, { force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
  const receipt = { base, head, baselineBlob, helperBlob, fixtureFiles: Object.fromEntries(fixtureFiles.map((file, index) => [file, fixtureHashes[index]])), canonicalCarrierRuntimeUnchanged: true, files: Object.fromEntries(files.map(file => [file, digest(readFileSync(file))])), baseline, candidate: fixed, sourceGraph: { firstPartySourceBytes, strictLimit: 4_826_000, boundarySuiteUnchangedSha256: digest(readFileSync(tests[5])) }, nativeEquivalenceSha256: digest(readFileSync(nativePath)), productionActions: false };
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify({ stage: "qualified", ...receipt }));
} catch (error) {
  console.error(JSON.stringify({ status: "failed", phase, errorClass: error instanceof Error ? error.name : "Unknown", rawOutputRetained: false }));
  process.exitCode = 1;
}
