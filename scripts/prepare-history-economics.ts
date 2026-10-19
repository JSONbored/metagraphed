import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { buildParquetPageIndex, parquetFooter } from "./build-parquet-page-index.ts";
import { parquetReadBudget, readIndexedParquet } from "../src/indexed-parquet.ts";
import { buildHistoryEconomicsAttribution } from "../src/history-economics-attribution.ts";
import { extrinsicSubnetIds } from "../src/block-economics.ts";
import { HistoryEconomicsSubnetIdsSchema } from "../schemas-src/artifacts/history-generation.ts";

const PartSchema = z.strictObject({
  key: z.string().regex(/^metagraph\/indexed-history\/v1\/(?:mainnet|testnet)\/extrinsics\/[a-f0-9]{64}\/\d{5,10}-[a-f0-9]{64}\.parquet$/),
  etag: z.string().regex(/^[a-f0-9]{32}$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.int().positive().max(128 * 1024 * 1024),
  rows: z.int().positive().max(65536),
});

/** Local preparation only: no credentials, uploads, manifests or selections. */
export async function prepareHistoryEconomics(bytes: Uint8Array, input: unknown) {
  const identity = PartSchema.parse(input);
  if (
    bytes.length !== identity.bytes ||
    !identity.key.endsWith(`-${identity.sha256}.parquet`) ||
    createHash("md5").update(bytes).digest("hex") !== identity.etag ||
    createHash("sha256").update(bytes).digest("hex") !== identity.sha256
  ) throw new Error("Economics source identity mismatch");
  const data = Uint8Array.from(bytes).buffer;
  const file = {
    byteLength: data.byteLength,
    slice: (start: number, end = data.byteLength) => data.slice(start, end),
  };
  const index = await buildParquetPageIndex(file, identity.key, identity.etag, await parquetFooter(file));
  if (index.rows !== identity.rows || index.groups.some((group) => group.rows > 512))
    throw new Error("Economics source census or row-group limit mismatch");
  const source = {
    async read(key: string, etag: string, offset: number, length: number) {
      if (key !== identity.key || etag !== identity.etag)
        throw new Error("Economics source changed");
      return data.slice(offset, offset + length);
    },
  };
  const subnetIds: number[][] = [];
  let attributionBytes = 0;
  const budget = parquetReadBudget(128 * 1024 * 1024, 4096);
  // Only derived IDs survive each batch. Offline preparation retains the same
  // 32 MiB/one-million-value decode limits while releasing the previous batch.
  for (let start = 0; start < identity.rows; start += 512) {
    const batchBudget = { ...budget, decodedBytes: 0, values: 0 };
    const batch = await readIndexedParquet(
      source, index, start, Math.min(start + 512, identity.rows), ["call_args"], batchBudget,
    );
    budget.bytes = batchBudget.bytes;
    budget.requests = batchBudget.requests;
    for (const row of batch) {
      const ids = HistoryEconomicsSubnetIdsSchema.parse(extrinsicSubnetIds(row.call_args));
      attributionBytes += JSON.stringify(ids).length + 1;
      if (attributionBytes > 2 * 1024 * 1024)
        throw new Error("Economics companion exceeds size bound");
      subnetIds.push(ids);
    }
  }
  const output = buildHistoryEconomicsAttribution(identity, subnetIds);
  return {
    bytes: output.bytes,
    descriptor: {
      key: output.key,
      etag: createHash("md5").update(output.bytes).digest("hex"),
      bytes: output.bytes.length,
    },
    index,
  };
}

export async function main(args = process.argv.slice(2)) {
  if (args.length !== 3)
    throw new Error("Usage: prepare-history-economics <part.parquet> <identity.json> <output.json>");
  const [partPath, identityPath, outputPath] = args;
  const identity = PartSchema.parse(JSON.parse(await readFile(identityPath, "utf8")));
  if ((await stat(partPath)).size !== identity.bytes) throw new Error("Economics source file size mismatch");
  const result = await prepareHistoryEconomics(await readFile(partPath), identity);
  await writeFile(outputPath, result.bytes, { flag: "wx" });
  return JSON.stringify(result.descriptor);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().then((result) => console.log(result), (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
