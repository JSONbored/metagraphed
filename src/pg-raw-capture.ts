import { Buffer } from "node:buffer";
import type { NativeSource } from "./native-api-process.ts";
import type { PgTransaction } from "./pg-pool.ts";
import type { NativeRawCapture } from "./native-raw-capture.ts";
import {
  prepareRawCapture,
  RAW_CAPTURE_CHUNK_BYTES,
} from "./raw-capture-object.ts";

const TABLES = [
  "raw_capture_budget",
  "raw_capture_batches",
  "raw_capture_chunks",
  "raw_capture_selected",
  "raw_capture_archives",
  "raw_capture_state",
] as const;
type Descriptor = ReturnType<typeof prepareRawCapture>["descriptor"];
type StoredCapture = {
  [Key in keyof Descriptor]: Descriptor[Key] extends number
    ? number | string
    : Descriptor[Key];
} & { complete?: boolean; native_key?: string; native_sha256?: string };
const SELECTED =
  "SELECT sha256 FROM (SELECT sha256,captured_at FROM raw_capture_selected WHERE key=? UNION ALL SELECT sha256,captured_at FROM raw_capture_archives WHERE key=? AND selected) AS selected_capture ORDER BY captured_at DESC LIMIT 1";

function integer(value: unknown): number {
  if (
    typeof value !== "number" &&
    (typeof value !== "string" || !/^-?\d+$/.test(value))
  )
    throw new Error("Raw capture integer is invalid");
  const result = Number(value);
  if (!Number.isSafeInteger(result))
    throw new Error("Raw capture integer exceeds safe range");
  return result;
}

function sameDescriptor(row: StoredCapture | null, expected: Descriptor) {
  return (
    row !== null &&
    Object.entries(expected).every(([name, value]) => {
      const actual = row[name as keyof Descriptor];
      return typeof value === "number"
        ? integer(actual) === value
        : actual === value;
    })
  );
}

async function confirm(scope: PgTransaction, key: string, digest: string) {
  const selected = await scope.first<{ sha256: string }>(SELECTED, [key, key]);
  if (selected?.sha256 !== digest)
    throw new Error("Raw capture selection was not acknowledged");
}

/** One verified source supplies byte storage and its monotonic frontier. The
 * process retains the pool lifecycle; construction performs no database I/O. */
export function createPgRawCapture(
  source: Pick<NativeSource, "relations" | "access" | "transaction">,
  now: () => number = Date.now,
): NativeRawCapture {
  if (
    source.access !== "read-write" ||
    !TABLES.every((name) => source.relations.includes(name))
  )
    throw new TypeError(
      "Native raw capture requires its complete writable source",
    );
  const transaction = source.transaction.bind(source);
  return Object.freeze({
    store: Object.freeze({
      async put(key: string, value: string) {
        const {
          descriptor,
          compressed,
          digest,
          compressedDigest,
          parts,
          network,
        } = prepareRawCapture(key, value);
        await transaction(
          async (scope) => {
            // Acquire before reads too, matching the schema's statement triggers
            // and fencing a concurrent archive-and-release operation.
            await scope.run("SELECT pg_advisory_xact_lock(1297306,0)");
            const budget = await scope.first<{
              bytes: string | number;
              objects: string | number;
            }>("SELECT bytes,objects FROM raw_capture_budget WHERE id=1");
            if (
              !budget ||
              integer(budget.bytes) < 0 ||
              integer(budget.bytes) > 536870912 ||
              integer(budget.objects) < 0 ||
              integer(budget.objects) > 16384
            )
              throw new Error("Raw capture storage budget is unavailable");
            const archived = await scope.first<StoredCapture>(
              "SELECT * FROM raw_capture_archives WHERE key=? AND sha256=?",
              [key, digest],
            );
            if (archived) {
              if (
                !sameDescriptor(archived, descriptor) ||
                archived.complete !== true ||
                archived.native_sha256 !== compressedDigest ||
                archived.native_key !==
                  `chain/raw/native/v1/${network}/${digest}/${compressedDigest}.gz`
              )
                throw new Error("Raw capture archive identity differs");
              await confirm(scope, key, digest);
              return;
            }
            await scope.run(
              "INSERT INTO raw_capture_batches(key,sha256,network,first_block,last_block,raw_bytes,compressed_bytes,compressed_sha256,parts,captured_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(key,sha256) DO NOTHING",
              Object.values(descriptor),
            );
            const reservation = await scope.first<StoredCapture>(
              "SELECT key,sha256,network,first_block,last_block,raw_bytes,compressed_bytes,compressed_sha256,parts,captured_at FROM raw_capture_batches WHERE key=? AND sha256=?",
              [key, digest],
            );
            if (!sameDescriptor(reservation, descriptor))
              throw new Error("Raw capture reservation readback differs");
            for (let start = 0; start < parts; start += 8) {
              const count = Math.min(8, parts - start);
              const chunks = Array.from({ length: count }, (_, index) =>
                compressed.subarray(
                  (start + index) * RAW_CAPTURE_CHUNK_BYTES,
                  (start + index + 1) * RAW_CAPTURE_CHUNK_BYTES,
                ),
              );
              await scope.run(
                "INSERT INTO raw_capture_chunks(key,sha256,part,data) VALUES " +
                  chunks.map(() => "(?,?,?,?)").join(",") +
                  " ON CONFLICT(key,sha256,part) DO NOTHING",
                chunks.flatMap((chunk, index) => [
                  key,
                  digest,
                  start + index,
                  chunk,
                ]),
              );
              const rows = await scope.query<{
                part: string | number;
                data: Uint8Array;
              }>(
                "SELECT part,data FROM raw_capture_chunks WHERE key=? AND sha256=? AND part>=? AND part<? ORDER BY part",
                [key, digest, start, start + count],
              );
              if (
                rows.length !== chunks.length ||
                rows.some(
                  (row, index) =>
                    integer(row.part) !== start + index ||
                    !Buffer.isBuffer(row.data) ||
                    !chunks[index]!.equals(row.data),
                )
              )
                throw new Error("Raw capture chunk readback differs");
            }
            await scope.run(
              "UPDATE raw_capture_batches SET complete=true WHERE key=? AND sha256=? AND parts=(SELECT count(*) FROM raw_capture_chunks WHERE key=? AND sha256=?) AND compressed_bytes=(SELECT sum(octet_length(data)) FROM raw_capture_chunks WHERE key=? AND sha256=?)",
              [key, digest, key, digest, key, digest],
            );
            await scope.run(
              "INSERT INTO raw_capture_selected(key,sha256,network,last_block,captured_at) SELECT key,sha256,network,last_block,captured_at FROM raw_capture_batches b WHERE key=? AND sha256=? AND complete AND NOT EXISTS(SELECT 1 FROM raw_capture_archives a WHERE a.key=b.key AND a.selected AND a.sha256<>b.sha256 AND a.captured_at>=b.captured_at) ON CONFLICT(key) DO UPDATE SET sha256=excluded.sha256,network=excluded.network,last_block=excluded.last_block,captured_at=excluded.captured_at WHERE raw_capture_selected.captured_at<excluded.captured_at OR raw_capture_selected.sha256=excluded.sha256",
              [key, digest],
            );
            await confirm(scope, key, digest);
          },
          { isolation: "read committed" },
        );
      },
    }),
    watermark(network: string) {
      if (network !== "mainnet" && network !== "testnet")
        throw new TypeError("Unknown raw capture network");
      const read = async () =>
        transaction(async (scope) => {
          const row = await scope.first<{
            last_contiguous_block: string | number;
          }>(
            "SELECT last_contiguous_block FROM raw_capture_state WHERE network=?",
            [network],
          );
          return row ? integer(row.last_contiguous_block) : null;
        });
      return Object.freeze({
        read,
        async write(value: number) {
          const stamp = now();
          if (
            !Number.isSafeInteger(value) ||
            value < 0 ||
            !Number.isSafeInteger(stamp) ||
            stamp < 0
          )
            throw new TypeError("Invalid raw capture watermark");
          await transaction(
            async (scope) => {
              await scope.run(
                "INSERT INTO raw_capture_state(network,last_contiguous_block,updated_at) VALUES(?,?,?) ON CONFLICT(network) DO UPDATE SET last_contiguous_block=GREATEST(raw_capture_state.last_contiguous_block,excluded.last_contiguous_block),updated_at=excluded.updated_at",
                [network, value, stamp],
              );
              const row = await scope.first<{
                last_contiguous_block: string | number;
              }>(
                "SELECT last_contiguous_block FROM raw_capture_state WHERE network=?",
                [network],
              );
              if (!row || integer(row.last_contiguous_block) < value)
                throw new Error("Raw capture watermark was not committed");
            },
            { isolation: "read committed" },
          );
        },
      });
    },
  });
}
