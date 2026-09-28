// Publish immutable registry bytes into the existing control namespace. The
// caller owns the existing publication lock; KV itself is not a transaction lock.
import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { setTimeout as sleep } from "node:timers/promises";
import {
  RegistryManifestSchema,
  type RegistryArtifact,
} from "../schemas-src/registry-kv.ts";
type RegistryManifest = ReturnType<typeof RegistryManifestSchema.parse>;
import {
  registryManifestKey,
  registryObjectKey,
  REGISTRY_KV_PREFIX,
} from "../src/registry-kv.ts";

const POINTER_KEY = "metagraph:latest";
const BATCH_BYTES = 8 * 1024 * 1024;
const STORAGE_BUDGET = 700 * 1024 * 1024;
const GC_GRACE_MS = 24 * 60 * 60 * 1000;
const STABLE_PATH =
  /^\/metagraph\/(?:health\/history\/\d{4}-\d{2}-\d{2}\.json|schemas\/(?!index\.json$)[A-Za-z0-9._:-]+\.json|fixtures\/(?!_capture-report\.json$)[A-Za-z0-9._:-]+\.json)$/;

interface RegistryKvObject {
  key: string;
  bytes: Uint8Array;
}
interface RegistryKvListing {
  name: string;
  metadata: { size_bytes: number; uploaded_at: string; utf8: boolean };
}
interface RegistryKvStore {
  read(key: string): Promise<Uint8Array | null>;
  readText(keys: string[]): Promise<Record<string, unknown>>;
  write(objects: RegistryKvObject[]): Promise<void>;
  list(): Promise<RegistryKvListing[]>;
  remove(keys: string[]): Promise<void>;
  /** Eventual stores can wait before rechecking a completed write. */
  waitForPropagation?(): Promise<void>;
}

export const registryDigest = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
const jsonBytes = (value: unknown): Uint8Array =>
  Buffer.from(JSON.stringify(value));

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid registry control metadata");
  return value as Record<string, unknown>;
}

async function readPointer(
  store: RegistryKvStore,
): Promise<Record<string, unknown>> {
  const raw = await store.read(POINTER_KEY);
  if (!raw) throw new Error("Existing registry pointer is required");
  return object(JSON.parse(Buffer.from(raw).toString("utf8")));
}

export async function readRegistryManifest(
  store: RegistryKvStore,
  digest: unknown,
): Promise<RegistryManifest> {
  if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest))
    throw new Error("Invalid registry manifest digest");
  const raw = await store.read(registryManifestKey(digest));
  if (!raw || registryDigest(raw) !== digest)
    throw new Error("Registry manifest integrity check failed");
  return RegistryManifestSchema.parse(
    JSON.parse(Buffer.from(raw).toString("utf8")),
  );
}

function verify(bytes: Uint8Array | null, entry: RegistryArtifact): void {
  if (
    !bytes ||
    bytes.byteLength !== entry.size_bytes ||
    registryDigest(bytes) !== entry.sha256
  ) {
    throw new Error(`Registry artifact integrity check failed: ${entry.path}`);
  }
}

/** A bounded bulk upload followed by exact byte readback, including binary
 * objects which the provider's text-only bulk GET cannot represent. */
async function writeVerified(
  store: RegistryKvStore,
  batch: RegistryKvObject[],
): Promise<void> {
  if (!batch.length) return;
  await store.write(batch);
  const text = batch.filter(({ bytes }) => isUtf8(bytes));
  const binary = batch.filter(({ bytes }) => !isUtf8(bytes));
  async function readback(): Promise<Error | null> {
    if (text.length) {
      const values = await store.readText(text.map(({ key }) => key));
      for (const item of text) {
        const value = values[item.key];
        if (
          typeof value !== "string" ||
          !Buffer.from(value).equals(Buffer.from(item.bytes))
        )
          return new Error(`Registry upload readback failed: ${item.key}`);
      }
    }
    for (const item of binary) {
      const actual = await store.read(item.key);
      if (!actual || !Buffer.from(actual).equals(Buffer.from(item.bytes)))
        return new Error(`Registry binary readback failed: ${item.key}`);
    }
    return null;
  }
  // A successful KV write can still read its previous cached value. Retry
  // verification, never the write; fail closed after the bounded grace period.
  for (let attempt = 0; ; attempt++) {
    const mismatch = await readback();
    if (!mismatch) return;
    if (attempt === 4 || !store.waitForPropagation) throw mismatch;
    await store.waitForPropagation();
  }
}

async function verifyStored(
  store: RegistryKvStore,
  entries: [string, RegistryArtifact][],
  known: Map<string, RegistryKvListing>,
): Promise<void> {
  let batch: [string, RegistryArtifact][] = [];
  let size = 0;
  async function flush(): Promise<void> {
    if (!batch.length) return;
    const values = await store.readText(batch.map(([key]) => key));
    for (const [key, entry] of batch) {
      const value = values[key];
      verify(typeof value === "string" ? Buffer.from(value) : null, entry);
    }
    batch = [];
    size = 0;
  }
  for (const [key, entry] of entries) {
    const listed = known.get(key);
    if (!listed || listed.metadata.size_bytes !== entry.size_bytes)
      throw new Error(`Registry retained object is missing: ${key}`);
    if (!listed.metadata.utf8) {
      verify(await store.read(key), entry);
      continue;
    }
    if (
      batch.length &&
      (batch.length >= 100 || size + entry.size_bytes > BATCH_BYTES)
    )
      await flush();
    batch.push([key, entry]);
    size += entry.size_bytes;
  }
  await flush();
}

interface RegistryPublishInput {
  artifacts: RegistryArtifact[];
  load(entry: RegistryArtifact): Promise<Uint8Array>;
  pointer: Record<string, unknown>;
  // Initial migration must supply an independently inventoried and verified
  // stable-history set. An empty set is an explicit assertion, never inferred.
  bootstrapStable?: RegistryArtifact[];
  // Bootstrap may stage and independently qualify the immutable generation
  // before a later invocation re-verifies it and activates the pointer.
  activate?: boolean;
}

export async function publishRegistryKv(
  store: RegistryKvStore,
  input: RegistryPublishInput,
): Promise<Record<string, unknown>> {
  const before = await readPointer(store);
  const previous = before.registry_manifest_sha256
    ? await readRegistryManifest(store, before.registry_manifest_sha256)
    : null;
  if (!previous && !input.bootstrapStable)
    throw new Error(
      "Initial KV publication requires the retained stable-history inventory",
    );
  const retained =
    previous?.artifacts.filter(({ path }) => STABLE_PATH.test(path)) ??
    input.bootstrapStable!;
  if (retained.some(({ path }) => !STABLE_PATH.test(path)))
    throw new Error("Invalid stable-history inventory");
  if (retained.length)
    RegistryManifestSchema.parse({ version: 1, artifacts: retained });
  // Validate the staged set before merging: duplicates must not be hidden by Map.
  const staged = RegistryManifestSchema.parse({
    version: 1,
    artifacts: input.artifacts,
  });
  const entries = new Map(retained.map((entry) => [entry.path, entry]));
  for (const entry of staged.artifacts) entries.set(entry.path, entry);
  const manifest = RegistryManifestSchema.parse({
    version: 1,
    artifacts: [...entries.values()].sort((a, b) =>
      a.path.localeCompare(b.path),
    ),
  });
  const manifestBytes = jsonBytes(manifest);
  const digest = registryDigest(manifestBytes);
  const listed = await store.list();
  const known = new Map(listed.map((entry) => [entry.name, entry]));
  if (
    known.size !== listed.length ||
    listed.some(
      (entry) =>
        !entry.name.startsWith(REGISTRY_KV_PREFIX) ||
        !Number.isSafeInteger(entry.metadata.size_bytes) ||
        entry.metadata.size_bytes < 0 ||
        typeof entry.metadata.utf8 !== "boolean" ||
        !Number.isFinite(Date.parse(entry.metadata.uploaded_at)),
    )
  ) {
    throw new Error("Incomplete registry storage accounting");
  }
  const unique = new Map(
    manifest.artifacts.map((entry) => [registryObjectKey(entry.sha256), entry]),
  );
  const newBytes =
    [...unique].reduce(
      (total, [key, entry]) => total + (known.has(key) ? 0 : entry.size_bytes),
      0,
    ) + manifestBytes.byteLength;
  const storedBytes = listed.reduce(
    (total, entry) => total + entry.metadata.size_bytes,
    0,
  );
  if (storedBytes + newBytes > STORAGE_BUDGET)
    throw new Error(
      "Registry publication exceeds its existing-storage budget; collect verified obsolete generations first",
    );

  await verifyStored(
    store,
    [...unique].filter(([key]) => known.has(key)),
    known,
  );
  let batch: RegistryKvObject[] = [];
  let batchBytes = 0;
  let uploaded = 0;
  for (const [key, entry] of unique) {
    // Every reused object is verified too. Content-addressing cannot justify
    // trusting an incomplete prior upload or an incorrect supplied inventory.
    if (known.has(key)) continue;
    const bytes = await input.load(entry);
    verify(bytes, entry);
    if (
      batch.length &&
      (batch.length >= 100 || batchBytes + bytes.byteLength > BATCH_BYTES)
    ) {
      await writeVerified(store, batch);
      uploaded += batch.length;
      batch = [];
      batchBytes = 0;
    }
    batch.push({ key, bytes });
    batchBytes += bytes.byteLength;
  }
  await writeVerified(store, batch);
  uploaded += batch.length;
  const manifests = [
    { key: registryManifestKey(digest), bytes: manifestBytes },
  ];
  if (previous && before.registry_manifest_sha256 !== digest) {
    const oldDigest = String(before.registry_manifest_sha256);
    const raw = await store.read(registryManifestKey(oldDigest));
    if (!raw || registryDigest(raw) !== oldDigest)
      throw new Error("Previous manifest changed during publication");
    // Refresh its retention clock as it leaves the current slot. The original
    // upload age of long-lived content is not a safe retirement clock.
    manifests.push({ key: registryManifestKey(oldDigest), bytes: raw });
  }
  await writeVerified(store, manifests);
  if (JSON.stringify(await readPointer(store)) !== JSON.stringify(before))
    throw new Error("Registry pointer changed during publication");
  if (input.activate === false)
    return {
      manifest_sha256: digest,
      artifacts: manifest.artifacts.length,
      uploaded,
      stored_bytes_before: storedBytes,
      new_bytes: newBytes,
      activated: false,
    };
  const previousDigest =
    before.registry_manifest_sha256 === digest
      ? before.registry_previous_manifest_sha256
      : before.registry_manifest_sha256;
  const pointer = {
    ...input.pointer,
    registry_manifest_sha256: digest,
    ...(previousDigest
      ? { registry_previous_manifest_sha256: previousDigest }
      : {}),
  };
  await writeVerified(store, [{ key: POINTER_KEY, bytes: jsonBytes(pointer) }]);
  return {
    manifest_sha256: digest,
    artifacts: manifest.artifacts.length,
    uploaded,
    stored_bytes_before: storedBytes,
    new_bytes: newBytes,
    activated: true,
  };
}

/** Reclaim only this publisher's unreferenced keys, after a full day for stale
 * pointers and in-flight reads. The selected and previous generations remain. */
export async function collectRegistryKv(
  store: RegistryKvStore,
  now = Date.now(),
): Promise<number> {
  const before = await readPointer(store);
  const retained = new Set<string>();
  const retainedObjects = new Map<string, RegistryArtifact>();
  const listed = await store.list();
  const recent = listed
    .filter(
      (entry) =>
        /^registry:v1:manifest:[a-f0-9]{64}$/.test(entry.name) &&
        Date.parse(entry.metadata.uploaded_at) >= now - GC_GRACE_MS,
    )
    .map(({ name }) => name.slice("registry:v1:manifest:".length));
  for (const digest of new Set([
    before.registry_manifest_sha256,
    before.registry_previous_manifest_sha256,
    ...recent,
  ])) {
    if (!digest) continue;
    const manifest = await readRegistryManifest(store, digest);
    retained.add(registryManifestKey(String(digest)));
    for (const entry of manifest.artifacts) {
      retained.add(registryObjectKey(entry.sha256));
      retainedObjects.set(registryObjectKey(entry.sha256), entry);
    }
  }
  if (!before.registry_manifest_sha256)
    throw new Error("KV registry is not selected");
  await verifyStored(
    store,
    [...retainedObjects],
    new Map(listed.map((entry) => [entry.name, entry])),
  );
  const candidates = listed.filter(
    (entry) =>
      /^registry:v1:(?:object|manifest):[a-f0-9]{64}$/.test(entry.name) &&
      !retained.has(entry.name) &&
      Date.parse(entry.metadata.uploaded_at) < now - GC_GRACE_MS,
  );
  if (JSON.stringify(await readPointer(store)) !== JSON.stringify(before))
    throw new Error("Registry pointer changed during collection");
  for (let i = 0; i < candidates.length; i += 1000)
    await store.remove(candidates.slice(i, i + 1000).map(({ name }) => name));
  for (let i = 0; i < candidates.length; i += 100) {
    const keys = candidates.slice(i, i + 100).map(({ name }) => name);
    const values = await store.readText(keys);
    if (keys.some((key) => values[key] !== null))
      throw new Error("Registry collection absence verification failed");
  }
  return candidates.length;
}

/** Provider adapter: paced REST calls, bounded responses, partial-write checks,
 * and no namespace creation or R2 operations. */
export function cloudflareRegistryKvStore(
  account: string,
  token: string,
  namespace: string,
  baseUrl = "https://api.cloudflare.com/client/v4",
): RegistryKvStore {
  const base = `${baseUrl}/accounts/${account}/storage/kv/namespaces/${namespace}`;
  let nextRequest = 0;
  async function request(
    suffix: string,
    method = "GET",
    body?: unknown,
  ): Promise<Response> {
    const delay = Math.max(0, nextRequest - Date.now());
    nextRequest = Date.now() + delay + 400;
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    const response = await fetch(`${base}${suffix}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok && response.status !== 404)
      throw new Error(`Registry KV ${method} failed: HTTP ${response.status}`);
    return response;
  }
  async function bytes(response: Response): Promise<Uint8Array> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing registry KV response");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.byteLength;
        if (size > 64 * 1024 * 1024)
          throw new Error("Registry KV response exceeds bound");
        chunks.push(item.value);
      }
    } finally {
      await reader.cancel();
    }
    return Buffer.concat(chunks);
  }
  async function json(
    suffix: string,
    method = "GET",
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    const response = await request(suffix, method, body);
    const value = object(
      JSON.parse(Buffer.from(await bytes(response)).toString("utf8")),
    );
    if (value.success !== true) throw new Error("Registry KV operation failed");
    return value;
  }
  return {
    waitForPropagation: () => sleep(30_000),
    async read(key) {
      const response = await request(`/values/${encodeURIComponent(key)}`);
      if (response.status === 404) {
        await response.body?.cancel();
        return null;
      }
      return bytes(response);
    },
    async readText(keys) {
      if (!keys.length || keys.length > 100)
        throw new Error("Invalid registry bulk read size");
      const value = await json("/bulk/get", "POST", { keys, type: "text" });
      return object(object(value.result).values);
    },
    async write(objects) {
      const uploadedAt = new Date().toISOString();
      const value = await json(
        "/bulk",
        "PUT",
        objects.map(({ key, bytes }) => ({
          key,
          value: Buffer.from(bytes).toString("base64"),
          base64: true,
          metadata: {
            size_bytes: bytes.byteLength,
            uploaded_at: uploadedAt,
            utf8: isUtf8(bytes),
          },
        })),
      );
      const result = object(value.result);
      if (
        result.successful_key_count !== objects.length ||
        !Array.isArray(result.unsuccessful_keys) ||
        result.unsuccessful_keys.length
      )
        throw new Error("Incomplete registry KV bulk write");
    },
    async list() {
      const entries: RegistryKvListing[] = [];
      const cursors = new Set<string>();
      let cursor = "";
      do {
        const query = new URLSearchParams({
          prefix: REGISTRY_KV_PREFIX,
          limit: "1000",
          ...(cursor ? { cursor } : {}),
        });
        const value = await json(`/keys?${query}`);
        if (!Array.isArray(value.result))
          throw new Error("Invalid registry KV listing");
        for (const item of value.result) {
          const entry = object(item);
          const metadata = object(entry.metadata);
          if (
            typeof entry.name !== "string" ||
            typeof metadata.size_bytes !== "number" ||
            typeof metadata.uploaded_at !== "string" ||
            typeof metadata.utf8 !== "boolean"
          )
            throw new Error("Registry KV key has no size receipt");
          entries.push({
            name: entry.name,
            metadata: {
              size_bytes: metadata.size_bytes,
              uploaded_at: metadata.uploaded_at,
              utf8: metadata.utf8,
            },
          });
        }
        const info = object(value.result_info);
        cursor = typeof info.cursor === "string" ? info.cursor : "";
        if (entries.length > 50_000 || (cursor && cursors.has(cursor)))
          throw new Error("Registry KV listing exceeds bound");
        if (cursor) cursors.add(cursor);
      } while (cursor);
      return entries;
    },
    async remove(keys) {
      if (
        !keys.length ||
        keys.length > 1000 ||
        keys.some(
          (key) => !/^registry:v1:(?:object|manifest):[a-f0-9]{64}$/.test(key),
        )
      )
        throw new Error("Invalid registry collection keys");
      const value = await json("/bulk/delete", "POST", keys);
      const result = object(value.result);
      if (
        result.successful_key_count !== keys.length ||
        !Array.isArray(result.unsuccessful_keys) ||
        result.unsuccessful_keys.length
      )
        throw new Error("Incomplete registry KV collection");
    },
  };
}
