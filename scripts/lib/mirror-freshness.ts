import { d1AdminBatch, d1AdminCredentials } from "./d1-admin.ts";
import { r2ObjectUrl } from "../r2-rest.ts";

const HOUR = 60 * 60 * 1000;
// These sources intentionally leave unchanged archive snapshots alone. Their
// mirror must still complete hourly, and scheduled source writers must be live.
export const MIRROR_SOURCES: Readonly<
  Record<string, "registry" | "compute" | "ownership" | "manual">
> = {
  compute_declarations: "compute",
  providers: "registry",
  surfaces: "registry",
  surface_history: "registry",
  subnet_ownership: "ownership",
  subnet_ownership_history: "ownership",
  emission_flow_watch: "manual",
  treasury_readings: "manual",
};

export interface MirrorFreshnessEvidence {
  receipt: unknown;
  lanes: Record<string, unknown>[];
  computeNewest: unknown;
  ownershipNewest: unknown;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function recent(stamp: unknown, now: number, bound: number): boolean {
  return (
    typeof stamp === "number" &&
    Number.isFinite(stamp) &&
    stamp > 0 &&
    stamp <= now &&
    now - stamp <= bound
  );
}

/** A quiet snapshot needs both a complete mirror and its source's health. */
export function evaluateMirrorFreshness(
  table: string,
  catalogFresh: boolean,
  hasSnapshot: boolean,
  evidence: MirrorFreshnessEvidence,
  now: number,
): { ok: boolean; detail: string } {
  const fail = (reason: string) => ({
    ok: false,
    detail: `${table}: ${reason}`,
  });
  const source = MIRROR_SOURCES[table];
  if (!Object.hasOwn(MIRROR_SOURCES, table))
    return fail("no mirror source classification");
  const receipt = record(evidence.receipt);
  const tables = record(receipt?.tables);
  const failures = record(receipt?.failures);
  const checked =
    typeof receipt?.checked_at === "string"
      ? Date.parse(receipt.checked_at)
      : NaN;
  if (
    !receipt ||
    receipt.ok !== true ||
    receipt.complete !== true ||
    receipt.namespace !== "chain" ||
    !tables ||
    !failures ||
    Object.keys(failures).length ||
    Object.keys(tables).length === 0 ||
    receipt.tables_expected !== Object.keys(tables).length ||
    receipt.tables_reported !== receipt.tables_expected ||
    !recent(checked, now, 6 * HOUR)
  )
    return fail("mirror completion is missing, failed, incomplete, or stale");
  const result = tables[table];
  if (typeof result !== "string" || !result.startsWith(`${table}: `))
    return fail("mirror receipt does not cover this table");
  const quiet = new RegExp(
    `^${table}: (unchanged \\(\\d+ rows\\), no snapshot|no rows above .+)$`,
  ).test(result);
  const appended = new RegExp(
    `^${table}: appended \\d+ rows (as a new version|through .+)$`,
  ).test(result);
  if (!quiet && !appended)
    return fail("mirror result is not a recognized successful table receipt");
  if (
    (!hasSnapshot && result !== `${table}: unchanged (0 rows), no snapshot`) ||
    (!catalogFresh && !quiet)
  )
    return fail("catalog age is not explained by an unchanged mirror result");
  const laneHealthy = (name: string, bound: number) => {
    const lanes = evidence.lanes.filter((lane) => lane.lane === name);
    return (
      lanes.length === 1 &&
      lanes[0].verdict === "ok" &&
      recent(lanes[0].checked_at, now, bound)
    );
  };
  if (
    source === "registry" &&
    (!laneHealthy("registry-sync", 2 * HOUR) ||
      !laneHealthy("registry-resync", 48 * HOUR))
  )
    return fail(
      "registry source writer or full resync is missing, failed, or stale",
    );
  if (
    source === "ownership" &&
    (!laneHealthy("subnet-ownership", 2 * HOUR) ||
      !laneHealthy("neon:subnet-ownership", 2 * HOUR) ||
      !recent(evidence.ownershipNewest, now, 2 * HOUR))
  )
    return fail(
      "ownership collector, ingestion writer, or source rows are missing, failed, or stale",
    );
  if (
    source === "compute" &&
    (!laneHealthy("compute-declarations", 4 * HOUR) ||
      !recent(evidence.computeNewest, now, 4 * HOUR))
  )
    return fail(
      "compute source writer or source rows are missing, failed, or stale",
    );
  return {
    ok: true,
    detail: `${table}: verified mirror at ${receipt.checked_at}; ${source} source; ${result.slice(table.length + 2)}`,
  };
}

/** One small status object and three indexed/small-table reads for the sweep. */
export async function loadMirrorFreshnessEvidence(
  transport: typeof fetch = fetch,
): Promise<MirrorFreshnessEvidence> {
  const credentials = d1AdminCredentials();
  const response = await transport(
    r2ObjectUrl(
      credentials.accountId,
      process.env.R2_ARTIFACTS_BUCKET ?? "metagraphed-artifacts",
      "metagraph/lakehouse/state-mirror-status.json",
    ),
    {
      headers: { authorization: `Bearer ${credentials.apiToken}` },
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!response.ok || !response.body)
    throw new Error(`Mirror receipt HTTP ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let text = "",
    bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 65536) {
        await reader.cancel();
        throw new Error("Mirror receipt exceeds 64 KiB");
      }
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  const receipt: unknown = JSON.parse(text);
  const results = await d1AdminBatch(
    [
      {
        sql: "SELECT lane, verdict, checked_at FROM lane_health_current WHERE lane IN ('registry-sync', 'registry-resync', 'compute-declarations', 'subnet-ownership', 'neon:subnet-ownership')",
      },
      { sql: "SELECT MAX(observed_at) AS newest FROM compute_declarations" },
      { sql: "SELECT MAX(captured_at) AS newest FROM subnet_ownership" },
    ],
    d1AdminCredentials({
      ...process.env,
      CLOUDFLARE_API_TOKEN:
        process.env.CLOUDFLARE_D1_API_TOKEN ?? credentials.apiToken,
    }),
    transport,
  );
  return {
    receipt,
    lanes: results[0].results,
    computeNewest: results[1].results[0]?.newest,
    ownershipNewest: results[2].results[0]?.newest,
  };
}
