// Native Node decoder controls only; synthetic receipts are never measurement evidence.
import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeSnapshot, sourceFrame, type Plan } from "./check-data-api-contract-graph.ts";

const identity = { source_commit: "a".repeat(40), run_id: "123456789", run_attempt: "1" };
const planHash = "b".repeat(64);
const forbidden = [
  "src/mcp-server.ts", "src/projection-write-store.ts", "src/native-store-export.ts",
  "src/raw-capture-d1.ts", "src/raw-capture-sync.ts", "src/account-balance.ts",
  "src/chain-burn.ts", "src/subnet-burn-history.ts", "src/network-parameters.ts",
  "src/chain-rpc.ts", "src/chain-rpc-admission.ts", "src/graphql.ts",
  "generated/graphql/schema.ts", "workers/api.ts", "workers/chain-firehose-hub.ts",
];
const pin = { path: "workers/data-api.ts", bytes: 395494, sha256: "c".repeat(64) };
const current: Plan = {
  version: 1, base_commit: "0a65fcffd51b0a6a2b9757905be02c1d8b859e6c",
  fixed_branch: "ci/unit-decoder-only", allowed_input_paths: [pin.path, "workers/data-api-types.ts"],
  tracked_paths: [pin.path], new_type_paths: ["workers/data-api-types.ts"],
  before_files: [pin], after_files: [pin],
};
function fixture() {
  return {
    phase: "before", ...identity, plan_sha256: planHash, source_frame: sourceFrame(current.before_files),
    graph: { all_input_count: 240, first_party_input_count: 150, first_party_bytes: 4_825_999,
      first_party_inventory_sha256: "d".repeat(64), source_guard_pass: true,
      tracked: [{ path: pin.path, in_graph: true, bytes: pin.bytes, sha256: pin.sha256 }],
      forbidden: forbidden.map((path) => ({ path, in_graph: false })),
      new_types: current.new_type_paths.map((path) => ({ path, in_graph: false })) },
    compiled: { bytes: 12345, sha256: "e".repeat(64) },
    canonical_native: { exit: 0, signal: null, process_error: false, stdout_bytes: 0, stderr_bytes: 0 },
    companion_native: { exit: 0, signal: null, process_error: false, stdout_bytes: 0, stderr_bytes: 0 },
  };
}
const decode = (value: unknown) => decodeSnapshot(value, "before", current, planHash, identity);

test("keeps the numeric counter when the unchanged strict source budget fails", () => {
  const value = fixture(); value.graph.first_party_bytes = 4_826_000; value.graph.source_guard_pass = false;
  assert.equal(decode(value).graph.first_party_bytes, 4_826_000);
  assert.equal(decode(value).graph.source_guard_pass, false);
});

test("refuses empty and unresolved imported snapshots", () => {
  for (const count of [0, 100]) { const value = fixture(); value.graph.all_input_count = count; assert.throws(() => decode(value), /snapshot_measured_bounds/); }
  const value = fixture(); value.graph.first_party_input_count = 0; assert.throws(() => decode(value), /snapshot_measured_bounds/);
});

test("refuses first-party counts larger than the complete graph", () => {
  const value = fixture(); value.graph.first_party_input_count = 241; assert.throws(() => decode(value), /snapshot_measured_bounds/);
});

test("refuses a missing compiled artifact represented by zero bytes", () => {
  const value = fixture(); value.compiled.bytes = 0; assert.throws(() => decode(value), /snapshot_measured_bounds/);
});

test("does not launder unknown raw fields into a compare receipt", () => {
  const value = fixture(); const marker = "raw-field-must-not-be-retained";
  const hostile = { ...value, raw: marker,
    graph: { ...value.graph, raw: marker, tracked: [{ ...value.graph.tracked[0], raw: marker }] },
    compiled: { ...value.compiled, raw: marker }, canonical_native: { ...value.canonical_native, raw: marker } };
  assert.equal(JSON.stringify(decode(hostile)).includes(marker), false);
});

test("binds the imported phase, run, commit and plan identity", () => {
  for (const patch of [{ phase: "after" }, { run_id: "123456788" }, { source_commit: "f".repeat(40) }, { plan_sha256: "f".repeat(64) }]) {
    assert.throws(() => decode({ ...fixture(), ...patch }), /snapshot_identity/);
  }
});

test("binds the exact phase source frame and pin vector", () => {
  const value = fixture(); value.source_frame.files[0]!.bytes++;
  assert.throws(() => decode(value), /snapshot_source_frame/);
});

test("refuses a tracked path substitution", () => {
  const value = fixture(); value.graph.tracked[0]!.path = "src/other.ts";
  assert.throws(() => decode(value), /tracked_member/);
});

test("requires every exact forbidden boundary without substitutions", () => {
  const value = fixture(); value.graph.forbidden.pop(); assert.throws(() => decode(value), /flag_vector/);
  const substitute = fixture(); substitute.graph.forbidden[0]!.path = "src/other.ts"; assert.throws(() => decode(substitute), /flag_member/);
});

test("refuses a failed native compile hidden in a measured snapshot", () => {
  const value = fixture(); value.canonical_native.exit = 1;
  assert.throws(() => decode(value), /snapshot_native_result/);
});

test("refuses a contradictory source guard or malformed digest", () => {
  const value = fixture(); value.graph.source_guard_pass = false; assert.throws(() => decode(value), /source_guard_value/);
  const malformed = fixture(); malformed.compiled.sha256 = "z".repeat(64); assert.throws(() => decode(malformed), /receipt_digest/);
});

test("uses the documented sorted path NUL SHA NUL decimal-bytes LF aggregate", () => {
  const frame = sourceFrame([
    { path: "workers/data-api.ts", bytes: 11, sha256: "b".repeat(64) },
    { path: "src/a.ts", bytes: 7, sha256: "a".repeat(64) },
  ]);
  assert.equal(frame.sha256, "2823972b1ff457bb676c66b1283e5346370afd4cef4c7bd7bec7dd1fe74885c8");
  assert.deepEqual(frame.files.map((file) => file.path), ["src/a.ts", "workers/data-api.ts"]);
});

test("requires its own entry and joins tracked source hashes to phase pins", () => {
  const value = fixture(); const missing = { ...value, graph: { ...value.graph, tracked: [{ path: pin.path, in_graph: false, bytes: null, sha256: null }] } };
  assert.throws(() => decode(missing), /snapshot_own_entry/);
  const mismatch = fixture(); mismatch.graph.tracked[0]!.sha256 = "f".repeat(64);
  assert.throws(() => decode(mismatch), /snapshot_tracked_source/);
});

test("refuses negative, fractional, nonfinite and over-cap numeric fields", () => {
  for (const number of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 4097]) {
    const value = fixture(); value.graph.all_input_count = number;
    assert.throws(() => decode(value), /receipt_integer/);
  }
  for (const number of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 16 * 1024 * 1024 + 1]) {
    const value = fixture(); value.graph.first_party_bytes = number;
    assert.throws(() => decode(value), /receipt_integer/);
  }
  for (const number of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 32 * 1024 * 1024 + 1]) {
    const value = fixture(); value.compiled.bytes = number;
    assert.throws(() => decode(value), /receipt_integer/);
  }
  const source = fixture(); source.graph.tracked[0]!.bytes = 2 * 1024 * 1024 + 1;
  assert.throws(() => decode(source), /receipt_integer/);
  const native = fixture(); native.canonical_native.stdout_bytes = 512 * 1024 + 1;
  assert.throws(() => decode(native), /receipt_integer/);
});
