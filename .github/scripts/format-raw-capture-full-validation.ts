import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const base = "0a65fcffd51b0a6a2b9757905be02c1d8b859e6c";
const fixture = ".github/fixtures/raw-capture-full-validation/";
const paths = [
  ".github/scripts/apply-raw-capture-full-validation.ts",
  ".github/scripts/report-raw-capture-full-validation.ts",
  ".github/scripts/format-raw-capture-full-validation.ts",
  ".github/workflows/raw-capture-full-validation.yml",
  ".github/workflows/raw-capture-full-format.yml",
  fixture + "manifest.json",
  fixture + "commands.json",
];
const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const git = (args: string[]) => execFileSync("git", args, {
  encoding: "utf8", maxBuffer: 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
}).trim();
const pins = () => Object.fromEntries(paths.map((file) => {
  const bytes = readFileSync(file);
  assert.ok(bytes.length > 0 && bytes.length < 131_072);
  return [file, { bytes: bytes.length, sha256: digest(bytes) }];
}));
const source = git(["rev-parse", "HEAD"]);
assert.equal(git(["status", "--porcelain", "--untracked-files=no"]), "");
for (const directory of ["src", "tests", "workers"])
  assert.equal(git(["rev-parse", source + ":" + directory]), git(["rev-parse", base + ":" + directory]));
const manifestBefore = JSON.parse(readFileSync(fixture + "manifest.json", "utf8"));
const commandsBefore = JSON.parse(readFileSync(fixture + "commands.json", "utf8"));
const before = pins();
let status = "failed", category = "formatter_contract", exitCode: number | null = null;
const nativePhases: { phase: string; exit_code: number | null; signal: string | null; ts_error_codes: string[] }[] = [];
let diagnosticControlsPassed = 0;
let helpersIncluded = 0;
let controlSemanticsPreserved = false;
function native(phase: string, args: string[]) {
  category = phase;
  const result = spawnSync(process.execPath, args, {
    encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 120_000,
  });
  nativePhases.push({ phase, exit_code: result.status, signal: result.signal,
    ts_error_codes: [...new Set((result.stdout + "\n" + result.stderr).match(/\bTS\d+\b/g) ?? [])].slice(0,32) });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0);
  return result.stdout;
}
try {
  native("native_format", ["node_modules/prettier/bin/prettier.cjs", "--write", ...paths]);
  exitCode = 0;
  const workflow = ".github/workflows/raw-capture-full-validation.yml";
  let value = readFileSync(workflow, "utf8");
  assert.match(value, /FULL_VALIDATION_MANIFEST_SHA256: [a-f0-9]{64}/);
  assert.match(value, /FULL_VALIDATION_COMMANDS_SHA256: [a-f0-9]{64}/);
  value = value.replace(/FULL_VALIDATION_MANIFEST_SHA256: [a-f0-9]{64}/,
    "FULL_VALIDATION_MANIFEST_SHA256: " + digest(readFileSync(fixture + "manifest.json")));
  value = value.replace(/FULL_VALIDATION_COMMANDS_SHA256: [a-f0-9]{64}/,
    "FULL_VALIDATION_COMMANDS_SHA256: " + digest(readFileSync(fixture + "commands.json")));
  writeFileSync(workflow, value);
  native("native_format_check", ["node_modules/prettier/bin/prettier.cjs", "--check", ...paths]);
  native("native_lint", ["node_modules/eslint/bin/eslint.js", "--max-warnings=0", ...paths.filter((item) => item.endsWith(".ts"))]);
  mkdirSync("tmp/raw-capture-full-format", { recursive: true });
  writeFileSync("tmp/raw-capture-full-format/helpers.tsconfig.json", JSON.stringify({
    extends: "../../tsconfig.json",
    compilerOptions: { incremental: false },
    include: paths.filter((item) => item.endsWith(".ts")).map((item) => "../../" + item),
  }));
  const compiled = native("native_types", ["node_modules/typescript/bin/tsc", "--noEmit", "--listFiles", "--project", "tmp/raw-capture-full-format/helpers.tsconfig.json"]);
  const listed = new Set(compiled.split(/\r?\n/).map((line) => line.trim()));
  for (const helper of paths.filter((item) => item.endsWith(".ts"))) {
    assert.ok(listed.has(path.resolve(helper)));
    helpersIncluded++;
  }
  assert.equal(helpersIncluded, 3);
  const control = JSON.parse(native("native_diagnostic_controls", [".github/scripts/report-raw-capture-full-validation.ts", "selfcheck"]).trim());
  assert.ok(Number.isSafeInteger(control.diagnostic_controls_passed) && control.diagnostic_controls_passed >= 33);
  diagnosticControlsPassed = control.diagnostic_controls_passed;
  assert.deepEqual(JSON.parse(readFileSync(fixture + "manifest.json", "utf8")), manifestBefore);
  assert.deepEqual(JSON.parse(readFileSync(fixture + "commands.json", "utf8")), commandsBefore);
  controlSemanticsPreserved = true;
  assert.equal(git(["rev-parse", "HEAD"]), source);
  const allowed = new Set(paths);
  for (const changed of git(["diff", "--name-only"]).split("\n").filter(Boolean)) assert.ok(allowed.has(changed));
  status = "carrier_format_lint_types_controls_passed_not_candidate_or_full_qualification";
  category = "none";
} catch {
  process.exitCode = 1;
} finally {
  mkdirSync("tmp/raw-capture-full-format", { recursive: true });
  const receipt = {
    status, category, source_commit: source, canonical_base: base,
    run_id: process.env.GITHUB_RUN_ID, run_attempt: process.env.GITHUB_RUN_ATTEMPT,
    formatter_exit_code: exitCode, native_phases: nativePhases, diagnostic_controls_passed: diagnosticControlsPassed,
    actual_helper_inputs_confirmed: helpersIncluded, before, after: pins(),
    manifest_and_commands_semantics_preserved: controlSemanticsPreserved,
    manifest_sha256: digest(readFileSync(fixture + "manifest.json")),
    commands_sha256: digest(readFileSync(fixture + "commands.json")),
    canonical_git_runtime_changed: false, candidate_payload_reformatted: false,
    raw_output_retained: false, production_actions: false,
  };
  writeFileSync("tmp/raw-capture-full-format/format-receipt.json", JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify({ status, category, source_commit: source, files: paths.length }));
}
