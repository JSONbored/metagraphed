import { HistorySourceCeilingSchema } from "../schemas-src/artifacts/history-source-ceiling.ts";
import type { HistoryBlockGeneration } from "../schemas-src/artifacts/history-generation.ts";
import { ExtrinsicsRowSchema } from "../schemas-src/lakehouse.ts";
import type { ExtrinsicsRow } from "../generated/lakehouse/types.ts";
import { EXTRINSICS_COLUMNS } from "../generated/lakehouse/types.ts";
import { feedOrder } from "./history-feed-tree.ts";
import {
  hotExtrinsicPredicate,
  hotHistoryNumbers,
  readHotHistoryTail,
} from "./history-feed-hot-bridge.ts";
import { restoreChainDetailPayloads } from "./chain-detail-payloads.ts";
import { type ChainNetworkId, DEFAULT_CHAIN_NETWORK } from "./chain-network.ts";
import { TESTNET_RAW_CAPTURE_GENESIS_FLOOR } from "./raw-capture-floors.ts";
import {
  catalogRow,
  readSelectedHistorySegments,
} from "./indexed-history-store.ts";
import {
  loadHistoryBlockGeneration,
  readHistoryPointers,
} from "./history-generation.ts";
import { parquetReadBudget, r2ParquetSource } from "./indexed-parquet.ts";
import { recordIndexedHistoryFailure } from "./indexed-history-status.ts";
import { requireRetainedHistoryAnswer } from "./retained-history-store.ts";
import {
  iterateExtrinsicFeed,
  extrinsicFeedPage,
  validateExtrinsicFeed,
  type ExtrinsicFeedSelector,
} from "./history-extrinsic-feed.ts";

type Bucket = Pick<R2Bucket, "get">;

/** Only a full, source-fenced selected generation may replace SQL, including
 * empty results. Invalid indexes fail closed instead of starting another scan. */
export function loadIndexedExtrinsicFeedPage(
  env: unknown,
  selector: ExtrinsicFeedSelector,
  limit: number,
  offset = 0,
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): Promise<ExtrinsicsRow[] | null | undefined> {
  return requireRetainedHistoryAnswer(
    env,
    loadSelectedExtrinsicFeedPage(env, selector, limit, offset, network),
  );
}

async function loadSelectedExtrinsicFeedPage(
  env: unknown,
  selector: ExtrinsicFeedSelector,
  limit: number,
  offset = 0,
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): Promise<ExtrinsicsRow[] | null | undefined> {
  try {
    const segments = await readSelectedHistorySegments(
      env,
      "extrinsics",
      network,
    );
    if (!segments) return undefined;
    const floor = network === "mainnet" ? 0 : TESTNET_RAW_CAPTURE_GENESIS_FLOOR;
    const requestedStart = Math.max(floor, selector.blockStart ?? floor);
    if (segments[0].firstBlock > requestedStart) return undefined;
    const bucket = (env as { METAGRAPH_ARCHIVE: Bucket }).METAGRAPH_ARCHIVE;
    const base = `metagraph/indexed-history/v1/${network}/extrinsics`;
    const ceilingKey = `${base}/source-ceiling.json`;
    const before = await bucket.get(ceilingKey);
    if (!before) return undefined;
    if (before.size > 8192)
      throw new Error("Extrinsic feed source ceiling exceeds budget");
    const ceiling = HistorySourceCeilingSchema.parse(await before.json());
    if (
      ceiling.network !== network ||
      ceiling.table !== "extrinsics" ||
      !before.etag
    )
      throw new Error("Extrinsic feed source ceiling scope mismatch");
    const requestedEnd = Math.min(
      ceiling.through,
      selector.blockEnd ?? ceiling.through,
    );
    const hot = await readHotHistoryTail(
      env,
      "extrinsics",
      segments.at(-1)!.lastBlock,
      requestedEnd,
      network,
      EXTRINSICS_COLUMNS,
      hotExtrinsicPredicate(selector),
      limit + offset,
    );
    if (!hot) return undefined;
    const source = r2ParquetSource(bucket),
      budget = parquetReadBudget(128 * 1024 * 1024, 1024);
    const generations = new Map<string, HistoryBlockGeneration>(),
      streams = [];
    for (const segment of segments) {
      if (
        segment.lastBlock < requestedStart ||
        segment.firstBlock > requestedEnd
      )
        continue;
      const object = await bucket.get(
        `${base}/generations/${segment.generation}/feeds/v1/manifest.json`,
      );
      if (!object) return undefined;
      if (object.size > 16 * 1024)
        throw new Error("Extrinsic feed manifest exceeds budget");
      const feed = validateExtrinsicFeed(await object.json(), {
        ...segment,
        table: "extrinsics",
      });
      const generation = await loadHistoryBlockGeneration(
        source,
        segment.blockManifest,
        segment,
        budget,
      );
      if (
        feed.rows !== generation.rows ||
        feed.sourceSnapshot !== generation.sourceSnapshot
      )
        throw new Error(
          "Extrinsic feed source census differs from its generation",
        );
      generations.set(segment.generation, generation);
      streams.push(iterateExtrinsicFeed(source, feed, selector, budget));
    }
    const output = new Map<string, ExtrinsicsRow>();
    if (hot.length)
      streams.push(
        (async function* () {
          for (const record of await restoreChainDetailPayloads(env, hot)) {
            const numeric = hotHistoryNumbers(record, ["fee_tao", "tip_tao"]);
            const row = ExtrinsicsRowSchema.required().parse({
              ...numeric,
              success: numeric.success === null ? null : numeric.success === 1,
            });
            const token =
              "0".repeat(64) +
              feedOrder(
                row.observed_at!,
                row.block_number!,
                row.extrinsic_index!,
              ) +
              "0".repeat(72);
            output.set(token.slice(64), row);
            yield {
              token,
              generation: "hot",
              fileId: 0,
              sourceIdentity: "0".repeat(64),
              row: 0,
              filter: {
                block_number: row.block_number!,
                extrinsic_index: row.extrinsic_index!,
                observed_at: row.observed_at!,
                signer: row.signer,
                call_module: row.call_module,
                call_function: row.call_function,
                success: row.success,
              },
            };
          }
        })(),
      );
    const page = await extrinsicFeedPage(streams, limit, offset);
    for (const [identity, generation] of generations) {
      const pointers = page.filter(
        (pointer) => pointer.generation === identity,
      );
      const records = await readHistoryPointers(
        source,
        generation,
        generation,
        pointers,
        budget,
      );
      records.forEach((record, index) => {
        const pointer = pointers[index],
          row = ExtrinsicsRowSchema.required().parse(catalogRow(record));
        for (const key of Object.keys(
          pointer.filter,
        ) as (keyof typeof pointer.filter)[])
          if (row[key] !== pointer.filter[key])
            throw new Error(
              "Extrinsic feed pointer differs from its retained row",
            );
        output.set(pointer.token.slice(64), row);
      });
    }
    const after = await bucket.get(ceilingKey);
    return after !== null && after.etag === before.etag
      ? page.map((pointer) => output.get(pointer.token.slice(64))!)
      : undefined;
  } catch {
    recordIndexedHistoryFailure();
    return null;
  }
}
