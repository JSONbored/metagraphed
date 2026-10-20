import {
  writeNativePayload as oldWrite,
  readNativePayload as oldRead,
} from "../../src/chain-detail-native-payloads.baseline.ts";
import {
  NATIVE_PAYLOAD_PREFIX,
  writeNativePayload as newWrite,
  readNativePayload as newRead,
} from "../../src/chain-detail-native-payloads.ts";
import {
  storeChainDetailPayloads as oldStore,
  restoreChainDetailPayloads as oldRestore,
} from "../../src/chain-detail-payloads.native-baseline.ts";
import {
  storeChainDetailPayloads as newStore,
  restoreChainDetailPayloads as newRestore,
} from "../../src/chain-detail-payloads.ts";
import { historySha256 } from "../../src/history-sha256.ts";
import type { ProducerStatement } from "../../src/producer-store.ts";

function require(value: unknown, label: string): asserts value {
  if (!value) throw new Error(label);
}
function sameBytes(a: Uint8Array, b: Uint8Array) {
  return a.length === b.length && (a.length === 0 || a.every((value, index) => value === b[index]));
}
function samePlan(a: ProducerStatement[], b: ProducerStatement[]) {
  require(a.length === b.length, "plan-length");
  for (let index = 0; index < a.length; index++) {
    require(a[index].text === b[index].text, "statement-text");
    const first = a[index].values ?? [], second = b[index].values ?? [];
    require(first.length === second.length, "statement-value-count");
    require(first.every((value, part) => Object.is(value, second[part])), "statement-exact-value");
  }
}
function planFingerprint(plan: ProducerStatement[]) {
  return historySha256(JSON.stringify(plan.map(statement => ({
    text: statement.text,
    values: statement.values?.map(value => typeof value === "string" ? { sha256: historySha256(value), length: value.length } : value),
  }))));
}
// Only the unchanged native reader's SELECT is modeled here. Existing atomic
// D1 suites separately exercise SQL commit, immutable conflict and rollback.
function environment(plan: ProducerStatement[]) {
  return { D1_STATE: { prepare() { return { bind(hash: string) { return { async all() {
    return { results: plan.filter(statement => statement.text.startsWith("INSERT INTO chain_detail_payload_chunks (sha256,part,data) VALUES") && statement.values?.[0] === hash)
      .map(statement => ({ part: statement.values![1], data: statement.values![2] }))
      .sort((a, b) => Number(a.part) - Number(b.part)) };
  } }; } }; } } };
}
function view(size: number) {
  const parent = new Uint8Array(size + 37).fill(239);
  const bytes = new Uint8Array(parent.buffer, 17, size);
  for (let index = 0; index < size; index++) bytes[index] = index % 256;
  return { parent, bytes };
}
async function checkRaw(bytes: Uint8Array, parent?: Uint8Array, golden?: string, location?: "inline" | "d1") {
  const snapshot = parent?.slice(), hash = historySha256(bytes.length === 0 ? new Uint8Array() : bytes), size = bytes.length;
  const first: ProducerStatement[] = [], second: ProducerStatement[] = [];
  const [oldReference, newReference] = await Promise.all([
    oldWrite(undefined, hash, size, bytes, "raw", first),
    newWrite(undefined, hash, size, bytes, "raw", second),
  ]);
  require(oldReference === newReference, "raw-reference");
  samePlan(first, second);
  const prefix = `${NATIVE_PAYLOAD_PREFIX}${hash}:${size}:${size}:raw:`;
  require(newReference.startsWith(prefix), "raw-reference-prefix");
  const storedLocation = newReference.slice(prefix.length);
  if (golden !== undefined) require(storedLocation === "inline:" + golden, "golden-base64");
  if (location === "inline") require(storedLocation.startsWith("inline:"), "inline-boundary");
  if (location === "d1") require(storedLocation === "d1", "chunk-boundary");
  require(sameBytes(await oldRead(environment(second), hash, size, storedLocation), bytes), "old-reader-new-output");
  require(sameBytes(await newRead(environment(first), hash, size, storedLocation), bytes), "new-reader-old-output");
  if (snapshot) require(sameBytes(parent!, snapshot), "raw-source-mutated");
  return { bytes: size, statements: second.length, referenceSha256: historySha256(newReference), planFingerprintSha256: planFingerprint(second) };
}
function entropy(length: number) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let state = 0x12345678;
  const chunks: string[] = [];
  for (let offset = 0; offset < length; offset += 8192) {
    let chunk = "";
    for (let index = offset; index < Math.min(offset + 8192, length); index++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      chunk += alphabet[(state >>> 16) & 63];
    }
    chunks.push(chunk);
  }
  return chunks.join("");
}
const names = ["golden-offsets", "all-octets", "inline-boundaries", "chunk-boundaries", "maximum-raw", "detached-empty", "maximum-ascii", "maximum-chunks", "unicode-bom"];
async function rawCase(name: string) {
  const checks = [];
  if (name === "golden-offsets") {
    const cases: [number[], string][] = [[[], ""], [[0], "AA=="], [[0, 255], "AP8="], [[0, 255, 128], "AP+A"], [[0, 255, 128, 127], "AP+Afw=="], [[0, 255, 128, 127, 1], "AP+AfwE="]];
    for (const [values, golden] of cases) {
      const parent = Uint8Array.from([19, 23, ...values, 29, 31]);
      checks.push(await checkRaw(new Uint8Array(parent.buffer, 2, values.length), parent, golden, "inline"));
    }
  } else if (name === "all-octets") {
    const parent = new Uint8Array(300).fill(239), bytes = parent.subarray(17, 290).subarray(9, 265);
    bytes.set(Uint8Array.from({ length: 256 }, (_, index) => index));
    checks.push(await checkRaw(bytes, parent, btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join("")), "inline"));
  } else if (name === "inline-boundaries") {
    for (const size of [98_303, 98_304, 98_305]) {
      const { parent, bytes } = view(size);
      checks.push(await checkRaw(bytes, parent, undefined, size <= 98_304 ? "inline" : "d1"));
    }
  } else if (name === "chunk-boundaries") {
    for (const size of [1_489_999, 1_490_000, 1_490_001, 1_490_002]) {
      const { parent, bytes } = view(size);
      checks.push(await checkRaw(bytes, parent, undefined, "d1"));
    }
  } else if (name === "maximum-raw") {
    const { parent, bytes } = view(16 * 1024 * 1024);
    checks.push(await checkRaw(bytes, parent, undefined, "d1"));
    require(checks[0].statements === 13, "maximum-twelve-chunks-plus-guard");
  } else if (name === "detached-empty") {
    const bytes = new Uint8Array([1, 2, 3]);
    structuredClone(bytes.buffer, { transfer: [bytes.buffer] });
    require(bytes.byteLength === 0, "fixture-detached");
    checks.push(await checkRaw(bytes, undefined, "", "inline"));
  } else return undefined;
  return checks;
}
export default {
  async fetch(request: Request) {
    const name = new URL(request.url).pathname.slice(1);
    require(names.includes(name), "fixture-name");
    const raw = await rawCase(name);
    if (raw) return Response.json({ name, exactReferenceEquality: true, exactPlanEquality: true, crossReaderHydration: true, sourceUnchanged: true, checks: raw });
    const rows = name === "maximum-ascii" ? [{ call_args: "x".repeat(16 * 1024 * 1024) }]
      : name === "maximum-chunks" ? [{ call_args: entropy(16 * 1024 * 1024) }]
      : [{ args: "\uFEFF" + "界😀".repeat(200_000) }, { call_args: JSON.stringify({ text: "\u0000\\\"界😀\r\n".repeat(30_000) }) }];
    const original = JSON.stringify(rows), first: ProducerStatement[] = [], second: ProducerStatement[] = [];
    const [oldRows, newRows] = await Promise.all([oldStore(undefined, rows, first), newStore(undefined, rows, second)]);
    require(JSON.stringify(rows) === original, "logical-source-mutated");
    require(JSON.stringify(oldRows) === JSON.stringify(newRows), "logical-reference");
    samePlan(first, second);
    if (name === "maximum-chunks") require(first.length > 1, "chunk-fixture-reachable");
    require(JSON.stringify(await oldRestore(environment(second), newRows)) === original, "old-logical-reader-new-output");
    require(JSON.stringify(await newRestore(environment(first), oldRows)) === original, "new-logical-reader-old-output");
    return Response.json({ name, exactReferenceEquality: true, exactPlanEquality: true, crossReaderHydration: true, sourceUnchanged: true, rows: rows.length, statements: second.length, inputSha256: historySha256(original), referencesSha256: historySha256(JSON.stringify(newRows)), planFingerprintSha256: planFingerprint(second) });
  },
};
