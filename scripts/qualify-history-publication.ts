import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { HistoryFileSchema } from "../schemas-src/artifacts/history-generation.ts";
import { HistorySelectionSchema } from "../schemas-src/artifacts/history-selection.ts";
import { validateHistoryBlockIndex } from "../src/history-block-index.ts";
import {
  validateHistoryBlockGeneration,
  validateHistoryGeneration,
} from "../src/history-generation.ts";

const MAX_BYTES = 32 * 1024 * 1024;
const ObjectSchema = z.strictObject({ key: z.string(), raw: z.string() });
const InputSchema = z.strictObject({
  blockManifest: ObjectSchema,
  blockIndex: ObjectSchema,
  files: z.array(ObjectSchema).max(10000),
  hashManifest: ObjectSchema.optional(),
  selection: HistorySelectionSchema,
});
type ObjectInput = z.infer<typeof ObjectSchema>;

function descriptor(object: ObjectInput) {
  return {
    key: object.key,
    etag: createHash("md5").update(object.raw).digest("hex"),
    bytes: Buffer.byteLength(object.raw),
  };
}

function sameObject(
  expected: ReturnType<typeof descriptor>,
  actual: ObjectInput,
) {
  const found = descriptor(actual);
  if (
    expected.key !== found.key ||
    expected.etag !== found.etag ||
    expected.bytes !== found.bytes
  )
    throw new Error("Publication object identity mismatch");
}

/** Validate exact publication bytes with the serving contracts. The caller
 * separately proves immutable objects and native/Arrow part agreement. */
export function qualifyHistoryPublication(input: unknown) {
  const value = InputSchema.parse(input);
  const selection = value.selection;
  const segments = selection.version === 1 ? [selection] : selection.segments;
  const selected = segments.at(-1)!;
  let last = -1;
  const seen = new Set<string>();
  for (const segment of segments) {
    const root = `metagraph/indexed-history/v1/${selection.network}/${selection.table}/generations/${segment.generation}`;
    const needsHash =
      selection.table === "blocks" || selection.table === "extrinsics";
    if (
      segment.network !== selection.network ||
      segment.table !== selection.table ||
      segment.firstBlock > segment.lastBlock ||
      (last >= 0 && segment.firstBlock !== last + 1) ||
      seen.has(segment.generation) ||
      segment.blockManifest.key !== `${root}/block-manifest.json` ||
      (needsHash
        ? segment.hashManifest?.key !== `${root}/manifest.json`
        : segment.hashManifest !== undefined)
    )
      throw new Error("Publication selection scope or coverage mismatch");
    seen.add(segment.generation);
    last = segment.lastBlock;
  }
  sameObject(selected.blockManifest, value.blockManifest);
  const block = validateHistoryBlockGeneration(
    JSON.parse(value.blockManifest.raw),
    selected,
  );
  sameObject(block.blockIndex, value.blockIndex);
  if (block.files.length !== value.files.length)
    throw new Error("Publication file census mismatch");
  for (const [fileId, object] of value.files.entries()) {
    sameObject(block.files[fileId], object);
    const file = HistoryFileSchema.parse(JSON.parse(object.raw));
    if (
      file.fileId !== fileId ||
      file.generation !== selected.generation ||
      file.network !== selected.network ||
      file.table !== selected.table ||
      file.rows !== block.files[fileId].rows
    )
      throw new Error("Publication file scope mismatch");
    let rows = 0;
    for (const [ordinal, part] of file.parts.entries()) {
      const prefix = `metagraph/indexed-history/v1/${file.network}/${file.table}/${file.sourceIdentity}/${String(ordinal).padStart(5, "0")}-`;
      if (
        part.rowStart !== rows ||
        !part.key.startsWith(prefix) ||
        !/^[0-9a-f]{64}\.parquet$/.test(part.key.slice(prefix.length)) ||
        part.bytes > 128 * 1024 * 1024 ||
        part.index.bytes > 8 * 1024 * 1024 ||
        part.index.key !== part.key.replace(/\.parquet$/, ".page-index.json")
      )
        throw new Error("Publication part scope or coverage mismatch");
      rows += part.rows;
    }
    if (rows !== file.rows) throw new Error("Publication part census mismatch");
  }
  const index = validateHistoryBlockIndex(JSON.parse(value.blockIndex.raw), {
    ...selected,
    fileRows: block.files.map((file) => file.rows),
  });
  if (
    index.shards.some(
      (shard) =>
        shard.firstBlock < selected.firstBlock ||
        shard.lastBlock > selected.lastBlock,
    )
  )
    throw new Error("Publication index exceeds selected coverage");
  if (selected.hashManifest) {
    if (!value.hashManifest)
      throw new Error("Publication hash manifest missing");
    sameObject(selected.hashManifest, value.hashManifest);
    const hash = validateHistoryGeneration(
      JSON.parse(value.hashManifest.raw),
      selected,
    );
    if (
      hash.sourceSnapshot !== block.sourceSnapshot ||
      hash.rows !== block.rows ||
      hash.files.length !== block.files.length ||
      hash.files.some(
        (file, i) =>
          file.rows !== block.files[i].rows ||
          file.key !== block.files[i].key ||
          file.etag !== block.files[i].etag ||
          file.bytes !== block.files[i].bytes,
      )
    )
      throw new Error("Publication hash and block generations differ");
  } else if (value.hashManifest)
    throw new Error("Unexpected publication hash manifest");
  return {
    version: 1,
    generation: selected.generation,
    rows: block.rows,
    files: block.files.length,
    firstBlock: selected.firstBlock,
    lastBlock: selected.lastBlock,
    blockManifest: descriptor(value.blockManifest),
    ...(value.hashManifest
      ? { hashManifest: descriptor(value.hashManifest) }
      : {}),
  };
}

export async function main(args = process.argv.slice(2)) {
  if (args.length !== 1)
    throw new Error("Usage: qualify-history-publication <publication.json>");
  if ((await stat(args[0])).size > MAX_BYTES)
    throw new Error("Publication metadata exceeds size budget");
  return JSON.stringify(
    qualifyHistoryPublication(JSON.parse(await readFile(args[0], "utf8"))),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().then(
    (result) => console.log(result),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
