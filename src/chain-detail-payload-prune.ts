import { selectedD1Store } from "./d1-store.ts";

/** Disabled until every reader uses a coherent chunk snapshot and old
 * invocations have drained. One bounded cursor pass runs under native prune. */
export async function pruneChainDetailPayloads(env: unknown): Promise<void> {
  if ((env as { CHAIN_DETAIL_PAYLOAD_GC?: string } | null)?.CHAIN_DETAIL_PAYLOAD_GC !== "enabled") return;
  const store = selectedD1Store(env, ["chain_detail_extrinsics", "chain_detail_chain_events"]);
  if (!store) return;
  const cursor = await store.first<{gc_after_sha256:string}>(
    "SELECT gc_after_sha256 FROM chain_detail_payload_budget WHERE id=1",
  );
  if (!cursor) throw new Error("Native payload reclamation budget missing");
  const candidates = await store.query<{sha256:string}>(
    "SELECT DISTINCT sha256 FROM chain_detail_payload_chunks WHERE sha256>? ORDER BY sha256 LIMIT 16",
    [cursor.gc_after_sha256],
  );
  const hashes = candidates.map((row) => row.sha256);
  const references = ([ ["chain_detail_extrinsics", "call_args"], ["chain_detail_chain_events", "args"] ] as const)
    .map(([table,field]) => `NOT EXISTS (SELECT 1 FROM ${table}
      WHERE substr(CAST(${field} AS BLOB),1,24)=X'006d657461677261706865643a7061796c6f61643a76313a'
        AND substr(CAST(${field} AS BLOB),-3)=X'3a6431'
        AND CAST(substr(CAST(${field} AS BLOB),25,64) AS TEXT)=chain_detail_payload_chunks.sha256)`).join(" AND ");
  await store.transaction([
    { text: `DELETE FROM chain_detail_payload_chunks WHERE sha256 IN (SELECT value FROM json_each(?))
        AND EXISTS (SELECT 1 FROM chain_detail_payload_budget WHERE id=1 AND gc_after_sha256=?)
        AND ${references}`, values: [JSON.stringify(hashes), cursor.gc_after_sha256] },
    { text: "UPDATE chain_detail_payload_budget SET gc_after_sha256=? WHERE id=1 AND gc_after_sha256=?",
      values: [hashes.at(-1) ?? "", cursor.gc_after_sha256] },
  ]);
}
