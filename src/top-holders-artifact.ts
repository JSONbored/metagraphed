// Top-holders served from a MATERIALIZED artifact when the Postgres tier
// misses.
//
// WHY AN ARTIFACT AND NOT A LAKEHOUSE READER. The route's SQL is dialect-
// hostile to R2 SQL (FULL OUTER JOIN, DISTINCT ON, CURRENT_DATE arithmetic),
// and every table it reads is a frozen snapshot of the decommissioned box --
// so the exact route query was run ONE final time against the live Postgres
// and its result stored at ARTIFACT_KEY. A query whose inputs cannot change
// has one answer; storing that answer loses nothing a live reader would add.
//
// The artifact holds the union of the top 1,000 rows per sortable key (the
// route serves at most 100), shaped exactly as postgres.js handed rows to the
// Worker (numerics as strings), so the SAME buildTopHoldersList formatter
// sorts and slices it and a caller cannot tell which tier answered. When a
// projection lane later recomputes this from the lakehouse, it overwrites the
// same key and this reader serves the fresher copy unchanged.

import { buildTopHoldersList } from "./top-holders.ts";

export const TOP_HOLDERS_ARTIFACT_KEY =
  "metagraph/materialized/top-holders.json";

interface ArtifactBucket {
  get(key: string): Promise<{ json(): Promise<unknown> } | null>;
}

/**
 * The rows this reader will actually serve from, or null when the body is not
 * the artifact this module wrote.
 *
 * Exported so the watchdog judges the artifact by the SAME test the read path
 * applies. Two copies of "is this body usable" would drift silently, and the
 * direction they drift is the dangerous one: a watchdog with a looser test
 * reports healthy on exactly the object the route is declining to serve.
 */
export function topHoldersArtifactRows(
  body: unknown,
): Record<string, unknown>[] | null {
  const parsed = body as { schema_version?: unknown; rows?: unknown } | null;
  // A body that is not the artifact this module wrote is a decline, not a
  // guess -- serving a half-recognized shape through the formatter would
  // produce a confidently wrong page.
  if (parsed?.schema_version !== 1 || !Array.isArray(parsed.rows)) return null;
  return parsed.rows as Record<string, unknown>[];
}

/**
 * The materialized top-holders payload, or null when the artifact store
 * cannot answer (unbound, missing object, malformed body) so the caller
 * keeps its schema-stable empty.
 */
export async function loadTopHoldersFromArtifact(
  env: Env | null | undefined,
  query: { sort?: string; limit?: unknown },
): Promise<ReturnType<typeof buildTopHoldersList> | null> {
  const bucket = (env as { METAGRAPH_ARCHIVE?: ArtifactBucket } | null)
    ?.METAGRAPH_ARCHIVE;
  if (!bucket?.get) return null;
  try {
    const object = await bucket.get(TOP_HOLDERS_ARTIFACT_KEY);
    if (!object) return null;
    const rows = topHoldersArtifactRows(await object.json());
    if (rows === null) return null;
    return buildTopHoldersList(rows, {
      sort: query.sort,
      limit: query.limit,
    });
  } catch {
    return null;
  }
}
