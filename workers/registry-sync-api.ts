// metagraphed registry-sync Worker — the ONLY write path into the registry
// Postgres instance (a dedicated, separate database from the chain-indexer's
// -- see deploy/postgres/registry-schema.sql). Kept SEPARATE from the main
// api.mjs Worker and from workers/data-api.mjs (which is READ-ONLY by design
// for chain data) for the same bundle-budget reason ADR 0013 already split
// data-api.mjs out: the postgres.js driver shouldn't grow every Worker that
// merely proxies to it.
//
// Reached only via the main Worker's REGISTRY_SYNC_API service binding (no
// public routes of its own) -- see workers/api.mjs's handleRegistrySyncProxy,
// which forwards the request here unchanged. This Worker's shared-secret
// check below is the only auth gate in the whole path.
//
// This is the write path scripts/sync-registry-to-postgres.mjs (merge-
// triggered) and scripts/backfill-registry-postgres.mjs (scheduled full
// resync) call over HTTPS from GitHub Actions -- there is no Tailscale, SSH,
// or direct network path from CI to the database at all. GitHub Actions
// only ever needs a REGISTRY_SYNC_SECRET value and the public HTTPS
// endpoint; the database itself stays exactly as private as it already was
// (bound to 127.0.0.1 on its host, reachable only via the Cloudflare Tunnel
// + Workers VPC Service + Hyperdrive path already proven for reads).
import postgres from "postgres";
import { timingSafeEqual } from "../src/webhooks.mjs";
import { resolveClientIp } from "./config.mjs";

const TOKEN_HEADER = "x-registry-sync-token";
const MAX_BODY_BYTES = 4_194_304; // 4 MiB -- the full registry is ~1.5k surfaces, comfortably under this
const MAX_ROWS_PER_KIND = 5_000;
// Per-caller abuse control (#5548) -- see wrangler.registry.jsonc's
// REGISTRY_SYNC_RATE_LIMITER comment for why 30/60s rather than the tighter
// 10/60s used by other shared-secret write routes.
const RATE_LIMIT = { limit: 30, windowSeconds: 60 };

interface ProviderSyncRow {
  id?: string;
  overlay?: unknown;
  source_commit?: string;
}
interface SubnetSyncRow {
  netuid?: unknown;
  slug?: string;
  name?: string;
  source?: string;
  overlay?: unknown;
  source_commit?: string;
}
interface PruneSurfacesRow {
  subnet_netuid?: unknown;
  current_surfaces?: unknown;
  source_commit?: string;
  authority_scope?: string;
}
interface DeleteSubnetRow {
  netuid?: unknown;
  source_commit?: string;
}
interface SurfaceSyncRow {
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

function json(
  data: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

function isValidRow(row: unknown): row is Record<string, unknown> {
  return Boolean(row) && typeof row === "object" && !Array.isArray(row);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return json({ error: "method not allowed" }, 405);
    }
    if (!env.REGISTRY_SYNC_SECRET) {
      return json(
        { error: "registry sync is not provisioned on this deployment" },
        503,
      );
    }
    const provided = request.headers.get(TOKEN_HEADER) || "";
    if (!provided || !timingSafeEqual(provided, env.REGISTRY_SYNC_SECRET)) {
      return json({ error: `provide a valid ${TOKEN_HEADER} header` }, 401);
    }
    // Rate-limit AFTER auth so an unauthenticated caller is rejected without
    // consuming limiter budget. Optional-chained so it's a no-op when the
    // binding is absent (local dev/CI).
    if (env.REGISTRY_SYNC_RATE_LIMITER?.limit) {
      const { success } = await env.REGISTRY_SYNC_RATE_LIMITER.limit({
        key: resolveClientIp(request),
      });
      if (!success) {
        return json(
          { error: "too many registry sync requests; slow down" },
          429,
          {
            "retry-after": String(RATE_LIMIT.windowSeconds),
            "x-ratelimit-limit": String(RATE_LIMIT.limit),
            "x-ratelimit-policy": `${RATE_LIMIT.limit};w=${RATE_LIMIT.windowSeconds}`,
            "x-ratelimit-remaining": "0",
          },
        );
      }
    }
    if (!env.HYPERDRIVE?.connectionString) {
      return json({ error: "hyperdrive binding unavailable" }, 503);
    }

    const raw = await request.text();
    if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
      return json({ error: `body exceeds ${MAX_BODY_BYTES} bytes` }, 413);
    }
    let body: {
      subnets?: unknown;
      providers?: unknown;
      surfaces?: unknown;
      prune_surfaces?: unknown;
      delete_subnets?: unknown;
    };
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ error: "body must be JSON" }, 400);
    }
    const subnets: SubnetSyncRow[] = Array.isArray(body?.subnets)
      ? body.subnets
      : [];
    const providers: ProviderSyncRow[] = Array.isArray(body?.providers)
      ? body.providers
      : [];
    const surfaces: SurfaceSyncRow[] = Array.isArray(body?.surfaces)
      ? body.surfaces
      : [];
    const pruneSurfaces: PruneSurfacesRow[] = Array.isArray(
      body?.prune_surfaces,
    )
      ? body.prune_surfaces
      : [];
    const deleteSubnets: DeleteSubnetRow[] = Array.isArray(
      body?.delete_subnets,
    )
      ? body.delete_subnets
      : [];
    const rowGroups: Array<[string, unknown[]]> = [
      ["subnets", subnets],
      ["providers", providers],
      ["surfaces", surfaces],
      ["prune_surfaces", pruneSurfaces],
      ["delete_subnets", deleteSubnets],
    ];
    for (const [name, rows] of rowGroups) {
      if (rows.length > MAX_ROWS_PER_KIND) {
        return json(
          { error: `at most ${MAX_ROWS_PER_KIND} ${name} rows per request` },
          413,
        );
      }
      if (!rows.every(isValidRow)) {
        return json({ error: `${name} must be an array of row objects` }, 400);
      }
    }
    if (
      !subnets.length &&
      !providers.length &&
      !surfaces.length &&
      !pruneSurfaces.length &&
      !deleteSubnets.length
    ) {
      return json({ error: "no rows provided" }, 400);
    }

    const sql = postgres(env.HYPERDRIVE.connectionString, {
      max: 5,
      prepare: false,
      fetch_types: false,
    });

    const summary = {
      providers_written: 0,
      subnets_written: 0,
      surfaces_written: 0,
      surfaces_deleted: 0,
      subnets_deleted: 0,
    };
    try {
      // sql.begin() reserves ONE physical connection for the whole batch,
      // including the SET -- Hyperdrive resets session state when a
      // connection is returned to its pool, so a bare SET (no transaction)
      // has no guarantee it applies to the writes that follow it (Hyperdrive's
      // connection-lifecycle docs; same root cause as #4686). This also makes
      // the batch atomic: previously a mid-batch failure left whatever had
      // already been written committed and the rest silently never applied,
      // a partial-sync state with no way to tell it happened; now the whole
      // batch commits together or rolls back together.
      return await sql.begin(async (sql) => {
        await sql`SET statement_timeout = '10000ms'`;

        for (const p of providers) {
          if (!p.id || !p.overlay || !p.source_commit) continue;
          await sql`
          INSERT INTO providers (id, overlay, source_commit)
          VALUES (${p.id}, ${sql.json(p.overlay as postgres.JSONValue)}, ${p.source_commit})
          ON CONFLICT (id) DO UPDATE SET
            overlay = EXCLUDED.overlay,
            source_commit = EXCLUDED.source_commit,
            updated_at = now()
          WHERE providers.overlay IS DISTINCT FROM EXCLUDED.overlay`;
          summary.providers_written += 1;
        }

        const writtenSubnetNetuids = new Set();
        for (const s of subnets) {
          if (
            !Number.isInteger(s.netuid) ||
            !s.slug ||
            !s.name ||
            !s.overlay ||
            !s.source_commit
          )
            continue;
          await sql`
          INSERT INTO subnets (netuid, slug, name, source, overlay, source_commit)
          VALUES (${s.netuid as number}, ${s.slug}, ${s.name}, ${s.source || "community"}, ${sql.json(s.overlay as postgres.JSONValue)}, ${s.source_commit})
          ON CONFLICT (netuid) DO UPDATE SET
            slug = EXCLUDED.slug,
            name = EXCLUDED.name,
            source = EXCLUDED.source,
            overlay = EXCLUDED.overlay,
            source_commit = EXCLUDED.source_commit,
            updated_at = now()`;
          summary.subnets_written += 1;
          writtenSubnetNetuids.add(s.netuid);
        }

        for (const prune of pruneSurfaces) {
          if (
            !Number.isInteger(prune.subnet_netuid) ||
            !Array.isArray(prune.current_surfaces) ||
            !prune.source_commit
          )
            continue;
          const keepPairs = prune.current_surfaces
            .filter((surface) => surface?.kind && surface?.url)
            .map((surface) => [surface.kind, surface.url]);
          // `authority_scope: "community"` (set by the merge-triggered fast path,
          // scripts/sync-registry-to-postgres.mjs) bounds this prune to ONLY the
          // community-authority rows for the subnet -- the fast path's
          // current_surfaces comes from a single registry/subnets/<slug>.json file
          // and has no visibility into machine-generated/candidate-promoted
          // surfaces (authority: "registry-observed") the same subnet may also
          // carry, so without this scope it would delete those rows on every
          // merge that touches the file. The scheduled full resync
          // (scripts/backfill-registry-postgres.mjs) computes current_surfaces
          // from the complete baseline-augmented view and omits authority_scope,
          // so it keeps pruning across every authority as before.
          const scopeToCommunity = prune.authority_scope === "community";
          let deleted;
          if (keepPairs.length) {
            // Plain scalar positional binds via sql.unsafe, NOT a bound JS
            // array -- Hyperdrive's fetch_types:false breaks postgres.js's
            // ANY($1)/array serialization (confirmed live 2026-07-10, #4771's
            // identical fix to data-api.mjs's neurons-sync prune; this query
            // shipped the same broken ANY(${keepKeys}) pattern in #3892 three
            // days earlier and was never ported). A bound array here sends a
            // malformed literal with no braces, 502'ing every write that
            // pruned against a non-empty current_surfaces list. Matches
            // (kind, url) pairs directly via a VALUES join instead of a
            // synthetic separator-joined key.
            const valuesSql = keepPairs
              .map((_, i) => `($${i * 2 + 3}::text, $${i * 2 + 4}::text)`)
              .join(", ");
            deleted = await sql.unsafe(
              `DELETE FROM surfaces
              WHERE subnet_netuid = $2::int
                AND (NOT $1::boolean OR authority = 'community')
                AND NOT EXISTS (
                  SELECT 1 FROM (VALUES ${valuesSql}) AS keep(kind, url)
                  WHERE keep.kind = surfaces.kind AND keep.url = surfaces.url
                )
              RETURNING id, subnet_netuid, overlay`,
              [scopeToCommunity, prune.subnet_netuid, ...keepPairs.flat()],
            );
          } else {
            deleted = await sql`
              DELETE FROM surfaces
              WHERE subnet_netuid = ${prune.subnet_netuid as number}
                AND (NOT ${scopeToCommunity} OR authority = ${"community"})
              RETURNING id, subnet_netuid, overlay`;
          }
          for (const row of deleted) {
            await sql`
            INSERT INTO surface_history (surface_id, subnet_netuid, action, overlay, source_commit)
            VALUES (${row.id}, ${row.subnet_netuid}, ${"delete"}, ${sql.json(row.overlay)}, ${prune.source_commit})`;
            summary.surfaces_deleted += 1;
          }
        }

        for (const deletion of deleteSubnets) {
          if (!Number.isInteger(deletion.netuid) || !deletion.source_commit)
            continue;
          if (writtenSubnetNetuids.has(deletion.netuid)) continue;
          const deletedSurfaces = await sql`
          DELETE FROM surfaces
          WHERE subnet_netuid = ${deletion.netuid as number}
          RETURNING id, subnet_netuid, overlay`;
          for (const row of deletedSurfaces) {
            await sql`
            INSERT INTO surface_history (surface_id, subnet_netuid, action, overlay, source_commit)
            VALUES (${row.id}, ${row.subnet_netuid}, ${"delete"}, ${sql.json(row.overlay)}, ${deletion.source_commit})`;
            summary.surfaces_deleted += 1;
          }
          const deletedSubnets = await sql`
          DELETE FROM subnets
          WHERE netuid = ${deletion.netuid as number}
          RETURNING netuid`;
          summary.subnets_deleted += deletedSubnets.length;
        }

        for (const surf of surfaces) {
          if (
            !Number.isInteger(surf.subnet_netuid) ||
            !surf.surface_key ||
            !surf.kind ||
            !surf.url ||
            !surf.overlay ||
            !surf.source_commit
          )
            continue;
          const result = await sql`
          INSERT INTO surfaces (
            subnet_netuid, provider_id, surface_key, kind, url,
            authority, review_state, probe_eligible, public_safe,
            overlay, source_commit
          )
          VALUES (
            ${surf.subnet_netuid as number}, ${surf.provider_id ?? null}, ${surf.surface_key}, ${surf.kind}, ${surf.url},
            ${surf.authority || "community"}, ${surf.review_state || "community-submitted"},
            ${Boolean(surf.probe_eligible)}, ${surf.public_safe !== false},
            ${sql.json(surf.overlay as postgres.JSONValue)}, ${surf.source_commit}
          )
          ON CONFLICT (subnet_netuid, kind, url) DO UPDATE SET
            provider_id = EXCLUDED.provider_id,
            surface_key = EXCLUDED.surface_key,
            authority = EXCLUDED.authority,
            review_state = EXCLUDED.review_state,
            probe_eligible = EXCLUDED.probe_eligible,
            public_safe = EXCLUDED.public_safe,
            overlay = EXCLUDED.overlay,
            source_commit = EXCLUDED.source_commit,
            updated_at = now()
          WHERE surfaces.overlay IS DISTINCT FROM EXCLUDED.overlay
          RETURNING (xmax = 0) AS inserted`;
          if (result.length) {
            const action = result[0].inserted ? "insert" : "update";
            await sql`
            INSERT INTO surface_history (subnet_netuid, action, overlay, source_commit)
            VALUES (${surf.subnet_netuid as number}, ${action}, ${sql.json(surf.overlay as postgres.JSONValue)}, ${surf.source_commit})`;
            summary.surfaces_written += 1;
          }
        }

        return json({ ok: true, ...summary });
      });
    } catch (err) {
      console.error("registry-sync-api write failed:", err);
      return json({ error: "write failed" }, 502);
    }
    // No sql.end() here: Hyperdrive automatically cleans up the connection
    // when the request/invocation ends (Cloudflare's documented pattern) --
    // the previous await sql.end(...) was undocumented, unnecessary extra
    // work that also delayed every response by however long teardown took.
  },
};
