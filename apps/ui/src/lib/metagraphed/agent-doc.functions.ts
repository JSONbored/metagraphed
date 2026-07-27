import { createServerFn } from "@tanstack/react-start";
import { queryOptions } from "@tanstack/react-query";
import { DEFAULT_API_BASE } from "./config";

export const AGENT_MARKDOWN_URL = `${DEFAULT_API_BASE}/agent.md`;

/**
 * Fetches the copyable agent system prompt (`/agent.md`) as raw markdown, so
 * the /agents page can show the payload it is asking you to copy instead of
 * only linking to it.
 *
 * This has to cross a server boundary rather than being a plain client fetch:
 * agent.md is served by the API's static-asset binding, which — unlike
 * /api/v1/* — sends no `access-control-allow-origin`, so a browser fetch from
 * metagraph.sh is blocked by CORS. The origin is pinned to DEFAULT_API_BASE
 * rather than getApiBase(): a server-side fetch whose target came from the
 * client (localStorage, in getApiBase's case) would be an SSRF sink.
 *
 * Extracted from the createServerFn handler so the fetch/error path is
 * unit-testable without TanStack Start's AsyncLocalStorage request context
 * (same split as market.functions.ts).
 */
export async function fetchAgentMarkdown(): Promise<string> {
  const response = await fetch(AGENT_MARKDOWN_URL);
  if (!response.ok) throw new Error(`agent.md returned ${response.status}`);
  return response.text();
}

export const getAgentMarkdown = createServerFn({ method: "GET" }).handler(fetchAgentMarkdown);

/**
 * The prompt is a build-time artifact that changes only on publish, so it is
 * cached hard — a reader scrolling the preview should never re-trigger it.
 */
export const agentMarkdownQuery = () =>
  queryOptions({
    queryKey: ["metagraphed", "agent-markdown"] as const,
    queryFn: () => getAgentMarkdown(),
    staleTime: 60 * 60 * 1000,
  });
