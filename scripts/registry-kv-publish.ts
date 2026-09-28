import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  RegistryManifestSchema,
  type RegistryArtifact,
} from "../schemas-src/registry-kv.ts";
import { R2_STAGING_RELATIVE_ROOT } from "../src/artifact-storage.ts";
import {
  artifactFilePath,
  readJson,
  repoRoot,
  stableStringify,
} from "./lib.ts";
import { requireCloudflareCredentials } from "./r2-rest.ts";
import {
  cloudflareRegistryKvStore,
  collectRegistryKv,
  publishRegistryKv,
  registryDigest,
} from "./registry-kv-store.ts";

export async function publishRegistryMain(
  args = process.argv.slice(2),
): Promise<void> {
  const fullManifestPath = path.join(
    repoRoot,
    R2_STAGING_RELATIVE_ROOT,
    "r2-manifest.json",
  );
  const fullManifest: Record<string, unknown> =
    await readJson(fullManifestPath);
  const staged = RegistryManifestSchema.parse({
    version: 1,
    artifacts: fullManifest.artifacts,
  });
  const localPaths = new Map(
    staged.artifacts.map((entry) => [
      entry.path,
      artifactFilePath(entry.path.replace(/^\/metagraph\//, "")),
    ]),
  );
  // Preserve the downloadable publication manifests as ordinary exact-byte
  // artifacts, independently of the small KV reader index.
  const controls = [
    ["/metagraph/r2-manifest.json", fullManifestPath],
    ["/metagraph/build-summary.json", artifactFilePath("build-summary.json")],
    [
      "/metagraph/r2-manifest.compact.json",
      path.join(repoRoot, "public/metagraph/r2-manifest.json"),
    ],
  ];
  for (const [artifactPath, localPath] of controls) {
    const data = await readFile(localPath!);
    staged.artifacts.push({
      path: artifactPath!,
      sha256: registryDigest(data),
      size_bytes: data.byteLength,
    });
    localPaths.set(artifactPath!, localPath!);
  }
  const manifest = RegistryManifestSchema.parse(staged);
  async function load(entry: RegistryArtifact): Promise<Uint8Array> {
    const localPath = localPaths.get(entry.path);
    if (!localPath)
      throw new Error(
        `Retained registry artifact is missing from KV: ${entry.path}`,
      );
    return readFile(localPath);
  }
  // The old upload step becomes a local integrity gate. It never writes R2 or
  // selects a partially uploaded publication; kv:publish owns the whole commit.
  for (const entry of manifest.artifacts) {
    const data = await load(entry);
    if (
      data.byteLength !== entry.size_bytes ||
      registryDigest(data) !== entry.sha256
    )
      throw new Error(`Staged registry changed: ${entry.path}`);
  }
  if (args.includes("--stage-only") || !args.includes("--write")) {
    console.log(
      stableStringify({
        mode: args.includes("--stage-only") ? "staged" : "dry-run",
        backend: "kv",
        artifacts: manifest.artifacts.length,
        bytes: manifest.artifacts.reduce((n, entry) => n + entry.size_bytes, 0),
        remote_writes: 0,
      }),
    );
    return;
  }
  const namespace = process.env.METAGRAPH_KV_NAMESPACE_ID;
  if (!namespace || process.env.METAGRAPH_ALLOW_KV_WRITE !== "1")
    throw new Error(
      "METAGRAPH_KV_NAMESPACE_ID and METAGRAPH_ALLOW_KV_WRITE=1 are required",
    );
  const { accountId, apiToken } = requireCloudflareCredentials();
  const store = cloudflareRegistryKvStore(accountId, apiToken, namespace);
  const summary: Record<string, unknown> = await readJson(
    artifactFilePath("build-summary.json"),
  );
  const freshness: { summary: Record<string, unknown> } = await readJson(
    artifactFilePath("freshness.json"),
  );
  // A normal publication can only follow the separately qualified initial
  // migration. Never infer an empty retained-history set from a failed read.
  const collected = await collectRegistryKv(store);
  const receipt = await publishRegistryKv(store, {
    artifacts: manifest.artifacts,
    load,
    pointer: {
      contract_version: fullManifest.contract_version,
      generated_at: fullManifest.generated_at,
      published_at: summary.published_at,
      run_prefix: fullManifest.run_prefix,
      artifact_count: manifest.artifacts.length,
      native_snapshot_captured_at:
        freshness.summary.native_snapshot_captured_at,
      health_surface_count: freshness.summary.health_surface_count,
    },
  });
  console.log(stableStringify({ ...receipt, collected, backend: "kv" }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await publishRegistryMain();
