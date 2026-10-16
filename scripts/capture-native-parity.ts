// Manual diagnostic: pinned native bytes are sealed before artifact retention.
import {
  constants,
  createCipheriv,
  createHash,
  createPublicKey,
  publicEncrypt,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

export const CAPTURE_LIMITS = Object.freeze({
  requestBytes: 4096,
  assets: 8,
  assetBytes: 524288,
  totalBytes: 2 * 1024 * 1024,
  manifestBytes: 4 * 1024 * 1024,
  manifestAssets: 16,
  manifestTotalBytes: 64 * 1024 * 1024,
  manifestExpandedBytes: 24 * 1024 * 1024,
  manifestEntries: 100000,
  encryptedBytes: 6 * 1024 * 1024,
  manifestEncryptedBytes: 8 * 1024 * 1024,
  sequenceTimeoutMs: 9 * 60 * 1000,
});

export interface CaptureAsset {
  partition: string;
  sha256: string;
  bytes: number;
  manifest?: true;
}

export interface CapturedAsset extends CaptureAsset {
  observedAt: string;
  data: string;
}

function refuse(): never {
  // Never include inputs, provider errors or parser snippets in diagnostics.
  throw new Error("Native parity capture refused");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: string[],
): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expected.length &&
    keys.every((key, i) => key === expected[i])
  );
}

export function parseCaptureAssets(text: string): CaptureAsset[] {
  if (Buffer.byteLength(text) > CAPTURE_LIMITS.requestBytes) refuse();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    refuse();
  }
  if (!Array.isArray(parsed) || parsed.length < 1) refuse();
  const manifestMode = parsed.some(
    (value) => record(value) && value.manifest === true,
  );
  if (
    parsed.length >
    (manifestMode ? CAPTURE_LIMITS.manifestAssets : CAPTURE_LIMITS.assets)
  ) {
    refuse();
  }
  const assets: CaptureAsset[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const value of parsed) {
    if (!record(value)) refuse();
    const manifest = value.manifest === true;
    if (manifest !== manifestMode) refuse();
    if (
      !exactKeys(
        value,
        manifest
          ? ["bytes", "manifest", "partition", "sha256"]
          : ["bytes", "partition", "sha256"],
      )
    ) {
      refuse();
    }
    if (
      typeof value.partition !== "string" ||
      value.partition.length !== 1 ||
      !/^[a-f0-9]$/.test(value.partition) ||
      typeof value.sha256 !== "string" ||
      value.sha256.length !== 64 ||
      !/^[a-f0-9]{64}$/.test(value.sha256) ||
      typeof value.bytes !== "number" ||
      !Number.isSafeInteger(value.bytes) ||
      value.bytes <= 0 ||
      seen.has(value.sha256)
    ) {
      refuse();
    }
    if (manifest) {
      if (value.bytes > CAPTURE_LIMITS.manifestBytes) refuse();
    } else if (value.bytes > CAPTURE_LIMITS.assetBytes) refuse();
    total += value.bytes;
    seen.add(value.sha256);
    assets.push({
      partition: value.partition,
      sha256: value.sha256,
      bytes: value.bytes,
      ...(manifest ? { manifest: true as const } : {}),
    });
  }
  if (
    total >
    (manifestMode
      ? CAPTURE_LIMITS.manifestTotalBytes
      : CAPTURE_LIMITS.totalBytes)
  ) {
    refuse();
  }
  return assets;
}

/** The publisher's flat path -> {hash, size} ledger, never its private values. */
export function validateCaptureManifest(raw: Uint8Array): void {
  if (raw.byteLength > CAPTURE_LIMITS.manifestBytes) refuse();
  let decoded: Buffer | undefined;
  try {
    decoded = gunzipSync(raw, {
      maxOutputLength: CAPTURE_LIMITS.manifestExpandedBytes,
    });
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(decoded);
    const ledger: unknown = JSON.parse(text);
    // The publisher writes compact JSON. Re-encoding detects duplicate members
    // before JSON.parse's collapsed object could undercount the ledger.
    if (!record(ledger) || text !== JSON.stringify(ledger)) refuse();
    const entries = Object.entries(ledger);
    if (entries.length > CAPTURE_LIMITS.manifestEntries) refuse();
    const seen = new Set<string>();
    for (const [path, value] of entries) {
      const data = /^\/([a-f0-9]{64})\.mgpack$/.exec(path);
      const manifest =
        /^\/__native_publisher__\/([a-f0-9]{64})\.json\.gz$/.exec(path);
      const match = data ?? manifest;
      const digest = match?.[0] === path ? match[1] : null;
      if (
        !digest ||
        !record(value) ||
        !exactKeys(value, ["hash", "size"]) ||
        typeof value.hash !== "string" ||
        value.hash !== digest.slice(0, 32) ||
        seen.has(value.hash) ||
        typeof value.size !== "number" ||
        !Number.isSafeInteger(value.size) ||
        value.size <= 0 ||
        value.size > CAPTURE_LIMITS.manifestExpandedBytes ||
        (data !== null && value.size > CAPTURE_LIMITS.assetBytes)
      ) {
        refuse();
      }
      seen.add(value.hash);
    }
  } catch {
    refuse();
  } finally {
    decoded?.fill(0);
  }
}

function capturePublicKey(encoded: string): KeyObject {
  try {
    const key = createPublicKey(Buffer.from(encoded, "base64"));
    if (
      key.asymmetricKeyType !== "rsa" ||
      (key.asymmetricKeyDetails?.modulusLength ?? 0) < 3072
    ) {
      refuse();
    }
    return key;
  } catch {
    refuse();
  }
}

function encryptedLimit(assets: readonly CaptureAsset[]): number {
  return assets.length === 1 && assets[0].manifest === true
    ? CAPTURE_LIMITS.manifestEncryptedBytes
    : CAPTURE_LIMITS.encryptedBytes;
}

function envelopeBytes(assets: readonly CaptureAsset[], publicKey: KeyObject) {
  const base64Bytes = (bytes: number) => 4 * Math.ceil(bytes / 3);
  // ISO dates use at most 27 characters, including extended years. Base64
  // needs no JSON escapes, so only its measured length is added below.
  const metadata = JSON.stringify({
    version: 1,
    assets: assets.map((asset) => ({
      ...asset,
      observedAt: "0".repeat(27),
      data: "",
    })),
  });
  const plaintextBytes =
    Buffer.byteLength(metadata) +
    assets.reduce((total, asset) => total + base64Bytes(asset.bytes), 0);
  const keySha256 = "0".repeat(64);
  const aad = Buffer.from(
    JSON.stringify({
      version: 1,
      keySha256,
      purpose: "metagraphed-native-parity-capture",
    }),
  ).toString("base64");
  const envelope = JSON.stringify({
    version: 1,
    keySha256,
    aad,
    iv: "0".repeat(16),
    tag: "0".repeat(24),
    wrappedKey: "",
    ciphertext: "",
  });
  const modulusLength = publicKey.asymmetricKeyDetails?.modulusLength;
  if (!modulusLength) refuse();
  return (
    Buffer.byteLength(envelope) +
    base64Bytes(plaintextBytes) +
    base64Bytes(Math.ceil(modulusLength / 8))
  );
}

export function estimateCaptureEnvelopeBytes(
  assets: readonly CaptureAsset[],
  publicKeyBase64: string,
): number {
  return envelopeBytes(assets, capturePublicKey(publicKeyBase64));
}

function preflightEnvelope(
  assets: readonly CaptureAsset[],
  publicKey: KeyObject,
) {
  if (envelopeBytes(assets, publicKey) > encryptedLimit(assets)) refuse();
}

function sealWithKey(assets: readonly CapturedAsset[], publicKey: KeyObject) {
  const limit = encryptedLimit(assets);
  const keySha256 = createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const plaintext = Buffer.from(JSON.stringify({ version: 1, assets }));
  try {
    if (plaintext.byteLength > limit) refuse();
    const aad = Buffer.from(
      JSON.stringify({
        version: 1,
        keySha256,
        purpose: "metagraphed-native-parity-capture",
      }),
    );
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
    ]);
    const encrypted = {
      version: 1,
      keySha256,
      aad: aad.toString("base64"),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      wrappedKey: publicEncrypt(
        {
          key: publicKey,
          padding: constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: "sha256",
        },
        key,
      ).toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
    const serialized = JSON.stringify(encrypted);
    if (Buffer.byteLength(serialized) > limit) refuse();
    return { serialized, keySha256 };
  } catch {
    refuse();
  } finally {
    key.fill(0);
    plaintext.fill(0);
  }
}

export function sealCapture(
  assets: readonly CapturedAsset[],
  publicKeyBase64: string,
) {
  return sealWithKey(assets, capturePublicKey(publicKeyBase64));
}

interface CaptureInput {
  assetsJson: string;
  publicKeyBase64: string;
  secret: string;
  fetcher?: typeof fetch;
  now?: () => Date;
  signal?: AbortSignal;
}

export async function captureNativeParity(input: CaptureInput) {
  const assets = parseCaptureAssets(input.assetsJson);
  if (assets[0].manifest && assets.length !== 1) refuse();
  const publicKey = capturePublicKey(input.publicKeyBase64);
  if (!input.secret) refuse();
  preflightEnvelope(assets, publicKey);
  const fetcher = input.fetcher ?? fetch;
  const captured: CapturedAsset[] = [];
  for (const asset of assets) {
    if (input.signal?.aborted) refuse();
    let response: Response;
    try {
      response = await fetcher(
        "https://api.metagraph.sh/api/v1/internal/native-store-export",
        {
          method: "POST",
          redirect: "error",
          signal: input.signal
            ? AbortSignal.any([AbortSignal.timeout(30000), input.signal])
            : AbortSignal.timeout(30000),
          headers: {
            "content-type": "application/json",
            "accept-encoding": "identity",
            "x-state-export-token": input.secret,
          },
          body: JSON.stringify({
            kind: "native-store",
            operation: "read",
            ...asset,
          }),
        },
      );
    } catch {
      refuse();
    }
    const raw = Buffer.alloc(asset.bytes);
    try {
      if (
        response.status !== 200 ||
        !response.body ||
        (response.headers.get("content-encoding") ?? "identity") !== "identity"
      ) {
        refuse();
      }
      const declared = response.headers.get("content-length");
      if (declared !== null && declared !== String(asset.bytes)) refuse();
      if (response.headers.get("x-content-sha256") !== asset.sha256) refuse();
      const reader = response.body.getReader();
      let offset = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          if (offset + part.value.byteLength > asset.bytes) refuse();
          raw.set(part.value, offset);
          offset += part.value.byteLength;
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      if (
        offset !== asset.bytes ||
        createHash("sha256").update(raw).digest("hex") !== asset.sha256
      ) {
        refuse();
      }
      if (asset.manifest) validateCaptureManifest(raw);
      captured.push({
        ...asset,
        observedAt: (input.now ?? (() => new Date()))().toISOString(),
        data: raw.toString("base64"),
      });
    } catch {
      refuse();
    } finally {
      raw.fill(0);
      await response.body?.cancel().catch(() => undefined);
    }
  }
  const sealed = sealWithKey(captured, publicKey);
  return {
    ...sealed,
    summary: {
      version: 1 as const,
      status: "encrypted" as const,
      assets: assets.length,
      bytes: assets.reduce((total, asset) => total + asset.bytes, 0),
      keySha256: sealed.keySha256,
    },
  };
}

export async function captureNativeParitySequence(
  input: Omit<CaptureInput, "signal"> & {
    sink: (
      result: Awaited<ReturnType<typeof captureNativeParity>>,
      index: number,
    ) => Promise<void>;
    budgetNow?: () => number;
  },
) {
  const budgetNow = input.budgetNow ?? (() => performance.now());
  const startedAt = budgetNow();
  const assets = parseCaptureAssets(input.assetsJson);
  if (!assets.every((asset) => asset.manifest === true)) refuse();
  const publicKey = capturePublicKey(input.publicKeyBase64);
  if (!input.secret || typeof input.sink !== "function") refuse();
  for (const asset of assets) preflightEnvelope([asset], publicKey);
  const controller = new AbortController();
  const checkBudget = () => {
    const elapsed = budgetNow() - startedAt;
    if (
      !Number.isFinite(elapsed) ||
      elapsed < 0 ||
      elapsed >= CAPTURE_LIMITS.sequenceTimeoutMs ||
      controller.signal.aborted
    ) {
      refuse();
    }
    return CAPTURE_LIMITS.sequenceTimeoutMs - elapsed;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Native parity capture refused"));
    }, checkBudget());
  });
  async function run() {
    for (const [index, asset] of assets.entries()) {
      checkBudget();
      const result = await captureNativeParity({
        assetsJson: JSON.stringify([asset]),
        publicKeyBase64: input.publicKeyBase64,
        secret: input.secret,
        fetcher: input.fetcher,
        now: input.now,
        signal: controller.signal,
      });
      checkBudget();
      // Keep only one sealed envelope in flight. A failed sink stops the batch
      // before its next read, and no plaintext is written on any path.
      await input.sink(result, index);
      checkBudget();
    }
    return {
      version: 1 as const,
      status: "encrypted" as const,
      assets: assets.length,
      bytes: assets.reduce((total, asset) => total + asset.bytes, 0),
      keySha256: createHash("sha256")
        .update(publicKey.export({ type: "spki", format: "der" }))
        .digest("hex"),
    };
  }
  try {
    return await Promise.race([deadline, run()]);
  } catch {
    refuse();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}

async function main() {
  try {
    const input = {
      assetsJson: process.env.NATIVE_PARITY_ASSETS ?? "",
      publicKeyBase64: process.env.NATIVE_PARITY_PUBLIC_KEY ?? "",
      secret: process.env.STATE_EXPORT_SECRET ?? "",
    };
    const assets = parseCaptureAssets(input.assetsJson);
    if (assets[0].manifest) {
      const summary = await captureNativeParitySequence({
        ...input,
        sink: async (result, index) => {
          const suffix = String(index).padStart(2, "0");
          await writeFile(
            `native-parity-capture-${suffix}.encrypted.json`,
            result.serialized,
            { mode: 0o600, flag: "wx" },
          );
        },
      });
      console.log(JSON.stringify(summary));
    } else {
      const result = await captureNativeParity(input);
      await writeFile(
        "native-parity-capture.encrypted.json",
        result.serialized,
        { mode: 0o600, flag: "wx" },
      );
      console.log(JSON.stringify(result.summary));
    }
  } catch {
    // The CLI is a final boundary even for unexpected runtime/filesystem errors.
    console.error("native_parity_capture_refused");
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
