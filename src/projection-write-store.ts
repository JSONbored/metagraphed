import { artifactBucket, type ArtifactStoreEnv } from "./projection-store.ts";

/** Separate write port: read-only callers cannot acquire writes. */
export interface ArtifactWriteStore {
  head?(key: string): Promise<{ etag: string } | null>;
  put(
    key: string,
    value: string,
    options?: { onlyIf: { etagMatches: string } },
  ): Promise<unknown>;
}

export interface ArtifactWriteEnv {
  METAGRAPH_ARCHIVE?: Partial<ArtifactWriteStore>;
}

function isWritable(
  bucket: Partial<ArtifactWriteStore> | null | undefined,
): bucket is ArtifactWriteStore {
  return typeof bucket?.put === "function";
}

/** The archive bucket for writing, or null when nothing usable is bound. */
export function artifactWriteBucket(
  env: ArtifactWriteEnv | null | undefined,
): ArtifactWriteStore | null {
  const bucket = env?.METAGRAPH_ARCHIVE;
  return isWritable(bucket) ? bucket : null;
}

/** Recompute from the winning artifact after a concurrent conditional write.
 * Never replay an old body over a newer flow vintage. */
export async function refreshExistingArtifact(
  env: ArtifactStoreEnv & ArtifactWriteEnv,
  key: string,
  compute: () => Promise<Record<string, unknown> | null>,
): Promise<Record<string, unknown> | null> {
  const reader = artifactBucket(env),
    writer = artifactWriteBucket(env);
  if (!reader || !writer?.head)
    throw new Error("Artifact refresh requires read and write storage");
  for (let attempt = 0; attempt < 3; attempt++) {
    const previous = await writer.head(key);
    if (!previous) return null;
    if (typeof previous.etag !== "string" || previous.etag.length === 0)
      throw new Error("Artifact refresh requires a source ETag");
    const body = await compute();
    if (body === null) return null;
    const written = await writer.put(key, JSON.stringify(body), {
      onlyIf: { etagMatches: previous.etag },
    });
    if (written !== null) return body;
  }
  throw new Error("Artifact refresh changed during all three attempts");
}
