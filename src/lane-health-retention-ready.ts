// Gate D1 housekeeping on actual trigger definitions, not a migration filename.
// Source merges start D1 maintenance and Worker builds independently. A Worker
// may arrive first; writes keep their acknowledgement while cleanup fails closed.
// Hashes use snapshot-d1-schema's whitespace normalization and are checked against
// actual SQLite metadata in native CI. Readiness is cached only per store/request.
export const LANE_HEALTH_RETENTION_TRIGGER_HASHES: Readonly<
  Record<string, string>
> = {
  lane_health_clocks_delete:
    "577e2993d1e3b3a390882123ed1d8333d04fce210e053c3cb1a2ecc591b1fb98",
  lane_health_clocks_update:
    "46e84e98fb670d117b341f842952f831b444ec24a46227de5daeac192fd8d309",
  lane_health_current_delete:
    "279bca32887a15d4a353367fd63f131bdd023f382bd68a75da2e6a9f1ba871aa",
  lane_health_verdict_delete:
    "dc9a6ffce1fb88b297b5294948765a6c3c3e012769cfe85ae20abd5a1b5c5aa4",
  lane_health_verdict_update:
    "7734ff313fbf720959c2d2256ce112ae0cc91f0b6684f65b19d93dc6224a20ee",
  lane_health_verdict_update_new:
    "0d8a55259e03ca923c3fd51d51a9bdceef6955eae5e47dbe9028075d5178a1fc",
};

export async function laneHealthRetentionReady(
  query: (sql: string) => Promise<unknown[]>,
): Promise<boolean> {
  try {
    const names = Object.keys(LANE_HEALTH_RETENTION_TRIGGER_HASHES);
    const rows = await query(
      `SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name IN (${names.map((n) => "'" + n + "'").join(",")}) LIMIT 7`,
    );
    if (rows.length !== names.length) return false;
    const seen = new Set<string>();
    for (const row of rows) {
      if (!row || typeof row !== "object") return false;
      const { name, sql } = row as { name?: unknown; sql?: unknown };
      if (
        typeof name !== "string" ||
        typeof sql !== "string" ||
        !Object.hasOwn(LANE_HEALTH_RETENTION_TRIGGER_HASHES, name) ||
        seen.has(name)
      )
        return false;
      seen.add(name);
      const normalized = sql
        .split("\n")
        .map((line) => line.trimEnd())
        .join("\n")
        .trim()
        .replace(/;$/, "");
      const bytes = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(normalized),
      );
      const digest = Array.from(new Uint8Array(bytes), (value) =>
        value.toString(16).padStart(2, "0"),
      ).join("");
      if (digest !== LANE_HEALTH_RETENTION_TRIGGER_HASHES[name]) return false;
    }
    return true;
  } catch {
    return false;
  }
}
