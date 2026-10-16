import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  constants,
  createDecipheriv,
  createHash,
  createPublicKey,
  generateKeyPairSync,
  privateDecrypt,
} from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import {
  CAPTURE_LIMITS,
  captureNativeParity,
  parseCaptureAssets,
  sealCapture,
  validateCaptureManifest,
  type CaptureAsset,
  type CapturedAsset,
} from "./capture-native-parity.ts";

const REFUSED = { message: "Native parity capture refused" };
const NOW = "2026-01-02T03:04:05.000Z";
const SECRET = "synthetic-export-secret";
const keyPair = generateKeyPairSync("rsa", {
  modulusLength: 3072,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const publicKeyBase64 = Buffer.from(keyPair.publicKey).toString("base64");
const keySha256 = createHash("sha256")
  .update(
    createPublicKey(keyPair.publicKey).export({ type: "spki", format: "der" }),
  )
  .digest("hex");

function digest(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function asset(overrides: Partial<CaptureAsset> = {}): CaptureAsset {
  return { partition: "3", sha256: "a".repeat(64), bytes: 1, ...overrides };
}

function captured(
  data: Buffer = Buffer.from("synthetic native bytes"),
): CapturedAsset {
  return {
    partition: "3",
    sha256: digest(data),
    bytes: data.byteLength,
    observedAt: NOW,
    data: data.toString("base64"),
  };
}

function manifest(entries: unknown): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(entries)));
}

function manifestPath(value: string, publisher = false): string {
  return publisher
    ? `/__native_publisher__/${value}.json.gz`
    : `/${value}.mgpack`;
}

function descriptor(value: string, size = 1) {
  return { hash: value.slice(0, 32), size };
}

function ledger(count: number): Record<string, { hash: string; size: number }> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => {
      const hash = index.toString(16).padStart(32, "0") + "0".repeat(32);
      return [manifestPath(hash), descriptor(hash)];
    }),
  );
}

// A legal gzip comment makes the synthetic compressed object match the pinned
// manifest size without inserting source data or depending on compression ratios.
function exactSizeManifest(entries: unknown): Buffer {
  const raw = manifest(entries);
  const extra = CAPTURE_LIMITS.manifestBytes - raw.byteLength;
  assert.ok(extra > 0);
  const header = Buffer.from(raw.subarray(0, 10));
  header[3] |= 0x10;
  return Buffer.concat([
    header,
    Buffer.alloc(extra - 1, 0x61),
    Buffer.from([0]),
    raw.subarray(10),
  ]);
}

interface Envelope {
  version: number;
  keySha256: string;
  aad: string;
  iv: string;
  tag: string;
  wrappedKey: string;
  ciphertext: string;
}

function decrypt(serialized: string) {
  const envelope = JSON.parse(serialized) as Envelope;
  assert.equal(envelope.version, 1);
  assert.equal(envelope.keySha256, keySha256);
  const aad = Buffer.from(envelope.aad, "base64");
  assert.deepEqual(JSON.parse(aad.toString("utf8")), {
    version: 1,
    keySha256,
    purpose: "metagraphed-native-parity-capture",
  });
  const key = privateDecrypt(
    {
      key: keyPair.privateKey,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    Buffer.from(envelope.wrappedKey, "base64"),
  );
  assert.equal(key.byteLength, 32);
  assert.equal(Buffer.from(envelope.iv, "base64").byteLength, 12);
  assert.equal(Buffer.from(envelope.tag, "base64").byteLength, 16);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(envelope.iv, "base64"),
  );
  decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8")) as {
    version: number;
    assets: CapturedAsset[];
  };
}

function responseFor(
  data: Uint8Array,
  headers: Record<string, string> = {},
): Response {
  return new Response(Buffer.from(data), {
    headers: {
      "content-length": String(data.byteLength),
      "x-content-sha256": digest(data),
      ...headers,
    },
  });
}

function captureInput(data: Uint8Array, overrides: Partial<CaptureAsset> = {}) {
  return {
    assetsJson: JSON.stringify([
      asset({ bytes: data.byteLength, sha256: digest(data), ...overrides }),
    ]),
    publicKeyBase64,
    secret: SECRET,
    now: () => new Date(NOW),
  };
}

test("capture budgets preserve ordinary limits and bound the manifest exception", () => {
  assert.deepEqual(CAPTURE_LIMITS, {
    requestBytes: 4096,
    assets: 8,
    assetBytes: 524288,
    totalBytes: 2097152,
    manifestBytes: 3236624,
    manifestExpandedBytes: 25165824,
    manifestEntries: 100000,
    encryptedBytes: 6291456,
  });
});

test("ordinary capture requests retain the bounded default contract", () => {
  assert.deepEqual(parseCaptureAssets(JSON.stringify([asset()])), [asset()]);
  const maximumTotal = Array.from({ length: 4 }, (_, index) =>
    asset({
      partition: String(index),
      sha256: String(index).repeat(64),
      bytes: CAPTURE_LIMITS.assetBytes,
    }),
  );
  assert.deepEqual(
    parseCaptureAssets(JSON.stringify(maximumTotal)),
    maximumTotal,
  );
  const maximumCount = Array.from(
    { length: CAPTURE_LIMITS.assets },
    (_, index) => asset({ sha256: String(index).repeat(64) }),
  );
  assert.equal(
    parseCaptureAssets(JSON.stringify(maximumCount)).length,
    CAPTURE_LIMITS.assets,
  );
  assert.throws(
    () =>
      parseCaptureAssets(
        JSON.stringify([...maximumTotal, asset({ sha256: "f".repeat(64) })]),
      ),
    REFUSED,
  );
  assert.throws(
    () =>
      parseCaptureAssets(
        JSON.stringify([...maximumCount, asset({ sha256: "f".repeat(64) })]),
      ),
    REFUSED,
  );
  assert.throws(
    () =>
      parseCaptureAssets(
        JSON.stringify([asset({ bytes: CAPTURE_LIMITS.assetBytes + 1 })]),
      ),
    REFUSED,
  );
});

test("capture request JSON is byte bounded and rejects malformed envelopes", () => {
  const text = JSON.stringify([asset()]);
  const bounded = text + " ".repeat(CAPTURE_LIMITS.requestBytes - text.length);
  assert.deepEqual(parseCaptureAssets(bounded), [asset()]);
  assert.throws(() => parseCaptureAssets(bounded + " "), REFUSED);
  for (const malformed of [
    "",
    "{synthetic-parser-detail",
    "null",
    "{}",
    "[]",
    "[null]",
    "[[]]",
  ]) {
    assert.throws(() => parseCaptureAssets(malformed), REFUSED);
  }
  for (const malformed of [
    { ...asset(), extra: "synthetic-private-value" },
    { ...asset(), partition: "33" },
    { ...asset(), partition: "F" },
    { ...asset(), partition: "g" },
    { ...asset(), partition: "3\n" },
    { ...asset(), partition: 3 },
    { ...asset(), sha256: "a".repeat(63) },
    { ...asset(), sha256: "A".repeat(64) },
    { ...asset(), sha256: "a".repeat(64) + "\n" },
    { ...asset(), sha256: null },
    { ...asset(), bytes: 0 },
    { ...asset(), bytes: -1 },
    { ...asset(), bytes: 1.5 },
    { ...asset(), bytes: "1" },
    { ...asset(), bytes: Number.MAX_SAFE_INTEGER + 1 },
    { partition: "3", bytes: 1 },
  ]) {
    assert.throws(
      () => parseCaptureAssets(JSON.stringify([malformed])),
      REFUSED,
    );
  }
  assert.throws(
    () =>
      parseCaptureAssets(JSON.stringify([asset(), asset({ partition: "4" })])),
    REFUSED,
  );
});

test("manifest capture is an explicit singleton with the exact pinned size", () => {
  const pinned = asset({
    manifest: true,
    bytes: CAPTURE_LIMITS.manifestBytes,
  });
  assert.deepEqual(parseCaptureAssets(JSON.stringify([pinned])), [pinned]);
  for (const malformed of [
    { ...pinned, bytes: CAPTURE_LIMITS.manifestBytes - 1 },
    { ...pinned, bytes: CAPTURE_LIMITS.manifestBytes + 1 },
    { ...pinned, manifest: false },
    { ...pinned, manifest: "true" },
    { ...pinned, manifest: null },
    { ...pinned, offset: 0 },
    { ...pinned, range: "bytes=0-1" },
  ]) {
    assert.throws(
      () => parseCaptureAssets(JSON.stringify([malformed])),
      REFUSED,
    );
  }
  assert.throws(
    () =>
      parseCaptureAssets(
        JSON.stringify([pinned, asset({ sha256: "b".repeat(64) })]),
      ),
    REFUSED,
  );
  assert.throws(
    () =>
      parseCaptureAssets(
        JSON.stringify([pinned, { ...pinned, sha256: "b".repeat(64) }]),
      ),
    REFUSED,
  );
});

test("manifest validation accepts the native flat ledger and both path kinds", () => {
  const dataHash = "a".repeat(64);
  const publisherHash = "b".repeat(64);
  assert.doesNotThrow(() =>
    validateCaptureManifest(
      manifest({
        [manifestPath(dataHash)]: descriptor(
          dataHash,
          CAPTURE_LIMITS.assetBytes,
        ),
        [manifestPath(publisherHash, true)]: descriptor(
          publisherHash,
          CAPTURE_LIMITS.manifestExpandedBytes,
        ),
      }),
    ),
  );
});

test("manifest decoding rejects corrupt gzip, invalid UTF-8 and invalid JSON", () => {
  const valid = manifest({});
  for (const raw of [
    Buffer.from("synthetic-invalid-gzip"),
    valid.subarray(0, valid.length - 1),
    gzipSync(Buffer.from([0xff])),
    gzipSync(Buffer.from("\uFEFF{}")),
    gzipSync(Buffer.from("{synthetic-parser-detail")),
    Buffer.alloc(CAPTURE_LIMITS.manifestBytes + 1),
  ]) {
    assert.throws(() => validateCaptureManifest(raw), REFUSED);
  }
});

test("manifest validation rejects unsupported shapes, paths and descriptor fields", () => {
  const hash = "a".repeat(64);
  const path = manifestPath(hash);
  for (const value of [null, [], "synthetic-private-value", 1]) {
    assert.throws(() => validateCaptureManifest(manifest(value)), REFUSED);
  }
  for (const invalidPath of [
    `${hash}.mgpack`,
    `/nested/${hash}.mgpack`,
    manifestPath("A".repeat(64)),
    manifestPath("a".repeat(63)),
    `/${hash}.json.gz`,
    `/__native_publisher__/${hash}.mgpack`,
    `/../${hash}.mgpack`,
    `${path}?synthetic-query`,
    `${path}\n`,
  ]) {
    assert.throws(
      () =>
        validateCaptureManifest(manifest({ [invalidPath]: descriptor(hash) })),
      REFUSED,
    );
  }
  for (const invalidDescriptor of [
    null,
    [],
    { size: 1 },
    { hash: hash.slice(0, 32) },
    { ...descriptor(hash), extra: "synthetic-private-value" },
    { hash: "b".repeat(32), size: 1 },
    { hash, size: 1 },
    { hash: hash.slice(0, 32).toUpperCase(), size: 1 },
    descriptor(hash, 0),
    descriptor(hash, -1),
    descriptor(hash, 1.5),
    descriptor(hash, Number.MAX_SAFE_INTEGER + 1),
    { hash: hash.slice(0, 32), size: "1" },
    descriptor(hash, CAPTURE_LIMITS.assetBytes + 1),
  ]) {
    assert.throws(
      () => validateCaptureManifest(manifest({ [path]: invalidDescriptor })),
      REFUSED,
    );
  }
  assert.throws(
    () =>
      validateCaptureManifest(
        manifest({
          [manifestPath(hash, true)]: descriptor(
            hash,
            CAPTURE_LIMITS.manifestExpandedBytes + 1,
          ),
        }),
      ),
    REFUSED,
  );
  const colliding = hash.slice(0, 32) + "b".repeat(32);
  assert.throws(
    () =>
      validateCaptureManifest(
        manifest({
          [path]: descriptor(hash),
          [manifestPath(colliding, true)]: descriptor(colliding),
        }),
      ),
    REFUSED,
  );
});

test("manifest entry count includes the exact limit and rejects excess entries", () => {
  assert.doesNotThrow(() =>
    validateCaptureManifest(manifest(ledger(CAPTURE_LIMITS.manifestEntries))),
  );
  assert.throws(
    () =>
      validateCaptureManifest(
        manifest(ledger(CAPTURE_LIMITS.manifestEntries + 1)),
      ),
    REFUSED,
  );
});

test("manifest refuses bounded gzip expansion overflow", () => {
  const expanded = Buffer.alloc(CAPTURE_LIMITS.manifestExpandedBytes + 1, 0x20);
  expanded.write("{}");
  assert.throws(() => validateCaptureManifest(gzipSync(expanded)), REFUSED);
});

test("manifest rejects duplicate JSON members before they can collapse", () => {
  const hash = "a".repeat(64);
  const path = JSON.stringify(manifestPath(hash));
  const value = JSON.stringify(descriptor(hash));
  const member = `${path}:${value}`;
  const conflicting = `${path}:${JSON.stringify(descriptor(hash, 2))}`;
  const duplicateDescriptor = `{"hash":"${hash.slice(0, 32)}","hash":"${hash.slice(0, 32)}","size":1}`;
  for (const text of [
    `{${member},${member}}`,
    `{${member},${conflicting}}`,
    `{${path}:${duplicateDescriptor}}`,
    `{${Array(CAPTURE_LIMITS.manifestEntries + 1)
      .fill(member)
      .join(",")}}`,
  ]) {
    assert.ok(Buffer.byteLength(text) < CAPTURE_LIMITS.manifestExpandedBytes);
    assert.throws(
      () => validateCaptureManifest(gzipSync(Buffer.from(text))),
      REFUSED,
    );
  }
});

test("manifest rejects noncanonical JSON despite valid decoded descriptor values", () => {
  const hash = "a".repeat(64);
  const entries = { [manifestPath(hash)]: descriptor(hash) };
  assert.throws(
    () =>
      validateCaptureManifest(
        gzipSync(Buffer.from(JSON.stringify(entries, null, 2))),
      ),
    REFUSED,
  );
});

test("sealing independently round trips RSA-OAEP-SHA256 and AES-256-GCM", () => {
  const assets = [captured()];
  const first = sealCapture(assets, publicKeyBase64);
  const second = sealCapture(assets, publicKeyBase64);
  assert.equal(first.keySha256, keySha256);
  assert.ok(
    Buffer.byteLength(first.serialized) <= CAPTURE_LIMITS.encryptedBytes,
  );
  assert.deepEqual(decrypt(first.serialized), { version: 1, assets });
  assert.notEqual(first.serialized, second.serialized);
  assert.ok(!first.serialized.includes("synthetic native bytes"));
  const envelope = JSON.parse(first.serialized) as Envelope;
  const damagedTag = Buffer.from(envelope.tag, "base64");
  damagedTag[0] ^= 1;
  assert.throws(() =>
    decrypt(
      JSON.stringify({ ...envelope, tag: damagedTag.toString("base64") }),
    ),
  );
});

test("sealing refuses malformed, non-RSA and undersized RSA public keys", () => {
  const smallRsa = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const elliptic = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  for (const key of [
    "synthetic-invalid-key",
    Buffer.from(smallRsa.publicKey).toString("base64"),
    Buffer.from(elliptic.publicKey).toString("base64"),
  ]) {
    assert.throws(() => sealCapture([captured()], key), REFUSED);
  }
});

test("sealing refuses oversized plaintext and oversized encrypted serialization", () => {
  for (const length of [5 * 1024 * 1024, CAPTURE_LIMITS.encryptedBytes]) {
    assert.throws(
      () =>
        sealCapture(
          [{ ...captured(), data: "a".repeat(length) }],
          publicKeyBase64,
        ),
      REFUSED,
    );
  }
});

test("capture sends one pinned identity request and returns an encrypted summary", async (t) => {
  const data = Buffer.from("synthetic native bytes");
  const input = captureInput(data);
  const signal = new AbortController().signal;
  const timeout = t.mock.method(
    AbortSignal,
    "timeout",
    (milliseconds: number) => {
      assert.equal(milliseconds, 30000);
      return signal;
    },
  );
  let calls = 0;
  const fetcher: typeof fetch = async (url, init) => {
    calls += 1;
    assert.equal(
      url,
      "https://api.metagraph.sh/api/v1/internal/native-store-export",
    );
    assert.ok(init);
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "error");
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);
    assert.equal(init.signal, signal);
    const headers = new Headers(init.headers);
    assert.equal(headers.get("content-type"), "application/json");
    assert.equal(headers.get("accept-encoding"), "identity");
    assert.equal(headers.get("x-state-export-token"), SECRET);
    assert.equal(headers.has("range"), false);
    assert.deepEqual(JSON.parse(String(init.body)), {
      kind: "native-store",
      operation: "read",
      partition: "3",
      sha256: digest(data),
      bytes: data.byteLength,
    });
    return responseFor(data);
  };
  const result = await captureNativeParity({ ...input, fetcher });
  assert.equal(calls, 1);
  assert.equal(timeout.mock.calls.length, 1);
  assert.deepEqual(result.summary, {
    version: 1,
    status: "encrypted",
    assets: 1,
    bytes: data.byteLength,
    keySha256,
  });
  assert.deepEqual(decrypt(result.serialized), {
    version: 1,
    assets: [captured(data)],
  });
  assert.ok(!JSON.stringify(result.summary).includes(SECRET));
  assert.ok(!JSON.stringify(result.summary).includes(digest(data)));
});

test("capture accepts a streamed ordinary response without a length header", async () => {
  const data = Buffer.from("synthetic streamed native bytes");
  let cancellations = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data.subarray(0, 5));
      controller.enqueue(data.subarray(5));
      controller.close();
    },
    cancel() {
      cancellations += 1;
    },
  });
  const fetcher: typeof fetch = async () =>
    new Response(body, { headers: { "x-content-sha256": digest(data) } });
  const result = await captureNativeParity({ ...captureInput(data), fetcher });
  assert.deepEqual(decrypt(result.serialized).assets, [captured(data)]);
  assert.equal(body.locked, false);
  assert.equal(cancellations, 0);
});

test("capture validates the full exact-size manifest before sealing it", async () => {
  const hash = "a".repeat(64);
  const data = exactSizeManifest({
    [manifestPath(hash)]: descriptor(hash),
  });
  assert.equal(data.byteLength, CAPTURE_LIMITS.manifestBytes);
  let calls = 0;
  const fetcher: typeof fetch = async (_url, init) => {
    calls += 1;
    assert.deepEqual(JSON.parse(String(init?.body)), {
      kind: "native-store",
      operation: "read",
      partition: "3",
      sha256: digest(data),
      bytes: CAPTURE_LIMITS.manifestBytes,
      manifest: true,
    });
    return responseFor(data, { "content-encoding": "identity" });
  };
  const result = await captureNativeParity({
    ...captureInput(data, { manifest: true }),
    fetcher,
  });
  assert.equal(calls, 1);
  assert.equal(result.summary.bytes, CAPTURE_LIMITS.manifestBytes);
  assert.deepEqual(decrypt(result.serialized).assets, [
    { ...captured(data), manifest: true },
  ]);
  assert.ok(
    Buffer.byteLength(result.serialized) <= CAPTURE_LIMITS.encryptedBytes,
  );
});

test("capture refuses bad HTTP, headers, bytes and fetch failures without retries", async () => {
  const data = Buffer.from("synthetic integrity fixture");
  const cases: Array<() => Response | Promise<Response>> = [
    () => new Response("synthetic-provider-detail", { status: 500 }),
    () => new Response(null, { status: 200 }),
    () => responseFor(data, { "content-encoding": "gzip" }),
    () => responseFor(data, { "content-length": String(data.byteLength + 1) }),
    () => responseFor(data, { "content-length": "synthetic-length" }),
    () => responseFor(data, { "x-content-sha256": "b".repeat(64) }),
    () => responseFor(data, { "x-content-sha256": "" }),
    () =>
      new Response(Buffer.alloc(data.byteLength, 0), {
        headers: { "x-content-sha256": digest(data) },
      }),
    () =>
      new Response(Buffer.concat([data, Buffer.from([0])]), {
        headers: { "x-content-sha256": digest(data) },
      }),
    () =>
      new Response(data.subarray(0, data.length - 1), {
        headers: { "x-content-sha256": digest(data) },
      }),
    () => {
      throw new Error("synthetic-provider-detail");
    },
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.error(new Error("synthetic-stream-detail"));
          },
        }),
        { headers: { "x-content-sha256": digest(data) } },
      ),
  ];
  for (const makeResponse of cases) {
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls += 1;
      return makeResponse();
    };
    await assert.rejects(
      captureNativeParity({ ...captureInput(data), fetcher }),
      REFUSED,
    );
    assert.equal(calls, 1);
  }
});

test("capture rejects invalid manifests even when transport integrity matches", async () => {
  const data = exactSizeManifest({ synthetic: "invalid descriptor" });
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls += 1;
    return responseFor(data);
  };
  await assert.rejects(
    captureNativeParity({
      ...captureInput(data, { manifest: true }),
      fetcher,
    }),
    REFUSED,
  );
  assert.equal(calls, 1);
});

test("capture validates request, recipient key and secret before any network read", async () => {
  const data = Buffer.from("synthetic preflight fixture");
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls += 1;
    return responseFor(data);
  };
  for (const invalid of [
    { assetsJson: "synthetic-invalid-json" },
    { publicKeyBase64: "synthetic-invalid-key" },
    { secret: "" },
  ]) {
    await assert.rejects(
      captureNativeParity({ ...captureInput(data), ...invalid, fetcher }),
      REFUSED,
    );
  }
  assert.equal(calls, 0);
});

test("CLI failures emit only the fixed refusal code and retain no artifact", () => {
  const directory = mkdtempSync(join(tmpdir(), "native-parity-capture-test-"));
  try {
    const child = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        fileURLToPath(new URL("./capture-native-parity.ts", import.meta.url)),
      ],
      {
        cwd: directory,
        env: {
          ...process.env,
          NATIVE_PARITY_ASSETS: "{synthetic-parser-detail",
          NATIVE_PARITY_PUBLIC_KEY: "synthetic-invalid-key",
          STATE_EXPORT_SECRET: SECRET,
          NODE_NO_WARNINGS: "1",
        },
        encoding: "utf8",
        timeout: 30000,
      },
    );
    assert.equal(child.error, undefined);
    assert.equal(child.status, 1);
    assert.equal(child.signal, null);
    assert.equal(child.stdout, "");
    assert.equal(child.stderr, "native_parity_capture_refused\n");
    assert.equal(
      existsSync(join(directory, "native-parity-capture.encrypted.json")),
      false,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
