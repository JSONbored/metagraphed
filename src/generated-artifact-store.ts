/** Small, mutable registry snapshots; durable state with no archive dependency. */
export function generatedArtifactStore(db?: Pick<D1Database, "prepare">) {
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
          `INSERT INTO generated_artifacts(key,payload) VALUES(?,?)
           ON CONFLICT(key) DO UPDATE SET payload=excluded.payload,
             updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') RETURNING key`,
        )
        .bind(key, payload)
        .first<{ key: string }>();
      if (stored?.key !== key)
        throw new Error("Generated artifact write was not acknowledged");
    },
  };
}
