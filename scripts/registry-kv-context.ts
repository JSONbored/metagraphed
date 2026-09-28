import { readFile } from "node:fs/promises";
import { registryObjectKey } from "../src/registry-kv.ts";
import { stripJsonComments } from "./lib.ts";
import { requireCloudflareCredentials } from "./r2-rest.ts";
import {
  cloudflareRegistryKvStore,
  readRegistryManifest,
  registryDigest,
} from "./registry-kv-store.ts";

async function configuredRegistryStore() {
  const { accountId, apiToken } = requireCloudflareCredentials();
  const config = JSON.parse(
    stripJsonComments(
      await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
    ),
  ) as { kv_namespaces: { binding: string; id: string }[] };
  const namespace =
    process.env.METAGRAPH_KV_NAMESPACE_ID ??
    config.kv_namespaces.find((entry) => entry.binding === "METAGRAPH_CONTROL")
      ?.id;
  if (!namespace)
    throw new Error("Existing METAGRAPH_CONTROL namespace is required");
  return cloudflareRegistryKvStore(accountId, apiToken, namespace);
}

export async function readPublishedRegistryJson(
  relativePath: string,
): Promise<Record<string, unknown> | null> {
  // Offline/dry-run builds keep their existing placeholders. A configured
  // publisher must propagate failures instead of replacing aliases or history
  // with an empty placeholder when its baseline cannot be read.
  if (!process.env.CLOUDFLARE_ACCOUNT_ID || !process.env.CLOUDFLARE_API_TOKEN)
    return null;
  const store = await configuredRegistryStore();
  const pointerBytes = await store.read("metagraph:latest");
  if (!pointerBytes) throw new Error("Published registry pointer is missing");
  const pointer = JSON.parse(Buffer.from(pointerBytes).toString("utf8"));
  const manifest = await readRegistryManifest(
    store,
    pointer.registry_manifest_sha256,
  );
  const entry = manifest.artifacts.find(
    (entry) => entry.path === `/metagraph/${relativePath}`,
  );
  if (!entry)
    throw new Error(`Published registry baseline is missing: ${relativePath}`);
  const bytes = await store.read(registryObjectKey(entry.sha256));
  if (
    !bytes ||
    bytes.byteLength !== entry.size_bytes ||
    registryDigest(bytes) !== entry.sha256
  )
    throw new Error(
      `Published registry baseline failed integrity: ${relativePath}`,
    );
  const value: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid published registry baseline: ${relativePath}`);
  return value as Record<string, unknown>;
}
