// The registry sync, against Neon (#10060).
//
// WHY THIS FAMILY MOVES FIRST, and why it moves WITHOUT a mirror. `surfaces`,
// `subnets`, `providers` and `surface_history` are read by exactly one thing --
// this Worker, inside this sync. `grep "FROM surfaces|FROM subnets|FROM
// providers|FROM surface_history"` over src/ and workers/ returns six hits and
// every one of them is in workers/registry-sync-api.ts; the public registry
// routes serve from R2 artifacts (ADR 0001), never from these tables. So there
// is no read to cut over, and nothing outside this file can observe the store
// changing.
//
// They are also the only tables in the migration that are REBUILDABLE: the sync
// re-derives all four from registry/subnets/*.json, so a bad write is fixed by
// re-running the lane. No observation table can say that -- a probe not stored
// is gone -- which is why those need a mirror and a proof, and this needs
// neither.
//
// ## This is a RESTORATION, not a port
//
// Every statement here ran against Postgres until the D1 move: the original had
// `sql.begin` and `DELETE ... RETURNING`. workers/registry-sync-api.ts had to
// give that up because the store's `batch()` is a fixed list of statements decided
// before any of them runs, so its reads moved OUT of the transaction and its
// own header documents the cost:
//
//   "The cost is a TOCTOU window between the two phases ... a surface deleted
//    by a concurrent call between phases would produce a history row for a row
//    that is already gone."
//
// Postgres has interactive transactions, so that window closes again. The reads
// below run INSIDE the same transaction as the writes, which is why this file
// does not reuse createPgSql: that runner opens a fresh connection per
// statement, and a transaction spanning two connections is not a transaction.
//
// ## The dialect differences, each verified against the live database
//
//   - `IS NOT` -> `IS DISTINCT FROM`. The D1 file's own comment says these are
//     equivalent and they are; confirmed by upserting an unchanged overlay and
//     watching the row not be touched.
//   - `json_each(?)` + `json_extract(v,'$.k')` -> `jsonb_array_elements($n)` +
//     `v->>'k'`; the id-list delete becomes `jsonb_array_elements_text`.
//   - `probe_eligible` / `public_safe` are 0/1 with a CHECK in the store and real
//     BOOLEAN in Neon, so the bindings become booleans.
//   - `(unixepoch() * 1000)` -> `(EXTRACT(EPOCH FROM now()) * 1000)::bigint`.
//
// ON CONFLICT (subnet_netuid, kind, url) keeps the EXISTING row's id, verified
// on a branch -- which is what makes the caller's `existing?.id ??
// crypto.randomUUID()` hoist still correct here.
import { Client } from "pg";

export interface ProviderSyncRow {
  id?: string;
  overlay?: unknown;
  source_commit?: string;
}

export interface SubnetSyncRow {
  netuid?: unknown;
  slug?: string;
  name?: string;
  source?: string;
  overlay?: unknown;
  source_commit?: string;
}

export interface SurfaceSyncRow {
  subnet_netuid?: unknown;
  provider_id?: string | null;
  surface_key?: string;
  kind?: string;
  url?: string;
  authority?: string;
  review_state?: string;
  probe_eligible?: unknown;
  public_safe?: unknown;
  overlay?: unknown;
  source_commit?: string;
}

export interface PruneSurfacesRow {
  subnet_netuid?: unknown;
  current_surfaces?: unknown;
  authority_scope?: string;
  source_commit?: string;
}

export interface DeleteSubnetRow {
  netuid?: unknown;
  source_commit?: string;
}

export interface RegistrySyncSummary {
  providers_written: number;
  subnets_written: number;
  surfaces_written: number;
  surfaces_deleted: number;
  subnets_deleted: number;
}

export interface RegistrySyncPayload {
  providers: ProviderSyncRow[];
  subnets: SubnetSyncRow[];
  surfaces: SurfaceSyncRow[];
  pruneSurfaces: PruneSurfacesRow[];
  deleteSubnets: DeleteSubnetRow[];
}

/** The slice of `pg`'s Client this uses, so a test can hand in a fake. */
export interface RegistryPgClient {
  /**
   * `unknown`, not `void`: `pg`'s own `connect()` resolves to the client, and
   * every caller here awaits it for the side effect and ignores the value. A
   * `void` return is not a superset of `Promise<Client>` inside a generic, so
   * declaring one made the real driver incompatible and forced
   * `new Client(...) as unknown as <Contract>` at the factory (#11339).
   */
  connect(): Promise<unknown>;
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
}

export interface RegistrySyncNeonDeps {
  clientFactory?: (connectionString: string) => RegistryPgClient;
  /** Injectable so a test can pin the id a fresh surface gets. */
  newId?: () => string;
}

const NOW_MS = "(EXTRACT(EPOCH FROM now()) * 1000)::bigint";

interface SurfaceRow {
  id?: unknown;
  subnet_netuid?: unknown;
  overlay?: unknown;
}

function overlayText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? {});
}

/**
 * Apply one sync payload to Neon, atomically.
 *
 * ONE transaction over ONE connection: reads and writes together, so the
 * history rows describe exactly the surfaces the same transaction deleted.
 * Any throw rolls the whole thing back, so a partial sync is not reachable.
 */
export async function applyRegistrySyncToNeon(
  connectionString: string,
  payload: RegistrySyncPayload,
  deps: RegistrySyncNeonDeps = {},
): Promise<RegistrySyncSummary> {
  const summary: RegistrySyncSummary = {
    providers_written: 0,
    subnets_written: 0,
    surfaces_written: 0,
    surfaces_deleted: 0,
    subnets_deleted: 0,
  };
  const client =
    deps.clientFactory?.(connectionString) ?? new Client({ connectionString });
  const newId = deps.newId ?? (() => crypto.randomUUID());

  await client.connect();
  try {
    await client.query("BEGIN");

    for (const p of payload.providers) {
      if (!p.id || !p.overlay || !p.source_commit) continue;
      await client.query(
        `INSERT INTO providers (id, overlay, source_commit, updated_at)
         VALUES ($1, $2, $3, ${NOW_MS})
         ON CONFLICT (id) DO UPDATE SET
           overlay = excluded.overlay,
           source_commit = excluded.source_commit,
           updated_at = ${NOW_MS}
         -- Postgres' IS DISTINCT FROM is what SQLite spelled IS NOT: the
         -- "only touch the row when the overlay actually changed" guard,
         -- NULL-safe in both.
         WHERE providers.overlay IS DISTINCT FROM excluded.overlay`,
        [p.id, JSON.stringify(p.overlay), p.source_commit],
      );
      summary.providers_written += 1;
    }

    const writtenSubnetNetuids = new Set<unknown>();
    for (const s of payload.subnets) {
      if (
        !Number.isInteger(s.netuid) ||
        !s.slug ||
        !s.name ||
        !s.overlay ||
        !s.source_commit
      )
        continue;
      await client.query(
        `INSERT INTO subnets (netuid, slug, name, source, overlay, source_commit, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, ${NOW_MS})
         ON CONFLICT (netuid) DO UPDATE SET
           slug = excluded.slug,
           name = excluded.name,
           source = excluded.source,
           overlay = excluded.overlay,
           source_commit = excluded.source_commit,
           updated_at = ${NOW_MS}`,
        [
          s.netuid,
          s.slug,
          s.name,
          s.source || "community",
          JSON.stringify(s.overlay),
          s.source_commit,
        ],
      );
      summary.subnets_written += 1;
      writtenSubnetNetuids.add(s.netuid);
    }

    for (const prune of payload.pruneSurfaces) {
      if (
        !Number.isInteger(prune.subnet_netuid) ||
        !Array.isArray(prune.current_surfaces) ||
        !prune.source_commit
      )
        continue;
      const keep = (prune.current_surfaces as { kind?: string; url?: string }[])
        .filter((s) => s?.kind && s?.url)
        .map((s) => ({ k: s.kind, u: s.url }));
      // ONE bound JSON array rather than two placeholders per kept surface --
      // the same reason the D1 version uses json_each, and it keeps the
      // statement text constant so the plan is reusable.
      const { rows } = await client.query(
        `SELECT id, subnet_netuid, overlay FROM surfaces
         WHERE subnet_netuid = $1
           AND ($2::int = 0 OR authority = 'community')
           AND NOT EXISTS (
             SELECT 1 FROM jsonb_array_elements($3::jsonb) AS keep(value)
             WHERE keep.value->>'k' = surfaces.kind
               AND keep.value->>'u' = surfaces.url
           )`,
        [
          prune.subnet_netuid,
          prune.authority_scope === "community" ? 1 : 0,
          JSON.stringify(keep),
        ],
      );
      const doomed = rows as SurfaceRow[];
      if (!doomed.length) continue;
      // By the exact ids just read, not by re-running the predicate: the
      // history rows below describe THESE rows. Inside one transaction this is
      // now belt-and-braces rather than load-bearing, which is the improvement
      // over the D1 shape.
      await client.query(
        `DELETE FROM surfaces WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb))`,
        [JSON.stringify(doomed.map((r) => r.id))],
      );
      await writeDeletionHistory(client, doomed, prune.source_commit);
      summary.surfaces_deleted += doomed.length;
    }

    for (const deletion of payload.deleteSubnets) {
      if (!Number.isInteger(deletion.netuid) || !deletion.source_commit)
        continue;
      if (writtenSubnetNetuids.has(deletion.netuid)) continue;
      const { rows } = await client.query(
        `SELECT id, subnet_netuid, overlay FROM surfaces WHERE subnet_netuid = $1`,
        [deletion.netuid],
      );
      const doomed = rows as SurfaceRow[];
      await client.query(`DELETE FROM surfaces WHERE subnet_netuid = $1`, [
        deletion.netuid,
      ]);
      await writeDeletionHistory(client, doomed, deletion.source_commit);
      await client.query(`DELETE FROM subnets WHERE netuid = $1`, [
        deletion.netuid,
      ]);
      summary.surfaces_deleted += doomed.length;
      summary.subnets_deleted += 1;
    }

    for (const surf of payload.surfaces) {
      if (
        !Number.isInteger(surf.subnet_netuid) ||
        !surf.surface_key ||
        !surf.kind ||
        !surf.url ||
        !surf.overlay ||
        !surf.source_commit
      )
        continue;
      const overlay = JSON.stringify(surf.overlay);
      const { rows } = await client.query(
        `SELECT id, overlay FROM surfaces WHERE subnet_netuid = $1 AND kind = $2 AND url = $3`,
        [surf.subnet_netuid, surf.kind, surf.url],
      );
      const existing = rows[0] as SurfaceRow | undefined;
      if (existing && existing.overlay === overlay) continue;
      const action = existing ? "update" : "insert";
      // HOISTED for the same reason as the D1 version: the audit row below has
      // to name the SAME surface, and computing this twice would mint a second
      // UUID per insert. Safe against the upsert because ON CONFLICT
      // (subnet_netuid, kind, url) keeps the existing row's id -- verified.
      const surfaceId = (existing?.id as string) ?? newId();
      await client.query(
        `INSERT INTO surfaces (
           id, subnet_netuid, provider_id, surface_key, kind, url,
           authority, review_state, probe_eligible, public_safe,
           overlay, source_commit, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, ${NOW_MS})
         ON CONFLICT (subnet_netuid, kind, url) DO UPDATE SET
           provider_id = excluded.provider_id,
           surface_key = excluded.surface_key,
           authority = excluded.authority,
           review_state = excluded.review_state,
           probe_eligible = excluded.probe_eligible,
           public_safe = excluded.public_safe,
           overlay = excluded.overlay,
           source_commit = excluded.source_commit,
           updated_at = ${NOW_MS}`,
        [
          surfaceId,
          surf.subnet_netuid,
          surf.provider_id ?? null,
          surf.surface_key,
          surf.kind,
          surf.url,
          surf.authority || "community",
          surf.review_state || "community-submitted",
          // Real booleans: these are BOOLEAN in Neon where D1 had 0/1 with a
          // CHECK constraint.
          Boolean(surf.probe_eligible),
          surf.public_safe !== false,
          overlay,
          surf.source_commit,
        ],
      );
      await client.query(
        `INSERT INTO surface_history (surface_id, subnet_netuid, action, overlay, source_commit, recorded_at)
         VALUES ($1, $2, $3, $4, $5, ${NOW_MS})`,
        [surfaceId, surf.subnet_netuid, action, overlay, surf.source_commit],
      );
      summary.surfaces_written += 1;
    }

    await client.query("COMMIT");
    return summary;
  } catch (error) {
    // Rollback is best-effort: if the connection is what failed, the
    // transaction is already gone, and masking the original error with the
    // rollback's would lose the only useful diagnostic.
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** One history row per surface a delete removed. Both delete paths need
 * exactly this, and the original Postgres version got it from DELETE ...
 * RETURNING. */
async function writeDeletionHistory(
  client: RegistryPgClient,
  rows: SurfaceRow[],
  sourceCommit: string,
): Promise<void> {
  for (const row of rows) {
    await client.query(
      `INSERT INTO surface_history (surface_id, subnet_netuid, action, overlay, source_commit, recorded_at)
       VALUES ($1, $2, 'delete', $3, $4, ${NOW_MS})`,
      [
        row.id ?? null,
        row.subnet_netuid ?? null,
        overlayText(row.overlay),
        sourceCommit,
      ],
    );
  }
}
