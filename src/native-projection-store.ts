import { z } from "zod";
import { projectionKey, type ChainNetworkId } from "./chain-network.ts";
import type { ArtifactStoreEnv } from "./projection-store.ts";
import { registerModuleStateReset } from "./module-state-registry.ts";
import { CHAIN_FIREHOSE_TOPICS } from "./chain-firehose-topics.ts";
import { HistoryObjectSchema } from "../schemas-src/artifacts/history-generation.ts";

export const NATIVE_PROJECTION_FILES = [
  "blocks-summary.json",
  "chain-registrations.json",
  "chain-deregistrations.json",
  "chain-deregistrations-by-hotkey.json",
  "chain-deregistrations-by-uid.json",
  "chain-transfers.json",
  "chain-stake-flow.json",
  "chain-activity.json",
  "chain-calls.json",
  "chain-fees.json",
  "chain-signers.json",
  "chain-alpha-volume.json",
  "chain-stake-transfers.json",
  "chain-transfer-pairs.json",
  "chain-stake-moves.json",
  "chain-serving.json",
  "chain-prometheus.json",
  "chain-weights.json",
  "chain-weight-setters.json",
  "chain-ownership.json",
] as const;
const SourceSchema = z.strictObject({
  version: z.literal(1),
  network: z.enum(["mainnet", "testnet"]),
  table: z.enum(CHAIN_FIREHOSE_TOPICS),
  table_uuid: z.string().min(1),
  snapshot: z.string().regex(/^[0-9]+$/),
  sequence: z.number().int().nonnegative(),
  coverage: z.string().nullable(),
  cutoff: z.number().int().nonnegative(),
  runtimeCuration: HistoryObjectSchema.optional(),
});
const ManifestSchema = z.strictObject({
  version: z.literal(1),
  state: z.literal("complete"),
  network: z.enum(["mainnet", "testnet"]),
  generatedAt: z.number().int().nonnegative(),
  readerCommit: z.string().regex(/^[0-9a-f]{40}$/),
  generation: z.string().regex(/^[0-9a-f]{64}$/),
  artifacts: z
    .array(
      z.strictObject({
        artifactKey: z.string(),
        rowCount: z.number().int().nonnegative().nullable(),
        object: z.strictObject({
          key: z.string(),
          etag: z.string().min(1),
          bytes: z
            .number()
            .int()
            .positive()
            .max(32 * 1024 * 1024),
        }),
      }),
    )
    .length(NATIVE_PROJECTION_FILES.length),
  sources: z.array(SourceSchema).length(4),
});
export type NativeProjectionManifest = z.infer<typeof ManifestSchema>;
export const NATIVE_PROJECTION_STALE_MS = 2 * 60 * 60 * 1000;
const CACHE_MS = 30_000;
let cache = new WeakMap<
  object,
  Map<
    ChainNetworkId,
    { until: number; value: Promise<NativeProjectionManifest | null> }
  >
>();
registerModuleStateReset("src/native-projection-store.ts", () => {
  cache = new WeakMap();
});

export function nativeProjectionsEnabled(
  env: ArtifactStoreEnv | null | undefined,
): boolean {
  return env?.NATIVE_PROJECTIONS === "enabled";
}

export function isNativeProjectionKey(key: string): boolean {
  return NATIVE_PROJECTION_FILES.some(
    (file) => key === `metagraph/projections/${file}`,
  );
}

export function validateNativeProjectionManifest(
  value: unknown,
  network: ChainNetworkId,
): NativeProjectionManifest | null {
  const parsed = ManifestSchema.safeParse(value);
  if (!parsed.success) return null;
  const manifest = parsed.data;
  const root = `metagraph/native-projections/v1/${network}/${manifest.generation}/`;
  const expected = new Set(
    NATIVE_PROJECTION_FILES.map((file) =>
      projectionKey(`metagraph/projections/${file}`, network),
    ),
  );
  if (
    manifest.network !== network ||
    new Set(manifest.sources.map((source) => source.table)).size !== 4 ||
    manifest.sources.some(
      (source) =>
        source.network !== network ||
        source.cutoff !== manifest.generatedAt - 90 * 86_400_000 ||
        (source.runtimeCuration !== undefined &&
          (source.table !== "account_events" ||
            !new RegExp(
              `^metagraph/runtime-account-curation/v1/${network}/[0-9a-f]{64}/manifest\\.json$`,
            ).test(source.runtimeCuration.key))),
    )
  )
    return null;
  for (const item of manifest.artifacts) {
    if (
      !expected.delete(item.artifactKey) ||
      item.object.key !== root + item.artifactKey.split("/").at(-1)
    )
      return null;
  }
  return manifest;
}

/** A selected owner never falls back to SQL when its proof becomes unreadable. */
export async function loadNativeProjectionManifest(
  env: ArtifactStoreEnv | null | undefined,
  network: ChainNetworkId,
  fresh = false,
): Promise<NativeProjectionManifest | null> {
  const bucket = env?.METAGRAPH_ARCHIVE;
  if (!bucket || typeof bucket.get !== "function") return null;
  const now = Date.now();
  let entries = cache.get(bucket);
  if (!entries) {
    entries = new Map();
    cache.set(bucket, entries);
  }
  const prior = entries.get(network);
  if (!fresh && prior && prior.until > now) return prior.value;
  const value = (async () => {
    try {
      const object = await bucket.get!(
        `metagraph/native-projections/v1/${network}/current.json`,
      );
      return object &&
        typeof object.size === "number" &&
        object.size > 0 &&
        object.size <= 65536
        ? validateNativeProjectionManifest(await object.json(), network)
        : null;
    } catch {
      return null;
    }
  })();
  entries.set(network, { until: now + CACHE_MS, value });
  return value;
}

export async function readNativeProjectionObject(
  env: ArtifactStoreEnv,
  key: string,
  network: ChainNetworkId,
): Promise<unknown | null> {
  const manifest = await loadNativeProjectionManifest(env, network);
  if (!manifest) return null;
  const selected = manifest.artifacts.find(
    (item) => item.artifactKey === projectionKey(key, network),
  );
  if (!selected) return null;
  const object = await env.METAGRAPH_ARCHIVE!.get!(selected.object.key);
  if (
    !object ||
    object.etag !== selected.object.etag ||
    object.size !== selected.object.bytes
  )
    return null;
  const body = (await object.json()) as { generated_at?: unknown } | null;
  return body?.generated_at === new Date(manifest.generatedAt).toISOString()
    ? body
    : null;
}
