import { API_BASE } from "./config";

/**
 * Calls a catalogued subnet surface through the registry's existing guarded
 * path (#8258).
 *
 * There is deliberately no new REST route for this. `call_subnet_surface` is
 * already exposed over the MCP Streamable-HTTP endpoint at `/mcp`, and it is
 * where every guardrail the playground needs already lives, server-side:
 *
 *  - allowlist — only a surface catalogued in the registry is reachable; there
 *    is no way to pass an arbitrary URL. With no `path`/`method` (which is all
 *    this client sends) it fetches the surface's own curated `url` using its
 *    declared probe method, nothing else.
 *  - auth — a surface with `auth_required` is rejected without a credential,
 *    and the playground never sends one.
 *  - timeouts, response-size caps and content-type rejection are enforced on
 *    the server; `truncated` comes back so the UI can say so.
 *  - rate limiting is the endpoint's own, shared with every other client.
 *
 * Reimplementing any of that in the browser would mean a second, weaker copy.
 */
export interface SurfaceCallResult {
  surface_id: string;
  url: string;
  status_code: number;
  content_type: string | null;
  latency_ms: number;
  truncated: boolean;
  /** Parsed JSON, or capped text. Rendered as data, never as markup. */
  body: unknown;
}

export interface SurfaceCallError {
  code: string;
  message: string;
}

/** Distinguishes the two failure shapes without throwing for the expected one. */
export type SurfaceCallOutcome =
  { ok: true; result: SurfaceCallResult } | { ok: false; error: SurfaceCallError };

interface McpEnvelope {
  result?: {
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
  };
  error?: { message?: string };
}

export async function callSubnetSurface(
  surfaceId: string,
  signal?: AbortSignal,
): Promise<SurfaceCallOutcome> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // The Streamable-HTTP transport negotiates on Accept; it answers plain
        // JSON when both are offered and there's no session to stream into.
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "call_subnet_surface", arguments: { surface_id: surfaceId } },
      }),
      signal,
    });
  } catch (e) {
    return {
      ok: false,
      error: {
        code: "network_error",
        message: e instanceof Error ? e.message : "Request failed before reaching the registry.",
      },
    };
  }

  if (!res.ok) {
    return {
      ok: false,
      error: { code: `http_${res.status}`, message: `The registry returned ${res.status}.` },
    };
  }

  let envelope: McpEnvelope;
  try {
    envelope = (await res.json()) as McpEnvelope;
  } catch {
    return { ok: false, error: { code: "bad_response", message: "Unparseable response." } };
  }

  if (envelope.error) {
    return {
      ok: false,
      error: { code: "rpc_error", message: envelope.error.message ?? "Call failed." },
    };
  }

  const structured = envelope.result?.structuredContent;
  if (!structured) {
    return { ok: false, error: { code: "bad_response", message: "No structured result." } };
  }

  // A tool-level failure (auth required, surface down, unexpected content type)
  // comes back as isError with an `error` block, not as a transport failure.
  if (envelope.result?.isError) {
    const err = structured.error as { code?: string; message?: string } | undefined;
    return {
      ok: false,
      error: {
        code: err?.code ?? "call_failed",
        message: err?.message ?? "The surface could not be called.",
      },
    };
  }

  return { ok: true, result: structured as unknown as SurfaceCallResult };
}

/**
 * True when the playground will offer an Execute button for this surface.
 *
 * The server is the real gate — this only decides whether to render a button
 * that we already know would be rejected. Auth-required surfaces still render
 * their request and docs link; they just can't be run from here, because the
 * playground never handles credentials.
 */
export function isExecutable(surface: {
  auth_required?: boolean;
  public_safe?: boolean;
  id?: string;
}): boolean {
  return Boolean(surface.id) && surface.public_safe !== false && surface.auth_required !== true;
}
