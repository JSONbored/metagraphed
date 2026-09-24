import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import {
  PROJECTION_LANES,
  PROJECTION_NETWORKS,
  projectionKey,
} from "../src/projection-lanes.ts";
import { projectionComputeEnv } from "../src/projection-compute-context.ts";
import { chainTable } from "../src/chain-network.ts";
import type { ChainNetworkId } from "../src/chain-network.ts";
import type { HistoricalQueryReader } from "../src/history-readers.ts";
import { topHoldersFlowSql } from "../src/top-holders-flow-tier.ts";
import { TopHoldersFlowFactsSchema } from "../schemas-src/projection-artifact.ts";

export const MAX_PROTOCOL_BYTES = 32 * 1024 * 1024;

/** Run the canonical builders with a pinned native reader. No writes occur
 * until every lane succeeds, including all keys produced by split lanes. */
export async function computeNativeProjections(
  network: ChainNetworkId,
  now: number,
  query: HistoricalQueryReader,
) {
  if (!PROJECTION_NETWORKS.includes(network))
    throw new Error("Unknown projection network");
  const env = projectionComputeEnv({} as Env, { query, now });
  const artifacts: { key: string; body: Record<string, unknown> }[] = [];
  let modules: string[] | undefined;
  for (const lane of PROJECTION_LANES) {
    const body = await lane.compute(env, network);
    if (body === null) throw new Error(`Projection declined: ${lane.name}`);
    if (lane.name === "chain-stake-flow") {
      body.top_holders_flow_rows = TopHoldersFlowFactsSchema.parse(
        await query(env, topHoldersFlowSql(now, network)),
      );
    }
    if (["chain-calls", "chain-fees", "chain-signers"].includes(lane.name)) {
      if (modules === undefined) {
        const census = await query(
          env,
          `SELECT DISTINCT call_module FROM ${chainTable("extrinsics", network)} WHERE observed_at >= ${now - 90 * 86_400_000} AND call_module IS NOT NULL ORDER BY call_module LIMIT 1025`,
        );
        if (
          census === null ||
          census.length > 1024 ||
          census.some(
            (row) =>
              typeof row.call_module !== "string" ||
              row.call_module.length > 1024,
          )
        )
          throw new Error(
            "Native module census is incomplete or exceeds budget",
          );
        modules = census.map((row) => row.call_module as string);
      }
      const moduleWindows: { module: string; windows: unknown }[] = [];
      for (const callModule of modules) {
        const scoped = await lane.compute(
          projectionComputeEnv({} as Env, { query, now, callModule }),
          network,
        );
        if (scoped === null)
          throw new Error(`Module projection declined: ${lane.name}`);
        moduleWindows.push({ module: callModule, windows: scoped.windows });
      }
      const empty = await lane.compute(
        projectionComputeEnv({} as Env, { query: async () => [], now }),
        network,
      );
      if (empty === null)
        throw new Error(`Empty module projection declined: ${lane.name}`);
      body.module_windows = moduleWindows;
      body.empty_module_windows = empty.windows;
    }
    const outputs = lane.split?.(body) ?? { [lane.artifactKey]: body };
    for (const [key, value] of Object.entries(outputs))
      artifacts.push({
        key: projectionKey(key, network),
        body: value as Record<string, unknown>,
      });
  }
  return artifacts;
}

export function parseProtocolLine(line: string): unknown {
  if (Buffer.byteLength(line) > MAX_PROTOCOL_BYTES)
    throw new RangeError("Projection protocol frame exceeds budget");
  return JSON.parse(line);
}

/** The parent owns the native engine, credentials, source proofs and atomic
 * publication. This process only sends SQL and consumes bounded row frames. */
export async function nativeProjectionProtocol(
  receive: () => Promise<unknown>,
  send: (value: unknown) => void,
) {
  const input = (await receive()) as {
    network: ChainNetworkId;
    now: number;
  };
  let id = 0;
  const query: HistoricalQueryReader = async (_env, sql) => {
    const request = ++id;
    send({ type: "query", id: request, sql });
    const response = (await receive()) as {
      id?: unknown;
      rows?: unknown;
    };
    if (
      response?.id !== request ||
      !Array.isArray(response.rows) ||
      response.rows.some(
        (row) => row === null || typeof row !== "object" || Array.isArray(row),
      )
    )
      throw new Error("Invalid native query response");
    return response.rows;
  };
  const artifacts = await computeNativeProjections(
    input.network,
    input.now,
    query,
  );
  // Publication is one complete response, never a successful prefix.
  send({ type: "complete", network: input.network, now: input.now, artifacts });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  try {
    await nativeProjectionProtocol(
      async () => {
        const frame = await iterator.next();
        if (frame.done) throw new Error("Native query parent disconnected");
        return parseProtocolLine(frame.value);
      },
      (value) => {
        const frame = JSON.stringify(value);
        if (Buffer.byteLength(frame) > MAX_PROTOCOL_BYTES)
          throw new RangeError("Projection output exceeds budget");
        process.stdout.write(`${frame}\n`);
      },
    );
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  } finally {
    lines.close();
  }
}
