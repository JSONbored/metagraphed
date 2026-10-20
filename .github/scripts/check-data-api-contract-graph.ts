// Independent source-graph measurement only. No resource/preflight code reused.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLAN = ".github/fixtures/data-api-contract-graph/plan.json";
const REPORTS = "queue-contract-graph-reports";
const BASE = "0a65fcffd51b0a6a2b9757905be02c1d8b859e6c";
const TEST = "tests/data-api-bundle-boundary.test.ts";
const TEST_BLOB = "d7781eafec8abd7a3d05fffba9fb963651a7168d";
const SOURCE_BUDGET = 4_826_000;
const FORBIDDEN = [
  "src/mcp-server.ts", "src/projection-write-store.ts", "src/native-store-export.ts",
  "src/raw-capture-d1.ts", "src/raw-capture-sync.ts", "src/account-balance.ts",
  "src/chain-burn.ts", "src/subnet-burn-history.ts", "src/network-parameters.ts",
  "src/chain-rpc.ts", "src/chain-rpc-admission.ts", "src/graphql.ts",
  "generated/graphql/schema.ts", "workers/api.ts", "workers/chain-firehose-hub.ts",
] as const;
type Phase = "before" | "after";
type MeasuredPhase = Phase | "formatted";
interface Pin { path: string; bytes: number; sha256: string }
export interface Plan {
  version: 1; base_commit: string; fixed_branch: string;
  allowed_input_paths: string[]; tracked_paths: string[]; new_type_paths: string[];
  before_files: Pin[]; after_files: Pin[];
}
interface SourceFrame { sha256: string; files: Pin[] }
interface Graph {
  all_input_count: number; first_party_input_count: number; first_party_bytes: number;
  first_party_inventory_sha256: string; source_guard_pass: boolean;
  tracked: { path: string; in_graph: boolean; bytes: number | null; sha256: string | null }[];
  forbidden: { path: string; in_graph: boolean }[];
  new_types: { path: string; in_graph: boolean }[];
}
interface Native { exit: number | null; signal: string | null; process_error: boolean; stdout_bytes: number; stderr_bytes: number }
interface Snapshot {
  phase: MeasuredPhase; source_commit: string; run_id: string; run_attempt: string; plan_sha256: string; source_frame: SourceFrame;
  graph: Graph; compiled: { bytes: number; sha256: string };
  canonical_native: Native; companion_native: Native;
}
class Refusal extends Error {
  readonly code: string;
  readonly details: unknown;
  constructor(code: string, details: unknown = null) { super(code); this.code = code; this.details = details; }
}
function refuse(condition: unknown, code: string): asserts condition { if (!condition) throw new Refusal(code); }
const hash = (raw: string | Uint8Array) => createHash("sha256").update(raw).digest("hex");
const record = (value: unknown): Record<string, unknown> => {
  refuse(value !== null && typeof value === "object" && !Array.isArray(value), "object_shape");
  return value as Record<string, unknown>;
};
const bounded = (path: string, cap: number, allowEmpty = false): Buffer => {
  const info = statSync(path); refuse(info.isFile() && (allowEmpty || info.size > 0) && info.size <= cap, "file_bound");
  const raw = readFileSync(path); refuse(raw.length === info.size, "file_changed"); return raw;
};
const load = (path: string, cap: number): unknown => JSON.parse(bounded(path, cap).toString("utf8")) as unknown;
const pathName = (value: unknown): value is string => typeof value === "string" && value.length <= 192 && /^(?:src|workers|schemas-src|generated|tests)\/[A-Za-z0-9_.\/-]+$/.test(value) && !value.includes("..") && !value.includes("//");
function paths(value: unknown, cap: number): string[] {
  refuse(Array.isArray(value) && value.length <= cap, "path_vector_bound");
  refuse(value.every(pathName) && new Set(value).size === value.length, "path_vector_shape");
  return value as string[];
}
function pins(value: unknown): Pin[] {
  refuse(Array.isArray(value) && value.length > 0 && value.length <= 128, "pin_vector_bound");
  return value.map((entry) => {
    const row = record(entry); refuse(pathName(row.path), "pin_path");
    refuse(typeof row.bytes === "number" && Number.isSafeInteger(row.bytes) && row.bytes > 0 && row.bytes <= 2 * 1024 * 1024, "pin_bytes");
    refuse(typeof row.sha256 === "string" && /^[0-9a-f]{64}$/.test(row.sha256), "pin_hash");
    return { path: row.path, bytes: row.bytes, sha256: row.sha256 };
  });
}
function plan(): { value: Plan; sha256: string } {
  const raw = bounded(PLAN, 512 * 1024), row = record(JSON.parse(raw.toString("utf8")) as unknown);
  refuse(row.version === 1 && row.base_commit === BASE && typeof row.fixed_branch === "string" && /^ci\/[a-z0-9-]+$/.test(row.fixed_branch), "plan_identity");
  const value: Plan = { version: 1, base_commit: BASE, fixed_branch: row.fixed_branch,
    allowed_input_paths: paths(row.allowed_input_paths, 4096), tracked_paths: paths(row.tracked_paths, 128), new_type_paths: paths(row.new_type_paths, 64), before_files: pins(row.before_files), after_files: pins(row.after_files) };
  refuse(value.tracked_paths.includes("workers/data-api.ts") && value.new_type_paths.length > 0 && value.tracked_paths.every((path) => value.allowed_input_paths.includes(path)) && value.new_type_paths.every((path) => value.allowed_input_paths.includes(path)), "plan_membership");
  refuse(new Set(value.before_files.map((pin) => pin.path)).size === value.before_files.length && new Set(value.after_files.map((pin) => pin.path)).size === value.after_files.length, "duplicate_pin");
  refuse(process.env.GITHUB_REF === "refs/heads/" + value.fixed_branch, "branch_identity");
  refuse(process.env.GITHUB_ACTIONS === "true" && process.platform === "linux" && process.versions.node === "22.23.2" && /^[0-9a-f]{40}$/.test(process.env.GITHUB_SHA ?? "") && /^[1-9][0-9]{0,19}$/.test(process.env.GITHUB_RUN_ID ?? "") && process.env.GITHUB_RUN_ATTEMPT === "1", "run_identity");
  const head = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, maxBuffer: 1024 });
  refuse(head.error === undefined && head.signal === null && head.status === 0 && head.stdout.trim() === process.env.GITHUB_SHA, "git_head_identity");
  const test = bounded(TEST, 16 * 1024); refuse(createHash("sha1").update("blob " + test.length + "\0").update(test).digest("hex") === TEST_BLOB, "canonical_test_changed");
  return { value, sha256: hash(raw) };
}
export function sourceFrame(files: Pin[]): SourceFrame {
  const ordered = files.map((pin) => ({ ...pin })).sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const aggregate = createHash("sha256"); for (const row of ordered) aggregate.update(row.path + "\0" + row.sha256 + "\0" + row.bytes + "\n");
  return { sha256: aggregate.digest("hex"), files: ordered };
}
function verify(files: Pin[]): SourceFrame {
  for (const pin of files) { const raw = bounded(pin.path, 2 * 1024 * 1024); refuse(raw.length === pin.bytes && hash(raw) === pin.sha256, "source_pin_mismatch"); }
  return sourceFrame(files);
}
function native(meta: string, output: string): Native {
  // Exact canonical invocation; the companion changes only the output path.
  const result = spawnSync("npx", ["esbuild", "workers/data-api.ts", "--bundle", "--format=esm", "--platform=node", `--metafile=${meta}`, `--outfile=${output}`, "--log-level=error", "--external:cloudflare:workers", "--external:node:*"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000, maxBuffer: 512 * 1024 });
  const value = { exit: result.status, signal: result.signal, process_error: result.error !== undefined, stdout_bytes: Buffer.byteLength(result.stdout ?? ""), stderr_bytes: Buffer.byteLength(result.stderr ?? "") };
  if (result.error !== undefined || result.signal !== null || result.status !== 0) throw new Refusal("native_compile_failed", { native: value });
  return value;
}
function graph(raw: unknown, current: Plan): Graph {
  const input = record(record(raw).inputs), entries = Object.entries(input); refuse(entries.length <= 4096 && entries.length > 100, "input_count_bound");
  refuse(Object.hasOwn(input, "workers/data-api.ts"), "own_entry_missing");
  const selected: { path: string; bytes: number; sha256: string }[] = []; let total = 0;
  for (const [path, value] of entries) {
    if (!/^(src|workers|schemas-src|generated)\//.test(path)) continue;
    refuse(pathName(path) && current.allowed_input_paths.includes(path), "unapproved_public_input");
    const count = record(value).bytes; refuse(typeof count === "number" && Number.isSafeInteger(count) && count >= 0 && count <= 2 * 1024 * 1024, "input_bytes_bound");
    const source = bounded(path, 2 * 1024 * 1024, true); refuse(source.length === count, "input_source_mismatch");
    total += count; refuse(total <= 16 * 1024 * 1024, "total_source_bound"); selected.push({ path, bytes: count, sha256: hash(source) });
  }
  selected.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const aggregate = createHash("sha256"); for (const row of selected) aggregate.update(row.path + "\0" + row.sha256 + "\0" + row.bytes + "\n");
  const byPath = new Map(selected.map((row) => [row.path, row]));
  return { all_input_count: entries.length, first_party_input_count: selected.length, first_party_bytes: total, first_party_inventory_sha256: aggregate.digest("hex"), source_guard_pass: total < SOURCE_BUDGET,
    tracked: current.tracked_paths.map((path) => ({ path, in_graph: byPath.has(path), bytes: byPath.get(path)?.bytes ?? null, sha256: byPath.get(path)?.sha256 ?? null })),
    forbidden: FORBIDDEN.map((path) => ({ path, in_graph: Object.hasOwn(input, path) })), new_types: current.new_type_paths.map((path) => ({ path, in_graph: Object.hasOwn(input, path) })) };
}
function measure(phase: MeasuredPhase, current: Plan, planHash: string, expected = phase === "before" ? current.before_files : current.after_files): Snapshot {
  const source_frame = verify(expected);
  if (phase === "before") refuse(current.new_type_paths.every((path) => !existsSync(path)), "new_types_already_present");
  const directory = mkdtempSync(join(tmpdir(), "data-api-contract-graph-"));
  try {
    const meta = join(directory, "meta.json"), canonical_native = native(meta, "/dev/null"), observed = graph(load(meta, 4 * 1024 * 1024), current);
    const companionMeta = join(directory, "companion-meta.json"), output = join(directory, "bundle.js"), companion_native = native(companionMeta, output), companionGraph = graph(load(companionMeta, 4 * 1024 * 1024), current);
    refuse(JSON.stringify(observed) === JSON.stringify(companionGraph), "companion_graph_changed");
    const compiled = bounded(output, 32 * 1024 * 1024); refuse(JSON.stringify(verify(expected)) === JSON.stringify(source_frame), "source_frame_changed");
    return { phase, source_commit: process.env.GITHUB_SHA ?? "", run_id: process.env.GITHUB_RUN_ID ?? "", run_attempt: process.env.GITHUB_RUN_ATTEMPT ?? "", plan_sha256: planHash, source_frame, graph: observed, compiled: { bytes: compiled.length, sha256: hash(compiled) }, canonical_native, companion_native };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
function natural(value: unknown, cap: number): number {
  refuse(typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= cap, "receipt_integer"); return value;
}
function digest(value: unknown): string { refuse(typeof value === "string" && /^[0-9a-f]{64}$/.test(value), "receipt_digest"); return value; }
export function decodeSnapshot(value: unknown, phase: MeasuredPhase, current: Plan, planHash: string, identity: { source_commit: string; run_id: string; run_attempt: string }, expectedFiles = phase === "before" ? current.before_files : current.after_files): Snapshot {
  const row = record(value); refuse(row.phase === phase && row.source_commit === identity.source_commit && row.run_id === identity.run_id && row.run_attempt === identity.run_attempt && row.plan_sha256 === planHash, "snapshot_identity");
  const input = record(row.graph), compiled = record(row.compiled);
  const source_frame = sourceFrame(expectedFiles);
  refuse(JSON.stringify(row.source_frame) === JSON.stringify(source_frame), "snapshot_source_frame");
  const flags = (raw: unknown, expected: readonly string[]) => {
    refuse(Array.isArray(raw) && raw.length === expected.length, "flag_vector");
    return raw.map((item, index) => { const entry = record(item); refuse(entry.path === expected[index] && typeof entry.in_graph === "boolean", "flag_member"); return { path: expected[index]!, in_graph: entry.in_graph }; });
  };
  refuse(Array.isArray(input.tracked) && input.tracked.length === current.tracked_paths.length, "tracked_vector");
  const tracked = input.tracked.map((item, index) => {
    const entry = record(item); refuse(entry.path === current.tracked_paths[index] && typeof entry.in_graph === "boolean", "tracked_member");
    if (!entry.in_graph) { refuse(entry.bytes === null && entry.sha256 === null, "tracked_absent"); return { path: current.tracked_paths[index]!, in_graph: false, bytes: null, sha256: null }; }
    return { path: current.tracked_paths[index]!, in_graph: true, bytes: natural(entry.bytes, 2 * 1024 * 1024), sha256: digest(entry.sha256) };
  });
  const ownEntry = tracked.find((entry) => entry.path === "workers/data-api.ts");
  refuse(ownEntry?.in_graph === true && ownEntry.bytes !== null && ownEntry.bytes > 0, "snapshot_own_entry");
  for (const entry of tracked) {
    const expected = source_frame.files.find((pin) => pin.path === entry.path);
    if (entry.in_graph && expected) refuse(entry.bytes === expected.bytes && entry.sha256 === expected.sha256, "snapshot_tracked_source");
  }
  const first_party_bytes = natural(input.first_party_bytes, 16 * 1024 * 1024); refuse(first_party_bytes > 0 && input.source_guard_pass === (first_party_bytes < SOURCE_BUDGET), "source_guard_value");
  const readNative = (value: unknown): Native => {
    const native = record(value); refuse(native.exit === 0 && native.signal === null && native.process_error === false, "snapshot_native_result");
    return { exit: 0, signal: null, process_error: false, stdout_bytes: natural(native.stdout_bytes, 512 * 1024), stderr_bytes: natural(native.stderr_bytes, 512 * 1024) };
  };
  const all_input_count = natural(input.all_input_count, 4096), first_party_input_count = natural(input.first_party_input_count, 4096), compiled_bytes = natural(compiled.bytes, 32 * 1024 * 1024);
  refuse(all_input_count > 100 && first_party_input_count > 0 && first_party_input_count <= all_input_count && compiled_bytes > 0, "snapshot_measured_bounds");
  return { phase, ...identity, plan_sha256: planHash, source_frame,
    graph: { all_input_count, first_party_input_count, first_party_bytes, first_party_inventory_sha256: digest(input.first_party_inventory_sha256), source_guard_pass: first_party_bytes < SOURCE_BUDGET, tracked, forbidden: flags(input.forbidden, FORBIDDEN), new_types: flags(input.new_types, current.new_type_paths) },
    compiled: { bytes: compiled_bytes, sha256: digest(compiled.sha256) }, canonical_native: readNative(row.canonical_native), companion_native: readNative(row.companion_native) };
}
function graphGuards(value: Graph) {
  refuse(value.source_guard_pass, "source_budget_failed");
  refuse(value.forbidden.every((entry) => entry.in_graph === false), "forbidden_boundary_failed");
  refuse(value.new_types.every((entry) => entry.in_graph === false), "new_types_in_runtime_graph");
}
function formattedFrame(current: Plan): { files: Pin[]; native_format_receipt_sha256: string } {
  const path = "queue-architecture-reports/format-receipt.json", raw = bounded(path, 131072), receipt = record(JSON.parse(raw.toString("utf8")) as unknown);
  refuse(receipt.version === 1 && receipt.phase === "format" && receipt.status === "passed" && receipt.source_commit === process.env.GITHUB_SHA && receipt.run_id === process.env.GITHUB_RUN_ID && receipt.run_attempt === process.env.GITHUB_RUN_ATTEMPT, "format_receipt_identity");
  const details = record(receipt.details), result = record(details.native);
  refuse(details.stage === "projected" && result.exit === 0 && result.signal === null && result.process_error === false && result.unhandled === false, "format_native_result");
  refuse(Array.isArray(details.input_source_pins) && Array.isArray(details.source_pins), "format_pin_vectors");
  const input = details.input_source_pins.map(record), output = details.source_pins.map(record);
  refuse(input.length <= 128 && output.length === input.length, "format_pin_bound");
  const files = current.after_files.map((expected) => {
    if (!expected.path.endsWith(".ts") || expected.path === TEST) return expected;
    const incoming = input.filter((pin) => pin.path === expected.path), outgoing = output.filter((pin) => pin.path === expected.path);
    refuse(incoming.length === 1 && outgoing.length === 1 && incoming[0]!.bytes === expected.bytes && incoming[0]!.sha256 === expected.sha256, "format_input_join");
    const bytes = natural(outgoing[0]!.bytes, 2 * 1024 * 1024); refuse(bytes > 0, "format_output_empty");
    return { path: expected.path, bytes, sha256: digest(outgoing[0]!.sha256) };
  });
  verify(files); return { files, native_format_receipt_sha256: hash(raw) };
}
function formattedWorkspace(current: Plan, planHash: string) {
  const path = ".github/fixtures/data-api-contract-graph/overlay-manifest.json", raw = bounded(path, 256 * 1024), manifest = record(JSON.parse(raw.toString("utf8")) as unknown), applied = record(load(join(REPORTS, "overlay-extract-receipt.json"), 131072));
  refuse(applied.status === "passed" && applied.source_commit === process.env.GITHUB_SHA && applied.run_id === process.env.GITHUB_RUN_ID && applied.run_attempt === process.env.GITHUB_RUN_ATTEMPT && applied.plan_sha256 === planHash && applied.manifest_sha256 === hash(raw), "formatted_overlay_identity");
  const carrier = manifest.carrier_files;
  refuse(Array.isArray(carrier) && carrier.length === 110 && new Set(carrier).size === 110 && carrier.every((name) => typeof name === "string" && name.length <= 256 && /^\.github\/[A-Za-z0-9_./-]+$/.test(name) && !name.includes("..") && !name.includes("//")), "formatted_carrier_scope");
  const git = (args: string[]) => { const result = spawnSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, maxBuffer: 1024 * 1024 }); refuse(result.error === undefined && result.signal === null && result.status === 0, "formatted_git_failed"); return result.stdout; };
  refuse(git(["rev-parse", "HEAD"]).trim() === process.env.GITHUB_SHA, "formatted_head_changed");
  const expected = [...carrier as string[], ...current.after_files.map((pin) => pin.path).filter((name) => name !== TEST)].sort();
  refuse(JSON.stringify(git(["diff", "--name-only", "-z", BASE]).split("\0").filter(Boolean).sort()) === JSON.stringify(expected), "formatted_workspace_scope");
  const roots = ["src", "workers", "schemas-src", "generated", "tests"];
  refuse(git(["ls-files", "--others", "--exclude-standard", "-z", "--", ...roots]) === "" && git(["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", ...roots]) === "", "formatted_untracked_public_source");
}
function decoderControls() {
  const path = ".github/scripts/check-data-api-contract-graph.test.ts";
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", path], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000, maxBuffer: 512 * 1024 });
  const stdout = result.stdout ?? "", stderr = result.stderr ?? "";
  const count = (name: string): number | null => { const found = new RegExp("^# " + name + " ([0-9]{1,4})$", "m").exec(stdout); return found ? Number(found[1]) : null; };
  return { control_source: { path, bytes: bounded(path, 64 * 1024).length, sha256: hash(bounded(path, 64 * 1024)) }, native: { exit: result.status, signal: result.signal, process_error: result.error !== undefined, stdout_bytes: Buffer.byteLength(stdout), stderr_bytes: Buffer.byteLength(stderr) }, counts: { tests: count("tests"), pass: count("pass"), fail: count("fail"), cancelled: count("cancelled"), skipped: count("skipped"), todo: count("todo") } };
}
function write(name: string, value: unknown) {
  const encoded = JSON.stringify({ ...record(value), source_commit: process.env.GITHUB_SHA, run_id: process.env.GITHUB_RUN_ID, run_attempt: process.env.GITHUB_RUN_ATTEMPT, plan_sha256: hash(bounded(PLAN, 512 * 1024)), node_version: process.versions.node, platform: process.platform }, null, 2) + "\n"; refuse(Buffer.byteLength(encoded) <= 131072, "receipt_bound");
  mkdirSync(REPORTS, { recursive: true }); const path = join(REPORTS, name + "-receipt.json"); writeFileSync(path + ".tmp", encoded); renameSync(path + ".tmp", path);
}
function main() {
  const mode = process.argv[2]; refuse(mode === "before" || mode === "after" || mode === "compare" || mode === "formatted" || mode === "controls" || mode === "summary", "mode");
  const selected = plan(); let details: unknown = null;
  try {
    if (mode === "summary") {
      formattedWorkspace(selected.value, selected.sha256);
      const names = ["before", "after", "compare", "formatted", "controls"] as const;
      const rows = names.map((name) => { const raw = bounded(join(REPORTS, name + "-receipt.json"), 131072), value = record(JSON.parse(raw.toString("utf8")) as unknown); refuse(value.status === (name === "compare" ? "compared" : "measured") && value.source_commit === process.env.GITHUB_SHA && value.run_id === process.env.GITHUB_RUN_ID && value.run_attempt === process.env.GITHUB_RUN_ATTEMPT && value.plan_sha256 === selected.sha256 && value.node_version === "22.23.2" && value.platform === "linux", "required_graph_phase_failed"); return { name, sha256: hash(raw), value }; });
      const identity = { source_commit: process.env.GITHUB_SHA!, run_id: process.env.GITHUB_RUN_ID!, run_attempt: process.env.GITHUB_RUN_ATTEMPT! };
      const first = decodeSnapshot(rows[0]!.value.details, "before", selected.value, selected.sha256, identity), after = decodeSnapshot(rows[1]!.value.details, "after", selected.value, selected.sha256, identity), proof = record(rows[2]!.value.details);
      const comparedFirst = decodeSnapshot(proof.before, "before", selected.value, selected.sha256, identity), comparedAfter = decodeSnapshot(proof.after, "after", selected.value, selected.sha256, identity);
      refuse(JSON.stringify(first) === JSON.stringify(comparedFirst) && JSON.stringify(after) === JSON.stringify(comparedAfter) && proof.compiled_output_equal === true && first.compiled.bytes === after.compiled.bytes && first.compiled.sha256 === after.compiled.sha256, "required_compiler_equivalence_failed");
      const formatted = formattedFrame(selected.value), finalProof = record(rows[3]!.value.details), final = decodeSnapshot(finalProof.snapshot, "formatted", selected.value, selected.sha256, identity, formatted.files);
      refuse(finalProof.native_format_receipt_sha256 === formatted.native_format_receipt_sha256 && finalProof.immutable_after_frame_sha256 === sourceFrame(selected.value.after_files).sha256 && JSON.stringify(finalProof.observed_formatted_frame) === JSON.stringify(final.source_frame) && finalProof.compiled_output_equal_to_unformatted_after === true && final.compiled.bytes === after.compiled.bytes && final.compiled.sha256 === after.compiled.sha256, "required_formatted_join_failed");
      const controls = record(rows[4]!.value.details), counts = record(controls.counts), native = record(controls.native), control = record(controls.control_source), controlPath = ".github/scripts/check-data-api-contract-graph.test.ts", controlBytes = bounded(controlPath, 64 * 1024);
      refuse(native.exit === 0 && native.signal === null && native.process_error === false && counts.tests === 14 && counts.pass === 14 && counts.fail === 0 && counts.cancelled === 0 && counts.skipped === 0 && counts.todo === 0 && control.path === controlPath && control.bytes === controlBytes.length && control.sha256 === hash(controlBytes), "required_controls_failed");
      graphGuards(after.graph); graphGuards(final.graph);
      details = { source_commit: identity.source_commit, run_id: identity.run_id, run_attempt: identity.run_attempt, plan_sha256: selected.sha256, phases: rows.map(({ name, sha256 }) => ({ name, sha256 })), final_source_frame_sha256: final.source_frame.sha256, final_first_party_bytes: final.graph.first_party_bytes, final_source_guard_pass: final.graph.source_guard_pass, workspace_scope_verified: true };
    } else if (mode === "controls") {
      const observed = decoderControls(); details = observed;
      refuse(observed.native.exit === 0 && observed.native.signal === null && observed.native.process_error === false && observed.counts.tests === 14 && observed.counts.pass === 14 && observed.counts.fail === 0 && observed.counts.cancelled === 0 && observed.counts.skipped === 0 && observed.counts.todo === 0, "native_decoder_controls_failed");
    } else if (mode === "formatted") {
      formattedWorkspace(selected.value, selected.sha256);
      const formatted = formattedFrame(selected.value), firstAfter = record(load(join(REPORTS, "after-receipt.json"), 131072));
      refuse(firstAfter.status === "measured", "snapshot_status");
      const identity = { source_commit: process.env.GITHUB_SHA!, run_id: process.env.GITHUB_RUN_ID!, run_attempt: process.env.GITHUB_RUN_ATTEMPT! };
      const unformatted = decodeSnapshot(firstAfter.details, "after", selected.value, selected.sha256, identity), observed = measure("formatted", selected.value, selected.sha256, formatted.files);
      const equal = unformatted.compiled.bytes === observed.compiled.bytes && unformatted.compiled.sha256 === observed.compiled.sha256;
      details = { native_format_receipt_sha256: formatted.native_format_receipt_sha256, immutable_after_frame_sha256: sourceFrame(selected.value.after_files).sha256, observed_formatted_frame: observed.source_frame, snapshot: observed, compiled_output_equal_to_unformatted_after: equal, workspace_scope_verified: true };
      formattedWorkspace(selected.value, selected.sha256);
      refuse(equal, "formatted_compiled_output_changed"); graphGuards(observed.graph);
    } else if (mode !== "compare") details = measure(mode, selected.value, selected.sha256);
    else {
      const before = record(load(join(REPORTS, "before-receipt.json"), 131072)), after = record(load(join(REPORTS, "after-receipt.json"), 131072));
      refuse(before.status === "measured" && after.status === "measured", "snapshot_status");
      const identity = { source_commit: process.env.GITHUB_SHA!, run_id: process.env.GITHUB_RUN_ID!, run_attempt: process.env.GITHUB_RUN_ATTEMPT! };
      const first = decodeSnapshot(before.details, "before", selected.value, selected.sha256, identity), last = decodeSnapshot(after.details, "after", selected.value, selected.sha256, identity);
      const firstCompiled = first.compiled, lastCompiled = last.compiled, lastGraph = last.graph;
      details = { before: first, after: last, compiled_output_equal: firstCompiled.bytes === lastCompiled.bytes && firstCompiled.sha256 === lastCompiled.sha256 };
      write(mode, { version: 1, status: "compared", details, acceptance: false, raw_output_retained: false });
      refuse(record(details).compiled_output_equal, "compiled_output_changed");
      graphGuards(lastGraph);
      return;
    }
    write(mode, { version: 1, status: "measured", details, acceptance: false, raw_output_retained: false });
  } catch (error) {
    if (error instanceof Refusal && error.details !== null) details = error.details;
    write(mode, { version: 1, status: "failed", reason: error instanceof Refusal ? error.code : "measurement_internal_error", details, acceptance: false, raw_output_retained: false });
    throw new Refusal("measurement_failed");
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch { console.error(JSON.stringify({ status: "graph_measurement_failed", raw_output_retained: false })); process.exitCode = 1; }
}
