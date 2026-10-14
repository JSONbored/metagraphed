// Exact selector/receipt SQL from prior runtime de41e2eaca02e8f224c3eb333b6850f3a438c239.
// This intentionally bypasses the NEW store.put's application-level guard.
const priorSelectorSql =
  "INSERT INTO raw_capture_selected(key,sha256,network,last_block,captured_at) SELECT key,sha256,network,last_block,captured_at FROM raw_capture_batches b WHERE key=? AND sha256=? AND complete=1 AND NOT EXISTS(SELECT 1 FROM raw_capture_archives a WHERE a.key=b.key AND a.selected=1 AND a.sha256<>b.sha256 AND a.captured_at>=b.captured_at) ON CONFLICT(key) DO UPDATE SET sha256=excluded.sha256,network=excluded.network,last_block=excluded.last_block,captured_at=excluded.captured_at WHERE raw_capture_selected.captured_at<excluded.captured_at OR raw_capture_selected.sha256=excluded.sha256";
const priorPublicationSql =
  "INSERT INTO raw_capture_publications(key,sha256,selected_sha256,chain_sha256) SELECT b.key,b.sha256,c.sha256,? FROM raw_capture_batches b JOIN (SELECT s.key,s.sha256,s.captured_at FROM raw_capture_selected s JOIN raw_capture_batches r USING(key,sha256) WHERE s.key=? AND r.complete=1 UNION ALL SELECT key,sha256,captured_at FROM raw_capture_archives WHERE key=? AND selected=1 AND complete=1 AND native_sha256=compressed_sha256 AND native_key='chain/raw/native/v1/'||network||'/'||sha256||'/'||compressed_sha256||'.gz' ORDER BY captured_at DESC LIMIT 1) c ON c.key=b.key LEFT JOIN raw_capture_publications p ON p.key=c.key AND p.sha256=c.sha256 WHERE b.key=? AND b.sha256=? AND b.complete=1 AND (c.sha256=b.sha256 OR p.chain_sha256=?) ON CONFLICT(key,sha256) DO NOTHING";
export async function priorPublication(
  db: D1Database,
  key: string,
  digest: string,
) {
  return db.batch([
    db
      .prepare(
        "UPDATE raw_capture_batches SET complete=1 WHERE key=? AND sha256=? AND parts=(SELECT count(*) FROM raw_capture_chunks WHERE key=? AND sha256=?) AND compressed_bytes=(SELECT sum(length(data)) FROM raw_capture_chunks WHERE key=? AND sha256=?)",
      )
      .bind(key, digest, key, digest, key, digest),
    db.prepare(priorSelectorSql).bind(key, digest),
    db
      .prepare(priorPublicationSql)
      .bind("f".repeat(64), key, key, key, digest, "f".repeat(64)),
  ]);
}
