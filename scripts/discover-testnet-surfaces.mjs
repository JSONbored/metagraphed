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
// Usage: node scripts/discover-testnet-surfaces.mjs [--out path] [--json]

import { promises as fs } from "node:fs";
import path from "node:path";
import {
  isUnsafeResolvedUrl,
  readJson,
  repoRoot,
  buildTimestamp,
} from "./lib.mjs";

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

async function readBodySnippet(res) {
  if (!res.body) {
    return "";
  }

  const reader = res.body.getReader();
  const chunks = [];
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

async function safeFetch(url, redirectCount = 0) {
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

    const contentType = (res.headers.get("content-type") || "").split(";")[0];
    const body = await readBodySnippet(res);
    return { status: res.status, contentType, body };
  } catch (error) {
    return { status: 0, contentType: error?.name || "FetchError", body: "" };
  }
}

function looksLikeOpenApi(body) {
  return (
    body.includes('"openapi"') ||
    body.includes('"swagger"') ||
    body.includes('"paths"')
  );
}

// Parse the host rather than substring-matching "github.com" (which would also
// match e.g. https://evil.com/?x=github.com). Returns "" for non-URL inputs so
// they fall through to probing.
function repoHostname(rawUrl) {
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

async function classify(subnet) {
  const url = subnet.url;
  const host = repoHostname(url);
  if (host === "github.com" || host.endsWith(".github.com")) {
    return { ...subnet, classification: "repo", callable: false, status: null };
  }
  const base = url.replace(/\/$/, "");
  // Probe the common callable-API paths first — a hit is the high-value signal.
  for (const apiPath of API_PATHS) {
    const probe = await safeFetch(base + apiPath);
    if (probe.status === 200 && probe.contentType.includes("json")) {
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
  if (root.contentType.includes("json") && looksLikeOpenApi(root.body)) {
    return {
      ...subnet,
      classification: "openapi",
      callable: true,
      status: root.status,
      discovered_url: base,
    };
  }
  if (root.contentType.includes("json")) {
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

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
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

async function main() {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  const outPath = outIndex >= 0 ? args[outIndex + 1] : null;
  const asJson = args.includes("--json");

  const snapshot = await readJson(SNAPSHOT);
  const targets = (snapshot.subnets || [])
    .map((s) => ({
      netuid: s.netuid,
      name: s.name,
      url: s.chain_identity?.subnet_url || null,
    }))
    .filter((s) => typeof s.url === "string" && /^https?:\/\//.test(s.url));

  const results = await mapLimit(targets, CONCURRENCY, classify);
  const callable = results.filter((r) => r.callable);
  const byClassification = {};
  for (const r of results) {
    byClassification[r.classification] =
      (byClassification[r.classification] || 0) + 1;
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
    callable_apis: callable.sort((a, b) => a.netuid - b.netuid),
    results: results.sort((a, b) => a.netuid - b.netuid),
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

main().catch((error) => {
  console.error(`testnet discovery failed: ${error?.message || error}`);
  process.exit(1);
});
