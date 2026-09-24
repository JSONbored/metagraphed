import {
  RuntimeAccountCurationPointerSchema,
  RuntimeAccountCurationSchema,
  RUNTIME_CURATED_EVENT_KINDS,
  RUNTIME_CURATION_FIRST_BLOCK,
  type RuntimeAccountCuration,
} from "../schemas-src/artifacts/runtime-account-curation.ts";
import type { HistoryObject } from "../schemas-src/artifacts/history-generation.ts";
import type { ChainNetworkId } from "./chain-network.ts";
import {
  boundedParquetBuffer,
  type ParquetRangeSource,
  type ParquetReadBudget,
} from "./indexed-parquet.ts";
import type { IndexedAccountFeedEntry } from "./history-account-feed.ts";

type Bucket = Pick<R2Bucket, "get">;
const kinds: ReadonlySet<string> = new Set(RUNTIME_CURATED_EVENT_KINDS);
const root = (network: ChainNetworkId) =>
  `metagraph/runtime-account-curation/v1/${network}`;

export async function readRuntimeCurationObject(
  source: ParquetRangeSource,
  object: HistoryObject,
  budget: ParquetReadBudget,
): Promise<unknown> {
  if (object.bytes > 16 * 1024)
    throw new Error("Runtime curation manifest exceeds its budget");
  const buffer = boundedParquetBuffer(source, object, budget);
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      await buffer.slice(0, object.bytes),
    ),
  );
}

/** Absence preserves the prior supported runtime contract. Once selected,
 * broken correction metadata is an explicit failed indexed read. */
export async function loadRuntimeAccountCuration(
  bucket: Bucket,
  source: ParquetRangeSource,
  network: ChainNetworkId,
  budget: ParquetReadBudget,
): Promise<RuntimeAccountCuration | undefined> {
  const current = await bucket.get(`${root(network)}/current.json`);
  if (!current) return undefined;
  if (current.size > 8192)
    throw new Error("Runtime curation pointer exceeds its budget");
  const pointer = RuntimeAccountCurationPointerSchema.parse(
    await current.json(),
  );
  if (
    pointer.network !== network ||
    !new RegExp(`^${root(network)}/[0-9a-f]{64}/manifest\\.json$`).test(
      pointer.manifest.key,
    )
  )
    throw new Error("Runtime curation pointer crosses network scope");
  const manifest = RuntimeAccountCurationSchema.parse(
    await readRuntimeCurationObject(source, pointer.manifest, budget),
  );
  const selected = manifest.selection;
  const generationRoot = `metagraph/indexed-history/v1/${network}/account_events/generations/${selected.generation}`;
  const correctionRoot = `${root(network)}/${selected.generation}`;
  if (
    manifest.network !== network ||
    selected.network !== network ||
    selected.firstBlock !== RUNTIME_CURATION_FIRST_BLOCK[network] ||
    selected.lastBlock < selected.firstBlock ||
    selected.hashManifest !== undefined ||
    selected.blockManifest.key !== `${generationRoot}/block-manifest.json` ||
    manifest.accountManifest.key !==
      `${generationRoot}/accounts/v1/manifest.json` ||
    pointer.manifest.key !== `${correctionRoot}/manifest.json` ||
    manifest.sourceProof.key !== `${correctionRoot}/source-proof.json` ||
    manifest.rows !== Object.values(manifest.counts).reduce((a, b) => a + b, 0)
  )
    throw new Error("Runtime curation scope or census mismatch");
  return manifest;
}

export function isRuntimeCorrectedRow(
  correction: RuntimeAccountCuration,
  row: { block_number?: unknown; event_kind?: unknown },
): boolean {
  return (
    typeof row.block_number === "number" &&
    row.block_number >= correction.selection.firstBlock &&
    row.block_number <= correction.selection.lastBlock &&
    typeof row.event_kind === "string" &&
    kinds.has(row.event_kind)
  );
}

export async function* excludeRuntimeCorrectedRows(
  rows: AsyncGenerator<IndexedAccountFeedEntry>,
  correction: RuntimeAccountCuration,
): AsyncGenerator<IndexedAccountFeedEntry> {
  for await (const entry of rows)
    if (!isRuntimeCorrectedRow(correction, entry.row)) yield entry;
}

export async function* validateRuntimeCorrectedRows(
  rows: AsyncGenerator<IndexedAccountFeedEntry>,
  correction: RuntimeAccountCuration,
): AsyncGenerator<IndexedAccountFeedEntry> {
  for await (const entry of rows) {
    if (!isRuntimeCorrectedRow(correction, entry.row))
      throw new Error("Runtime correction feed contains an unrelated row");
    yield entry;
  }
}
