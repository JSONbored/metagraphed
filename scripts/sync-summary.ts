import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { artifactFilePath } from "./lib.ts";

// This script only formats a best-effort PR-description report from committed
// JSON artifacts that may be missing/cold/reshaped -- every field access below
// is already `?.`-guarded in the original JS, so typing each hop through
// `unknown` would force a cast at every guard for no real safety gain (the
// values are only ever interpolated into strings or diffed by key). Mirrors
// the readJson/readArtifactJson precedent in scripts/lib.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const files = {
  subnets: "public/metagraph/subnets.json",
  surfaces: "public/metagraph/surfaces.json",
  coverage: "public/metagraph/coverage.json",
  health: "public/metagraph/health/latest.json",
  endpoints: "public/metagraph/endpoints.json",
  endpointPools: "public/metagraph/endpoint-pools.json",
  rpc: "public/metagraph/rpc-endpoints.json",
  rpcPools: "public/metagraph/rpc/pools.json",
  changelog: "public/metagraph/changelog.json",
  freshness: "public/metagraph/freshness.json",
  sourceHealth: "public/metagraph/source-health.json",
  sourceSnapshots: "public/metagraph/source-snapshots.json",
  r2Manifest: "public/metagraph/r2-manifest.json",
  schemaDrift: "public/metagraph/schema-drift.json",
  adaptersAllways: "public/metagraph/adapters/allways.json",
  adaptersGittensor: "public/metagraph/adapters/gittensor.json",
};

const previous: Record<string, Row | null> = Object.fromEntries(
  Object.entries(files).map(([key, file]) => [key, readHeadJson(file)]),
);
const current: Record<string, Row | null> = Object.fromEntries(
  Object.entries(files).map(([key, file]) => [key, readWorktreeJson(file)]),
);

const subnetDiff = diffByKey(
  previous.subnets?.subnets || [],
  current.subnets?.subnets || [],
  "netuid",
);
const surfaceDiff = diffByKey(
  previous.surfaces?.surfaces || [],
  current.surfaces?.surfaces || [],
  "id",
);
const renamed = ((current.subnets?.subnets || []) as Row[])
  .map((subnet) => {
    const oldSubnet = ((previous.subnets?.subnets || []) as Row[]).find(
      (candidate) => candidate.netuid === subnet.netuid,
    );
    return oldSubnet && oldSubnet.name !== subnet.name
      ? `${subnet.netuid}: ${oldSubnet.name} -> ${subnet.name}`
      : null;
  })
  .filter(Boolean) as string[];

const lines: string[] = [];
lines.push("## Summary");
lines.push(
  "- refresh Metagraphed backend registry artifacts for `metagraph.sh`",
);
lines.push(
  `- native subnets: ${countLine(previous.coverage?.chain_subnet_count, current.coverage?.chain_subnet_count)}`,
);
lines.push(
  `- curated surfaces: ${countLine(previous.coverage?.surface_count, current.coverage?.surface_count)}`,
);
lines.push(
  `- candidate surfaces: ${countLine(previous.coverage?.candidate_count, current.coverage?.candidate_count)}`,
);
lines.push(
  `- probed surfaces: ${countLine(previous.coverage?.probed_surface_count, current.coverage?.probed_surface_count)}`,
);
lines.push("");
lines.push("## What changed");
lines.push(
  `- added netuids: ${formatList(subnetDiff.added.map((subnet) => String(subnet.netuid)))}`,
);
lines.push(
  `- removed netuids: ${formatList(subnetDiff.removed.map((subnet) => String(subnet.netuid)))}`,
);
lines.push(`- renamed netuids: ${formatList(renamed)}`);
lines.push(
  `- added surfaces: ${formatList(
    surfaceDiff.added.map((surface) => surface.id),
    12,
  )}`,
);
lines.push(
  `- removed surfaces: ${formatList(
    surfaceDiff.removed.map((surface) => surface.id),
    12,
  )}`,
);
lines.push("");
lines.push("## Health");
lines.push(
  `- surface status: ${formatCounts(current.health?.summary?.status_counts)}`,
);
lines.push(
  `- surface classifications: ${formatCounts(current.health?.summary?.classification_counts)}`,
);
lines.push(`- RPC endpoints: ${formatCounts(current.rpc?.summary?.by_status)}`);
lines.push(
  `- endpoint resources: ${countLine(previous.endpoints?.summary?.endpoint_count, current.endpoints?.summary?.endpoint_count)}`,
);
lines.push(
  `- RPC archive-supported endpoints: ${current.rpc?.summary?.archive_supported_count ?? 0}`,
);
lines.push(
  `- generalized endpoint pools: ${(current.endpointPools?.pools || []).map((pool: Row) => `${pool.id}: ${pool.eligible_count}/${pool.endpoint_count}`).join(", ") || "none"}`,
);
lines.push(
  `- endpoint pools: ${(current.rpcPools?.pools || []).map((pool: Row) => `${pool.id}: ${pool.eligible_count}/${pool.endpoint_count}`).join(", ") || "none"}`,
);
lines.push("");
lines.push("## Schema And Adapters");
lines.push(
  `- OpenAPI drift: ${formatCounts(current.schemaDrift?.summary?.by_drift_status)}`,
);
lines.push(
  `- Allways adapter: ${current.adaptersAllways?.snapshot?.status || "not-captured"}`,
);
lines.push(
  `- Gittensor adapter: ${current.adaptersGittensor?.snapshot?.status || "not-captured"}`,
);
lines.push("");
lines.push("## Cloudflare Artifacts");
lines.push(
  `- generated changelog: ${current.changelog?.summary ? "available" : "missing"}`,
);
lines.push(
  `- freshness native snapshot: ${current.freshness?.summary?.native_snapshot_captured_at || "unknown"}`,
);
lines.push(
  `- source health: ${formatCounts(current.sourceHealth?.summary?.status_counts)}`,
);
lines.push(
  `- source snapshots: ${current.sourceSnapshots?.summary?.source_count ?? 0}`,
);
lines.push(
  `- R2 manifest artifacts: ${current.r2Manifest?.artifact_count ?? 0}`,
);
lines.push("");
lines.push("## Validation");
lines.push("- `npm run validate`");
lines.push("- `npm test`");
lines.push("- `npm run build`");
lines.push("- `npm run schemas:snapshot`");
lines.push("- `npm run adapters:snapshot`");
lines.push("- `METAGRAPH_WRITE_PROBE_RESULTS=1 npm run probes:smoke`");
lines.push("- `npm run validate:schemas`");
lines.push("- `npm run validate:api`");
lines.push("- `npm run validate:intake`");
lines.push("- `npm run validate:workflows`");
lines.push("- `npm run r2:manifest:dry-run`");
lines.push("- `npm run r2:download:dry-run`");
lines.push("- `npm run kv:publish:dry-run`");
lines.push("- `npm run worker:deploy:dry-run`");
lines.push("- `npm run scan:public-safety`");

console.log(lines.join("\n"));

function readWorktreeJson(file: string): Row | null {
  try {
    return JSON.parse(readFileSync(worktreePath(file), "utf8"));
  } catch {
    return null;
  }
}

function worktreePath(file: string): string {
  if (file.startsWith("public/metagraph/")) {
    return artifactFilePath(file.replace(/^public\/metagraph\//, ""));
  }
  return file;
}

function readHeadJson(file: string): Row | null {
  try {
    return JSON.parse(
      execFileSync("git", ["show", `HEAD:${file}`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
  } catch {
    return null;
  }
}

function diffByKey(
  oldItems: Row[],
  newItems: Row[],
  key: string,
): { added: Row[]; removed: Row[] } {
  const oldMap = new Map(oldItems.map((item) => [String(item[key]), item]));
  const newMap = new Map(newItems.map((item) => [String(item[key]), item]));
  return {
    added: [...newMap.entries()]
      .filter(([id]) => !oldMap.has(id))
      .map(([, item]) => item),
    removed: [...oldMap.entries()]
      .filter(([id]) => !newMap.has(id))
      .map(([, item]) => item),
  };
}

function countLine(oldValue: unknown, newValue: unknown): string {
  const oldCount = Number.isFinite(oldValue) ? oldValue : "n/a";
  const newCount = Number.isFinite(newValue) ? newValue : "n/a";
  if (!Number.isFinite(oldValue) || !Number.isFinite(newValue)) {
    return `${newCount} (previous ${oldCount})`;
  }
  const delta = (newValue as number) - (oldValue as number);
  return `${newValue} (${delta >= 0 ? "+" : ""}${delta})`;
}

function formatList(items: string[], limit = 20): string {
  if (!items.length) {
    return "none";
  }
  const shown = items.slice(0, limit);
  const suffix =
    items.length > shown.length ? `, +${items.length - shown.length} more` : "";
  return `${shown.join(", ")}${suffix}`;
}

function formatCounts(
  counts: Record<string, unknown> | null | undefined,
): string {
  if (!counts || Object.keys(counts).length === 0) {
    return "none";
  }
  return Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}: ${value}`)
    .join(", ");
}
