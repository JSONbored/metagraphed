// Testnet surface discovery (the "testnet flywheel", TN-E).
//
// Testnet subnets are native-only — chain identity, no curated surfaces. As a
// subnet matures it may stand up a public API/openapi/SSE endpoint; this probes
// every declared chain-identity URL (+ the common callable paths) and classifies
// what is live, so a subnet that STARTS exposing a callable service is caught.
//
// Per ADR 0006 (see .github/workflows/sync-subnets.yml) machine-probed data is
// NOT committed to git — this emits a report (stdout + optional --out file /
// CI artifact) for review/promotion, never a bot PR. A newly-found callable API
// is the signal to add it as a curated testnet surface. SSRF-guarded via
// isUnsafeResolvedUrl, bounded concurrency + timeouts so a hung host can't wedge.
//
// Usage: node scripts/discover-testnet-surfaces.ts [--out path] [--json]

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isJsonContentType,
  isUnsafeResolvedUrl,
  readJson,
  repoRoot,
  buildTimestamp,
} from "./lib.mjs";
import {
  initSentry,
  endSessionAndFlush,
  captureFatalAndExit,
} from "./observability.mjs";

type Row = Record<string, unknown>;

const SNAPSHOT = path.join(repoRoot, "registry/native/test-subnets.json");
const PROBE_TIMEOUT_MS = 8000;
const CONCURRENCY = 12;
const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 4096;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
// Derived callable-API probe paths appended to each subnet_url base.
const API_PATHS = [
  "/openapi.json",
  "/swagger.json",
  "/.well-known/openapi.json",
  "/api",
  "/docs/openapi.json",
];

interface FetchResult {
  status: number;
  contentType: string;
  body: string;
}

async function readBodySnippet(res: Response): Promise<string> {
  if (!res.body) {
    return "";
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  try {
    while (bytesRead < MAX_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      const remaining = MAX_BODY_BYTES - bytesRead;
      chunks.push(
        value.byteLength > remaining ? value.slice(0, remaining) : value,
      );
      bytesRead += Math.min(value.byteLength, remaining);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  return new TextDecoder().decode(Buffer.concat(chunks)).toLowerCase();
}

async function safeFetch(url: string, redirectCount = 0): Promise<FetchResult> {
  // SSRF guard: refuse private/loopback/rebinding targets before every request,
  // including each manually-followed redirect target.
  if (await isUnsafeResolvedUrl(url)) {
    return { status: 0, contentType: "blocked-unsafe-url", body: "" };
  }
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: { "user-agent": "metagraphed-testnet-discovery/1.0" },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });

    const location = res.headers.get("location");
    if (REDIRECT_STATUSES.has(res.status) && location) {
      await res.body?.cancel();
      if (redirectCount >= MAX_REDIRECTS) {
        return { status: 0, contentType: "too-many-redirects", body: "" };
      }
      const redirectTarget = new URL(location, url).toString();
      return safeFetch(redirectTarget, redirectCount + 1);
    }

    const contentType = (res.headers.get("content-type") || "")
      .split(";")[0]
      .trim();
    const body = await readBodySnippet(res);
    return { status: res.status, contentType, body };
  } catch (error) {
    return {
      status: 0,
      contentType: (error as Error)?.name || "FetchError",
      body: "",
    };
  }
}

function looksLikeOpenApi(body: string): boolean {
  return (
    body.includes('"openapi"') ||
    body.includes('"swagger"') ||
    body.includes('"paths"')
  );
}

// Parse the host rather than substring-matching "github.com" (which would also
// match e.g. https://evil.com/?x=github.com). Returns "" for non-URL inputs so
// they fall through to probing.
function repoHostname(rawUrl: string): string {
  try {
    return new URL(
      rawUrl.includes("://") ? rawUrl : `https://${rawUrl}`,
    ).hostname
      .replace(/^www\./, "")
      .toLowerCase();
  } catch {
    return "";
  }
}

interface Subnet {
  netuid: unknown;
  name: unknown;
  url: string;
}

async function classify(subnet: Subnet): Promise<Row> {
  const url = subnet.url;
  const host = repoHostname(url);
  if (host === "github.com" || host.endsWith(".github.com")) {
    return { ...subnet, classification: "repo", callable: false, status: null };
  }
  const base = url.replace(/\/$/, "");
  // Probe the common callable-API paths first — a hit is the high-value signal.
  for (const apiPath of API_PATHS) {
    const probe = await safeFetch(base + apiPath);
    if (probe.status === 200 && isJsonContentType(probe.contentType)) {
      return {
        ...subnet,
        classification: looksLikeOpenApi(probe.body) ? "openapi" : "json-api",
        callable: true,
        status: probe.status,
        discovered_url: base + apiPath,
      };
    }
  }
  const root = await safeFetch(base);
  if (root.status === 0) {
    return {
      ...subnet,
      classification: "dead",
      callable: false,
      status: 0,
      error: root.contentType,
    };
  }
  if (isJsonContentType(root.contentType) && looksLikeOpenApi(root.body)) {
    return {
      ...subnet,
      classification: "openapi",
      callable: true,
      status: root.status,
      discovered_url: base,
    };
  }
  if (isJsonContentType(root.contentType)) {
    return {
      ...subnet,
      classification: "maybe-api",
      callable: false,
      status: root.status,
    };
  }
  let classification = "website";
  if (root.body.includes("docusaurus") || root.body.includes("gitbook")) {
    classification = "docs";
  }
  return { ...subnet, classification, callable: false, status: root.status };
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      out[index] = await fn(items[index]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return out;
}

async function main(): Promise<Row> {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  const outPath = outIndex >= 0 ? args[outIndex + 1] : null;
  const asJson = args.includes("--json");

  const snapshot: Row = await readJson(SNAPSHOT);
  const targets = ((snapshot.subnets as Row[]) || [])
    .map((s) => ({
      netuid: s.netuid,
      name: s.name,
      url: (s.chain_identity as Row | undefined)?.subnet_url || null,
    }))
    .filter(
      (s): s is Subnet =>
        typeof s.url === "string" && /^https?:\/\//.test(s.url),
    );

  const results = await mapLimit(targets, CONCURRENCY, classify);
  const callable = results.filter((r) => r.callable);
  const byClassification: Record<string, number> = {};
  for (const r of results) {
    const key = r.classification as string;
    byClassification[key] = (byClassification[key] || 0) + 1;
  }

  const report = {
    schema_version: 1,
    generated_at: buildTimestamp(),
    network: "test",
    source: "testnet-surface-discovery",
    summary: {
      subnet_urls_probed: targets.length,
      callable_count: callable.length,
      by_classification: byClassification,
    },
    callable_apis: callable.sort(
      (a, b) => (a.netuid as number) - (b.netuid as number),
    ),
    results: results.sort(
      (a, b) => (a.netuid as number) - (b.netuid as number),
    ),
  };

  if (outPath) {
    await fs.writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return report;
  }

  console.log(`Testnet surface discovery — ${report.generated_at}`);
  console.log(
    `Probed ${targets.length} subnet_urls → ${JSON.stringify(byClassification)}`,
  );
  if (callable.length === 0) {
    console.log(
      "No callable testnet subnet APIs found. (Re-run as subnets mature; a hit is the signal to curate it as a testnet surface.)",
    );
  } else {
    console.log(
      `\n${callable.length} CALLABLE testnet API(s) — promote these:`,
    );
    for (const c of callable) {
      console.log(
        `  sn${c.netuid} ${c.name}: ${c.discovered_url} [${c.classification}]`,
      );
    }
  }
  return report;
}

export { classify };

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  initSentry("discover-testnet-surfaces");
  main()
    .then(async () => {
      await endSessionAndFlush();
    })
    .catch(async (error) => {
      console.error(
        `testnet discovery failed: ${(error as Error)?.message || error}`,
      );
      // Explicit capture required here (not left to @sentry/node's default
      // OnUnhandledRejection integration, see observability.mjs's own
      // comment): Node stops considering a promise "unhandled" once
      // something calls .catch() on it, which this script already did
      // before Sentry instrumentation existed.
      await captureFatalAndExit(error);
    });
}
