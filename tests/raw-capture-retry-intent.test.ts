import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { test } from "vitest";
import {
  RAW_CAPTURE_CHUNK_BYTES,
  RAW_CAPTURE_INTENT_MAX_BYTES,
  RAW_CAPTURE_MAX_BYTES,
  decodeRawCaptureIntent,
  encodeRawCaptureIntent,
  prepareRawCapture,
  rawCaptureIdentity,
  rawCaptureIntentKey,
  resumeRawCapture,
  type RawCaptureIntent,
  type RawCapturePrepared,
} from "../src/raw-capture-retry-intent.ts";

const schema = "raw-capture-0028-0029-v1";
const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const key = (first: number, last = first, testnet = false) =>
  `chain/raw/${testnet ? "testnet/" : ""}blocks/${String(first).padStart(12, "0")}-${String(last).padStart(12, "0")}.ndjson`;
const row = (block: number, timestamp = "1700000000000", tail = "") =>
  `{"block_number":${block},"captured_at":${timestamp}${tail}}\n`;
const prepared = () => prepareRawCapture(key(42), row(42));
const intent = () => decodeRawCaptureIntent(encodeRawCaptureIntent(prepared()));
const encoded = (value: unknown) => JSON.stringify(value);

function changed(
  mutate: (value: RawCaptureIntent) => void,
): RawCaptureIntent {
  const value = intent();
  mutate(value);
  return value;
}

test("raw identity and intent describe both networks and the exact raw and gzip bytes", () => {
  assert.equal(RAW_CAPTURE_CHUNK_BYTES, 65_536);
  assert.equal(RAW_CAPTURE_MAX_BYTES, 33_554_432);
  assert.equal(RAW_CAPTURE_INTENT_MAX_BYTES, 98_304);
  assert.equal(rawCaptureIntentKey("mainnet"), "raw-capture-retry/v1/mainnet");
  assert.equal(rawCaptureIntentKey("testnet"), "raw-capture-retry/v1/testnet");
  for (const testnet of [false, true]) {
    const object = key(41, 42, testnet);
    const raw = row(41, "1700000000001") + row(42, "1700000000000");
    const capture = prepareRawCapture(object, raw);
    assert.deepEqual(rawCaptureIdentity(object, raw), {
      key: object,
      network: testnet ? "testnet" : "mainnet",
      first: 41,
      last: 42,
      sha256: sha256(raw),
    });
    assert.deepEqual(capture.descriptor, {
      key: object,
      sha256: sha256(raw),
      network: testnet ? "testnet" : "mainnet",
      first_block: 41,
      last_block: 42,
      raw_bytes: Buffer.byteLength(raw),
      compressed_bytes: capture.compressed.length,
      compressed_sha256: sha256(capture.compressed),
      parts: Math.ceil(capture.compressed.length / RAW_CAPTURE_CHUNK_BYTES),
      captured_at: 1700000000001,
    });
    assert.equal(gunzipSync(capture.compressed).toString("utf8"), raw);
    const payload = encodeRawCaptureIntent(capture);
    assert.deepEqual(decodeRawCaptureIntent(payload), {
      version: 1,
      schema,
      descriptor: capture.descriptor,
      provenance: ["1700000000001", "1700000000000"],
    });
  }
});

test("resuming replaces only top-level provenance tokens and preserves every other byte", () => {
  const detail =
    ',"nested":{"captured_at":0,"array":["captured_at",{"captured_at":-1}]}' +
    ',"note":' +
    JSON.stringify('λ🚀 captured_at \\ " { [ ] }') +
    ',"balance":900719925474099312345678901234567890';
  const original =
    row(41, "1.700000000000e12", detail) +
    row(42, "1700000000001.0000000000000000000", detail);
  const newest = row(41, "1800000000000", detail) + row(42, "1800000000001", detail);
  const capture = prepareRawCapture(key(41, 42), original);
  const retained = decodeRawCaptureIntent(encodeRawCaptureIntent(capture));
  assert.deepEqual(retained.provenance, [
    "1.700000000000e12",
    "1700000000001.0000000000000000000",
  ]);
  assert.notEqual(rawCaptureIdentity(key(41, 42), newest).sha256, capture.descriptor.sha256);
  const resumed = resumeRawCapture(retained, key(41, 42), newest);
  assert.deepEqual(resumed.descriptor, capture.descriptor);
  assert.deepEqual(resumed.compressed, capture.compressed);
  assert.equal(gunzipSync(resumed.compressed).toString("utf8"), original);
});

test("escaped identity keys, quotes, Unicode and long numeric spellings retain their exact tokens", () => {
  const object = key(1);
  const raw =
    '{"block_\\u006eumber":1,"captured_\\u0061t":9007199254740991.0000000000000000,' +
    '"nested":[{"captured_at":2}],"value":"captured_at",' +
    '"escaped":' +
    JSON.stringify('é e\u0301 \\ \\" quote " captured_at') +
    '}\n';
  const capture = prepareRawCapture(object, raw);
  assert.equal(capture.descriptor.captured_at, Number.MAX_SAFE_INTEGER);
  assert.deepEqual(capture.provenance, ["9007199254740991.0000000000000000"]);
  const retained = decodeRawCaptureIntent(encodeRawCaptureIntent(capture));
  const retry = raw.replace("9007199254740991.0000000000000000", "1700000000000");
  assert.equal(gunzipSync(resumeRawCapture(retained, object, retry).compressed).toString("utf8"), raw);
});

test("raw capture refuses malformed identities, ranges, records and unsafe timestamps", () => {
  const invalid: [string, string][] = [
    ["chain/raw/blocks/1-1.ndjson", row(1)],
    ["chain/raw/other/blocks/000000000001-000000000001.ndjson", row(1)],
    [key(1) + "\n", row(1)],
    [key(1) + "\r\n", row(1)],
    [key(1) + "\u2028", row(1)],
    [key(1) + "\u2029", row(1)],
    [key(2, 1), row(1)],
    [key(0, 4096), row(0)],
    [key(1), ""],
    [key(1), row(1).trimEnd()],
    [key(1), "\n"],
    [key(1), "null\n"],
    [key(1), "[]\n"],
    [key(1), '[{"block_number":1,"captured_at":1}]\n'],
    [key(1), '{"block_number":1,"nested":{"captured_at":1}}\n'],
    [key(1), '{"block_number":"1","captured_at":1}\n'],
    [key(1), row(2)],
    [key(1, 2), row(1)],
    [key(1, 2), row(1) + row(3)],
    [key(1, 3), row(1) + "\n" + row(3)],
    [key(1), "\uFEFF" + row(1)],
    [key(1, 2), row(1) + "\uFEFF" + row(2)],
    [key(1), row(1) + "not-json\n"],
  ];
  for (const token of ["0", "-1", "1.5", "9007199254740992", "1e999", '"1"', "true", "null"])
    invalid.push([key(1), row(1, token)]);
  for (const [object, value] of invalid) {
    assert.throws(() => rawCaptureIdentity(object, value));
    assert.throws(() => prepareRawCapture(object, value));
  }
  assert.throws(() => prepareRawCapture(key(1), null as unknown as string));
});

test("duplicate top-level identity keys are refused even when escaped aliases agree", () => {
  for (const raw of [
    '{"block_number":1,"captured_at":1,"captured_at":1}\n',
    '{"block_number":1,"captured_at":1,"captured_\\u0061t":1}\n',
    '{"block_number":1,"block_number":1,"captured_at":1}\n',
    '{"block_number":1,"block_\\u006eumber":1,"captured_at":1}\n',
    '{"block_number":2,"block_number":1,"captured_at":1}\n',
  ]) {
    assert.throws(() => prepareRawCapture(key(1), raw));
    assert.throws(() => rawCaptureIdentity(key(1), raw));
  }
});

test("intent decoding rejects noncanonical and duplicate control keys before trusting the descriptor", () => {
  const payload = encodeRawCaptureIntent(prepared());
  for (const malformed of [
    "",
    "{",
    "null",
    "[]",
    "1",
    '"value"',
    " " + payload,
    payload + "\n",
    "\uFEFF" + payload,
    payload.replace('"version":1', '"version":1,"version":1'),
    payload.replace('"version":1', '"version":1e0'),
    payload.replace('"version"', '"\\u0076ersion"'),
    payload.replace('"descriptor":{', '"descriptor":{"raw_bytes":1,'),
    payload.replace('"provenance":', '"provenance":[],"provenance":'),
  ])
    assert.throws(() => decodeRawCaptureIntent(malformed));
  assert.throws(() => decodeRawCaptureIntent(null as unknown as string));
});

test("intent envelope, descriptor, numeric limits and provenance are strict", () => {
  const valid = intent();
  const descriptors: [string, unknown][] = [
    ["key", 1],
    ["key", key(43)],
    ["network", "testnet"],
    ["first_block", 41],
    ["last_block", 43],
    ["sha256", 1],
    ["sha256", "A".repeat(64)],
    ["sha256", "a".repeat(63)],
    ["sha256", "a".repeat(64) + "\n"],
    ["sha256", "a".repeat(64) + "\r"],
    ["sha256", "a".repeat(64) + "\u2028"],
    ["sha256", "a".repeat(64) + "\u2029"],
    ["compressed_sha256", 1],
    ["compressed_sha256", "g".repeat(64)],
    ["compressed_sha256", "a".repeat(64) + "\r\n"],
    ["raw_bytes", 0],
    ["raw_bytes", 1.5],
    ["raw_bytes", RAW_CAPTURE_MAX_BYTES + 1],
    ["compressed_bytes", 0],
    ["compressed_bytes", 33_619_969],
    ["parts", 0],
    ["parts", 2],
    ["parts", 514],
    ["captured_at", 0],
    ["captured_at", 1.5],
    ["captured_at", Number.MAX_SAFE_INTEGER + 1],
    ["captured_at", 1700000000001],
  ];
  for (const [field, value] of descriptors) {
    const candidate = changed((candidate) => {
      (candidate.descriptor as unknown as Record<string, unknown>)[field] = value;
    });
    assert.throws(() => decodeRawCaptureIntent(encoded(candidate)));
  }
  for (const candidate of [
    {},
    { ...valid, version: 2 },
    { ...valid, schema: "different" },
    { ...valid, extra: true },
    { ...valid, descriptor: null },
    { ...valid, descriptor: "wrong" },
    { ...valid, descriptor: [] },
    { ...valid, descriptor: { ...valid.descriptor, extra: true } },
    { ...valid, descriptor: { ...valid.descriptor, key: key(0, 4096) } },
    { ...valid, provenance: null },
    { ...valid, provenance: {} },
    { ...valid, provenance: [] },
    { ...valid, provenance: [...valid.provenance, "1"] },
  ])
    assert.throws(() => decodeRawCaptureIntent(encoded(candidate)));
  for (const field of Object.keys(valid.descriptor)) {
    const descriptor = { ...valid.descriptor } as Record<string, unknown>;
    delete descriptor[field];
    assert.throws(() => decodeRawCaptureIntent(encoded({ ...valid, descriptor })));
  }
  for (const token of [null, 1, [], "", "0", "-1", "1.5", "1e999", "9007199254740992", "+1", "01", "0x1", "Infinity", "NaN", "1700000000000\n", "1700000000000\r\n", "1700000000000\u2028", "1700000000000\u2029"])
    assert.throws(() => decodeRawCaptureIntent(encoded({ ...valid, provenance: [token] })));
});

test("range and raw byte budgets accept their exact boundary and refuse the next record or byte", () => {
  const records = Array.from({ length: 4096 }, (_, block) => row(block, "1")).join("");
  const capture = prepareRawCapture(key(0, 4095), records);
  assert.equal(capture.provenance.length, 4096);
  assert.equal(decodeRawCaptureIntent(encodeRawCaptureIntent(capture)).descriptor.last_block, 4095);
  assert.throws(() => prepareRawCapture(key(0, 4096), records + row(4096, "1")));

  const prefix = '{"block_number":1,"captured_at":1,"payload":"';
  const suffix = '"}\n';
  const remaining = RAW_CAPTURE_MAX_BYTES - Buffer.byteLength(prefix + suffix);
  const raw = prefix + "λ".repeat(Math.floor(remaining / 2)) + "x".repeat(remaining % 2) + suffix;
  assert.equal(Buffer.byteLength(raw), RAW_CAPTURE_MAX_BYTES);
  assert.ok(raw.length < RAW_CAPTURE_MAX_BYTES);
  const maximum = prepareRawCapture(key(1), raw);
  assert.equal(maximum.descriptor.raw_bytes, RAW_CAPTURE_MAX_BYTES);
  assert.equal(sha256(gunzipSync(maximum.compressed)), sha256(raw));
  const oversized = raw.slice(0, -suffix.length) + "x" + suffix;
  assert.equal(Buffer.byteLength(oversized), RAW_CAPTURE_MAX_BYTES + 1);
  assert.throws(() => prepareRawCapture(key(1), oversized));
  assert.throws(() => rawCaptureIdentity(key(1), oversized));
});

function metadataAtSize(target: number): RawCapturePrepared {
  let zeros = target - 1024;
  for (let attempt = 0; attempt < 8; attempt++) {
    const capture = prepareRawCapture(key(1), row(1, "1." + "0".repeat(zeros)));
    const bytes = Buffer.byteLength(encoded({
      version: 1,
      schema,
      descriptor: capture.descriptor,
      provenance: capture.provenance,
    }));
    if (bytes === target) return capture;
    zeros += target - bytes;
  }
  throw new Error("Metadata boundary fixture did not converge");
}

test("the intent metadata budget accepts exactly 96 KiB of valid provenance and refuses one byte more", () => {
  const capture = metadataAtSize(RAW_CAPTURE_INTENT_MAX_BYTES);
  const payload = encodeRawCaptureIntent(capture);
  assert.equal(Buffer.byteLength(payload), RAW_CAPTURE_INTENT_MAX_BYTES);
  const decoded = decodeRawCaptureIntent(payload);
  assert.equal(decoded.descriptor.captured_at, 1);
  assert.deepEqual(decoded.provenance, capture.provenance);
  assert.equal(gunzipSync(resumeRawCapture(decoded, key(1), row(1, "2")).compressed).toString("utf8"), gunzipSync(capture.compressed).toString("utf8"));
  const oversized = metadataAtSize(RAW_CAPTURE_INTENT_MAX_BYTES + 1);
  assert.throws(() => encodeRawCaptureIntent(oversized));
  assert.throws(() => decodeRawCaptureIntent(payload + " "));
});

test("a retry refuses a changed range, raw bytes, raw digest or compressed descriptor", () => {
  const object = key(42);
  const raw = row(42, "1700000000000", ',"value":"é","balance":9007199254740993123');
  const capture = prepareRawCapture(object, raw);
  const retained = decodeRawCaptureIntent(encodeRawCaptureIntent(capture));
  assert.deepEqual(resumeRawCapture(retained, object, raw).compressed, capture.compressed);
  assert.throws(() => resumeRawCapture(retained, key(42, 42, true), raw));
  for (const conflict of [
    raw.replace("9007199254740993123", "9007199254740993124"),
    raw.replace("é", "e\u0301"),
    raw.replace('"block_number"', ' "block_number"'),
    raw.replace('"captured_at"', '"captured_\\u0061t"'),
    raw.replace("\n", "\r\n"),
  ])
    assert.throws(() => resumeRawCapture(retained, object, conflict));
  for (const field of ["sha256", "compressed_sha256"] as const) {
    const candidate = decodeRawCaptureIntent(encodeRawCaptureIntent(capture));
    candidate.descriptor[field] = "0".repeat(64);
    assert.throws(() => resumeRawCapture(candidate, object, raw));
  }
  const wrongSize = decodeRawCaptureIntent(encodeRawCaptureIntent(capture));
  wrongSize.descriptor.compressed_bytes++;
  assert.throws(() => resumeRawCapture(wrongSize, object, raw));
});
