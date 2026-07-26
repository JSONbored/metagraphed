import { fileURLToPath } from "node:url";

// Scheduled alarm for the artifact read path (#8287).
//
// #8279 added a read-side fallback: when the KV pointer names a prefix that
// holds no objects, the Worker retries at the literal `latest/` key and logs
// `r2_pointer_prefix_miss`. That restored production during the 2026-07-26
// outage (#8276) and is a good backstop -- but a backstop nobody watches
// becomes the silent normal. The API can serve entirely through the fallback,
// every read paying a second round-trip, with nothing surfacing that the
// pointer is still wrong.
//
// Same posture as the publish-freshness alarm (#8286): read the LIVE PUBLIC
// signal rather than internal logs or workflow status, so this needs no
// secrets and cannot pass while the public surface is degraded. The signal is
// the `x-metagraph-artifact-resolution` response header, which reports which
// strategy resolved each artifact's R2 key.

const DEFAULT_API_BASE = "https://api.metagraph.sh";
const FETCH_ATTEMPTS = 3;
const RETRY_DELAY_MS = 10_000;

// The RAW artifact routes, not /api/v1/*. Verified against production: the
// artifact diagnostics (source / storage-tier / resolution) are set by the raw
// `/metagraph/*.json` response builder; the /api/v1 envelope builder never
// carried them, so probing /api/v1 reported `unknown` forever and the alarm was
// blind. These paths ARE the artifact read path this alarm is about.
//
// A spread rather than one: a single path could be missing from the run
// manifest for its own reasons (and legitimately resolve via `prefix`), while a
// broken POINTER degrades all of them at once. Probing several is what
// separates "one artifact is odd" from "the read path is sick".
const DEFAULT_PROBE_PATHS = [
  "/metagraph/subnets.json",
  "/metagraph/coverage.json",
  "/metagraph/providers.json",
];

export type Resolution = "manifest" | "prefix" | "fallback" | "unknown";

export interface ProbeResult {
  path: string;
  resolution: Resolution;
}

export type ResolutionVerdict =
  | { status: "healthy"; results: ProbeResult[] }
  | { status: "degraded"; results: ProbeResult[]; fallbackPaths: string[] }
  | { status: "unknown"; reason: string; results: ProbeResult[] };

/**
 * Pure verdict, split from I/O so the boundary behaviour is directly testable.
 *
 * `fallback` on ANY probed artifact is the alarm: it means that read's resolved
 * key held no object and only the literal `latest/` retry saved it. One is
 * enough -- the fallback is per-key, so a pointer wrong for one artifact is
 * wrong for all of them, and waiting for a majority just delays the page.
 *
 * `prefix` is explicitly NOT degraded. It is the correct, healthy answer for a
 * pointer written before #8277, for artifacts the run manifest does not name,
 * and for stable-latest artifacts that bypass the pointer by design. Treating
 * it as an error would make this alarm fire constantly and get muted, which is
 * the failure mode this issue exists to prevent.
 */
export function evaluateResolution(results: ProbeResult[]): ResolutionVerdict {
  if (results.length === 0) {
    return { status: "unknown", reason: "no artifacts were probed", results };
  }
  const unknown = results.filter((r) => r.resolution === "unknown");
  if (unknown.length === results.length) {
    return {
      status: "unknown",
      reason:
        "no artifact reported x-metagraph-artifact-resolution — the Worker may predate #8287, or the header is not being exposed",
      results,
    };
  }
  const fallbackPaths = results
    .filter((r) => r.resolution === "fallback")
    .map((r) => r.path);
  if (fallbackPaths.length > 0) {
    return { status: "degraded", results, fallbackPaths };
  }
  return { status: "healthy", results };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function probe(apiBase: string, path: string): Promise<ProbeResult> {
  // Transient network flakes must not read as a degraded pointer, so retry
  // before believing an absent header.
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    try {
      // HEAD: the diagnostics live in the headers, so there is no reason to
      // pull a multi-hundred-KB body three times a day.
      const res = await fetch(`${apiBase}${path}`, {
        method: "HEAD",
        headers: { accept: "application/json" },
      });
      const header = res.headers.get("x-metagraph-artifact-resolution");
      if (
        header === "manifest" ||
        header === "prefix" ||
        header === "fallback"
      ) {
        return { path, resolution: header };
      }
      // A 2xx with no header is a real signal (old Worker / header not exposed),
      // not a flake — don't burn retries on it.
      if (res.ok) return { path, resolution: "unknown" };
    } catch {
      // fall through to retry
    }
    if (attempt < FETCH_ATTEMPTS) await sleep(RETRY_DELAY_MS);
  }
  return { path, resolution: "unknown" };
}

export async function main(): Promise<number> {
  const apiBase = (process.env.METAGRAPH_API_BASE || DEFAULT_API_BASE).replace(
    /\/$/,
    "",
  );
  const paths = process.env.METAGRAPH_PROBE_PATHS
    ? process.env.METAGRAPH_PROBE_PATHS.split(",").map((p) => p.trim())
    : DEFAULT_PROBE_PATHS;

  const results: ProbeResult[] = [];
  for (const path of paths) {
    results.push(await probe(apiBase, path));
  }
  const verdict = evaluateResolution(results);
  const summary = results.map((r) => `${r.path}=${r.resolution}`).join(" ");

  if (verdict.status === "degraded") {
    console.error(
      `::error::Artifact reads are being served through the pointer-miss FALLBACK: ${verdict.fallbackPaths.join(", ")}. ` +
        `The KV pointer names a prefix that holds no objects, so every read pays a second round-trip. ` +
        `Fix by re-running the publish (gated by the readback check) rather than hand-editing KV. [${summary}]`,
    );
    return 1;
  }
  if (verdict.status === "unknown") {
    // A missing header is not an outage, but it does mean this alarm is blind —
    // say so loudly rather than reporting a false green.
    console.error(`::warning::${verdict.reason} [${summary}]`);
    return 0;
  }
  console.log(`Artifact read path healthy. [${summary}]`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
