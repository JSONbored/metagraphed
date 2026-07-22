// Isolated, account-gated fullnode RPC proxy (ADR 0021, #6835):
// POST /rpc/v1/fullnode. Reuses rpc-proxy.mjs's proven scoring/failover
// machinery (orderSafeRpcEndpoints, proxyWithFailover) against a SEPARATE,
// dedicated origin list -- never TRUSTED_RPC_UPSTREAM_ORIGINS's public pool,
// and a SEPARATE in-isolate circuit-breaker map -- so a public-pool
// degradation can never affect a paying caller's request, and a gated-tier
// incident can never silently fail open to public traffic (ADR 0021 section
// 6's explicit isolation requirement).
//
// Auth: a caller-supplied mg_... API key travels as a `?authorization=`
// query param, not a header (matches taostats' own convention so existing
// WSS-client code needs minimal changes to point here instead -- ADR 0021
// section 6), validated via src/api-key-validation.mjs's KV-cache-fronted
// lookup -- Unkey-backed since the 2026-07-19 rework (src/unkey-client.ts),
// not the local hash/compare ADR 0020 originally used.
//
// Method scope: read-only SAFE_RPC_METHODS PLUS author_submitExtrinsic
// (owner decision, 2026-07-19) -- this gated, account-authenticated tier is
// real RPC access, not the free/anonymous pool's read-only-only posture.
// author_submitAndWatchExtrinsic is deliberately excluded: it's subscription-
// based and doesn't fit this proxy's single-POST/single-response model (no
// WSS support here, matching the public proxy's own HTTP-only /rpc/v1/{network}
// route). Every other author_/sudo_/payment_/contracts_/state_call method
// stays blocked by the same DENIED_RPC_PREFIXES the public proxy uses.
//
// No response caching here (unlike the public proxy's Cache API layer): this
// is a lower-volume, paid/gated tier where correctness/freshness matters more
// than shaving upstream calls, and it now carries a non-idempotent write
// method -- a deliberate v1 scope cut, not an oversight.
import { errorResponse } from "../http.ts";
import { validateApiKey } from "../../src/api-key-validation.ts";
import {
  orderSafeRpcEndpoints,
  proxyWithFailover,
  RPC_MAX_ATTEMPTS,
  type RpcEndpoint,
  type RpcHealthMap,
} from "./rpc-proxy.ts";
import {
  DENIED_RPC_PREFIXES,
  MAX_RPC_BODY_BYTES,
  resolveClientIp,
  SAFE_RPC_METHODS,
} from "../config.ts";

const FULLNODE_EXTRA_SAFE_METHODS = new Set(["author_submitExtrinsic"]);

function isFullnodeSafeRpcMethod(method: string): boolean {
  if (method.startsWith("author_")) {
    return FULLNODE_EXTRA_SAFE_METHODS.has(method);
  }
  if (DENIED_RPC_PREFIXES.some((prefix) => method.startsWith(prefix))) {
    return false;
  }
  return SAFE_RPC_METHODS.has(method);
}

// Isolated in-isolate circuit breaker -- deliberately a SEPARATE Map from
// rpc-proxy.mjs's own module-default RPC_HEALTH (see that file's own header
// on why the breaker co-locates with its readers/writers). An ejected
// public-pool endpoint must never influence this pool's ordering, or vice
// versa.
const FULLNODE_RPC_HEALTH: RpcHealthMap = new Map();

// Bounds the cost of an unauthenticated caller guessing random keys (each
// miss is a real KV-then-Postgres round trip via src/api-key-validation.mjs)
// -- checked BEFORE key validation, by client IP, same posture and figure as
// the public proxy's own RPC_RATE_LIMITER.
export const FULLNODE_RPC_GUESS_RATE_LIMIT = { limit: 100, windowSeconds: 60 };

// Per-tier rate-limit policy, keyed by rpc_accounts.tier (workers/data-api.mjs's
// handleAccountTierPromote is the only way a tier changes -- no invite code
// stamps this anymore, 2026-07-19 rework). 'gittensor-partner' is an owner-
// designated partner cohort with a materially higher ceiling for real
// internal infra use, not casual dev exploration; 'unlimited' is for a
// manually-promoted account with no meaningful ceiling; 'free' is the
// default every self-served key starts at. An unrecognized/future tier
// falls back to 'free' rather than being unbounded. Each entry's own
// Cloudflare Rate Limiting binding is checked AFTER a key validates, keyed
// by accountId (stable per account, available even on a KV-cache hit --
// src/api-key-validation.mjs no longer has a "prefix" concept to key by,
// since Unkey's key format has no separate public prefix segment) rather
// than IP, so legitimate traffic from many callers sharing one key isn't
// starved and one key can't be inflated by rotating source IPs. This is
// DELIBERATELY still Cloudflare-native, not Unkey's own per-key ratelimits
// -- see src/unkey-client.ts's header comment for why.
interface FullnodeRpcTierPolicy {
  envVar: string;
  limit: number;
  windowSeconds: number;
}

export const FULLNODE_RPC_TIER_RATE_LIMITS: Record<
  string,
  FullnodeRpcTierPolicy
> = {
  free: {
    envVar: "FULLNODE_RPC_RATE_LIMITER",
    limit: 300,
    windowSeconds: 60,
  },
  "gittensor-partner": {
    envVar: "FULLNODE_RPC_RATE_LIMITER_GITTENSOR",
    limit: 6000,
    windowSeconds: 60,
  },
  unlimited: {
    envVar: "FULLNODE_RPC_RATE_LIMITER_UNLIMITED",
    limit: 100_000,
    windowSeconds: 60,
  },
};

function rateLimitPolicyForTier(tier: string): FullnodeRpcTierPolicy {
  return (
    FULLNODE_RPC_TIER_RATE_LIMITS[tier] ||
    (FULLNODE_RPC_TIER_RATE_LIMITS.free as FullnodeRpcTierPolicy)
  );
}

function parseFullnodeOrigins(env: Env): {
  pool: { endpoints: RpcEndpoint[] };
  trustedOrigins: Set<string>;
} {
  const raw = env?.FULLNODE_RPC_ORIGINS || "";
  const trustedOrigins = new Set<string>();
  const endpoints: RpcEndpoint[] = [];
  for (const rawUrl of raw.split(",").map((entry) => entry.trim())) {
    if (!rawUrl) continue;
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      continue; // malformed config entry -- skip rather than 500
    }
    trustedOrigins.add(parsed.origin);
    endpoints.push({
      id: `fullnode-${endpoints.length}`,
      url: rawUrl,
      pool_eligible: true,
      provider: "fullnode",
    });
  }
  return { pool: { endpoints }, trustedOrigins };
}

export async function handleFullnodeRpcProxyRequest(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  if (request.method !== "POST") {
    return errorResponse(
      "method_not_allowed",
      "The fullnode RPC gate only accepts POST requests.",
      405,
      {},
      { allow: "POST, OPTIONS" },
    );
  }

  if (env.FULLNODE_RPC_GUESS_RATE_LIMITER?.limit) {
    const { success } = await env.FULLNODE_RPC_GUESS_RATE_LIMITER.limit({
      key: `fullnode-rpc-guess:${resolveClientIp(request)}`,
    });
    if (!success) {
      return errorResponse(
        "fullnode_rpc_rate_limited",
        "Too many fullnode RPC requests from this client; slow down.",
        429,
        {},
        {
          "retry-after": String(FULLNODE_RPC_GUESS_RATE_LIMIT.windowSeconds),
          "x-ratelimit-limit": String(FULLNODE_RPC_GUESS_RATE_LIMIT.limit),
          "x-ratelimit-policy": `${FULLNODE_RPC_GUESS_RATE_LIMIT.limit};w=${FULLNODE_RPC_GUESS_RATE_LIMIT.windowSeconds}`,
        },
      );
    }
  }

  const rawKey = url.searchParams.get("authorization") || "";
  const auth = await validateApiKey(env, rawKey);
  if (!auth.ok) {
    return errorResponse(
      "fullnode_rpc_unauthorized",
      auth.code === "key_revoked"
        ? "This API key has been revoked."
        : "Provide a valid API key via ?authorization=.",
      401,
    );
  }

  // auth.tier is `unknown` (validateApiKey's success-shape tier comes straight
  // from Unkey's own untyped JSON response) -- rateLimitPolicyForTier's own
  // `|| FULLNODE_RPC_TIER_RATE_LIMITS.free` fallback already handles a
  // missing/unmapped tier, so this is a safe cast, not a new assumption.
  const rateLimitPolicy = rateLimitPolicyForTier(auth.tier as string);
  const rateLimiter = (env as unknown as Record<string, RateLimit | undefined>)[
    rateLimitPolicy.envVar
  ];
  if (rateLimiter?.limit) {
    const { success } = await rateLimiter.limit({
      key: `fullnode-rpc:${auth.accountId}`,
    });
    if (!success) {
      return errorResponse(
        "fullnode_rpc_rate_limited",
        "Too many requests for this API key; slow down.",
        429,
        {},
        {
          "retry-after": String(rateLimitPolicy.windowSeconds),
          "x-ratelimit-limit": String(rateLimitPolicy.limit),
          "x-ratelimit-policy": `${rateLimitPolicy.limit};w=${rateLimitPolicy.windowSeconds}`,
        },
      );
    }
  }

  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const contentLength = Number(declaredLength);
    if (!Number.isFinite(contentLength) || contentLength < 0) {
      return errorResponse(
        "fullnode_rpc_invalid_content_length",
        "Invalid Content-Length header.",
        400,
      );
    }
    if (contentLength > MAX_RPC_BODY_BYTES) {
      return errorResponse(
        "fullnode_rpc_body_too_large",
        "Request body is too large for the fullnode RPC gate.",
        413,
      );
    }
  }

  let bodyText: string;
  let rpcBody: { method: string; [key: string]: unknown };
  try {
    bodyText = await request.text();
    if (new TextEncoder().encode(bodyText).length > MAX_RPC_BODY_BYTES) {
      return errorResponse(
        "fullnode_rpc_body_too_large",
        "Request body is too large for the fullnode RPC gate.",
        413,
      );
    }
    rpcBody = JSON.parse(bodyText);
  } catch {
    return errorResponse(
      "fullnode_rpc_invalid_json",
      "RPC request body must be a JSON object.",
      400,
    );
  }

  if (
    !rpcBody ||
    Array.isArray(rpcBody) ||
    typeof rpcBody !== "object" ||
    typeof rpcBody.method !== "string"
  ) {
    return errorResponse(
      "fullnode_rpc_invalid_request",
      "Only single JSON-RPC request objects are supported.",
      400,
    );
  }

  if (!isFullnodeSafeRpcMethod(rpcBody.method)) {
    return errorResponse(
      "fullnode_rpc_method_blocked",
      `RPC method is not allowed through the fullnode gate: ${rpcBody.method}`,
      403,
    );
  }

  const { pool, trustedOrigins } = parseFullnodeOrigins(env);
  const { endpoints, unsafeEndpoint } = orderSafeRpcEndpoints(
    pool,
    Math.random,
    { healthMap: FULLNODE_RPC_HEALTH, trustedOrigins },
  );
  if (!endpoints.length) {
    return errorResponse(
      unsafeEndpoint
        ? "fullnode_rpc_endpoint_unsafe"
        : "fullnode_rpc_unavailable",
      unsafeEndpoint
        ? "The configured fullnode endpoint URL is not allowed by the Worker upstream safety policy."
        : "No fullnode RPC endpoint is configured for this deployment.",
      unsafeEndpoint ? 502 : 503,
    );
  }

  return proxyWithFailover(endpoints, {
    bodyText,
    poolId: "fullnode",
    healthMap: FULLNODE_RPC_HEALTH,
    maxAttempts: RPC_MAX_ATTEMPTS,
  });
}
