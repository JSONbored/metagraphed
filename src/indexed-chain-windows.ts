import { HistorySourceCeilingSchema } from "../schemas-src/artifacts/history-source-ceiling.ts";
import type { HistoryBlockGeneration } from "../schemas-src/artifacts/history-generation.ts";
import { ChainEventsRowSchema } from "../schemas-src/lakehouse.ts";
import type { ChainEventsRow } from "../generated/lakehouse/types.ts";
import { type ChainNetworkId, DEFAULT_CHAIN_NETWORK } from "./chain-network.ts";
import { TESTNET_RAW_CAPTURE_GENESIS_FLOOR } from "./raw-capture-floors.ts";
import {
  catalogRow,
  readSelectedHistorySegments,
} from "./indexed-history-store.ts";
import {
  loadHistoryBlockGeneration,
  readHistoryPointers,
  scanHistoryBlockRange,
  type HistoryPhysicalPointer,
} from "./history-generation.ts";
import { parquetReadBudget, r2ParquetSource } from "./indexed-parquet.ts";
import { recordIndexedHistoryFailure } from "./indexed-history-status.ts";

type Bucket = Pick<R2Bucket, "get">;
const Fields = ChainEventsRowSchema.pick({
  block_number: true,
  observed_at: true,
  event_index: true,
  pallet: true,
  method: true,
}).required();
type Filter = ReturnType<typeof Fields.parse>;
interface Candidate extends HistoryPhysicalPointer {
  generation: string;
  filter: Filter;
}
interface WindowQuery {
  first: number;
  last: number;
  limit: number;
  pallet?: string;
  method?: string;
  cursor?: readonly number[];
}
function compare(a: Candidate, b: Candidate): number {
  return (
    b.filter.block_number! - a.filter.block_number! ||
    (b.filter.event_index ?? -1) - (a.filter.event_index ?? -1) ||
    a.sourceIdentity.localeCompare(b.sourceIdentity) ||
    a.row - b.row
  );
}

/** A bounded max heap retains only the requested page while every selected
 * physical row is checked. Payload columns are read only after page selection. */
function retain(heap: Candidate[], value: Candidate, limit: number): void {
  if (heap.length === limit && compare(value, heap[0]) >= 0) return;
  let index: number;
  if (heap.length < limit) {
    index = heap.length;
    heap.push(value);
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compare(heap[parent], value) >= 0) break;
      heap[index] = heap[parent];
      index = parent;
    }
  } else {
    index = 0;
    while (index * 2 + 1 < heap.length) {
      let child = index * 2 + 1;
      if (child + 1 < heap.length && compare(heap[child + 1], heap[child]) > 0)
        child++;
      if (compare(value, heap[child]) >= 0) break;
      heap[index] = heap[child];
      index = child;
    }
  }
  heap[index] = value;
}

/** The source ceiling fences both full and empty answers. A missing selection
 * remains unqualified; corrupt selected data declines without a SQL fallback. */
async function windowContext(
  env: unknown,
  first: number,
  last: number,
  network: ChainNetworkId,
) {
  if (
    !Number.isSafeInteger(first) ||
    first < 0 ||
    !Number.isSafeInteger(last) ||
    last < first ||
    last > 0xffffffff ||
    last - first > 5000
  )
    throw new Error("Invalid indexed chain window");
  const segments = await readSelectedHistorySegments(
    env,
    "chain_events",
    network,
  );
  if (!segments) return undefined;
  const floor = network === "mainnet" ? 0 : TESTNET_RAW_CAPTURE_GENESIS_FLOOR;
  if (segments[0].firstBlock > Math.max(floor, first)) return undefined;
  const bucket = (env as { METAGRAPH_ARCHIVE: Bucket }).METAGRAPH_ARCHIVE;
  const ceilingKey = `metagraph/indexed-history/v1/${network}/chain_events/source-ceiling.json`;
  const before = await bucket.get(ceilingKey);
  if (!before) return undefined;
  if (before.size > 8192)
    throw new Error("Chain window ceiling exceeds budget");
  const ceiling = HistorySourceCeilingSchema.parse(await before.json());
  if (
    ceiling.network !== network ||
    ceiling.table !== "chain_events" ||
    !before.etag
  )
    throw new Error("Chain window source ceiling scope mismatch");
  if (segments.at(-1)!.lastBlock < Math.min(last, ceiling.through))
    return undefined;
  const source = r2ParquetSource(bucket),
    budget = parquetReadBudget(128 * 1024 * 1024, 4096);
  const generations: HistoryBlockGeneration[] = [];
  for (const segment of segments) {
    if (
      segment.lastBlock < first ||
      segment.firstBlock > Math.min(last, ceiling.through)
    )
      continue;
    generations.push(
      await loadHistoryBlockGeneration(
        source,
        segment.blockManifest,
        segment,
        budget,
      ),
    );
  }
  return {
    source,
    budget,
    generations,
    first,
    last: Math.min(last, ceiling.through),
    unchanged: async () => {
      const after = await bucket.get(ceilingKey);
      return after !== null && after.etag === before.etag;
    },
  };
}

export async function loadIndexedChainWindow(
  env: unknown,
  query: WindowQuery,
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): Promise<ChainEventsRow[] | null | undefined> {
  try {
    if (
      !Number.isSafeInteger(query.limit) ||
      query.limit < 1 ||
      query.limit > 5001
    )
      throw new Error("Invalid chain window page size");
    const context = await windowContext(env, query.first, query.last, network);
    if (!context) return undefined;
    const { source, budget, generations } = context,
      candidates: Candidate[] = [];
    for (const generation of generations) {
      await scanHistoryBlockRange(
        source,
        generation,
        generation,
        context.first,
        context.last,
        ["event_index", "pallet", "method"],
        budget,
        (record, pointer) => {
          const row = Fields.parse(catalogRow(record));
          if (
            (query.pallet !== undefined && row.pallet !== query.pallet) ||
            (query.method !== undefined && row.method !== query.method) ||
            (query.cursor &&
              !(
                row.block_number! < query.cursor[1] ||
                (row.event_index !== null && row.event_index < query.cursor[2])
              ))
          )
            return;
          retain(
            candidates,
            { ...pointer, generation: generation.generation, filter: row },
            query.limit,
          );
        },
      );
    }
    candidates.sort(compare);
    const output = new Map<Candidate, ChainEventsRow>();
    for (const generation of generations) {
      const pointers = candidates.filter(
        (value) => value.generation === generation.generation,
      );
      if (pointers.length === 0) continue;
      const rows = await readHistoryPointers(
        source,
        generation,
        generation,
        pointers,
        budget,
      );
      rows.forEach((record, index) => {
        const row = ChainEventsRowSchema.required().parse(catalogRow(record)),
          pointer = pointers[index];
        for (const key of [
          "block_number",
          "observed_at",
          "event_index",
          "pallet",
          "method",
        ] as const)
          if (row[key] !== pointer.filter[key])
            throw new Error("Chain window pointer differs from retained row");
        output.set(pointer, row);
      });
    }
    return (await context.unchanged())
      ? candidates.map((pointer) => output.get(pointer)!)
      : undefined;
  } catch {
    recordIndexedHistoryFailure();
    return null;
  }
}

const Group = ChainEventsRowSchema.pick({
  pallet: true,
  method: true,
}).required();
function nameOrder(a: string | null, b: string | null): number {
  // SQL ASC puts nulls last. Compare Unicode code points using the same UTF-8
  // order as the catalog, without locale-dependent collation.
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const left = Array.from(a, (value) => value.codePointAt(0)!);
  const right = Array.from(b, (value) => value.codePointAt(0)!);
  for (let index = 0; index < Math.min(left.length, right.length); index++)
    if (left[index] !== right[index]) return left[index] - right[index];
  return left.length - right.length;
}
export async function loadIndexedChainWindowStats(
  env: unknown,
  first: number,
  last: number,
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): Promise<Record<string, unknown>[] | null | undefined> {
  try {
    const context = await windowContext(env, first, last, network);
    if (!context) return undefined;
    const groups = new Map<
      string,
      { pallet: string | null; method: string | null; count: number }
    >();
    for (const generation of context.generations) {
      await scanHistoryBlockRange(
        context.source,
        generation,
        generation,
        context.first,
        context.last,
        ["pallet", "method"],
        context.budget,
        (record) => {
          const row = Group.parse(record),
            key = JSON.stringify([row.pallet, row.method]),
            group = groups.get(key);
          if (group) group.count++;
          else {
            if (groups.size >= 65536)
              throw new Error("Chain window groups exceed budget");
            groups.set(key, {
              pallet: row.pallet,
              method: row.method,
              count: 1,
            });
          }
        },
      );
    }
    const rows = [...groups.values()]
      .sort(
        (a, b) =>
          b.count - a.count ||
          nameOrder(a.pallet, b.pallet) ||
          nameOrder(a.method, b.method),
      )
      .slice(0, 100);
    return (await context.unchanged()) ? rows : undefined;
  } catch {
    recordIndexedHistoryFailure();
    return null;
  }
}
