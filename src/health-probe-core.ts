// Pure, isomorphic surface-probing primitives shared by the Node data build
// (scripts/probes-smoke.mjs) and the Cloudflare cron prober (src/health-prober.ts,
// wired through workers/api.mjs `scheduled()`).
//
// NO module-level I/O: `fetch`, the SSRF guard, and the WebSocket connector are
// INJECTED so every branch is unit-testable and the code runs unchanged on the
// Workers runtime and Node 22 (both expose fetch, AbortController, performance,
// URL, TextEncoder). The classification + scoring logic is lifted verbatim from
// the historical build so artifacts stay byte-stable after the extraction
// (writeJson sorts keys via stableStringify, so only VALUES must match).
import { ipv6EmbeddedIpv4 } from "./ip-safety.ts";

export const SUBTENSOR_PROBE_CALLS = [
  {
    key: "chain_getHeader",
    method: "chain_getHeader",
    params: [] as unknown[],
  },
  { key: "system_health", method: "system_health", params: [] as unknown[] },
  { key: "rpc_methods", method: "rpc_methods", params: [] as unknown[] },
  {
    key: "archive_probe",
    method: "chain_getBlockHash",
    params: [1] as unknown[],
  },
  // Genesis (block 0) hash — uniquely identifies the network. Lets us reject an
  // RPC endpoint that answers but is on the WRONG chain (cosmos.directory checks
  // chain_id the same way). A wrong/misconfigured submitted endpoint returns a
  // different genesis and is excluded before it can pollute the proxy pool.
  { key: "genesis", method: "chain_getBlockHash", params: [0] as unknown[] },
];

// Finney (Bittensor mainnet) genesis hash — verified live against
// bittensor-finney.api.onfinality.io. Endpoints whose block-0 hash differs are
// classified `wrong-chain`. Override per-network via probeSubtensorHttp options.
export const FINNEY_GENESIS_HASH =
  "0x2f0555cc76fc2840a25a6ea3b9637146806f1f44b090c175ffde2a7e5ab36c03";

function normalizeHash(value: unknown): string | null {
  return typeof value === "string" ? value.trim().toLowerCase() : null;
}

// Surface kinds whose health changes minute-to-minute and is worth probing live
// (the 15-minute cron prober). Everything else — docs, website, source-repo,
// dashboard, openapi, sdk, example, repo-registry — stays on the slower batch build.
// This is the single source of truth: scripts/build-artifacts.mjs emits the
// operational-surfaces.json list from it, and the Worker prober consumes that list.
export const OPERATIONAL_SURFACE_KINDS = [
  "subtensor-rpc",
  "subtensor-wss",
  "archive",
  "subnet-api",
  "sse",
  "data-artifact",
];

// --- URL safety: isomorphic literal SSRF guard --------------------------------
// Best-effort default used by the Worker (which cannot resolve DNS). The Node
// build injects the stronger DNS-aware `isUnsafeResolvedUrl` from scripts/lib.mjs.
// Operational surfaces are already curated `public_safe`, so this is defense in
// depth, not the primary control.
// IPv4 + registrable-domain literal patterns. IPv6-literal ranges are handled
// separately by isUnsafeIpv6Literal — applying an IPv6 prefix like `fd` to every
// host wrongly rejected public domains (fda.gov, fd.io) as unique-local (#2375).
const UNSAFE_HOST_PATTERNS = [
  /^localhost$/i,
  /\.localhost$/i,
  /\.local$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  // 100.64.0.0/10 CGNAT — blocked by the webhook + build SSRF guards; the probe
  // literal guard must stay in parity (issue #2312).
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  // Non-global special-use IPv4 the webhook + build guards already reject; the
  // probe literal guard drifted out of parity and let these through (both as a
  // direct host and as an IPv4 tunnelled inside an IPv6 literal, since the
  // embedded-v4 re-check below reuses this list). Mirror src/webhooks.mjs:
  //   192.0.0.0/24   IETF protocol assignments
  //   198.18.0.0/15  benchmarking (RFC 2544)
  //   224.0.0.0/3    multicast 224/4 + reserved 240/4 (incl. 255/8 broadcast) —
  //                  not global unicast, matching the a>=224 guard (#1538).
  /^192\.0\.0\./,
  /^198\.1[89]\./,
  /^(22[4-9]|2[3-5]\d)\./,
];

// IPv6-literal SSRF ranges, checked only when the host is an actual IPv6 literal
// (it contains a colon — a registrable domain never does). Mirrors the webhook
// guard in src/webhooks.mjs so the two stay at parity:
//   ::1            loopback
//   ::             unspecified
//   fe00::/8       link-local fe80::/10 + deprecated site-local fec0::/10 (#1538)
//   fc00::/7       unique-local — first hextet fc00–fdff, i.e. an fc__/fd__ prefix
//   ff00::/8       multicast — not global unicast (2000::/3), matching the a>=224
//                  IPv4 broadcast/multicast guard (#1538)
// The full fc00::/7 range matters: the old /^fc00:/ only caught the literal fc00:
// hextet and let other ULAs (fc12::1, fdab::1) through (#2375). The ff__ multicast
// prefix was missing here while the webhook guard already blocked it, so the probe
// literal guard let ff02::1 (all-routers) and other multicast targets through.
function isUnsafeIpv6Literal(host: string): boolean {
  return (
    host === "::1" ||
    host === "::" ||
    host.startsWith("fe") ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    host.startsWith("ff")
  );
}

export function isUnsafePublicUrl(value: unknown): boolean {
  try {
    const url = new URL(value as string);
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
      return true;
    }
    const host = String(url.hostname || "")
      .trim()
      .toLowerCase()
      .replace(/^\[(.*)\]$/, "$1")
      .replace(/\.$/, "");
    if (!host) {
      return true;
    }
    // 172.16.0.0 – 172.31.255.255 (private range).
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
      return true;
    }
    // IPv4 tunnelled inside an IPv6 literal (::ffff:a.b.c.d mapped, ::a.b.c.d
    // compatible, 2002::/16 6to4, 64:ff9b::/96 NAT64) hides a private/loopback
    // target — e.g. ::ffff:169.254.169.254 (cloud metadata) — from the prefix
    // patterns. Re-check the embedded v4 against the same ranges.
    const embedded = ipv6EmbeddedIpv4(host);
    if (embedded) {
      const dotted = embedded.join(".");
      if (
        /^172\.(1[6-9]|2\d|3[01])\./.test(dotted) ||
        UNSAFE_HOST_PATTERNS.some((pattern) => pattern.test(dotted))
      ) {
        return true;
      }
    }
    // An IPv6 literal (host contains a colon) is matched only against the IPv6
    // ranges; the IPv4/domain patterns never apply to it. Conversely, a domain
    // or IPv4 host is never tested against the IPv6 prefixes — that parity is
    // what keeps public `fd*`/`fc*` domains probeable (#2375).
    if (host.includes(":")) {
      return isUnsafeIpv6Literal(host);
    }
    return UNSAFE_HOST_PATTERNS.some((pattern) => pattern.test(host));
  } catch {
    return true;
  }
}

export function isJsonContentType(value: unknown): boolean {
  return String(value || "")
    .toLowerCase()
    .includes("json");
}

export function acceptHeader(expect: unknown): string {
  switch (expect) {
    case "json":
      return "application/json";
    case "html":
      return "text/html,application/xhtml+xml";
    case "sse":
      return "text/event-stream";
    default:
      return "*/*";
  }
}

interface ProbeOptions {
  isUnsafeUrl?: (url: unknown) => boolean | Promise<boolean>;
  fetchImpl?: typeof fetch;
  connect?: (
    url: string,
    calls: typeof SUBTENSOR_PROBE_CALLS,
    timeoutMs: number,
  ) => Promise<Map<string, JsonRpcCallResult>>;
  expectedGenesis?: string;
}

export interface HttpProbeResult {
  ok?: boolean;
  error?: string | null;
  error_class?: string | null;
  content_type?: string | null;
  latency_ms: number;
  method_tested?: string;
  status_code?: number | null;
  redirect_target?: string | null;
  unsafe_url?: boolean;
  private_redirect_blocked?: boolean;
  verified_at?: string;
}

// --- HTTP(S) probe ------------------------------------------------------------
export async function probeUrl(
  url: string,
  method: string,
  accept: string,
  timeoutMs: number,
  options: ProbeOptions = {},
  redirectCount = 0,
): Promise<HttpProbeResult> {
  const { isUnsafeUrl = isUnsafePublicUrl, fetchImpl = fetch } = options;

  if (await isUnsafeUrl(url)) {
    return {
      ok: false,
      error: "unsafe URL",
      latency_ms: 0,
      method_tested: method,
      unsafe_url: true,
      verified_at: new Date().toISOString(),
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();

  try {
    const response = await fetchImpl(url, {
      method,
      headers: {
        accept,
        "user-agent": "metagraphed-smoke-probe/0.0",
      },
      redirect: "manual",
      signal: controller.signal,
    });

    const latencyMs = Math.round(performance.now() - started);
    const location = response.headers.get("location");
    if (
      [301, 302, 303, 307, 308].includes(response.status) &&
      location &&
      redirectCount < 5
    ) {
      const redirectTarget = new URL(location, url).toString();
      if (await isUnsafeUrl(redirectTarget)) {
        await response.body?.cancel();
        return {
          ok: false,
          error: "redirect target is unsafe",
          latency_ms: latencyMs,
          method_tested: method,
          private_redirect_blocked: true,
          redirect_target: redirectTarget,
          status_code: response.status,
          verified_at: new Date().toISOString(),
        };
      }
      await response.body?.cancel();
      const redirected = await probeUrl(
        redirectTarget,
        method,
        accept,
        timeoutMs,
        options,
        redirectCount + 1,
      );
      return {
        ...redirected,
        latency_ms: latencyMs + (redirected.latency_ms || 0),
        redirect_target: redirected.redirect_target || redirectTarget,
      };
    }

    const contentType = response.headers.get("content-type") || "";
    await response.body?.cancel();
    return {
      ok: response.ok,
      content_type: contentType || null,
      latency_ms: latencyMs,
      method_tested: method,
      status_code: response.status,
      verified_at: new Date().toISOString(),
    };
  } catch (error) {
    return {
      ok: false,
      error: (error as Error).message,
      error_class: (error as Error).name,
      latency_ms: Math.round(performance.now() - started),
      method_tested: method,
      verified_at: new Date().toISOString(),
    };
  } finally {
    clearTimeout(timer);
  }
}

interface ProbeSurfaceProbeConfig {
  method: string;
  expect?: string;
  timeout_ms?: number;
}

export interface ProbeSurface {
  id: unknown;
  kind: string;
  url: string;
  netuid: unknown;
  provider: unknown;
  public_safe: unknown;
  auth_required: unknown;
  subnet_name: unknown;
  subnet_slug: unknown;
  authority?: unknown;
  probe: ProbeSurfaceProbeConfig;
}

export function classifyProbe(
  probe: HttpProbeResult,
  surface: ProbeSurface,
): string {
  if (probe.unsafe_url || probe.private_redirect_blocked) {
    return "unsafe";
  }
  if (probe.error_class === "AbortError") {
    return "timeout";
  }
  if (probe.status_code === 429) {
    return "rate-limited";
  }
  if (probe.status_code != null && [401, 403].includes(probe.status_code)) {
    return "auth-required";
  }
  if (probe.status_code != null && [404, 410].includes(probe.status_code)) {
    return "dead";
  }
  if (probe.status_code != null && probe.status_code >= 500) {
    return "transient";
  }
  if (probe.ok && contentMismatch(probe, surface)) {
    return "content-mismatch";
  }
  if (probe.ok && probe.redirect_target) {
    return "redirected";
  }
  if (probe.ok) {
    return "live";
  }
  return "unsupported";
}

export function classifyRpcProbe(probe: RpcProbeResult): string {
  if (probe.unsafe_url || probe.private_redirect_blocked) {
    return "unsafe";
  }
  if (
    probe.error_class === "AbortError" ||
    probe.error_class === "TimeoutError"
  ) {
    return "timeout";
  }
  if (probe.status_code === 429) {
    return "rate-limited";
  }
  if (probe.status_code != null && [401, 403].includes(probe.status_code)) {
    return "auth-required";
  }
  if (probe.status_code != null && probe.status_code >= 500) {
    return "transient";
  }
  // Wrong network: the node answered but its genesis hash didn't match. Only
  // triggers on an EXPLICIT mismatch (chain_verified === false); a node that
  // didn't return a genesis (null) is judged on its other methods.
  if (probe.chain_verified === false) {
    return "wrong-chain";
  }
  if (probe.error) {
    return "unsupported";
  }
  if (
    probe.method_results?.chain_getHeader?.ok &&
    probe.method_results?.system_health?.ok
  ) {
    return "live";
  }
  if (probe.method_results?.chain_getHeader?.ok) {
    return "unsupported";
  }
  return "transient";
}

export function contentMismatch(
  probe: HttpProbeResult,
  surface: ProbeSurface,
): boolean {
  if (surface.probe.expect === "json") {
    if (
      String(probe.content_type || "")
        .toLowerCase()
        .includes("text/plain") &&
      (new URL(surface.url).pathname.toLowerCase().endsWith(".json") ||
        new URL(surface.url).hostname === "raw.githubusercontent.com")
    ) {
      return false;
    }
    return !isJsonContentType(probe.content_type);
  }
  if (surface.probe.expect === "html") {
    return !String(probe.content_type || "")
      .toLowerCase()
      .includes("html");
  }
  if (surface.probe.expect === "sse") {
    return !String(probe.content_type || "")
      .toLowerCase()
      .includes("text/event-stream");
  }
  return false;
}

// Canonical probe status values — every surface row should use one of these.
// Callers that aggregate rows into rollupSubnetStatus must normalize through
// normalizeProbeStatus first so unrecognized / forward-compat strings cannot
// bypass the four buckets and roll up to a false "ok".
export const PROBE_STATUS_VALUES = Object.freeze([
  "ok",
  "degraded",
  "failed",
  "unknown",
]);

export function normalizeProbeStatus(status: unknown): string {
  return PROBE_STATUS_VALUES.includes(status as string)
    ? (status as string)
    : "unknown";
}

// Canonical subnet operational-status rollup — the SINGLE source of the
// ok/degraded/failed/unknown precedence shared by the live serve overlay
// (health-serving), the 15-minute prober, and the build/smoke status columns.
// Keeping every caller here means build-time status and live-served status can
// never silently diverge — drift in the health domain that is the product's core
// promise. Precedence: all-unknown (or empty) → unknown; no failed/degraded → ok;
// any ok or degraded present → degraded; else → failed.
export function rollupSubnetStatus({
  ok = 0,
  degraded = 0,
  failed = 0,
  unknown = 0,
  total,
}: {
  ok?: number;
  degraded?: number;
  failed?: number;
  unknown?: number;
  total: number;
}): string {
  if (total === 0 || unknown === total) return "unknown";
  if (failed === 0 && degraded === 0) return "ok";
  if (ok > 0 || degraded > 0) return "degraded";
  return "failed";
}

// Latency is a success-only signal: keep a probe's latency only when it resolved
// `ok`. Every failure (timeout, 5xx, unsafe, thrown) collapses to null, so it
// counts toward uptime but never toward the latency mean or percentiles.
export function okLatencyMs(
  status: unknown,
  latencyMs: unknown,
): number | null {
  return status === "ok" && Number.isFinite(latencyMs)
    ? (latencyMs as number)
    : null;
}

export function statusForClassification(
  classification: string,
  surface: ProbeSurface | null = null,
): string {
  if (["live", "redirected"].includes(classification)) {
    return "ok";
  }
  // Wrong network is always a hard failure — never softened by authority.
  if (classification === "wrong-chain") {
    return "failed";
  }
  if (
    ["rate-limited", "auth-required", "transient", "timeout"].includes(
      classification,
    )
  ) {
    return "degraded";
  }
  if (
    ["unsupported", "dead", "content-mismatch"].includes(classification) &&
    ["registry-observed", "community"].includes(surface?.authority as string)
  ) {
    return "degraded";
  }
  return "failed";
}

export interface NormalizedJsonRpcResult {
  ok: boolean;
  error: string | null;
  code: unknown;
  result_type: string;
  result_present: boolean;
  raw_header?: { number: unknown };
  rpc_method_count?: number;
  raw_hex_result_present?: boolean;
}

export interface JsonRpcCallResult {
  transport_error?: boolean;
  unsafe_url?: boolean;
  private_redirect_blocked?: boolean;
  redirect_target?: string;
  status_code?: number;
  content_type?: string | null;
  error?: string;
  error_class?: string;
  ok?: boolean;
  result?: unknown;
  rpc_error?: { message?: string; code?: unknown } | null;
}

export interface RpcProbeResult {
  unsafe_url?: boolean;
  private_redirect_blocked?: boolean;
  error?: string | null;
  error_class?: string | null;
  latency_ms: number;
  content_type?: string | null;
  status_code?: number | null;
  method_results?: Record<string, NormalizedJsonRpcResult>;
  chain_verified?: boolean | null;
  verified_at?: string;
  archive_support?: boolean;
  latest_block?: number | null;
  methods_supported?: {
    chain_getHeader: boolean;
    system_health: boolean;
    rpc_methods: boolean;
    chain_getBlockHash: boolean;
  };
  rpc_method_count?: number | null;
}

// --- Subtensor JSON-RPC probes (HTTP + WSS) -----------------------------------
export async function probeSubtensorHttp(
  url: string,
  timeoutMs: number,
  options: ProbeOptions = {},
): Promise<RpcProbeResult> {
  const {
    isUnsafeUrl = isUnsafePublicUrl,
    fetchImpl = fetch,
    expectedGenesis = FINNEY_GENESIS_HASH,
  } = options;
  if (await isUnsafeUrl(url)) {
    return {
      unsafe_url: true,
      error: "unsafe URL",
      latency_ms: 0,
      verified_at: new Date().toISOString(),
    };
  }

  const started = performance.now();
  const methodResults: Record<string, NormalizedJsonRpcResult> = {};
  let statusCode: number | null = null;
  let contentType: string | null = null;
  let genesisHash: string | null = null;

  for (const [index, call] of SUBTENSOR_PROBE_CALLS.entries()) {
    const response = await jsonRpcHttp(
      url,
      call.method,
      call.params,
      index + 1,
      timeoutMs,
      {
        fetchImpl,
        isUnsafeUrl,
      },
    );

    statusCode = response.status_code || statusCode;
    contentType = response.content_type || contentType;
    if (call.key === "genesis" && typeof response.result === "string") {
      genesisHash = response.result;
    }
    methodResults[call.key] = normalizeJsonRpcResult(response);

    if (response.transport_error) {
      return {
        ...response,
        content_type: contentType,
        latency_ms: Math.round(performance.now() - started),
        method_results: methodResults,
        status_code: statusCode,
        verified_at: new Date().toISOString(),
      };
    }
  }

  // chain_verified: true on a matching genesis, false on an explicit mismatch
  // (wrong network), null when the node didn't return a genesis hash (don't
  // penalize a node that simply restricts chain_getBlockHash).
  const expected = normalizeHash(expectedGenesis);
  const chainVerified = genesisHash
    ? normalizeHash(genesisHash) === expected
    : null;

  return summarizeRpcProbe({
    content_type: contentType,
    latency_ms: Math.round(performance.now() - started),
    method_results: methodResults,
    status_code: statusCode,
    chain_verified: chainVerified,
    verified_at: new Date().toISOString(),
  });
}

async function jsonRpcHttp(
  url: string,
  method: string,
  params: unknown[],
  id: number,
  timeoutMs: number,
  options: ProbeOptions = {},
): Promise<JsonRpcCallResult> {
  const { isUnsafeUrl = isUnsafePublicUrl, fetchImpl = fetch } = options;
  if (await isUnsafeUrl(url)) {
    return {
      transport_error: true,
      unsafe_url: true,
      error: "unsafe URL",
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": "metagraphed-subtensor-rpc-probe/0.0",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      redirect: "manual",
      signal: controller.signal,
    });

    const location = response.headers.get("location");
    if ([301, 302, 303, 307, 308].includes(response.status) && location) {
      const redirectTarget = new URL(location, url).toString();
      if (await isUnsafeUrl(redirectTarget)) {
        await response.body?.cancel();
        return {
          transport_error: true,
          private_redirect_blocked: true,
          redirect_target: redirectTarget,
          status_code: response.status,
          error: "redirect target is unsafe",
        };
      }
    }

    const contentType = response.headers.get("content-type") || "";
    const text = await response.text();
    let body: Record<string, unknown> | null = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      return {
        transport_error: true,
        content_type: contentType || null,
        status_code: response.status,
        error: "response was not JSON",
      };
    }

    return {
      content_type: contentType || null,
      ok: response.ok && !body?.error,
      result: body?.result,
      rpc_error:
        (body?.error as { message?: string; code?: unknown } | undefined) ||
        null,
      status_code: response.status,
    };
  } catch (error) {
    return {
      transport_error: true,
      error: (error as Error).message,
      error_class: (error as Error).name,
    };
  } finally {
    clearTimeout(timer);
  }
}

// WSS probe. The connector is injected because the runtimes differ: Node uses
// the global `WebSocket` constructor; the Worker opens an outbound socket via
// `fetch(url, { headers: { Upgrade: "websocket" } })` → `response.webSocket`.
// `connect(url, calls, timeoutMs)` resolves a Map<callKey, {ok, result, rpc_error}>.
export async function probeSubtensorWss(
  url: string,
  timeoutMs: number,
  options: ProbeOptions = {},
): Promise<RpcProbeResult> {
  const {
    isUnsafeUrl = isUnsafePublicUrl,
    connect,
    expectedGenesis = FINNEY_GENESIS_HASH,
  } = options;
  if (await isUnsafeUrl(url)) {
    return {
      unsafe_url: true,
      error: "unsafe URL",
      latency_ms: 0,
      verified_at: new Date().toISOString(),
    };
  }

  if (typeof connect !== "function") {
    return {
      error: "no WebSocket connector available in this runtime",
      error_class: "UnsupportedRuntime",
      latency_ms: 0,
      verified_at: new Date().toISOString(),
    };
  }

  const started = performance.now();
  const methodResults: Record<string, NormalizedJsonRpcResult> = {};
  try {
    const rawResults = await connect(url, SUBTENSOR_PROBE_CALLS, timeoutMs);
    let genesisHash: string | null = null;
    for (const call of SUBTENSOR_PROBE_CALLS) {
      const response = rawResults.get(call.key) || {
        error: "missing response",
      };
      if (call.key === "genesis" && typeof response.result === "string") {
        genesisHash = response.result;
      }
      methodResults[call.key] = normalizeJsonRpcResult(response);
    }
    const expected = normalizeHash(expectedGenesis);
    const chainVerified = genesisHash
      ? normalizeHash(genesisHash) === expected
      : null;
    return summarizeRpcProbe({
      latency_ms: Math.round(performance.now() - started),
      method_results: methodResults,
      chain_verified: chainVerified,
      verified_at: new Date().toISOString(),
    });
  } catch (error) {
    return {
      error: (error as Error).message,
      error_class: (error as Error).name,
      latency_ms: Math.round(performance.now() - started),
      method_results: methodResults,
      verified_at: new Date().toISOString(),
    };
  }
}

// Node WebSocket connector (uses the global `WebSocket`, Node 22+). The Worker
// supplies its own fetch-upgrade connector in src/health-prober.ts.
export function nodeWebSocketConnector(
  WebSocketImpl: typeof WebSocket | undefined = globalThis.WebSocket,
): (
  url: string,
  calls: typeof SUBTENSOR_PROBE_CALLS,
  timeoutMs: number,
) => Promise<Map<string, JsonRpcCallResult>> {
  return (url, calls, timeoutMs) =>
    new Promise((resolve, reject) => {
      if (typeof WebSocketImpl !== "function") {
        reject(new Error("WebSocket global is unavailable in this runtime"));
        return;
      }
      const socket = new WebSocketImpl(url);
      const byId = new Map(calls.map((call, index) => [index + 1, call.key]));
      const results = new Map<string, JsonRpcCallResult>();
      let settled = false;
      const timer = setTimeout(
        () =>
          finish(new Error("WebSocket RPC probe timed out"), "TimeoutError"),
        timeoutMs,
      );

      // Every terminal path (success, timeout, error, parse-error, premature
      // close) funnels through finish() so the first event wins, the timer is
      // always cleared, and the socket is ALWAYS closed — mirroring the Worker
      // connector's finish() in src/health-prober.ts (#2074). Before this, the
      // error path cleared the timer but never closed the socket (leaking a
      // half-open fd), and there was no close handler, so a server that closed
      // before all responses arrived hung the probe until the full timeout.
      function finish(error?: Error | null, name?: string): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          socket.close();
        } catch {
          // Ignore close failures on a terminal path.
        }
        if (error) {
          if (name) error.name = name;
          reject(error);
        } else {
          resolve(results);
        }
      }

      socket.addEventListener("open", () => {
        calls.forEach((call, index) => {
          socket.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: index + 1,
              method: call.method,
              params: call.params,
            }),
          );
        });
      });

      socket.addEventListener("message", (event) => {
        try {
          const body = JSON.parse(String((event as MessageEvent).data));
          const key = byId.get(body.id);
          if (!key) {
            return;
          }
          results.set(key, {
            ok: !body.error,
            result: body.result,
            rpc_error: body.error || null,
          });
          if (results.size === calls.length) {
            finish(null);
          }
        } catch (error) {
          finish(error as Error);
        }
      });

      socket.addEventListener("error", () => {
        finish(new Error("WebSocket RPC connection failed"));
      });

      // A server that accepts then closes before all responses arrive must
      // reject promptly instead of hanging until the timeout.
      socket.addEventListener("close", () => {
        if (results.size < calls.length) {
          finish(new Error("WebSocket closed before all responses"));
        }
      });
    });
}

export function normalizeJsonRpcResult(
  response: JsonRpcCallResult,
): NormalizedJsonRpcResult {
  const normalized: NormalizedJsonRpcResult = {
    ok: Boolean(response.ok),
    error: response.error || response.rpc_error?.message || null,
    code: response.rpc_error?.code || null,
    result_type:
      response.result === null
        ? "null"
        : Array.isArray(response.result)
          ? "array"
          : typeof response.result,
    result_present: response.result !== null && response.result !== undefined,
  };
  if (
    response.result &&
    typeof response.result === "object" &&
    !Array.isArray(response.result) &&
    (response.result as Record<string, unknown>).number
  ) {
    normalized.raw_header = {
      number: (response.result as Record<string, unknown>).number,
    };
  }
  if (
    response.result &&
    Array.isArray((response.result as Record<string, unknown>).methods)
  ) {
    normalized.rpc_method_count = (
      (response.result as Record<string, unknown>).methods as unknown[]
    ).length;
  }
  if (typeof response.result === "string" && response.result.startsWith("0x")) {
    normalized.raw_hex_result_present = true;
  }
  return normalized;
}

export function summarizeRpcProbe(probe: RpcProbeResult): RpcProbeResult {
  const methodResults = probe.method_results || {};
  const header = methodResults.chain_getHeader;
  const methods = methodResults.rpc_methods;
  const archiveProbe = methodResults.archive_probe;
  const latestBlock = parseBlockNumber(header?.raw_header);
  return {
    ...probe,
    archive_support: Boolean(
      archiveProbe?.ok && archiveProbe.raw_hex_result_present,
    ),
    latest_block: latestBlock,
    methods_supported: {
      chain_getHeader: Boolean(methodResults.chain_getHeader?.ok),
      system_health: Boolean(methodResults.system_health?.ok),
      rpc_methods: Boolean(methodResults.rpc_methods?.ok),
      chain_getBlockHash: Boolean(methodResults.archive_probe?.ok),
    },
    rpc_method_count: methods?.rpc_method_count ?? null,
  };
}

export function parseBlockNumber(
  header: { number?: unknown } | null | undefined,
): number | null {
  if (!header || typeof header !== "object") {
    return null;
  }
  const value = header.number;
  let block: number;
  if (typeof value === "number") {
    block = value;
  } else if (typeof value === "string") {
    block = value.startsWith("0x")
      ? Number.parseInt(value, 16)
      : Number.parseInt(value, 10);
  } else {
    return null;
  }
  // A real block height is a non-negative integer. Anything else — NaN from a
  // malformed "0x"/"0xZZ"/empty string, or a non-finite/fractional number —
  // is unusable and collapses to null, matching this function's other branches
  // (and so it never leaks NaN past the `??` fallbacks downstream).
  return Number.isInteger(block) && block >= 0 ? block : null;
}

// Bounded-concurrency map. Preserves INPUT order in the returned array (callers
// that need a different order sort afterwards). Used by both the Node build and
// the Worker cron prober to respect the runtime's simultaneous-connection cap.
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

// --- Top-level: probe one surface → common probe-derived row ------------------
// Returns the fields both callers share. It does NOT compute `last_ok` or
// `uptime_sample_ratio` (history/store-derived): the Node build computes those
// from its daily history files; the Worker computes them from D1 `surface_status`.
export async function probeSurface(
  surface: ProbeSurface,
  options: ProbeOptions = {},
): Promise<Record<string, unknown>> {
  const isRpc = ["subtensor-rpc", "subtensor-wss"].includes(surface.kind);
  if (isRpc) {
    const timeoutMs = surface.probe.timeout_ms || 12000;
    const fallbackVerifiedAt = new Date().toISOString();
    const probe =
      surface.kind === "subtensor-wss"
        ? await probeSubtensorWss(surface.url, timeoutMs, options)
        : await probeSubtensorHttp(surface.url, timeoutMs, options);
    const classification = classifyRpcProbe(probe);
    const status = statusForClassification(classification, surface);
    const verifiedAt = probe.verified_at || fallbackVerifiedAt;
    // NOTE: pass probe fields through verbatim (no `?? null`). In the
    // transport-error case the RPC probe omits archive_support/latest_block/
    // methods_supported/rpc_method_count entirely; preserving `undefined` keeps
    // the Node build's stableStringify output byte-identical (undefined keys are
    // dropped). The Worker coerces to null at the D1 column boundary.
    return {
      archive_support: probe.archive_support,
      auth_required: surface.auth_required,
      classification,
      content_type: probe.content_type || null,
      error: probe.error || null,
      error_class: probe.error_class || null,
      kind: surface.kind,
      last_checked: verifiedAt,
      latency_ms: probe.latency_ms,
      latest_block: probe.latest_block,
      method_results: probe.method_results,
      method_tested: surface.probe.method,
      methods_supported: probe.methods_supported,
      netuid: surface.netuid,
      private_redirect_blocked: probe.private_redirect_blocked || false,
      provider: surface.provider,
      public_safe: surface.public_safe,
      redirect_target: null,
      rpc_method_count: probe.rpc_method_count,
      status,
      status_code: probe.status_code || null,
      subnet_name: surface.subnet_name,
      subnet_slug: surface.subnet_slug,
      surface_id: surface.id,
      url: surface.url,
      verified_at: verifiedAt,
    };
  }

  const timeoutMs = surface.probe.timeout_ms || 8000;
  let probe = await probeUrl(
    surface.url,
    surface.probe.method,
    acceptHeader(surface.probe.expect),
    timeoutMs,
    options,
  );
  if (
    !probe.ok &&
    surface.probe.method === "HEAD" &&
    probe.status_code != null &&
    [400, 403, 405].includes(probe.status_code)
  ) {
    probe = await probeUrl(
      surface.url,
      "GET",
      acceptHeader(surface.probe.expect),
      timeoutMs,
      options,
    );
  }
  const classification = classifyProbe(probe, surface);
  const status = statusForClassification(classification, surface);
  return {
    auth_required: surface.auth_required,
    classification,
    content_type: probe.content_type || null,
    error: probe.error || null,
    error_class: probe.error_class || null,
    kind: surface.kind,
    last_checked: probe.verified_at,
    latency_ms: probe.latency_ms,
    method_tested: probe.method_tested,
    netuid: surface.netuid,
    private_redirect_blocked: probe.private_redirect_blocked || false,
    provider: surface.provider,
    public_safe: surface.public_safe,
    redirect_target: probe.redirect_target || null,
    status,
    status_code: probe.status_code || null,
    subnet_name: surface.subnet_name,
    subnet_slug: surface.subnet_slug,
    surface_id: surface.id,
    url: surface.url,
    verified_at: probe.verified_at,
  };
}
