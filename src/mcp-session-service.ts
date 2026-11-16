import type { SubnetStatusCaller } from "./subnet-status-service.ts";

export interface McpSessionService {
  fetch(sessionId: string, request: Request): Promise<Response>;
}
export interface McpSessionServiceEnv {
  MCP_SESSION_SERVICE?: unknown;
  MCP_SESSION_HUB?: Pick<DurableObjectNamespace, "get" | "idFromName">;
}
/** Explicit native session routing; absence alone can select the Worker path. */
export function mcpSessionService(
  env: McpSessionServiceEnv,
  sessionId: string,
): SubnetStatusCaller | undefined {
  const native = env.MCP_SESSION_SERVICE;
  if (native !== undefined) {
    if (!native || typeof (native as { fetch?: unknown }).fetch !== "function")
      throw new TypeError("Invalid native MCP session service");
    const service = native as McpSessionService;
    return {
      fetch: (input, init) =>
        service.fetch(sessionId, new Request(input, init)),
    };
  }
  const namespace = env.MCP_SESSION_HUB;
  return namespace
    ? {
        fetch: (input, init) =>
          namespace.get(namespace.idFromName(sessionId)).fetch(input, init),
      }
    : undefined;
}
