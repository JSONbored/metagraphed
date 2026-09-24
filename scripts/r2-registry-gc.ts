import { pathToFileURL } from "node:url";
import { r2ApiBaseUrl, requireCloudflareCredentials } from "./r2-rest.ts";

export interface RegistryObject {
  key: string;
  etag: string;
  size: number;
  last_modified: string;
}
export interface RegistryStore {
  list(prefix: string): Promise<RegistryObject[]>;
  read(key: string): Promise<unknown>;
  pointer(): Promise<unknown>;
  remove(keys: string[]): Promise<void>;
}
interface Roots {
  identity: string;
  references: Set<string>;
  manifests: number;
}
const HASH_KEY = /^by-hash\/[a-f0-9]{64}$/;
const RUN_MANIFEST = /^runs\/[^/]+\/r2-manifest\.json$/;
const GRACE_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_DELETIONS = 10000;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid registry metadata");
  }
  return value as Record<string, unknown>;
}
function identities(objects: RegistryObject[]): string {
  return JSON.stringify(
    objects.map(({ key, etag, size }) => [key, etag, size]).sort(),
  );
}
async function roots(store: RegistryStore): Promise<Roots> {
  const pointer = record(await store.pointer());
  const selected = pointer.full_manifest_run_key;
  if (typeof selected !== "string" || !RUN_MANIFEST.test(selected)) {
    throw new Error("Live pointer has no retained run manifest");
  }
  const runs = await store.list("runs/");
  const keys = [
    ...new Set([
      "latest/r2-manifest.json",
      selected,
      ...runs
        .filter((object) => RUN_MANIFEST.test(object.key))
        .map(({ key }) => key),
    ]),
  ].sort();
  const references = new Set<string>();
  const manifests: unknown[] = [];
  for (const key of keys) {
    const manifest = record(await store.read(key));
    if (!Array.isArray(manifest.artifacts) || !manifest.artifacts.length) {
      throw new Error(`Incomplete registry manifest: ${key}`);
    }
    for (const item of manifest.artifacts) {
      const artifact = record(item);
      if (typeof artifact.key !== "string" || !HASH_KEY.test(artifact.key)) {
        throw new Error(`Invalid registry artifact in ${key}`);
      }
      references.add(artifact.key);
    }
    manifests.push([key, manifest]);
  }
  return {
    identity: JSON.stringify([pointer, identities(runs), manifests]),
    references,
    manifests: keys.length,
  };
}

/** Run only while holding the publish workflow's concurrency lock. Never expire runs here. */
export async function collectRegistryHashes(
  store: RegistryStore,
  { write = false, now = Date.now() }: { write?: boolean; now?: number } = {},
): Promise<Record<string, number | boolean>> {
  const before = await roots(store);
  const objects = await store.list("by-hash/");
  const listed = new Map(objects.map((object) => [object.key, object]));
  if (
    listed.size !== objects.length ||
    [...before.references].some((key) => !listed.has(key))
  ) {
    throw new Error(
      "Registry listing is incomplete or a retained artifact is missing",
    );
  }
  const candidates = objects.filter(
    (object) =>
      HASH_KEY.test(object.key) &&
      !before.references.has(object.key) &&
      Number.isSafeInteger(object.size) &&
      object.size >= 0 &&
      !!object.etag &&
      Date.parse(object.last_modified) < now - GRACE_MS,
  );
  const after = await roots(store);
  if (before.identity !== after.identity)
    throw new Error("Registry publication changed");
  let deleted = 0;
  let deletedBytes = 0;
  if (write && candidates.length) {
    // Listing refresh checks exact identities without one HEAD per hash. The
    // workflow lock excludes a publisher reusing an old hash before its manifest lands.
    const refreshed = new Map(
      (await store.list("by-hash/")).map((object) => [object.key, object]),
    );
    const selected = candidates.slice(0, MAX_DELETIONS);
    for (const object of selected) {
      const current = refreshed.get(object.key);
      if (
        !current ||
        identities([current]) !== identities([object]) ||
        current.last_modified !== object.last_modified
      ) {
        throw new Error("Registry candidate identity changed");
      }
    }
    if ((await roots(store)).identity !== before.identity)
      throw new Error("Registry publication changed");
    for (let offset = 0; offset < selected.length; offset += 1000) {
      const batch = selected.slice(offset, offset + 1000);
      await store.remove(batch.map(({ key }) => key));
      deleted += batch.length;
      deletedBytes += batch.reduce((sum, object) => sum + object.size, 0);
    }
    const remaining = new Set(
      (await store.list("by-hash/")).map(({ key }) => key),
    );
    if (
      selected.some(({ key }) => remaining.has(key)) ||
      [...before.references].some((key) => !remaining.has(key))
    ) {
      throw new Error("Registry deletion readback failed");
    }
    if ((await roots(store)).identity !== before.identity)
      throw new Error("Registry publication changed");
  }
  return {
    write,
    manifests: before.manifests,
    references: before.references.size,
    candidates: candidates.length,
    candidateBytes: candidates.reduce((sum, object) => sum + object.size, 0),
    deleted,
    deletedBytes,
  };
}

export function cloudflareRegistryStore(
  accountId: string,
  apiToken: string,
  namespace: string,
): RegistryStore {
  const base = `${r2ApiBaseUrl()}/accounts/${accountId}`;
  const objects = `${base}/r2/buckets/metagraphed-artifacts/objects`;
  let nextRequest = 0;
  async function request(
    url: string,
    method = "GET",
    body?: unknown,
  ): Promise<unknown> {
    const wait = Math.max(0, nextRequest - Date.now());
    nextRequest = Date.now() + wait + 400;
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok)
      throw new Error(`Registry ${method} returned HTTP ${response.status}`);
    return response.json();
  }
  return {
    async list(prefix) {
      const values: RegistryObject[] = [];
      const seen = new Set<string>();
      let cursor = "";
      do {
        const query = new URLSearchParams({
          prefix,
          per_page: "1000",
          ...(cursor ? { cursor } : {}),
        });
        const result = record(await request(`${objects}?${query}`));
        if (result.success !== true || !Array.isArray(result.result))
          throw new Error("Registry listing failed");
        for (const item of result.result) {
          const object = record(item);
          if (
            typeof object.key !== "string" ||
            !object.key.startsWith(prefix) ||
            typeof object.etag !== "string" ||
            typeof object.size !== "number" ||
            typeof object.last_modified !== "string"
          )
            throw new Error("Invalid listed registry object");
          values.push({
            key: object.key,
            etag: object.etag,
            size: object.size,
            last_modified: object.last_modified,
          });
        }
        const info = record(result.result_info);
        if (typeof info.is_truncated !== "boolean")
          throw new Error("Missing registry pagination state");
        cursor =
          info.is_truncated && typeof info.cursor === "string"
            ? info.cursor
            : "";
        if ((info.is_truncated && !cursor) || (cursor && seen.has(cursor)))
          throw new Error("Invalid registry pagination cursor");
        seen.add(cursor);
      } while (cursor);
      return values;
    },
    read: (key) =>
      request(`${objects}/${key.split("/").map(encodeURIComponent).join("/")}`),
    pointer: () =>
      request(
        `${base}/storage/kv/namespaces/${namespace}/values/metagraph%3Alatest`,
      ),
    async remove(keys) {
      if (
        !keys.length ||
        keys.length > 1000 ||
        keys.some((key) => !HASH_KEY.test(key))
      )
        throw new Error("Invalid registry delete scope");
      const result = record(await request(objects, "DELETE", keys));
      if (
        result.success !== true ||
        !Array.isArray(result.result) ||
        JSON.stringify(result.result.map((item) => record(item).key).sort()) !==
          JSON.stringify([...keys].sort())
      ) {
        throw new Error("Registry deletion did not confirm every key");
      }
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const write = process.argv.includes("--write");
  if (write && process.env.METAGRAPH_R2_GC_PUBLISH_LOCK !== "1") {
    throw new Error(
      "Registry cleanup requires the exclusive publish workflow lock",
    );
  }
  const { accountId, apiToken } = requireCloudflareCredentials();
  const namespace = process.env.METAGRAPH_KV_NAMESPACE_ID;
  if (!namespace) throw new Error("METAGRAPH_KV_NAMESPACE_ID is required");
  console.log(
    JSON.stringify(
      await collectRegistryHashes(
        cloudflareRegistryStore(accountId, apiToken, namespace),
        { write },
      ),
    ),
  );
}
