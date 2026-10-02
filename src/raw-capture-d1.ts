import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { gzipSync } from "node:zlib";
import type { RawCaptureStore } from "./raw-chain-capture.ts";

const CHUNK = 65_536;
const MAX_RAW = 32 * 1024 * 1024;
const KEY = /^chain\/raw\/(testnet\/)?blocks\/(\d{12})-(\d{12})\.ndjson$/;
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const PUBLICATION =
  "SELECT sha256 FROM (SELECT b.sha256 FROM raw_capture_batches b JOIN raw_capture_publications p USING(key,sha256) WHERE b.key=? AND b.sha256=? AND b.complete=1 UNION ALL SELECT a.sha256 FROM raw_capture_archives a JOIN raw_capture_publications p USING(key,sha256) WHERE a.key=? AND a.sha256=? AND a.complete=1 AND a.native_sha256=a.compressed_sha256 AND a.native_key='chain/raw/native/v1/'||a.network||'/'||a.sha256||'/'||a.compressed_sha256||'.gz') LIMIT 1";
type Db = Pick<D1Database, "prepare" | "batch">;

/** Hash every original byte except each top-level captured_at numeric token. */
function chainPayloadHash(value: string, rows: string[]): string {
  const digest = createHash("sha256");
  let rowStart = 0,
    hashedThrough = 0;
  for (const line of rows) {
    let depth = 0;
    let provenance: { start: number; end: number } | undefined;
    // JSON.parse already validated this row. Skip quoted strings as a whole,
    // including escaped quotes, so nested fields and SCALE/header bytes cannot
    // be mistaken for the one top-level provenance key. Parse key strings only;
    // never round or reserialize another payload field.
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === "{" || char === "[") depth++;
      else if (char === "}" || char === "]") depth--;
      else if (char === '"') {
        const start = i;
        for (;;) {
          i = line.indexOf('"', i + 1);
          let slashes = 0;
          for (let j = i - 1; line[j] === "\\"; j--) slashes++;
          if (slashes % 2 === 0) break;
        }
        if (
          depth !== 1 ||
          JSON.parse(line.slice(start, i + 1)) !== "captured_at"
        )
          continue;
        const colon = /^\s*:\s*/.exec(line.slice(i + 1));
        if (!colon) continue;
        const tokenStart = i + 1 + colon[0].length;
        const number = /^[0-9.eE+-]+/.exec(line.slice(tokenStart));
        if (provenance || !number)
          throw new Error("Raw capture provenance is ambiguous");
        provenance = { start: tokenStart, end: tokenStart + number[0].length };
      }
    }
    // The validated safe-integer field necessarily supplied this numeric token.
    digest.update(value.slice(hashedThrough, rowStart + provenance!.start));
    digest.update("0");
    hashedThrough = rowStart + provenance!.end;
    rowStart += line.length + 1;
  }
  return digest.update(value.slice(hashedThrough)).digest("hex");
}

/** Keep exact SCALE bytes in bounded D1 chunks; never acknowledge a partial batch. */
export function rawCaptureD1(db: Db): RawCaptureStore {
  return {
    async put(key, value) {
      const match = KEY.exec(key);
      if (!match || typeof value !== "string" || !value.endsWith("\n"))
        throw new Error("Invalid raw capture object");
      const first = Number(match[2]),
        last = Number(match[3]);
      const raw = Buffer.from(value);
      if (
        !raw.length ||
        raw.length > MAX_RAW ||
        last < first ||
        last - first >= 4096
      )
        throw new Error("Raw capture exceeds its storage budget");
      const rows = value.trimEnd().split("\n");
      let capturedAt = 0;
      if (rows.length !== last - first + 1)
        throw new Error("Raw capture range differs from its records");
      for (let index = 0; index < rows.length; index++) {
        const row = JSON.parse(rows[index]!);
        if (
          row?.block_number !== first + index ||
          !Number.isSafeInteger(row.captured_at) ||
          row.captured_at <= 0
        )
          throw new Error("Raw capture identity differs");
        capturedAt = Math.max(capturedAt, row.captured_at);
      }
      const chainDigest = chainPayloadHash(value, rows);
      const compressed = gzipSync(raw, { level: 6 });
      // The reservation's compressed_bytes/parts CHECKs enforce the compressed
      // budget before any chunk is written; the input bound caps compression.
      const digest = hash(raw),
        compressedDigest = hash(compressed);
      const parts = Math.ceil(compressed.length / CHUNK);
      const network = match[1] ? "testnet" : "mainnet";
      const descriptor = {
        key,
        sha256: digest,
        network,
        first_block: first,
        last_block: last,
        raw_bytes: raw.length,
        compressed_bytes: compressed.length,
        compressed_sha256: compressedDigest,
        parts,
        captured_at: capturedAt,
      };
      const values = Object.values(descriptor);
      // Reads and immutable writes replay the same pinned capture. Allow one
      // delayed transient-storage retry per object; every existing readback still
      // has to pass before the caller can advance its watermark.
      let retried = false;
      const retry = async <T>(operation: () => Promise<T>): Promise<T> => {
        try {
          return await operation();
        } catch (error) {
          if (
            retried ||
            !(error instanceof Error) ||
            !/^(?:D1_ERROR: )?(?:Network connection lost\.|Replica disconnected from primary\.|D1 DB reset because its code was updated\.|Internal error (?:while starting up|in) D1 DB storage caused object to be reset\.|Cannot resolve D1 DB due to transient issue on remote node\.|internal error; reference = e_[A-Za-z0-9_-]+)$/.test(
              error.message,
            )
          )
            throw error;
          retried = true;
          await new Promise((resolve) =>
            setTimeout(resolve, 250 + Math.floor(Math.random() * 250)),
          );
          return operation();
        }
      };
      const archived = await retry(() =>
        db
          .prepare(
            "SELECT * FROM raw_capture_archives WHERE key=? AND sha256=?",
          )
          .bind(key, digest)
          .first<Record<string, string | number>>(),
      );
      if (archived) {
        // The archive consumer records this identity only after independent
        // native-byte verification, atomically releasing the staging chunks.
        if (
          Object.entries(descriptor).some(([k, v]) => archived[k] !== v) ||
          archived.complete !== 1 ||
          archived.native_sha256 !== compressedDigest ||
          archived.native_key !==
            `chain/raw/native/v1/${network}/${digest}/${compressedDigest}.gz`
        )
          throw new Error("Raw capture archive identity differs");
        const current = await retry(() =>
          db
            .prepare(PUBLICATION)
            .bind(key, digest, key, digest)
            .first<{ sha256: string }>(),
        );
        if (current?.sha256 !== digest)
          throw new Error("Raw capture selection was not acknowledged");
        return;
      }
      await retry(() =>
        db
          .prepare(
            "INSERT INTO raw_capture_batches(key,sha256,network,first_block,last_block,raw_bytes,compressed_bytes,compressed_sha256,parts,captured_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(key,sha256) DO NOTHING",
          )
          .bind(...values)
          .run(),
      );
      const selected = await retry(() =>
        db
          .prepare(
            "SELECT key,sha256,network,first_block,last_block,raw_bytes,compressed_bytes,compressed_sha256,parts,captured_at FROM raw_capture_batches WHERE key=? AND sha256=?",
          )
          .bind(key, digest)
          .first<Record<string, string | number>>(),
      );
      if (
        !selected ||
        Object.entries(descriptor).some(([k, v]) => selected[k] !== v)
      )
        throw new Error("Raw capture reservation readback differs");

      // Eight chunks keep every request and response below one MiB. Replaying
      // immutable inserts after an unknown response cannot select partial data.
      for (let start = 0; start < parts; start += 8) {
        const count = Math.min(8, parts - start);
        const chunks = Array.from({ length: count }, (_, i) =>
          compressed.subarray((start + i) * CHUNK, (start + i + 1) * CHUNK),
        );
        await retry(() =>
          db
            .prepare(
              "INSERT INTO raw_capture_chunks(key,sha256,part,data) VALUES " +
                chunks.map(() => "(?,?,?,?)").join(",") +
                " ON CONFLICT(key,sha256,part) DO NOTHING",
            )
            .bind(
              ...chunks.flatMap((chunk, i) => [
                key,
                digest,
                start + i,
                Uint8Array.from(chunk).buffer,
              ]),
            )
            .run(),
        );
        const readback = await retry(() =>
          db
            .prepare(
              "SELECT part,hex(data) AS data FROM raw_capture_chunks WHERE key=? AND sha256=? AND part>=? AND part<? ORDER BY part",
            )
            .bind(key, digest, start, start + count)
            .all<{ part: number; data: string }>(),
        );
        if (readback.results.length !== chunks.length)
          throw new Error("Raw capture chunk census differs");
        for (let i = 0; i < chunks.length; i++) {
          const hex = readback.results[i]?.data;
          if (
            readback.results[i]?.part !== start + i ||
            typeof hex !== "string" ||
            hex !== chunks[i]!.toString("hex").toUpperCase()
          )
            throw new Error("Raw capture chunk readback differs");
        }
      }
      // Every ordered stored chunk matched the compressed source byte-for-byte.
      // Hashing those same bytes again and inflating the local compression adds
      // no storage verification. Independent raw reconstruction remains in the
      // archive consumer before it can release any staging bytes.
      // Completion, selection and its immutable receipt share one transaction.
      // A receipt pins the selected version that acknowledged these exact bytes:
      // either this version won selection, or its complete chain payload matched
      // an already acknowledged selection byte-for-byte apart from provenance.
      // A conflicting or unproven version receives no receipt. Both original
      // captures stay intact, and receipts survive supersession and archival.
      let publicationStarted = false;
      await retry(async () => {
        // A lost transaction reply may already have a durable receipt, even
        // after native archival released all staging. Confirm it before replay:
        // source chunks no longer exist after that successful handoff.
        if (publicationStarted) {
          const committed = await db
            .prepare(PUBLICATION)
            .bind(key, digest, key, digest)
            .first<{ sha256: string }>();
          if (committed) {
            if (committed.sha256 !== digest)
              throw new Error("Raw capture selection was not acknowledged");
            return;
          }
        }
        publicationStarted = true;
        await db.batch([
          db
            .prepare(
              "UPDATE raw_capture_batches SET complete=1 WHERE key=? AND sha256=? AND parts=(SELECT count(*) FROM raw_capture_chunks WHERE key=? AND sha256=?) AND compressed_bytes=(SELECT sum(length(data)) FROM raw_capture_chunks WHERE key=? AND sha256=?)",
            )
            .bind(key, digest, key, digest, key, digest),
          db
            .prepare(
              "INSERT INTO raw_capture_selected(key,sha256,network,last_block,captured_at) SELECT key,sha256,network,last_block,captured_at FROM raw_capture_batches b WHERE key=? AND sha256=? AND complete=1 AND NOT EXISTS(SELECT 1 FROM raw_capture_archives a WHERE a.key=b.key AND a.selected=1 AND a.sha256<>b.sha256 AND a.captured_at>=b.captured_at) ON CONFLICT(key) DO UPDATE SET sha256=excluded.sha256,network=excluded.network,last_block=excluded.last_block,captured_at=excluded.captured_at WHERE raw_capture_selected.captured_at<excluded.captured_at OR raw_capture_selected.sha256=excluded.sha256",
            )
            .bind(key, digest),
          db
            .prepare(
              "INSERT INTO raw_capture_publications(key,sha256,selected_sha256,chain_sha256) SELECT b.key,b.sha256,c.sha256,? FROM raw_capture_batches b JOIN (SELECT s.key,s.sha256,s.captured_at FROM raw_capture_selected s JOIN raw_capture_batches r USING(key,sha256) WHERE s.key=? AND r.complete=1 UNION ALL SELECT key,sha256,captured_at FROM raw_capture_archives WHERE key=? AND selected=1 AND complete=1 AND native_sha256=compressed_sha256 AND native_key='chain/raw/native/v1/'||network||'/'||sha256||'/'||compressed_sha256||'.gz' ORDER BY captured_at DESC LIMIT 1) c ON c.key=b.key LEFT JOIN raw_capture_publications p ON p.key=c.key AND p.sha256=c.sha256 WHERE b.key=? AND b.sha256=? AND b.complete=1 AND (c.sha256=b.sha256 OR p.chain_sha256=?) ON CONFLICT(key,sha256) DO NOTHING",
            )
            .bind(chainDigest, key, key, key, digest, chainDigest),
        ]);
      });
      const receipt = await retry(() =>
        db
          .prepare(PUBLICATION)
          .bind(key, digest, key, digest)
          .first<{ sha256: string }>(),
      );
      if (receipt?.sha256 !== digest)
        throw new Error("Raw capture selection was not acknowledged");
    },
  };
}
