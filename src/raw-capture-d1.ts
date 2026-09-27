import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { gzipSync, gunzipSync } from "node:zlib";
import type { RawCaptureStore } from "./raw-chain-capture.ts";

const CHUNK = 65_536;
const MAX_RAW = 32 * 1024 * 1024;
const KEY = /^chain\/raw\/(testnet\/)?blocks\/(\d{12})-(\d{12})\.ndjson$/;
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
type Db = Pick<D1Database, "prepare" | "batch">;

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
      const compressed = gzipSync(raw, { level: 6 });
      if (compressed.length > MAX_RAW + CHUNK)
        throw new Error("Compressed raw capture exceeds its storage budget");
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
      await db
        .prepare(
          "INSERT INTO raw_capture_batches(key,sha256,network,first_block,last_block,raw_bytes,compressed_bytes,compressed_sha256,parts,captured_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(key,sha256) DO NOTHING",
        )
        .bind(...values)
        .run();
      const selected = await db
        .prepare(
          "SELECT key,sha256,network,first_block,last_block,raw_bytes,compressed_bytes,compressed_sha256,parts,captured_at FROM raw_capture_batches WHERE key=? AND sha256=?",
        )
        .bind(key, digest)
        .first<Record<string, string | number>>();
      if (
        !selected ||
        Object.entries(descriptor).some(([k, v]) => selected[k] !== v)
      )
        throw new Error("Raw capture reservation readback differs");

      const verified = createHash("sha256");
      // Eight chunks keep every request and response below one MiB. Replaying
      // immutable inserts after an unknown response cannot select partial data.
      for (let start = 0; start < parts; start += 8) {
        const count = Math.min(8, parts - start);
        const chunks = Array.from({ length: count }, (_, i) =>
          compressed.subarray((start + i) * CHUNK, (start + i + 1) * CHUNK),
        );
        await db
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
          .run();
        const readback = await db
          .prepare(
            "SELECT part,hex(data) AS data FROM raw_capture_chunks WHERE key=? AND sha256=? AND part>=? AND part<? ORDER BY part",
          )
          .bind(key, digest, start, start + count)
          .all<{ part: number; data: string }>();
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
          verified.update(Buffer.from(hex, "hex"));
        }
      }
      if (
        verified.digest("hex") !== compressedDigest ||
        !gunzipSync(compressed, { maxOutputLength: MAX_RAW }).equals(raw)
      )
        throw new Error("Raw capture reconstruction differs");
      // Mark complete and publish the pointer atomically. A newer capture of
      // the same finalized range cannot be replaced by an older invocation.
      await db.batch([
        db
          .prepare(
            "UPDATE raw_capture_batches SET complete=1 WHERE key=? AND sha256=? AND parts=(SELECT count(*) FROM raw_capture_chunks WHERE key=? AND sha256=?) AND compressed_bytes=(SELECT sum(length(data)) FROM raw_capture_chunks WHERE key=? AND sha256=?)",
          )
          .bind(key, digest, key, digest, key, digest),
        db
          .prepare(
            "INSERT INTO raw_capture_selected(key,sha256,network,last_block,captured_at) SELECT key,sha256,network,last_block,captured_at FROM raw_capture_batches WHERE key=? AND sha256=? AND complete=1 ON CONFLICT(key) DO UPDATE SET sha256=excluded.sha256,network=excluded.network,last_block=excluded.last_block,captured_at=excluded.captured_at WHERE raw_capture_selected.captured_at<excluded.captured_at OR raw_capture_selected.sha256=excluded.sha256",
          )
          .bind(key, digest),
      ]);
      const receipt = await db
        .prepare("SELECT sha256 FROM raw_capture_selected WHERE key=?")
        .bind(key)
        .first<{ sha256: string }>();
      if (receipt?.sha256 !== digest)
        throw new Error("Raw capture selection was not acknowledged");
    },
  };
}
