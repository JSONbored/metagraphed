// Bake COMPUTED_LIVE artifacts to disk so they can be uploaded to R2.
//
// WHY THIS EXISTS. 129 of 194 declared artifacts are COMPUTED_LIVE
// (src/contracts.ts's COMPUTED_LIVE): the route computes them per request from
// Postgres and no file is written anywhere. That is fine while Postgres is up.
// It stops being fine when the indexer box is decommissioned, because
// `tryPostgresTier` returning null makes the caller substitute an EMPTY
// payload -- so ~130 routes would answer 200 with nothing in them rather than
// serving the last known-good values. Empty is worse than stale: an empty
// /incidents reads as "zero incidents, perfect uptime".
//
// These can only be produced while the database is alive, so this is a
// deadline-bound job, not a migration step.
//
// REVERSIBILITY IS THE POINT. The output lands at each artifact's OWN declared
// `path`, which `workers/storage.ts`'s readArtifact already resolves (asset
// first, then R2 -- and computed artifacts have no committed asset, so R2 is
// reached). Nothing here invents a parallel namespace. If Postgres ever comes
// back, `tryPostgresTier` succeeds again and these files stop being consulted
// without a single line changing.
//
// WHAT IT DELIBERATELY DOES NOT DO. Routes whose path parameters are unbounded
// -- {ss58}, {hotkey}, {hash}, {ref}, {uid}, {h160} -- are not bakeable: the
// key space is every account/block/extrinsic that has ever existed. Those are
// reported in the manifest as `unbakeable` and belong behind an honest
// structured 503 (or R2 SQL, metagraphed-infra#207), never a fabricated empty
// body.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  API_ROUTES,
  PUBLIC_ARTIFACTS,
  isComputedArtifact,
} from "../src/contracts.ts";

const API_BASE = process.env.BAKE_API_BASE ?? "https://api.metagraph.sh";
const OUT_DIR = process.env.BAKE_OUT_DIR ?? "bake-out";
const CONCURRENCY = Number(process.env.BAKE_CONCURRENCY ?? 6);
const ONLY = process.env.BAKE_ONLY ?? ""; // "plain" | "bounded" | ""

// Parameters whose value space is finite and enumerable at bake time. Anything
// else makes a route unbakeable by definition, not by effort.
const BOUNDED_PARAMS = new Set(["netuid", "tag"]);

type Row = Record<string, unknown>;

function pathParamsOf(routePath: string): string[] {
  return [...routePath.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
}

async function fetchJson(
  url: string,
): Promise<{ ok: boolean; status: number; body?: string }> {
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    const body = await res.text();
    return { ok: res.ok, status: res.status, body };
  } catch (error) {
    return { ok: false, status: 0, body: String(error) };
  }
}

// The subnet list is itself served from a baked artifact, so this works even if
// the Postgres tier is already degraded -- which matters, because the whole
// reason we are baking is that the tier is about to go away.
async function loadNetuids(): Promise<number[]> {
  const res = await fetchJson(`${API_BASE}/api/v1/subnets?limit=1000`);
  if (!res.ok || !res.body)
    throw new Error(`cannot enumerate subnets: HTTP ${res.status}`);
  const parsed = JSON.parse(res.body) as Row;
  const rows = ((parsed.data as Row)?.subnets ?? parsed.subnets ?? []) as Row[];
  const ids = rows
    .map((r) => Number(r.netuid))
    .filter((n) => Number.isInteger(n));
  if (!ids.length)
    throw new Error(
      "subnet list came back empty; refusing to bake a partial set",
    );
  return ids;
}

// Tag values come from the contract's own enum rather than a guess, so a new
// tag cannot silently go unbaked.
function tagValues(route: Row): string[] {
  const params = (route.query_parameters ?? []) as Row[];
  for (const p of params) {
    const schema = p.schema as Row | undefined;
    if (p.name === "tag" && Array.isArray(schema?.enum))
      return schema.enum as string[];
  }
  return [];
}

interface Job {
  artifactPath: string;
  routePath: string;
  url: string;
}

function expand(route: Row, netuids: number[]): Job[] {
  const routePath = route.path as string;
  const artifactPath = route.artifact_path as string;
  const params = pathParamsOf(routePath);
  if (!params.length) {
    return [{ artifactPath, routePath, url: `${API_BASE}${routePath}` }];
  }
  let combos: Array<Record<string, string>> = [{}];
  for (const param of params) {
    const values =
      param === "netuid"
        ? netuids.map(String)
        : param === "tag"
          ? tagValues(route)
          : [];
    if (!values.length) return []; // unbounded -> not bakeable
    combos = combos.flatMap((base) =>
      values.map((v) => ({ ...base, [param]: v })),
    );
  }
  return combos.map((combo) => {
    let rp = routePath;
    let ap = artifactPath;
    for (const [k, v] of Object.entries(combo)) {
      rp = rp.replaceAll(`{${k}}`, v);
      ap = ap.replaceAll(`{${k}}`, v);
    }
    return { artifactPath: ap, routePath: rp, url: `${API_BASE}${rp}` };
  });
}

async function main() {
  const computedPaths = new Set(
    (PUBLIC_ARTIFACTS as unknown as Row[])
      .filter((a) => isComputedArtifact(a.id as string))
      .map((a) => a.path as string),
  );

  const candidates = (API_ROUTES as unknown as Row[]).filter(
    (r) => r.artifact_path && computedPaths.has(r.artifact_path as string),
  );

  const unbakeable: string[] = [];
  const bakeable: Row[] = [];
  for (const route of candidates) {
    const params = pathParamsOf(route.path as string);
    if (params.every((p) => BOUNDED_PARAMS.has(p))) bakeable.push(route);
    else unbakeable.push(route.path as string);
  }

  const netuids = bakeable.some((r) =>
    pathParamsOf(r.path as string).includes("netuid"),
  )
    ? await loadNetuids()
    : [];
  if (netuids.length) console.log(`enumerated ${netuids.length} subnets`);

  // BAKE_ONLY narrows the run for validation. Filter on the ROUTE's own
  // parameters, not the expanded job's -- an expanded job has its placeholders
  // already substituted, so testing the job for "{" would match nothing and
  // silently pass an empty set off as a successful plain-only run.
  const selected =
    ONLY === "plain"
      ? bakeable.filter((r) => pathParamsOf(r.path as string).length === 0)
      : ONLY === "bounded"
        ? bakeable.filter((r) => pathParamsOf(r.path as string).length > 0)
        : bakeable;
  const jobs = selected.flatMap((r) => expand(r, netuids));

  // A route family that expanded to nothing is a silent hole, so surface it.
  const expandedFamilies = new Set(
    jobs.map((j) => j.routePath.replace(/\d+/g, "{}")),
  );
  console.log(
    `routes: ${candidates.length} computed | ${bakeable.length} bakeable | ${unbakeable.length} unbakeable`,
  );
  console.log(
    `jobs: ${jobs.length} (from ${expandedFamilies.size} expanded families)`,
  );

  const results = { ok: 0, failed: 0, errors: [] as Row[] };
  let cursor = 0;
  async function worker() {
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      const res = await fetchJson(job.url);
      if (!res.ok || !res.body) {
        results.failed++;
        results.errors.push({ url: job.url, status: res.status });
        continue;
      }
      const dest = join(OUT_DIR, job.artifactPath.replace(/^\//, ""));
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, res.body);
      results.ok++;
      if (results.ok % 250 === 0)
        console.log(`  baked ${results.ok}/${jobs.length}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const manifest = {
    baked_at: new Date().toISOString(),
    api_base: API_BASE,
    ok: results.ok,
    failed: results.failed,
    // Named explicitly so a reader does not mistake absence for an oversight.
    unbakeable_route_families: unbakeable.sort(),
    errors: results.errors.slice(0, 100),
  };
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(
    join(OUT_DIR, "_bake-manifest.json"),
    JSON.stringify(manifest, null, 2),
  );

  console.log(`\nbaked ${results.ok}, failed ${results.failed}`);
  console.log(
    `unbakeable (unbounded params, need 503 or R2 SQL): ${unbakeable.length}`,
  );
  if (results.failed) process.exitCode = 1;
}

await main();
