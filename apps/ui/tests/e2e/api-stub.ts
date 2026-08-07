#!/usr/bin/env node
// A local, deterministic stand-in for api.metagraph.sh, replaying the same
// HAR fixtures the browser-level replay uses.
//
// WHY THIS EXISTS
//
// `page.routeFromHAR` intercepts requests the BROWSER makes. It cannot see a
// request the server makes, and this app makes plenty: router.tsx wires
// `setupRouterSsrQueryIntegration`, so a route's `useSuspenseQuery` runs
// during SSR and fetches before any HTML is streamed. Those fetches went
// straight to live production, which made the supposedly-deterministic sweep
// depend on the health of a real API. Caught in the act:
//
//   ✘ [ERROR] Error in renderToReadableStream: ApiError: The event history
//   for 5Gsb... could not be read right now ... status: 503,
//   code: 'account_summary_unavailable',
//   url: 'https://api.metagraph.sh/api/v1/accounts/5Gsb...'
//
// -- a genuine production tier failure, surfacing as an SSR error inside a
// test run that had nothing to do with it. The overflow sweep's own comment
// claimed "this app fetches everything client-side -- no SSR loaders,
// confirmed empirically"; that stopped being true.
//
// Pointing the build's VITE_METAGRAPH_API_BASE at this server closes the
// hole for BOTH sides at once: SSR and the browser hit the same recorded
// bytes, and the run no longer touches the network.
import { createServer } from "node:http";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { HAR_DIR, DATED_ENDPOINT_PATTERNS } from "./har-path.ts";

const port = Number(process.argv[2] ?? 8081);
// `--record` fills gaps from live production and writes them to the
// supplement below. Needed because the HARs cannot contain SSR-only
// endpoints: they were captured through a browser, and a request the SERVER
// makes never passes through one. /api/v1/accounts/{ss58} is the worked
// example -- its eight sub-resources are all recorded, and the summary the
// page's SSR `useSuspenseQuery` actually blocks on is not.
const recording = process.argv.includes("--record");
const SUPPLEMENT = path.join(HAR_DIR, "ssr-supplement.json");
const UPSTREAM = "https://api.metagraph.sh";

type Recorded = { status: number; contentType: string; body: Buffer };

/** pathname + search -> response, the precise match. */
const byUrl = new Map<string, Recorded>();
/** pathname -> response, for a query string that differs from the recording. */
const byPath = new Map<string, Recorded>();
/** Endpoints whose PATH carries a volatile segment (a date); matched by regex. */
const byPattern: { pattern: RegExp; recorded: Recorded }[] = [];

function decode(entry: {
  response: { status: number; content?: Record<string, unknown> };
}): Recorded {
  const content = (entry.response.content ?? {}) as {
    encoding?: string;
    text?: string;
    mimeType?: string;
  };
  return {
    status: entry.response.status,
    contentType: content.mimeType || "application/json",
    body:
      content.encoding === "base64"
        ? Buffer.from(content.text ?? "", "base64")
        : Buffer.from(content.text ?? "", "utf8"),
  };
}

let entryCount = 0;
for (const file of readdirSync(HAR_DIR).filter((f) => f.endsWith(".har"))) {
  const har = JSON.parse(readFileSync(path.join(HAR_DIR, file), "utf8"));
  for (const entry of har.log.entries) {
    const url = new URL(entry.request.url);
    const recorded = decode(entry);
    entryCount += 1;
    // First recording of a URL wins. Fixtures overlap heavily (every route
    // pulls /api/v1/icon, /coverage, /health), and picking one consistently
    // beats letting readdir order decide which route's copy a given run gets.
    const withQuery = url.pathname + url.search;
    if (!byUrl.has(withQuery)) byUrl.set(withQuery, recorded);
    if (!byPath.has(url.pathname)) byPath.set(url.pathname, recorded);
    for (const pattern of DATED_ENDPOINT_PATTERNS) {
      if (pattern.test(entry.request.url) && !byPattern.some((p) => p.pattern === pattern)) {
        byPattern.push({ pattern, recorded });
      }
    }
  }
}

// The SSR-only supplement, recorded by `--record` and committed alongside
// the HARs. Loaded last so a real HAR always wins.
type Supplement = Record<string, { status: number; contentType: string; bodyBase64: string }>;
const supplement: Supplement = existsSync(SUPPLEMENT)
  ? (JSON.parse(readFileSync(SUPPLEMENT, "utf8")) as Supplement)
  : {};
for (const [key, value] of Object.entries(supplement)) {
  entryCount += 1;
  const recorded = {
    status: value.status,
    contentType: value.contentType,
    body: Buffer.from(value.bodyBase64, "base64"),
  };
  if (!byUrl.has(key)) byUrl.set(key, recorded);
  // Also index by bare pathname. Recording captures the exact query a route
  // happened to send; the app varies them (sort, limit, window), and without
  // this a recorded endpoint still 404s the moment a parameter differs.
  // /api/v1/validators did exactly that -- recorded, and still missing at
  // test time, which left /validators with no table at all.
  const pathname = key.split("?")[0]!;
  if (!byPath.has(pathname)) byPath.set(pathname, recorded);
}

function lookup(rawUrl: string): Recorded | null {
  const url = new URL(rawUrl, `http://127.0.0.1:${port}`);
  return (
    byUrl.get(url.pathname + url.search) ??
    byPath.get(url.pathname) ??
    byPattern.find((p) => p.pattern.test(url.pathname))?.recorded ??
    null
  );
}

// Misses are reported once each. A route that starts requesting an endpoint
// no fixture covers should be loud about it -- that is the signal to
// re-record, and the alternative (silently serving a 404 the app renders as
// an empty state) is how a stale fixture hides for weeks.
const reportedMisses = new Set<string>();

/**
 * Fetches a missing endpoint from live production and persists it, so the
 * next run is hermetic. Only 2xx is stored: baking in a transient 503 would
 * enshrine exactly the failure this whole layer exists to keep out of test
 * runs (and that endpoint really was 503ing when this was written).
 */
async function record(pathAndQuery: string): Promise<Recorded | null> {
  try {
    const upstream = await fetch(UPSTREAM + pathAndQuery);
    const body = Buffer.from(await upstream.arrayBuffer());
    const contentType = upstream.headers.get("content-type") ?? "application/json";
    if (!upstream.ok) {
      console.error(
        `[api-stub] REFUSING to record ${pathAndQuery}: upstream returned ${upstream.status}. ` +
          `Re-run --record when it is healthy; a recorded error is worse than a gap.`,
      );
      return null;
    }
    supplement[pathAndQuery] = {
      status: upstream.status,
      contentType,
      bodyBase64: body.toString("base64"),
    };
    writeFileSync(SUPPLEMENT, `${JSON.stringify(supplement, null, 2)}\n`);
    const recorded = { status: upstream.status, contentType, body };
    byUrl.set(pathAndQuery, recorded);
    console.log(`[api-stub] recorded ${pathAndQuery} (${body.length} bytes)`);
    return recorded;
  } catch (error) {
    console.error(`[api-stub] failed to record ${pathAndQuery}: ${String(error)}`);
    return null;
  }
}

const server = createServer((req, res) => {
  const origin = req.headers.origin ?? "*";
  const cors = {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "*",
    vary: "Origin",
  };
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    res.end();
    return;
  }

  const serve = (recorded: Recorded) => {
    res.writeHead(recorded.status, { ...cors, "content-type": recorded.contentType });
    res.end(recorded.body);
  };

  const hit = lookup(req.url ?? "/");
  if (hit) {
    serve(hit);
    return;
  }

  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  const pathAndQuery = url.pathname + url.search;
  if (recording) {
    void record(pathAndQuery).then((recorded) => {
      if (recorded) return serve(recorded);
      res.writeHead(404, { ...cors, "content-type": "application/json" });
      res.end(JSON.stringify({ error: "record_failed", path: url.pathname }));
    });
    return;
  }

  if (!reportedMisses.has(url.pathname)) {
    reportedMisses.add(url.pathname);
    console.error(
      `[api-stub] MISS ${url.pathname} -- no fixture covers it. Re-record with ` +
        `\`node tests/e2e/api-stub.ts ${port} --record\` and replay the routes.`,
    );
  }
  res.writeHead(404, { ...cors, "content-type": "application/json" });
  res.end(JSON.stringify({ error: "no_fixture", path: url.pathname }));
});

// Node closes an idle keep-alive socket after 5s by default. workerd pools
// connections and will happily reuse one at the moment Node is retiring it,
// and the loser of that race is the request: it surfaces inside the app as
// `ApiError: Network connection lost` with status 0. Sequential traffic never
// shows it -- a `curl` pass over every route produced zero -- but a run with
// two Playwright workers produced 222, which read as the API being broken
// when it was purely a socket-lifetime race.
//
// Keep sockets open far longer than any single run needs, and keep
// headersTimeout above keepAliveTimeout so Node never times out a socket it
// is still willing to keep.
server.keepAliveTimeout = 120_000;
server.headersTimeout = 125_000;
server.maxRequestsPerSocket = 0; // unlimited
server.on("clientError", (_error, socket) => {
  if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

server.listen(port, "127.0.0.1", () => {
  console.log(
    `[api-stub] replaying ${entryCount} recorded responses ` +
      `(${byUrl.size} urls, ${byPath.size} paths) on http://127.0.0.1:${port}`,
  );
});
