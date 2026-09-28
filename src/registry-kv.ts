import {
  RegistryDigestSchema,
  RegistryManifestSchema,
  type RegistryArtifact,
} from "../schemas-src/registry-kv.ts";
import { registerModuleStateReset } from "./module-state-registry.ts";

export const REGISTRY_KV_PREFIX = "registry:v1:";
export const registryObjectKey = (sha256: string): string =>
  `${REGISTRY_KV_PREFIX}object:${sha256}`;
export const registryManifestKey = (sha256: string): string =>
  `${REGISTRY_KV_PREFIX}manifest:${sha256}`;

export interface RegistryKvPointer {
  registry_manifest_sha256?: string;
  registry_previous_manifest_sha256?: string;
}

type Index = Map<string, RegistryArtifact>;
// Four small immutable indexes per binding, never an unbounded history of runs.
let indexes = new WeakMap<KVNamespace, Map<string, Promise<Index>>>();
registerModuleStateReset("src/registry-kv.ts", () => {
  indexes = new WeakMap();
});

async function manifestIndex(kv: KVNamespace, digest: string): Promise<Index> {
  RegistryDigestSchema.parse(digest);
  let cache = indexes.get(kv);
  if (!cache) {
    cache = new Map();
    indexes.set(kv, cache);
  }
  const cached = cache.get(digest);
  if (cached) return cached;
  const pending = (async () => {
    const raw = await kv.get(registryManifestKey(digest), { type: "json" });
    const manifest = RegistryManifestSchema.parse(raw);
    return new Map(manifest.artifacts.map((entry) => [entry.path, entry]));
  })();
  cache.set(digest, pending);
  if (cache.size > 4) cache.delete(cache.keys().next().value!);
  try {
    return await pending;
  } catch (error) {
    // A miss during propagation must be retried, not pinned for the isolate's life.
    cache.delete(digest);
    throw error;
  }
}

export type RegistryKvRead =
  | {
      ok: true;
      object: Response;
      source: "kv";
      storage_tier: "kv";
      resolution: "manifest" | "fallback";
    }
  | { ok: false; status: number; code: string; message: string };

/** Read one immutable generation, with the prior complete generation retained
 * for propagation gaps. Explicit removal in a readable manifest is a 404:
 * it must never resurrect an old artifact from the previous publication. */
export async function readRegistryKv(
  kv: KVNamespace,
  pointer: RegistryKvPointer,
  artifactPath: string,
): Promise<RegistryKvRead> {
  const generations = [
    pointer.registry_manifest_sha256,
    pointer.registry_previous_manifest_sha256,
  ];
  for (const [index, digest] of generations.entries()) {
    if (!digest) continue;
    try {
      const manifest = await manifestIndex(kv, digest);
      const entry = manifest.get(artifactPath);
      if (!entry) {
        return {
          ok: false,
          status: 404,
          code: "artifact_not_found",
          message: `Artifact not found in registry: ${artifactPath}`,
        };
      }
      const bytes = await kv.get(registryObjectKey(entry.sha256), {
        type: "arrayBuffer",
      });
      if (!bytes || bytes.byteLength !== entry.size_bytes) continue;
      return {
        ok: true,
        object: new Response(bytes),
        source: "kv",
        storage_tier: "kv",
        resolution: index === 0 ? "manifest" : "fallback",
      };
    } catch {
      // Read/parse failures may be transient while the selected generation
      // propagates. No R2 read is allowed after the pointer selects KV.
    }
  }
  return {
    ok: false,
    status: 503,
    code: "registry_unavailable",
    message: "Published registry is temporarily unavailable.",
  };
}
