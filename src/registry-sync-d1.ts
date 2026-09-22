import type { ProducerStore, ProducerStatement } from "./producer-store.ts";
import type {
  RegistrySyncPayload,
  RegistrySyncSummary,
} from "./registry-sync-neon.ts";

export const REGISTRY_D1_TABLES = [
  "providers",
  "subnets",
  "surfaces",
  "surface_history",
] as const;
type Row = Record<string, unknown>;
const json = (field: string, source = "value") =>
  `json_extract(${source},'$.${field}')`;

function chunks(rows: Row[]): string[] {
  const result: string[] = [];
  let batch: Row[] = [],
    bytes = 2;
  for (const row of rows) {
    const size = new TextEncoder().encode(JSON.stringify(row)).length + 1;
    if (size > 524286)
      throw new RangeError("Registry row exceeds D1 payload budget");
    if (batch.length === 100 || bytes + size > 524288) {
      result.push(JSON.stringify(batch));
      batch = [];
      bytes = 2;
    }
    batch.push(row);
    bytes += size;
  }
  if (batch.length) result.push(JSON.stringify(batch));
  return result;
}

// LAG follows duplicate logical keys within a payload in delivery order. The
// first ID is stable for a new surface; an existing surface keeps its own ID.
// Both the history insert and final upsert read the same pre-mutation state in
// one transaction. A payload A -> B -> A still records both changes even though
// its final overlay equals the original.
const SURFACE_CHANGES = `WITH incoming AS (
 SELECT CAST(key AS INTEGER) seq,value,${json("subnet_netuid")} netuid,${json("kind")} kind,${json("url")} url FROM json_each(?)
), ordered AS (
 SELECT i.*,s.id existing_id,
 FIRST_VALUE(${json("id", "i.value")}) OVER(PARTITION BY i.netuid,i.kind,i.url ORDER BY seq) first_id,
 LAG(${json("overlay", "i.value")},1,s.overlay) OVER(PARTITION BY i.netuid,i.kind,i.url ORDER BY seq) previous_overlay,
 ROW_NUMBER() OVER(PARTITION BY i.netuid,i.kind,i.url ORDER BY seq) ordinal
 FROM incoming i LEFT JOIN surfaces s ON s.subnet_netuid=i.netuid AND s.kind=i.kind AND s.url=i.url
), changed AS (
 SELECT *,COALESCE(existing_id,first_id) surface_id FROM ordered WHERE ${json("overlay")} IS NOT previous_overlay
), ranked AS (
 SELECT *,ROW_NUMBER() OVER(PARTITION BY netuid,kind,url ORDER BY seq DESC) final_rank FROM changed
)`;
const PRUNED = `s.subnet_netuid=${json("netuid", "p.value")}
 AND (${json("community", "p.value")}=0 OR s.authority='community')
 AND NOT EXISTS(SELECT 1 FROM json_each(p.value,'$.keep') k WHERE ${json("k", "k.value")}=s.kind AND ${json("u", "k.value")}=s.url)`;

/** All registry mutations and their exact provenance commit in one D1 batch. */
export async function applyRegistrySyncToD1(
  store: ProducerStore,
  payload: RegistrySyncPayload,
  deps: { newId?: () => string; now?: () => number } = {},
): Promise<RegistrySyncSummary> {
  const now = (deps.now ?? Date.now)(),
    newId = deps.newId ?? (() => crypto.randomUUID());
  const statements: ProducerStatement[] = [];
  const counters: {
    index: number;
    field: "surfaces_written" | "surfaces_deleted";
  }[] = [];
  const summary: RegistrySyncSummary = {
    providers_written: 0,
    subnets_written: 0,
    surfaces_written: 0,
    surfaces_deleted: 0,
    subnets_deleted: 0,
  };
  function add(
    text: string,
    values: unknown[],
    field?: "surfaces_written" | "surfaces_deleted",
  ) {
    if (field) counters.push({ index: statements.length, field });
    statements.push({ text, values });
  }
  const providers = payload.providers
    .filter((p) => p.id && p.overlay && p.source_commit)
    .map((p) => ({
      id: p.id,
      overlay: JSON.stringify(p.overlay),
      source_commit: p.source_commit,
      updated_at: now,
    }));
  const subnets = payload.subnets
    .filter(
      (s) =>
        Number.isInteger(s.netuid) &&
        s.slug &&
        s.name &&
        s.overlay &&
        s.source_commit,
    )
    .map((s) => ({
      ...s,
      source: s.source || "community",
      overlay: JSON.stringify(s.overlay),
      updated_at: now,
    }));
  const written = new Set(subnets.map((s) => s.netuid));
  summary.providers_written = providers.length;
  summary.subnets_written = subnets.length;
  for (const batch of chunks(providers))
    add(
      `INSERT INTO providers(id,overlay,source_commit,updated_at)
   SELECT ${["id", "overlay", "source_commit", "updated_at"].map((c) => json(c)).join(",")} FROM json_each(?) WHERE true
   ON CONFLICT(id) DO UPDATE SET overlay=excluded.overlay,source_commit=excluded.source_commit,updated_at=excluded.updated_at
   WHERE providers.overlay IS NOT excluded.overlay`,
      [batch],
    );
  for (const batch of chunks(subnets))
    add(
      `INSERT INTO subnets(netuid,slug,name,source,overlay,source_commit,updated_at)
   SELECT ${["netuid", "slug", "name", "source", "overlay", "source_commit", "updated_at"].map((c) => json(c)).join(",")} FROM json_each(?) WHERE true
   ON CONFLICT(netuid) DO UPDATE SET slug=excluded.slug,name=excluded.name,source=excluded.source,overlay=excluded.overlay,source_commit=excluded.source_commit,updated_at=excluded.updated_at`,
      [batch],
    );
  function prune(rows: Row[]) {
    for (const batch of chunks(rows)) {
      add(
        `INSERT INTO surface_history(surface_id,subnet_netuid,action,overlay,source_commit,recorded_at)
       SELECT s.id,s.subnet_netuid,'delete',s.overlay,
        (SELECT ${json("commit", "p.value")} FROM json_each(?) p WHERE ${PRUNED} ORDER BY CAST(p.key AS INTEGER) LIMIT 1),?
       FROM surfaces s WHERE EXISTS(SELECT 1 FROM json_each(?) p WHERE ${PRUNED})`,
        [batch, now, batch],
      );
      add(
        `DELETE FROM surfaces AS s WHERE EXISTS(SELECT 1 FROM json_each(?) p WHERE ${PRUNED})`,
        [batch],
        "surfaces_deleted",
      );
    }
  }
  const prunes = payload.pruneSurfaces
    .filter(
      (p) =>
        Number.isInteger(p.subnet_netuid) &&
        Array.isArray(p.current_surfaces) &&
        p.source_commit,
    )
    .map((p) => ({
      netuid: p.subnet_netuid,
      community: p.authority_scope === "community" ? 1 : 0,
      commit: p.source_commit,
      keep: (p.current_surfaces as { kind?: string; url?: string }[])
        .filter((s) => s?.kind && s?.url)
        .map((s) => ({ k: s.kind, u: s.url })),
    }));
  prune(prunes);
  const deletions = payload.deleteSubnets
    .filter(
      (d) =>
        Number.isInteger(d.netuid) && d.source_commit && !written.has(d.netuid),
    )
    .map((d) => ({
      netuid: d.netuid,
      community: 0,
      keep: [],
      commit: d.source_commit,
    }));
  prune(deletions);
  summary.subnets_deleted = deletions.length;
  for (const batch of chunks(deletions))
    add(
      `DELETE FROM subnets WHERE netuid IN(SELECT ${json("netuid")} FROM json_each(?))`,
      [batch],
    );
  const surfaces = payload.surfaces
    .filter(
      (s) =>
        Number.isInteger(s.subnet_netuid) &&
        s.surface_key &&
        s.kind &&
        s.url &&
        s.overlay &&
        s.source_commit,
    )
    .map((s) => ({
      ...s,
      id: newId(),
      provider_id: s.provider_id ?? null,
      authority: s.authority || "community",
      review_state: s.review_state || "community-submitted",
      probe_eligible: Number(Boolean(s.probe_eligible)),
      public_safe: Number(s.public_safe !== false),
      overlay: JSON.stringify(s.overlay),
      updated_at: now,
    }));
  const columns = [
    "provider_id",
    "surface_key",
    "authority",
    "review_state",
    "probe_eligible",
    "public_safe",
    "overlay",
    "source_commit",
    "updated_at",
  ];
  for (const batch of chunks(surfaces)) {
    add(
      `${SURFACE_CHANGES} INSERT INTO surface_history(surface_id,subnet_netuid,action,overlay,source_commit,recorded_at)
     SELECT surface_id,netuid,CASE WHEN existing_id IS NULL AND ordinal=1 THEN 'insert' ELSE 'update' END,${json("overlay")},${json("source_commit")},? FROM changed ORDER BY seq`,
      [batch, now],
      "surfaces_written",
    );
    add(
      `${SURFACE_CHANGES} INSERT INTO surfaces(id,subnet_netuid,kind,url,${columns.join(",")})
     SELECT surface_id,netuid,kind,url,${columns.map((c) => json(c)).join(",")} FROM ranked WHERE final_rank=1
     ON CONFLICT(subnet_netuid,kind,url) DO UPDATE SET ${columns.map((c) => `${c}=excluded.${c}`).join(",")}`,
      [batch],
    );
  }
  if (statements.length > 900)
    throw new RangeError("Registry transaction exceeds D1 statement budget");
  const results = await store.transaction(statements);
  for (const { index, field } of counters)
    summary[field] += results[index].changes;
  return summary;
}
