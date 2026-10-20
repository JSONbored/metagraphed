// Hosted source overlay only; measurement and qualification run separately.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const BASE = "0a65fcffd51b0a6a2b9757905be02c1d8b859e6c";
const BRANCH = "ci/data-api-type-contract-graph-20261020";
const SELF = ".github/scripts/apply-data-api-type-contract-graph.ts";
const ROOT = ".github/fixtures/data-api-contract-graph/";
const MANIFEST = ROOT + "overlay-manifest.json";
const PLAN = ROOT + "plan.json";
const PLAN_SHA256 = "af973a684f49d02929596d5a71b4003c1a12b7b9c3955c7fc736bf4423c2f419";
const BASELINE_SHA256 = "ff2d981180a789375e9bb7d3572ac4c779fd0498a0197b0341b0d578c0401f78";
const EXTRACT_SHA256 = "60cc5954037eeb2d955bc5d25c6f5a4fe3834408db4d6d4dcceb4dba133e68df";
const BEFORE_SHA256 = "334bbb407b5261ac5b320c68a9bcabdcbaaa7b783a81607ad675b963585ed990";
const AFTER_SHA256 = "154b6081ff381a32147a3ba7f72cae764deb61f6c1ae4c26ddcd5e9d8c5a5cef";
const TEST = "tests/data-api-bundle-boundary.test.ts";
const TEST_BLOB = "d7781eafec8abd7a3d05fffba9fb963651a7168d";
const REPORTS = "queue-contract-graph-reports";
const REPORT_NAMES = ["before", "after", "compare", "formatted", "controls", "overlay-baseline", "overlay-extract"] as const;
type Mode = "baseline" | "extract";
interface Pin { path: string; bytes: number; sha256: string }
interface Payload extends Pin { payload: string; git_blob_sha: string; expected_base_blob_sha: string | null }
interface Manifest { version: 1; base_commit: string; fixed_branch: string; plan_sha256: string; helper_sha256: string; carrier_files: string[]; baseline_files: Payload[]; extract_files: Payload[] }
interface Plan { before_files: Pin[]; after_files: Pin[]; new_type_paths: string[]; tracked_paths: string[] }
interface Entry { mode: string; type: string; sha: string }
interface Identity { source_commit: string; run_id: string; run_attempt: string }
class Refusal extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}
function requireThat(value: unknown, code: string): asserts value { if (!value) throw new Refusal(code); }
const hash = (raw: string | Uint8Array) => createHash("sha256").update(raw).digest("hex");
const blob = (raw: Uint8Array) => createHash("sha1").update("blob " + raw.byteLength + "\0").update(raw).digest("hex");
const record = (value: unknown): Record<string, unknown> => { requireThat(value !== null && typeof value === "object" && !Array.isArray(value), "object_shape"); return value as Record<string, unknown>; };
const publicPath = (value: unknown): value is string => typeof value === "string" && value.length <= 192 && /^(?:src|workers|tests)\/[A-Za-z0-9_./-]+$/.test(value) && !value.includes("..") && !value.includes("//");
const carrierPath = (value: unknown): value is string => typeof value === "string" && value.length <= 256 && /^\.github\/[A-Za-z0-9_./-]+$/.test(value) && !value.includes("..") && !value.includes("//");
const digest = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const gitDigest = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
const ordered = <T extends { path: string }>(rows: T[]): T[] => [...rows].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function frame(rows: Pin[]) { const files = ordered(rows.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }))); return { sha256: hash(files.map((pin) => pin.path + "\0" + pin.sha256 + "\0" + pin.bytes + "\n").join("")), files }; }
function read(path: string, maximum: number): Buffer { const info = lstatSync(path); requireThat(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= maximum, "file_bound"); const raw = readFileSync(path); requireThat(raw.length === info.size, "file_changed"); return raw; }
function absent(path: string): boolean { try { lstatSync(path); return false; } catch (error) { if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return true; throw error; } }
function json(path: string, maximum: number): unknown { return JSON.parse(read(path, maximum).toString("utf8")) as unknown; }
function git(...args: string[]): Buffer { try { return execFileSync("git", args, { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 4 * 1024 * 1024, timeout: 30_000 }); } catch { throw new Refusal("git_operation_failed"); } }
const gitText = (...args: string[]) => git(...args).toString("utf8").trim();
function tree(ref: string): Map<string, Entry> {
  const entries = new Map<string, Entry>();
  for (const item of git("ls-tree", "-r", "-z", ref).toString("utf8").split("\0").filter(Boolean)) {
    const match = /^([0-7]{6}) (blob|commit) ([0-9a-f]{40})\t(.+)$/.exec(item); requireThat(match && !entries.has(match[4]!), "git_tree_shape");
    entries.set(match[4]!, { mode: match[1]!, type: match[2]!, sha: match[3]! });
  }
  requireThat(entries.size > 1000 && entries.size <= 10000, "git_tree_bound"); return entries;
}
function diff(reference: string, cached = false, end?: string): { path: string; status: string }[] {
  const args = ["diff", ...(cached ? ["--cached"] : []), "--name-status", "--no-renames", "-z", reference, ...(end ? [end] : []), "--"];
  const fields = git(...args).toString("utf8").split("\0"); requireThat(fields.pop() === "" && fields.length % 2 === 0, "git_diff_shape");
  const rows: { path: string; status: string }[] = []; for (let i = 0; i < fields.length; i += 2) rows.push({ path: fields[i + 1]!, status: fields[i]! }); return ordered(rows);
}
function readPins(value: unknown, count: number): Pin[] {
  requireThat(Array.isArray(value) && value.length === count, "pin_count");
  const pins = value.map((entry) => { const row = record(entry); requireThat(publicPath(row.path) && typeof row.bytes === "number" && Number.isSafeInteger(row.bytes) && row.bytes > 0 && row.bytes <= 2 * 1024 * 1024 && digest(row.sha256), "pin_shape"); return { path: row.path, bytes: row.bytes, sha256: row.sha256 }; });
  requireThat(new Set(pins.map((pin) => pin.path)).size === count, "duplicate_pin"); return ordered(pins);
}
function readPayloads(value: unknown, mode: Mode, count: number): Payload[] {
  const pins = readPins(value, count), rows = value as unknown[];
  return pins.map((pin) => { const row = record(rows.find((entry) => record(entry).path === pin.path)); requireThat(row.payload === ROOT + mode + "/" + pin.path + ".payload" && gitDigest(row.git_blob_sha) && (row.expected_base_blob_sha === null || gitDigest(row.expected_base_blob_sha)), "payload_shape"); return { ...pin, payload: row.payload, git_blob_sha: row.git_blob_sha, expected_base_blob_sha: row.expected_base_blob_sha } as Payload; });
}
function identity(): Identity {
  const sourceCommit = process.env.GITHUB_SHA, runId = process.env.GITHUB_RUN_ID;
  requireThat(process.env.GITHUB_ACTIONS === "true" && process.platform === "linux" && process.versions.node === "22.23.2" && process.env.GITHUB_REF === "refs/heads/" + BRANCH && gitDigest(sourceCommit) && typeof runId === "string" && /^[1-9][0-9]{0,19}$/.test(runId) && process.env.GITHUB_RUN_ATTEMPT === "1", "run_identity");
  requireThat(gitText("rev-parse", "HEAD") === sourceCommit && gitText("rev-parse", BASE) === BASE, "head_identity"); git("merge-base", "--is-ancestor", BASE, "HEAD");
  return { source_commit: sourceCommit, run_id: runId, run_attempt: "1" };
}
function load(): { manifest: Manifest; plan: Plan; manifestHash: string } {
  const raw = read(MANIFEST, 256 * 1024), row = record(JSON.parse(raw.toString("utf8")) as unknown);
  requireThat(row.version === 1 && row.base_commit === BASE && row.fixed_branch === BRANCH && row.plan_sha256 === PLAN_SHA256 && digest(row.helper_sha256), "manifest_identity");
  requireThat(Array.isArray(row.carrier_files) && row.carrier_files.length >= 105 && row.carrier_files.length <= 160 && row.carrier_files.every(carrierPath) && new Set(row.carrier_files).size === row.carrier_files.length, "carrier_vector");
  const manifest: Manifest = { version: 1, base_commit: BASE, fixed_branch: BRANCH, plan_sha256: PLAN_SHA256, helper_sha256: row.helper_sha256, carrier_files: row.carrier_files as string[], baseline_files: readPayloads(row.baseline_files, "baseline", 21), extract_files: readPayloads(row.extract_files, "extract", 78) };
  requireThat(hash(read(SELF, 64 * 1024)) === manifest.helper_sha256 && hash(read(PLAN, 128 * 1024)) === PLAN_SHA256, "helper_or_plan_pin");
  requireThat(blob(read(TEST, 16 * 1024)) === TEST_BLOB, "canonical_boundary_changed");
  requireThat(frame(manifest.baseline_files).sha256 === BASELINE_SHA256 && frame(manifest.extract_files).sha256 === EXTRACT_SHA256, "payload_frame_identity");
  const selected = record(json(PLAN, 128 * 1024)); requireThat(selected.version === 1 && selected.base_commit === BASE && selected.fixed_branch === BRANCH, "plan_identity");
  const plan: Plan = { before_files: readPins(selected.before_files, 56), after_files: readPins(selected.after_files, 95), new_type_paths: [], tracked_paths: [] };
  requireThat(Array.isArray(selected.new_type_paths) && selected.new_type_paths.length === 39 && selected.new_type_paths.every(publicPath) && new Set(selected.new_type_paths).size === 39 && Array.isArray(selected.tracked_paths) && selected.tracked_paths.length === 41 && selected.tracked_paths.every(publicPath), "plan_paths");
  plan.new_type_paths = selected.new_type_paths as string[]; plan.tracked_paths = selected.tracked_paths as string[];
  requireThat(frame(plan.before_files).sha256 === BEFORE_SHA256 && frame(plan.after_files).sha256 === AFTER_SHA256, "source_frame_identity");
  const types = new Set(plan.new_type_paths), runtime = manifest.extract_files.filter((file) => !types.has(file.path));
  requireThat(runtime.length === 39 && runtime.every((file) => plan.tracked_paths.includes(file.path)) && plan.new_type_paths.every((path) => manifest.extract_files.some((file) => file.path === path)), "extraction_membership");
  const beforePaths = [...new Set([...manifest.baseline_files.map((file) => file.path), ...runtime.map((file) => file.path), TEST])].sort();
  const final = finalFiles(manifest), afterPaths = [...final.map((file) => file.path), TEST].sort();
  requireThat(same(beforePaths, plan.before_files.map((file) => file.path).sort()) && same(afterPaths, plan.after_files.map((file) => file.path).sort()), "finite_frame_union");
  for (const file of manifest.baseline_files) requireThat(same(frame([file]).files, frame(plan.before_files.filter((pin) => pin.path === file.path)).files), "baseline_plan_join");
  for (const file of final) requireThat(same(frame([file]).files, frame(plan.after_files.filter((pin) => pin.path === file.path)).files), "final_plan_join");
  const required = [SELF, MANIFEST, PLAN, ...manifest.baseline_files.map((file) => file.payload), ...manifest.extract_files.map((file) => file.payload)];
  requireThat(required.every((path) => manifest.carrier_files.includes(path)), "carrier_membership"); return { manifest, plan, manifestHash: hash(raw) };
}
function finalFiles(manifest: Manifest): Payload[] { const files = new Map(manifest.baseline_files.map((file) => [file.path, file])); for (const file of manifest.extract_files) files.set(file.path, file); const rows = ordered([...files.values()]); requireThat(rows.length === 94, "final_target_count"); return rows; }
function verify(pins: Pin[]) { for (const pin of pins) { const raw = read(pin.path, 2 * 1024 * 1024); requireThat(raw.length === pin.bytes && hash(raw) === pin.sha256, "source_pin_mismatch"); } return frame(pins); }
function headProof(manifest: Manifest): Map<string, Entry> {
  const baseline = tree(BASE), head = tree("HEAD"), approved = new Set(manifest.carrier_files);
  requireThat(head.size === baseline.size + approved.size, "canonical_tree_count");
  for (const [path, entry] of baseline) requireThat(!approved.has(path) && same(entry, head.get(path)), "canonical_tree_changed");
  for (const path of approved) { const entry = head.get(path); requireThat(!baseline.has(path) && entry?.mode === "100644" && entry.type === "blob" && blob(read(path, 2 * 1024 * 1024)) === entry.sha, "carrier_not_new_regular_committed"); }
  requireThat(same(diff(BASE, false, "HEAD"), ordered(manifest.carrier_files.map((path) => ({ path, status: "A" })))), "head_carrier_diff");
  for (const file of [...manifest.baseline_files, ...manifest.extract_files]) requireThat(file.expected_base_blob_sha === (baseline.get(file.path)?.sha ?? null) && (!baseline.has(file.path) || (baseline.get(file.path)!.mode === "100644" && baseline.get(file.path)!.type === "blob")), "base_payload_join");
  return baseline;
}
function expectedDiff(manifest: Manifest, files: Payload[], baseline: Map<string, Entry>) {
  return ordered([...manifest.carrier_files.map((path) => ({ path, status: "A" })), ...files.filter((file) => baseline.get(file.path)?.sha !== file.git_blob_sha).map((file) => ({ path: file.path, status: baseline.has(file.path) ? "M" : "A" }))]);
}
function workspace(manifest: Manifest, files: Payload[], baseline: Map<string, Entry>) {
  const expected = expectedDiff(manifest, files, baseline); requireThat(same(diff(BASE), expected) && same(diff(BASE, true), expected), "workspace_full_diff");
  requireThat(git("diff", "--name-only", "-z", "--").length === 0, "unstaged_change");
  const reports = new Set(REPORT_NAMES.map((name) => REPORTS + "/" + name + "-receipt.json"));
  const untracked = git("ls-files", "--others", "--exclude-standard", "-z").toString("utf8").split("\0").filter(Boolean);
  requireThat(untracked.length <= reports.size && untracked.every((path) => reports.has(path)), "unapproved_untracked_file"); for (const path of untracked) read(path, 131072);
  requireThat(git("ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", "src", "workers", "schemas-src", "generated", "tests").length === 0, "ignored_public_source_present");
  const indexed = new Map<string, { mode: string; sha: string }>();
  for (const line of git("ls-files", "--stage", "-z").toString("utf8").split("\0").filter(Boolean)) { const match = /^([0-7]{6}) ([0-9a-f]{40}) 0\t(.+)$/.exec(line); requireThat(match, "index_conflict_or_shape"); indexed.set(match[3]!, { mode: match[1]!, sha: match[2]! }); }
  for (const file of files) requireThat(indexed.get(file.path)?.mode === "100644" && indexed.get(file.path)?.sha === file.git_blob_sha, "index_payload_pin");
}
function payloads(files: Payload[]) { let total = 0; const verified = files.map((file) => { const raw = read(file.payload, 2 * 1024 * 1024); requireThat(raw.length === file.bytes && hash(raw) === file.sha256 && blob(raw) === file.git_blob_sha, "payload_pin_mismatch"); total += raw.length; return { file, raw }; }); requireThat(total <= 4 * 1024 * 1024, "payload_total_bound"); return verified; }
function priorReceipts(plan: Plan, identity: Identity, manifestHash: string, helperHash: string) {
  const applied = record(json(join(REPORTS, "overlay-baseline-receipt.json"), 131072)); requireThat(applied.version === 1 && applied.mode === "baseline" && applied.status === "passed" && applied.source_commit === identity.source_commit && applied.run_id === identity.run_id && applied.run_attempt === identity.run_attempt && applied.canonical_base === BASE && applied.plan_sha256 === PLAN_SHA256 && applied.manifest_sha256 === manifestHash && applied.helper_sha256 === helperHash && applied.canonical_baseline_proven === true && applied.head_unchanged === true && applied.final_public_paths_staged === 21 && same(applied.source_frame, frame(plan.before_files)), "baseline_receipt_identity");
  const measured = record(json(join(REPORTS, "before-receipt.json"), 131072)), details = record(measured.details);
  requireThat(measured.version === 1 && measured.status === "measured" && details.phase === "before" && details.source_commit === identity.source_commit && details.run_id === identity.run_id && details.run_attempt === identity.run_attempt && details.plan_sha256 === PLAN_SHA256 && same(details.source_frame, frame(plan.before_files)), "before_measurement_identity");
}
function save(mode: Mode, value: unknown) { const raw = JSON.stringify(value, null, 2) + "\n"; requireThat(Buffer.byteLength(raw) <= 131072, "receipt_bound"); mkdirSync(REPORTS, { recursive: true }); const path = join(REPORTS, "overlay-" + mode + "-receipt.json"); writeFileSync(path + ".tmp", raw); renameSync(path + ".tmp", path); }
function main(mode: Mode) {
  const who = identity(), selected = load(), { manifest, plan, manifestHash } = selected; let canonicalBaselineProven = false;
  try {
    const baseline = headProof(manifest); let verified: { file: Payload; raw: Buffer }[];
    if (mode === "baseline") {
      workspace(manifest, [], baseline); canonicalBaselineProven = true;
      requireThat(plan.new_type_paths.every(absent), "new_types_present_before_baseline");
      for (const file of manifest.baseline_files) { if (file.expected_base_blob_sha === null) requireThat(absent(file.path), "new_baseline_target_exists"); else requireThat(blob(read(file.path, 2 * 1024 * 1024)) === file.expected_base_blob_sha, "canonical_baseline_target_changed"); }
      verified = payloads(manifest.baseline_files);
    } else {
      workspace(manifest, manifest.baseline_files, baseline); verify(plan.before_files); priorReceipts(plan, who, manifestHash, manifest.helper_sha256);
      requireThat(plan.new_type_paths.every(absent), "new_types_present_before_extract"); verified = payloads(manifest.extract_files);
    }
    for (const { file, raw } of verified) { mkdirSync(dirname(file.path), { recursive: true }); writeFileSync(file.path, raw); requireThat(hash(read(file.path, 2 * 1024 * 1024)) === file.sha256, "overlay_readback"); }
    const final = mode === "baseline" ? manifest.baseline_files : finalFiles(manifest), sourceFrame = verify(mode === "baseline" ? plan.before_files : plan.after_files);
    git("add", "--", ...final.map((file) => file.path)); headProof(manifest); workspace(manifest, final, baseline); const indexTree = gitText("write-tree"); requireThat(gitText("rev-parse", "HEAD") === who.source_commit, "head_changed");
    save(mode, { version: 1, mode, status: "passed", ...who, canonical_base: BASE, plan_sha256: PLAN_SHA256, manifest_sha256: manifestHash, helper_sha256: manifest.helper_sha256, source_frame: sourceFrame, payload_files_written: verified.length, payload_bytes_written: verified.reduce((total, item) => total + item.raw.length, 0), final_public_paths_staged: final.length, runner_index_tree: indexTree, canonical_baseline_proven: canonicalBaselineProven, head_unchanged: true, runtime_graph_acceptance: false, resource_acceptance: false, production_activation: false, raw_output_retained: false });
    console.log(JSON.stringify({ mode, status: "passed", files_written: verified.length, staged_public_paths: final.length, raw_output_retained: false }));
  } catch (error) { save(mode, { version: 1, mode, status: "failed", ...who, canonical_base: BASE, plan_sha256: PLAN_SHA256, manifest_sha256: manifestHash, helper_sha256: manifest.helper_sha256, reason: error instanceof Refusal ? error.code : "overlay_internal_error", canonical_baseline_proven: canonicalBaselineProven, runtime_graph_acceptance: false, resource_acceptance: false, production_activation: false, raw_output_retained: false }); throw error; }
}
try { const mode = process.argv[2]; requireThat(mode === "baseline" || mode === "extract", "mode"); main(mode); } catch { console.error(JSON.stringify({ status: "source_overlay_failed", raw_output_retained: false })); process.exitCode = 1; }
