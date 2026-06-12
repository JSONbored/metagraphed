// Stateless remote MCP (Model Context Protocol) server for metagraphed.
//
// Exposes the operational registry to AI agents (Claude Desktop/Code, Cursor,
// autonomous agents) over the MCP Streamable HTTP transport at `POST /mcp`.
// The registry is read-only, so the server is fully stateless: no session id,
// no Durable Object, no server-initiated streams. We hand-roll the JSON-RPC 2.0
// envelope rather than pulling in `@modelcontextprotocol/sdk` so the Worker
// bundle stays lean and the hot REST/RPC path is untouched.
//
// Artifact/KV reads are injected (`deps.readArtifact`, `deps.readHealthKv`) so
// this module is pure and unit-testable, and so it reuses the exact same
// R2/ASSETS resolution the REST routes use.
import { CONTRACT_VERSION, PRIMARY_DOMAIN } from "./contracts.mjs";
import { KV_HEALTH_RPC_POOL } from "./health-prober.mjs";
import { overlayRpcPoolEligibility } from "./health-serving.mjs";
import {
  aiEnabled,
  askQuestion,
  semanticSearch,
  withinRateLimit,
} from "./ai-search.mjs";

// Protocol versions we understand. We echo the client's requested version when
// it is one of these, otherwise we answer with our latest.
export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MCP_LATEST_PROTOCOL = MCP_PROTOCOL_VERSIONS[0];

export const MCP_SERVER_INFO = {
  name: "metagraphed",
  title: "metagraphed — Bittensor subnet operational registry",
  version: CONTRACT_VERSION,
};

export const MCP_INSTRUCTIONS =
  "metagraphed is the operational + integration registry for Bittensor subnets: " +
  "what each of the ~129 subnets exposes (APIs, docs, schemas), whether those " +
  "surfaces are healthy, and how to call them. Use search_subnets / " +
  "find_subnets_by_capability to discover by keyword/capability, semantic_search " +
  "to discover by intent (meaning-based), and ask for a grounded natural-" +
  "language answer with citations; get_subnet / get_subnet_health for detail, " +
  "list_subnet_apis + get_api_schema to integrate a subnet's API, and " +
  "get_best_rpc_endpoint for a live-healthy Bittensor base-layer RPC endpoint. " +
  "All data is public and read-only.";

const JSONRPC_VERSION = "2.0";

// Abuse controls for the public Streamable-HTTP endpoint. Keep these small
// enough to prevent one unauthenticated request from amplifying into many
// artifact/KV reads, while still allowing legacy clients that send tiny
// JSON-RPC batches.
export const MAX_MCP_BODY_BYTES = 64 * 1024;
export const MAX_MCP_BATCH_LENGTH = 10;
const MCP_RATE_LIMIT = { limit: 100, windowSeconds: 60 };

// JSON-RPC error codes (subset of the spec we emit).
const RPC_PARSE_ERROR = -32700;
const RPC_INVALID_REQUEST = -32600;
const RPC_METHOD_NOT_FOUND = -32601;
const RPC_INTERNAL_ERROR = -32603;

// A tool-level failure: surfaced to the client as a successful tools/call result
// with isError:true (per MCP), not as a transport JSON-RPC error.
function toolError(code, message) {
  const error = new Error(message);
  error.toolError = true;
  error.code = code;
  return error;
}

async function loadArtifactData(ctx, artifactPath) {
  const result = await ctx.readArtifact(ctx.env, artifactPath);
  if (!result || !result.ok) {
    throw toolError(
      result?.code || "artifact_unavailable",
      result?.message || `Artifact is not available: ${artifactPath}`,
    );
  }
  return result.data;
}

// AI-dependent tools (semantic_search, ask) need the VECTORIZE + AI bindings and
// the kill-switch on. In a cold/CI env they degrade to a graceful isError result
// pointing at the keyword fallback, never a transport error.
function requireAi(ctx) {
  if (!aiEnabled(ctx.env)) {
    throw toolError(
      "ai_unavailable",
      "The AI layer is not enabled in this environment. Use search_subnets / " +
        "find_subnets_by_capability for keyword discovery instead.",
    );
  }
}

function mcpAiClientKey(ctx, scope) {
  return `${scope}:${ctx.clientIp || "anon"}`;
}

async function requireAiRateLimit(ctx, scope) {
  if (await withinRateLimit(ctx.env, mcpAiClientKey(ctx, scope))) return;
  throw toolError(
    "rate_limited",
    "Too many AI requests. Please retry shortly.",
  );
}

// Run an ai-search call, mapping its input-validation errors to tool errors so
// they surface as a clean isError result instead of a thrown transport error.
async function runAi(fn) {
  try {
    return await fn();
  } catch (error) {
    if (error?.aiInput) throw toolError("invalid_params", error.message);
    throw error;
  }
}

function requireNetuid(args) {
  const netuid = args?.netuid;
  if (!Number.isInteger(netuid) || netuid < 0) {
    throw toolError(
      "invalid_params",
      "Argument `netuid` must be a non-negative integer.",
    );
  }
  return netuid;
}

function requireString(args, key) {
  const value = args?.[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw toolError(
      "invalid_params",
      `Argument \`${key}\` must be a non-empty string.`,
    );
  }
  return value.trim();
}

function clampLimit(value, fallback, max) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value)));
}

// Score a search document against the query terms: how many distinct terms
// appear as substrings of the document's title/subtitle/tokens haystack.
function scoreDocument(doc, terms) {
  const haystack = [
    doc.title,
    doc.subtitle,
    doc.slug,
    ...(Array.isArray(doc.tokens) ? doc.tokens : []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (haystack.includes(term)) score += 1;
  }
  return score;
}

function queryTerms(query) {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 0);
}

// ---------------------------------------------------------------------------
// Tool registry. Each tool is a thin wrapper over artifact/KV reads.
// ---------------------------------------------------------------------------

export const MCP_TOOLS = [
  {
    name: "search_subnets",
    title: "Search Bittensor subnets",
    description:
      "Full-text search across Bittensor subnets by name, slug, capability, " +
      "or keyword. Returns ranked matches with netuid, slug, title, and a one-" +
      "line description. Use this to discover subnets before fetching detail.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search terms, e.g. 'image generation' or 'scraping'.",
        },
        limit: {
          type: "integer",
          description: "Max results (1-50, default 10).",
          minimum: 1,
          maximum: 50,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const query = requireString(args, "query");
      const limit = clampLimit(args?.limit, 10, 50);
      const index = await loadArtifactData(ctx, "/metagraph/search.json");
      const terms = queryTerms(query);
      const docs = Array.isArray(index.documents) ? index.documents : [];
      const ranked = docs
        .filter((doc) => doc.type === "subnet")
        .map((doc) => ({ doc, score: scoreDocument(doc, terms) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score || a.doc.netuid - b.doc.netuid)
        .slice(0, limit)
        .map(({ doc }) => ({
          netuid: doc.netuid,
          slug: doc.slug,
          title: doc.title,
          description: doc.subtitle || null,
          url: `https://${ctx.domain}/api/v1/subnets/${doc.netuid}/overview`,
        }));
      return { query, count: ranked.length, results: ranked };
    },
  },
  {
    name: "find_subnets_by_capability",
    title: "Find subnets by capability",
    description:
      "Find Bittensor subnets that expose callable services (APIs, OpenAPI " +
      "schemas, SSE streams) matching a capability or category. Returns only " +
      "subnets an agent can actually call, ranked by callable-service count. " +
      "Pair with list_subnet_apis to get concrete endpoints.",
    inputSchema: {
      type: "object",
      properties: {
        capability: {
          type: "string",
          description:
            "Capability/category to match, e.g. 'inference', 'data', 'bitcoin'.",
        },
        limit: {
          type: "integer",
          description: "Max results (1-50, default 10).",
          minimum: 1,
          maximum: 50,
        },
      },
      required: ["capability"],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const capability = requireString(args, "capability");
      const limit = clampLimit(args?.limit, 10, 50);
      const catalog = await loadArtifactData(
        ctx,
        "/metagraph/agent-catalog.json",
      );
      const terms = queryTerms(capability);
      const subnets = Array.isArray(catalog.subnets) ? catalog.subnets : [];
      const ranked = subnets
        .map((subnet) => {
          const haystack = [
            subnet.name,
            subnet.slug,
            ...(Array.isArray(subnet.categories) ? subnet.categories : []),
            ...(Array.isArray(subnet.service_kinds)
              ? subnet.service_kinds
              : []),
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
          let score = 0;
          for (const term of terms) if (haystack.includes(term)) score += 1;
          return { subnet, score };
        })
        .filter((entry) => entry.score > 0 && entry.subnet.callable_count > 0)
        .sort(
          (a, b) =>
            b.score - a.score ||
            (b.subnet.integration_readiness || 0) -
              (a.subnet.integration_readiness || 0) ||
            b.subnet.callable_count - a.subnet.callable_count,
        )
        .slice(0, limit)
        .map(({ subnet }) => ({
          netuid: subnet.netuid,
          slug: subnet.slug,
          name: subnet.name,
          categories: subnet.categories || [],
          service_kinds: subnet.service_kinds || [],
          callable_count: subnet.callable_count,
          integration_readiness: subnet.integration_readiness ?? null,
        }));
      return { capability, count: ranked.length, results: ranked };
    },
  },
  {
    name: "get_subnet",
    title: "Get subnet overview",
    description:
      "Fetch the composed overview for one subnet by netuid: identity, " +
      "completeness, curated surfaces, health summary, gaps, and counts.",
    inputSchema: {
      type: "object",
      properties: {
        netuid: { type: "integer", description: "Subnet netuid.", minimum: 0 },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const netuid = requireNetuid(args);
      return loadArtifactData(ctx, `/metagraph/overview/${netuid}.json`);
    },
  },
  {
    name: "get_subnet_health",
    title: "Get subnet health",
    description:
      "Fetch live operational health for one subnet's surfaces (probed every " +
      "~2 minutes): per-surface status, latency, and last-ok timestamps.",
    inputSchema: {
      type: "object",
      properties: {
        netuid: { type: "integer", description: "Subnet netuid.", minimum: 0 },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const netuid = requireNetuid(args);
      return loadArtifactData(ctx, `/metagraph/health/subnets/${netuid}.json`);
    },
  },
  {
    name: "list_subnet_apis",
    title: "List a subnet's callable services",
    description:
      "List the callable services (subnet-api, openapi, sse) one subnet " +
      "exposes, each with base URL, auth requirement, machine-readable schema " +
      "URL, current health, and call eligibility. The agent integration path.",
    inputSchema: {
      type: "object",
      properties: {
        netuid: { type: "integer", description: "Subnet netuid.", minimum: 0 },
      },
      required: ["netuid"],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const netuid = requireNetuid(args);
      const data = await loadArtifactData(
        ctx,
        `/metagraph/agent-catalog/${netuid}.json`,
      );
      return {
        netuid: data.netuid ?? netuid,
        service_count: Array.isArray(data.services) ? data.services.length : 0,
        services: data.services || [],
      };
    },
  },
  {
    name: "get_api_schema",
    title: "Get a surface's API schema",
    description:
      "Fetch the captured OpenAPI/Swagger schema for a subnet surface by its " +
      "surface_id (from list_subnet_apis). Returns a sanitized full spec " +
      "under `document` (paths, components, securitySchemes) plus capture " +
      "metadata (auth_required, auth_schemes, drift_status). Use it to " +
      "generate a typed client or understand endpoints; prefer the curated " +
      "surface base_url over any upstream server/callback hints.",
    inputSchema: {
      type: "object",
      properties: {
        surface_id: {
          type: "string",
          description: "Surface id, e.g. '7:subnet-api:allways'.",
        },
      },
      required: ["surface_id"],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const surfaceId = requireString(args, "surface_id");
      // surface_id is part of an R2 key path; reject anything that could escape
      // the schemas/ namespace.
      if (!/^[A-Za-z0-9._:-]+$/.test(surfaceId)) {
        throw toolError(
          "invalid_params",
          "surface_id contains invalid characters.",
        );
      }
      return loadArtifactData(ctx, `/metagraph/schemas/${surfaceId}.json`);
    },
  },
  {
    name: "get_agent_catalog",
    title: "Get the agent capability catalog",
    description:
      "Fetch the machine-readable agent capability catalog. With no argument " +
      "returns the global index of subnets exposing callable services; with a " +
      "netuid returns that subnet's full per-service catalog.",
    inputSchema: {
      type: "object",
      properties: {
        netuid: {
          type: "integer",
          description: "Optional subnet netuid for the per-subnet catalog.",
          minimum: 0,
        },
      },
      additionalProperties: false,
    },
    async handler(args, ctx) {
      if (args?.netuid === undefined || args?.netuid === null) {
        return loadArtifactData(ctx, "/metagraph/agent-catalog.json");
      }
      const netuid = requireNetuid(args);
      return loadArtifactData(ctx, `/metagraph/agent-catalog/${netuid}.json`);
    },
  },
  {
    name: "get_best_rpc_endpoint",
    title: "Get the best Bittensor RPC endpoint",
    description:
      "Return the best currently-eligible Bittensor base-layer RPC/WSS " +
      "endpoint(s), scored and filtered by live health (down endpoints are " +
      "excluded). Use this to pick a node endpoint for on-chain reads.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          description: "Max endpoints to return (1-10, default 3).",
          minimum: 1,
          maximum: 10,
        },
      },
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const limit = clampLimit(args?.limit, 3, 10);
      const poolData = await loadArtifactData(ctx, "/metagraph/rpc/pools.json");
      const liveRpcPool = ctx.readHealthKv
        ? await ctx.readHealthKv(ctx.env, KV_HEALTH_RPC_POOL)
        : null;
      const pools =
        poolData.pools && typeof poolData.pools === "object"
          ? poolData.pools
          : {};
      // Pool map keys ("0"/"1"/"2") are pool indices, NOT networks — and the
      // same physical endpoint can appear in more than one pool. Dedupe by
      // endpoint id, keeping the best-scored instance.
      const bestById = new Map();
      for (const pool of Object.values(pools)) {
        const overlaid = overlayRpcPoolEligibility(pool, liveRpcPool);
        for (const endpoint of overlaid.endpoints || []) {
          if (!endpoint.pool_eligible) continue;
          const existing = bestById.get(endpoint.id);
          if (!existing || (endpoint.score || 0) > (existing.score || 0)) {
            bestById.set(endpoint.id, endpoint);
          }
        }
      }
      const candidates = [...bestById.values()].sort(
        (a, b) =>
          (b.score || 0) - (a.score || 0) ||
          (a.latency_ms ?? Infinity) - (b.latency_ms ?? Infinity),
      );
      const endpoints = candidates.slice(0, limit).map((endpoint) => ({
        id: endpoint.id,
        // The connectable endpoint URL — the whole point of the tool.
        url: endpoint.url ?? null,
        provider: endpoint.provider ?? null,
        kind: endpoint.kind ?? null,
        // These pools are the Bittensor mainnet (Finney) base layer.
        network: "finney",
        layer: endpoint.layer ?? "bittensor-base",
        score: endpoint.score ?? null,
        latency_ms: endpoint.latency_ms ?? null,
        status: endpoint.status ?? null,
        health_source: endpoint.health_source ?? null,
      }));
      return {
        eligible_count: candidates.length,
        endpoints,
        live_health: Boolean(liveRpcPool),
      };
    },
  },
  {
    name: "registry_summary",
    title: "Get the registry-wide summary",
    description:
      "Fetch the registry-wide summary: overall completeness, the most " +
      "complete subnets, coverage-level counts, and the latest registry " +
      "changes. A fast orientation for the whole Bittensor application layer.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async handler(_args, ctx) {
      return loadArtifactData(ctx, "/metagraph/registry-summary.json");
    },
  },
  {
    name: "semantic_search",
    title: "Semantic search across the registry",
    description:
      "Meaning-based (vector) search across Bittensor subnets, surfaces, and " +
      "providers. Unlike search_subnets' keyword match, this understands intent " +
      "— 'generate images from a prompt', 'stream live price data' — and ranks " +
      "by semantic similarity. Returns netuid/slug/title/description/url per " +
      "hit. Requires the AI layer; fall back to search_subnets when it is not " +
      "available.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Natural-language intent, e.g. 'summarize long documents'.",
        },
        limit: {
          type: "integer",
          description: "Max results (1-20, default 10).",
          minimum: 1,
          maximum: 20,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      requireAi(ctx);
      const query = requireString(args, "query");
      await requireAiRateLimit(ctx, "semantic");
      return runAi(() =>
        semanticSearch(ctx.env, query, { limit: args?.limit }),
      );
    },
  },
  {
    name: "ask",
    title: "Ask a grounded question about the registry",
    description:
      "Natural-language Q&A grounded in the registry (RAG). Retrieves the most " +
      "relevant subnets/surfaces and answers from them with bracketed [n] " +
      "citations — e.g. 'Which subnets expose an inference API I can call " +
      "today?'. Returns the answer plus its citations. Requires the AI layer.",
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description:
            "A question about Bittensor subnets or the registry as a whole.",
        },
      },
      required: ["question"],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      requireAi(ctx);
      const question = requireString(args, "question");
      await requireAiRateLimit(ctx, "ask");
      return runAi(() =>
        askQuestion(ctx.env, question, {}, { readArtifact: ctx.readArtifact }),
      );
    },
  },
];

const TOOLS_BY_NAME = new Map(MCP_TOOLS.map((tool) => [tool.name, tool]));

export function listToolDefinitions() {
  return MCP_TOOLS.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

function negotiateProtocol(requested) {
  return MCP_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : MCP_LATEST_PROTOCOL;
}

async function callTool(params, ctx) {
  const name = params?.name;
  const tool = typeof name === "string" ? TOOLS_BY_NAME.get(name) : undefined;
  if (!tool) {
    return {
      content: [{ type: "text", text: `Unknown tool: ${String(name)}` }],
      isError: true,
    };
  }
  try {
    const data = await tool.handler(params?.arguments || {}, ctx);
    return {
      content: [{ type: "text", text: JSON.stringify(data) }],
      structuredContent: data,
      isError: false,
    };
  } catch (error) {
    if (error?.toolError) {
      return {
        content: [{ type: "text", text: `${error.code}: ${error.message}` }],
        isError: true,
      };
    }
    throw error;
  }
}

// Dispatch a single JSON-RPC message. Returns the response object for requests,
// or null for notifications (no id).
async function dispatchMessage(message, ctx) {
  const isNotification =
    message === null ||
    typeof message !== "object" ||
    message.id === undefined ||
    message.id === null;
  const id = isNotification ? null : message.id;

  if (
    message === null ||
    typeof message !== "object" ||
    message.jsonrpc !== JSONRPC_VERSION ||
    typeof message.method !== "string"
  ) {
    if (isNotification) return null;
    return rpcError(id, RPC_INVALID_REQUEST, "Invalid JSON-RPC request.");
  }

  const { method, params } = message;

  try {
    switch (method) {
      case "initialize": {
        const result = {
          protocolVersion: negotiateProtocol(params?.protocolVersion),
          capabilities: { tools: { listChanged: false } },
          serverInfo: MCP_SERVER_INFO,
          instructions: MCP_INSTRUCTIONS,
        };
        return isNotification ? null : rpcResult(id, result);
      }
      case "ping":
        return isNotification ? null : rpcResult(id, {});
      case "tools/list":
        return isNotification
          ? null
          : rpcResult(id, { tools: listToolDefinitions() });
      case "tools/call": {
        const result = await callTool(params, ctx);
        return isNotification ? null : rpcResult(id, result);
      }
      // Capabilities we do not advertise but answer gracefully so strict
      // clients that probe them do not error.
      case "resources/list":
        return isNotification ? null : rpcResult(id, { resources: [] });
      case "resources/templates/list":
        return isNotification ? null : rpcResult(id, { resourceTemplates: [] });
      case "prompts/list":
        return isNotification ? null : rpcResult(id, { prompts: [] });
      case "notifications/initialized":
      case "notifications/cancelled":
        return null;
      default:
        return isNotification
          ? null
          : rpcError(id, RPC_METHOD_NOT_FOUND, `Unknown method: ${method}`);
    }
  } catch (error) {
    if (isNotification) return null;
    return rpcError(
      id,
      RPC_INTERNAL_ERROR,
      error?.message || "Internal error.",
    );
  }
}

function rpcResult(id, result) {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: JSONRPC_VERSION, id, error: { code, message } };
}

// Build the MCP processing context from the Worker request + injected deps.
function buildContext(request, env, deps) {
  let domain;
  try {
    domain = new URL(request.url).host || PRIMARY_DOMAIN;
  } catch {
    domain = PRIMARY_DOMAIN;
  }
  return {
    env,
    domain,
    clientIp: mcpClientKey(request),
    readArtifact: deps.readArtifact,
    readHealthKv: deps.readHealthKv,
  };
}

const MCP_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "cache-control": "no-store",
};

function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...MCP_HEADERS, ...headers },
  });
}

function mcpClientKey(request) {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for") ||
    "anonymous"
  );
}

async function enforceMcpRateLimit(request, env) {
  const limiter = env.MCP_RATE_LIMITER || env.RPC_RATE_LIMITER;
  if (!limiter?.limit) return null;

  const { success } = await limiter.limit({ key: mcpClientKey(request) });
  if (success) return null;

  return jsonResponse(
    rpcError(
      null,
      RPC_INVALID_REQUEST,
      "Too many MCP requests from this client; slow down.",
    ),
    429,
    {
      "retry-after": String(MCP_RATE_LIMIT.windowSeconds),
      "x-ratelimit-limit": String(MCP_RATE_LIMIT.limit),
      "x-ratelimit-policy": `${MCP_RATE_LIMIT.limit};w=${MCP_RATE_LIMIT.windowSeconds}`,
      "x-ratelimit-remaining": "0",
    },
  );
}

function bodyTooLargeResponse() {
  return jsonResponse(
    rpcError(null, RPC_INVALID_REQUEST, "MCP request body is too large."),
    413,
  );
}

// Entry point wired into the Worker at `POST /mcp`. `deps` injects the shared
// artifact/KV readers from workers/api.mjs.
export async function handleMcpRequest(request, env = {}, deps = {}) {
  if (request.method !== "POST") {
    return new Response(
      JSON.stringify({
        jsonrpc: JSONRPC_VERSION,
        id: null,
        error: {
          code: RPC_INVALID_REQUEST,
          message:
            "The MCP endpoint accepts POST JSON-RPC requests over the " +
            "Streamable HTTP transport.",
        },
      }),
      { status: 405, headers: { ...MCP_HEADERS, allow: "POST, OPTIONS" } },
    );
  }

  const rateLimitResponse = await enforceMcpRateLimit(request, env);
  if (rateLimitResponse) return rateLimitResponse;

  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_MCP_BODY_BYTES) {
    return bodyTooLargeResponse();
  }

  let body;
  try {
    const bodyText = await request.text();
    if (new TextEncoder().encode(bodyText).length > MAX_MCP_BODY_BYTES) {
      return bodyTooLargeResponse();
    }
    body = JSON.parse(bodyText);
  } catch {
    return jsonResponse(
      rpcError(null, RPC_PARSE_ERROR, "Request body is not valid JSON."),
      400,
    );
  }

  const ctx = buildContext(request, env, deps);

  // Legacy JSON-RPC batch (array). MCP 2025-06-18 removed batching, but cap
  // older-client compatibility so one HTTP request cannot fan out unboundedly.
  if (Array.isArray(body)) {
    if (body.length === 0) {
      return jsonResponse(
        rpcError(null, RPC_INVALID_REQUEST, "Empty JSON-RPC batch."),
        400,
      );
    }
    if (body.length > MAX_MCP_BATCH_LENGTH) {
      return jsonResponse(
        rpcError(
          null,
          RPC_INVALID_REQUEST,
          `JSON-RPC batch length exceeds the maximum of ${MAX_MCP_BATCH_LENGTH}.`,
        ),
        400,
      );
    }
    const responses = [];
    for (const message of body) {
      const response = await dispatchMessage(message, ctx);
      if (response) responses.push(response);
    }
    if (responses.length === 0) {
      return new Response(null, { status: 202, headers: MCP_HEADERS });
    }
    return jsonResponse(responses);
  }

  const response = await dispatchMessage(body, ctx);
  if (!response) {
    // Notification(s) only — nothing to return.
    return new Response(null, { status: 202, headers: MCP_HEADERS });
  }
  return jsonResponse(response);
}
