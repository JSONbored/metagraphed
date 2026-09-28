/** Shared attribution for explicitly requested production qualification. */
export function mcpProbeRequest(
  endpoint: string,
  probe:
    | "mcp-conformance"
    | "operation-latency"
    | "cross-surface-values"
    | "adversarial-surface",
  token = process.env.MCP_PROBE_TOKEN,
): Pick<RequestInit, "headers" | "redirect"> {
  const target = new URL(endpoint);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2025-11-25",
    "user-agent":
      probe === "mcp-conformance"
        ? "metagraphed-conformance/1"
        : `metagraphed-${probe}/1`,
  };
  // Endpoint overrides must never receive the production probe credential.
  if (target.origin === "https://api.metagraph.sh") {
    if (target.username || target.password) {
      throw new Error("MCP probe endpoints must not contain credentials.");
    }
    const proof = token?.trim();
    if (!proof) {
      throw new Error(
        "MCP_PROBE_TOKEN is required for production qualification; refusing unmarked probe traffic.",
      );
    }
    headers["x-metagraph-probe"] = probe;
    headers["x-metagraph-probe-token"] = proof;
  }
  // A redirect must not forward the proof to another origin.
  return { headers, redirect: "error" };
}
