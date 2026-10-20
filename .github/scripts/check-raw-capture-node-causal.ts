import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, readSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

const F = ".github/fixtures/raw-capture-full-validation/";
const SELF = ".github/scripts/check-raw-capture-node-causal.ts";
const WORKFLOW = ".github/workflows/raw-capture-node-causal.yml";
const OUTPUT = "tmp/raw-capture-node-causal/";
const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
interface Source { path: string; bytes: number; sha256: string }
interface Input {
  sources: Source[];
  raw_pairs: { original: string; fixed: string; destination: string }[];
  parser_pair: { original: string; fixed: string };
  full_manifest_sha256: string;
  tracked: { count: number; path_mode_sha256: string; maximum_file_bytes: number; maximum_total_bytes: number; symlink: { path: string; target: string; git_blob_sha: string } };
}
interface Native {
  id: string; exit: number | null; signal: string | null; process_error: boolean;
  elapsed_ms: number; stdout_bytes: number; stderr_bytes: number;
  unsupported_typescript: boolean; unhandled: boolean; ts_codes: string[];
  frames: { source_id: number; source_sha256: string; line: number; column: number | null }[]; frames_truncated: boolean;
  cwd_id: "root" | "ui";
}
interface TrackedFile { path: string; mode: string; bytes: number; sha256: string }
interface TrackedState { index_sha256: string; files: TrackedFile[] }
const trackedReceipts: { id: string; count: number; bytes: number; index_sha256: string; content_sha256: string }[] = [];
const nativeReceipts: Native[] = [];
const aliases: { id: number; file: string; expected: string }[] = [];
function unhandledLine(clean: string) {
  return /^\s*(?:\((?:node|bun):\d+\)\s*)?(?:UnhandledPromiseRejection(?:Warning)?|Unhandled Rejection|Uncaught Exception)(?::|\s+(?:at|in)\b|\s*$)/i.test(clean)
    || /^\s*(?:(?:✘|×)\s*)?(?:\[ERROR\]\s*)?Uncaught(?:\s+\(in promise\))?\s+(?:[A-Za-z]*Error|Exception):/i.test(clean)
    || /^[\s\u23af-]*Unhandled (?:Errors?|Rejection|Exception)[\s\u23af-]*$/.test(clean);
}
const syntaxReceipts: { id: string; source_sha256: string; stripped: boolean; unsupported_typescript: boolean; unknown_error: boolean }[] = [];
const pins = (files: string[]) => files.map((file) => {
  const bytes = readFileSync(file); assert.ok(bytes.length > 0 && bytes.length <= 131072);
  return { path: file, bytes: bytes.length, sha256: sha(bytes) };
});
function save(name: string, value: unknown) {
  const bytes = JSON.stringify(value, null, 2) + "\n";
  assert.ok(Buffer.byteLength(bytes) <= 65536);
  mkdirSync(OUTPUT, { recursive: true }); writeFileSync(OUTPUT + name, bytes);
}
function native(id: string, command: string, args: string[], maximum = 1048576, cwdId: "root" | "ui" = "root") {
  const begin = performance.now();
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: maximum, timeout: 180000, cwd: cwdId === "ui" ? "apps/ui" : undefined, stdio: ["ignore", "pipe", "pipe"] });
  const stdout = result.stdout ?? "", stderr = result.stderr ?? "";
  const clean = stripVTControlCharacters(stdout + "\n" + stderr);
  const unsupported = /(?:^|\n)\s*(?:code:\s*['"]ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX['"],?|SyntaxError \[ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX\]:[^\n]*)\s*(?:\n|$)/.test(clean);
  const unhandled = clean.split(/\r?\n/).some(unhandledLine);
  const frames: Native["frames"] = [];
  let framesTruncated = false;
  for (const source of [...aliases, { id: 3, file: SELF, expected: sha(readFileSync(SELF)) }]) {
    const data = readFileSync(source.file); assert.ok(data.length <= 131072); assert.equal(sha(data), source.expected);
    const lines = data.toString("utf8").split(/\r?\n/);
    const escaped = path.resolve(source.file).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const expression = new RegExp(escaped + ":([1-9]\\d{0,6})(?::([1-9]\\d{0,6}))?", "g");
    for (const match of clean.matchAll(expression)) {
      const line = Number(match[1]), column = match[2] ? Number(match[2]) : null;
      assert.ok(line <= lines.length && (column === null || column <= lines[line - 1]!.length + 1));
      if (frames.length === 8) { framesTruncated = true; break; }
      frames.push({ source_id: source.id, source_sha256: source.expected, line, column });
    }
  }
  const receipt = { id, exit: result.status, signal: result.signal, process_error: Boolean(result.error), elapsed_ms: Math.round(performance.now() - begin), stdout_bytes: Buffer.byteLength(stdout), stderr_bytes: Buffer.byteLength(stderr), unsupported_typescript: unsupported, unhandled, frames, frames_truncated: framesTruncated, ts_codes: [...new Set(clean.match(/\bTS\d{4,5}\b/g) ?? [])].slice(0, 32), cwd_id: cwdId };
  nativeReceipts.push(receipt);
  assert.equal(receipt.signal, null); assert.equal(receipt.process_error, false); assert.equal(receipt.unhandled, false); assert.equal(receipt.frames_truncated, false);
  return { receipt, stdout };
}
function pass(result: ReturnType<typeof native>) { assert.equal(result.receipt.exit, 0); assert.equal(result.receipt.unsupported_typescript, false); }
function syntax(id: string, file: string, expected: boolean) {
  const source = readFileSync(file, "utf8");
  let stripped = false, unsupported = false, unknown = false;
  try { stripTypeScriptTypes(source, { mode: "strip" }); stripped = true; }
  catch (error) {
    unsupported = Boolean(error && typeof error === "object" && "code" in error && error.code === "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX");
    unknown = !unsupported;
  }
  syntaxReceipts.push({ id, source_sha256: sha(Buffer.from(source)), stripped, unsupported_typescript: unsupported, unknown_error: unknown });
  assert.equal(unknown, false); assert.equal(stripped, expected); assert.equal(unsupported, !expected);
}
function trackedState(id: string, expected?: TrackedState): TrackedState {
  const listed = spawnSync("git", ["ls-files", "--stage", "-z"], { encoding: "utf8", maxBuffer: 2097152, timeout: 30000, stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(listed.status, 0); assert.equal(listed.signal, null); assert.equal(Boolean(listed.error), false); assert.equal(listed.stderr, "");
  const listing = listed.stdout; assert.ok(listing.endsWith("\0"));
  const items = listing.slice(0, -1).split("\0").map((item) => {
    const match = /^(100644|100755|120000) ([a-f0-9]{40}) 0\t([^\r\n\0]+)$/.exec(item); assert.ok(match);
    const file = match[3]!; assert.ok(!path.isAbsolute(file) && !file.includes("\\") && file.split("/").every((part) => part !== "." && part !== ".." && part !== ""));
    return { path: file, mode: match[1]! };
  }).sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  assert.equal(items.length, input.tracked.count); assert.equal(new Set(items.map((item) => item.path)).size, items.length);
  assert.equal(sha(Buffer.from(items.map((item) => item.path + "\0" + item.mode + "\n").join(""))), input.tracked.path_mode_sha256);
  let total = 0;
  const buffer = Buffer.alloc(65536);
  const files = items.map((item) => {
    let bytes = 0, digest: string;
    if (item.mode === "120000") {
      assert.equal(item.path, input.tracked.symlink.path); assert.ok(lstatSync(item.path).isSymbolicLink());
      const target = Buffer.from(readlinkSync(item.path)); assert.equal(target.toString("utf8"), input.tracked.symlink.target);
      assert.equal(createHash("sha1").update(Buffer.from("blob " + target.length + "\0")).update(target).digest("hex"), input.tracked.symlink.git_blob_sha);
      bytes = target.length; digest = sha(target);
    } else {
      const fd = openSync(item.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = fstatSync(fd); assert.ok(stat.isFile() && stat.size <= input.tracked.maximum_file_bytes);
        assert.equal(stat.mode & 0o111, item.mode === "100755" ? 0o111 : 0);
        const hash = createHash("sha256");
        for (;;) {
          const count = readSync(fd, buffer, 0, buffer.length, null); if (!count) break;
          bytes += count; assert.ok(bytes <= stat.size && bytes <= input.tracked.maximum_file_bytes); hash.update(buffer.subarray(0, count));
        }
        assert.equal(bytes, stat.size); digest = hash.digest("hex");
      } finally { closeSync(fd); }
    }
    total += bytes; assert.ok(total <= input.tracked.maximum_total_bytes);
    return { ...item, bytes, sha256: digest };
  });
  const state = { index_sha256: sha(Buffer.from(listing)), files };
  trackedReceipts.push({ id, count: files.length, bytes: total, index_sha256: state.index_sha256, content_sha256: sha(Buffer.from(files.map((item) => item.path + "\0" + item.sha256 + "\0" + item.bytes + "\n").join(""))) });
  if (expected) assert.deepEqual(state, expected);
  return state;
}
function prerequisite(id: string, command: string, args: string[], expected: TrackedState, cwdId: "root" | "ui" = "root") {
  trackedState(id + "-before", expected);
  try { return native(id, command, args, 1048576, cwdId); }
  finally { trackedState(id + "-after", expected); }
}
const mode = process.argv[2];
const inputBytes = readFileSync(F + "node-causal-manifest.json");
assert.equal(sha(inputBytes), process.env.NODE_CAUSAL_MANIFEST_SHA256);
assert.ok(inputBytes.length <= 65536);
const input = JSON.parse(inputBytes.toString("utf8")) as Input;
const full = JSON.parse(readFileSync(F + "manifest.json", "utf8")) as { files: Source[] };
assert.equal(full.files.length, 20);
const originalRuntimePins = pins(full.files.map((file) => file.path));
assert.deepEqual(originalRuntimePins, full.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })));
assert.equal(input.sources.length, 6); assert.equal(input.raw_pairs.length, 2);
assert.equal(sha(readFileSync(F + "manifest.json")), input.full_manifest_sha256);
for (const item of mode === "preflight" ? input.sources : []) {
  const current = pins([item.path])[0]!; assert.deepEqual(current, item);
}
const originalSources = pins(input.sources.map((s) => s.path));
input.raw_pairs.forEach((pair, id) => aliases.push({ id, file: pair.destination, expected: sha(readFileSync(pair.original)) }));
const identity = { run_id: process.env.GITHUB_RUN_ID, run_attempt: process.env.GITHUB_RUN_ATTEMPT, head: process.env.GITHUB_SHA, node: process.version, input_manifest_sha256: sha(inputBytes), full_manifest_sha256: input.full_manifest_sha256 };
assert.equal(process.version, "v22.23.2"); assert.equal(process.env.GITHUB_RUN_ATTEMPT, "1");
assert.equal(process.platform, "linux"); assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.match(identity.run_id ?? "", /^[1-9]\d{0,19}$/); assert.match(identity.head ?? "", /^[a-f0-9]{40}$/);
assert.equal(process.env.GITHUB_REF, "refs/heads/ci/raw-capture-node-strip-causal-20261020");
assert.equal(process.env.GITHUB_REPOSITORY, "JSONbored/metagraphed");
assert.notEqual(process.env.METAGRAPH_PRODUCTION_BUILD, "1");
const head = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", maxBuffer: 1024, timeout: 30000, stdio: ["ignore", "pipe", "pipe"] });
assert.equal(head.status, 0); assert.equal(head.signal, null); assert.equal(Boolean(head.error), false); assert.equal(head.stderr, ""); assert.equal(head.stdout.trim(), identity.head);
let stage = "input";
let status: string;
try {
  if (mode === "preflight") {
    stage = "format";
    pass(native("format", process.execPath, ["node_modules/prettier/bin/prettier.cjs", "--write", SELF, WORKFLOW, ...input.raw_pairs.map((p) => p.fixed)]));
    stage = "format_check";
    pass(native("format_check", process.execPath, ["node_modules/prettier/bin/prettier.cjs", "--check", SELF, WORKFLOW, F + "node-causal-manifest.json", ...input.raw_pairs.map((p) => p.fixed)]));
    stage = "lint";
    pass(native("lint", process.execPath, ["node_modules/eslint/bin/eslint.js", "--max-warnings=0", SELF]));
    mkdirSync(OUTPUT, { recursive: true });
    writeFileSync(OUTPUT + "helpers.tsconfig.json", JSON.stringify({ extends: "../../tsconfig.json", compilerOptions: { incremental: false }, include: ["../../" + SELF] }));
    stage = "types";
    const compiled = native("types", process.execPath, ["node_modules/typescript/bin/tsc", "--noEmit", "--listFiles", "--project", OUTPUT + "helpers.tsconfig.json"], 4194304); pass(compiled);
    assert.ok(compiled.stdout.split(/\r?\n/).some((line) => line.trim() === path.resolve(SELF)));
    for (const file of [input.parser_pair.original, input.parser_pair.fixed, ...input.raw_pairs.map((p) => p.original)])
      assert.deepEqual(pins([file])[0], originalSources.find((p) => p.path === file));
    status = "native_preflight_passed_not_causal_or_full_acceptance";
  } else {
    assert.equal(mode, "causal");
    const preflight = JSON.parse(readFileSync(OUTPUT + "preflight-receipt.json", "utf8")) as { identity: typeof identity; status: string; actual_sources: Source[]; actual_helper: Source; actual_workflow: Source };
    assert.deepEqual(preflight.identity, identity);
    assert.deepEqual(pins([SELF])[0], preflight.actual_helper);
    assert.deepEqual(pins([WORKFLOW])[0], preflight.actual_workflow);
    assert.equal(preflight.status, "native_preflight_passed_not_causal_or_full_acceptance");
    assert.deepEqual(pins(input.sources.map((s) => s.path)), preflight.actual_sources);
    stage = "syntax";
    input.raw_pairs.forEach((p, i) => { syntax("raw-original-" + i, p.original, false); syntax("raw-fixed-" + i, p.fixed, true); });
    syntax("parser-original", input.parser_pair.original, false); syntax("parser-fixed", input.parser_pair.fixed, true);
    stage = "tracked_baseline";
    const originalTracked = trackedState("original-baseline");
    stage = "original_import";
    for (const [i, pair] of input.raw_pairs.entries()) {
      const scratch = OUTPUT + "original-" + i + ".ts"; writeFileSync(scratch, readFileSync(pair.original));
      aliases.push({ id: i, file: scratch, expected: sha(readFileSync(pair.original)) });
      const result = native("original-import-" + i, process.execPath, ["--input-type=module", "--eval", "import {pathToFileURL} from 'node:url'; await import(pathToFileURL(process.argv[1]).href);", scratch]);
      assert.equal(result.receipt.exit, 1); assert.equal(result.receipt.unsupported_typescript, true); assert.ok(result.receipt.frames.some((frame) => frame.source_id === i));
    }
    const prerequisites: { id: string; command: string; args: string[]; cwd: "root" | "ui" }[] = [
      { id: "build", command: "npm", args: ["run", "build"], cwd: "root" },
      { id: "contract-drift", command: "npm", args: ["run", "validate:contract-drift"], cwd: "root" },
      { id: "limits-docs", command: process.execPath, args: ["scripts/generate-limits-docs.ts"], cwd: "ui" },
    ];
    for (const item of prerequisites) {
      stage = "original_" + item.id;
      const original = prerequisite("original-" + item.id, item.command, item.args, originalTracked, item.cwd);
      assert.equal(original.receipt.exit, 1); assert.equal(original.receipt.unsupported_typescript, true); assert.ok(original.receipt.frames.some((frame) => frame.source_id === 0));
    }
    assert.deepEqual(pins(full.files.map((file) => file.path)), originalRuntimePins);
    stage = "fixed_source";
    for (const [id, pair] of input.raw_pairs.entries()) {
      writeFileSync(pair.destination, readFileSync(pair.fixed));
      const alias = aliases.find((alias) => alias.id === id && alias.file === pair.destination)!;
      alias.expected = sha(readFileSync(pair.fixed));
    }
    const expectedTracked: TrackedState = { index_sha256: originalTracked.index_sha256, files: originalTracked.files.map((file) => {
      const pair = input.raw_pairs.find((pair) => pair.destination === file.path);
      if (!pair) return file;
      const fixed = pins([pair.fixed])[0]!;
      return { ...file, bytes: fixed.bytes, sha256: fixed.sha256 };
    }) };
    trackedState("fixed-two-source-baseline", expectedTracked);
    stage = "fixed_import";
    const contracts = [
      "const e=new m.RawCaptureBulkLeaseError('raw_capture_bulk_busy'); assert.equal(e.code,'raw_capture_bulk_busy'); assert.deepEqual(Object.keys(e),['code','name']);",
      "const count=()=>2, retry=async()=>{}; for(const cause of [null,0,'cause']){const e=new m.RawCaptureRpcCleanupError(count,retry,true,cause); assert.equal(e.pendingCount,count); assert.equal(e.retryCleanup,retry); assert.equal(e.cause,cause); assert.deepEqual(Object.keys(e),['pendingCount','retryCleanup','name']);} const absent=new m.RawCaptureRpcCleanupError(count,retry,false,undefined); assert.equal(Object.hasOwn(absent,'cause'),false);",
    ];
    for (const [i, pair] of input.raw_pairs.entries()) pass(native("fixed-import-contract-" + i, process.execPath, ["--input-type=module", "--eval", "import assert from 'node:assert/strict'; import {pathToFileURL} from 'node:url'; const m=await import(pathToFileURL(process.argv[1]).href);" + contracts[i]!, pair.destination]));
    for (const item of prerequisites) {
      stage = "fixed_" + item.id;
      pass(prerequisite("fixed-" + item.id, item.command, item.args, expectedTracked, item.cwd));
    }
    const expectedRuntime = originalRuntimePins.map((file) => {
      const pair = input.raw_pairs.find((pair) => pair.destination === file.path);
      if (!pair) return file;
      const fixed = pins([pair.fixed])[0]!;
      return { path: file.path, bytes: fixed.bytes, sha256: fixed.sha256 };
    });
    assert.deepEqual(pins(full.files.map((file) => file.path)), expectedRuntime);
    status = "native_original_failure_fixed_import_and_three_prerequisites_passed_not_full_acceptance";
  }
} catch { status = "failed_or_incomplete"; process.exitCode = 1; }
finally {
  save(mode === "preflight" ? "preflight-receipt.json" : "causal-receipt.json", { status, stage, identity, original_sources: originalSources, actual_sources: pins(input.sources.map((s) => s.path)), actual_helper: pins([SELF])[0], actual_workflow: pins([WORKFLOW])[0], original_runtime: originalRuntimePins, actual_runtime: pins(full.files.map((file) => file.path)), native_receipts: nativeReceipts, syntax_receipts: syntaxReceipts, tracked_receipts: trackedReceipts, raw_output_retained: false, full_acceptance: false, resource_acceptance: false, production_actions: false });
  console.log(JSON.stringify({ status, stage, native_cases: nativeReceipts.length, syntax_cases: syntaxReceipts.length }));
}
