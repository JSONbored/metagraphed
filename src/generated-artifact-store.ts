export interface GeneratedArtifactStore {
  get(key: string, maxBytes?: number): Promise<unknown>;
  put(key: string, payload: string): Promise<void>;
}

export interface GeneratedArtifactEnv {
  D1_STATE?: Pick<D1Database, "prepare">;
  GENERATED_ARTIFACT_STORE?: GeneratedArtifactStore;
}

/** Explicit native selection applies to every reader and writer of this family. */
export function selectedGeneratedArtifactStore(
  env: unknown,
): GeneratedArtifactStore | undefined {
  if (!env || typeof env !== "object") return undefined;
  const configured = env as GeneratedArtifactEnv;
  const selected = configured.GENERATED_ARTIFACT_STORE;
  if (selected !== undefined) {
    if (
      !selected ||
      typeof selected.get !== "function" ||
      typeof selected.put !== "function"
    ) {
      throw new TypeError("Selected generated-artifact store is invalid");
    }
    return selected;
  }
  return generatedArtifactStore(configured.D1_STATE);
}

/** Small, mutable registry snapshots; durable state with no archive dependency. */
export function generatedArtifactStore(
  db?: Pick<D1Database, "prepare">,
): GeneratedArtifactStore | undefined {
  if (!db?.prepare) return undefined;
  return {
    async get(key: string) {
      try {
        const row = await db
          .prepare("SELECT payload FROM generated_artifacts WHERE key=?")
          .bind(key)
          .first<{ payload: string }>();
        return row ? (JSON.parse(row.payload) as unknown) : null;
      } catch {
        // Existing cold-store behavior: retain the committed seed or recapture.
        return null;
      }
    },
    async put(key: string, payload: string) {
      const stored = await db
        .prepare(
          `INSERT INTO generated_artifacts(key,payload,updated_at) VALUES(?,?,?)
           ON CONFLICT(key) DO UPDATE SET payload=excluded.payload,
             updated_at=excluded.updated_at RETURNING key`,
        )
        .bind(key, payload, new Date().toISOString())
        .first<{ key: string }>();
      if (stored?.key !== key)
        throw new Error("Generated artifact write was not acknowledged");
    },
  };
}
