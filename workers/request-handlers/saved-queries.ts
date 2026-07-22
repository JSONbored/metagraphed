// GET /api/v1/queries/{id}: run one maintainer-curated saved-query template
// (epic #6755/#6757) -- the REST mirror of the run_saved_query MCP tool, both
// backed by src/saved-queries.mjs's shared runSavedQuery(). A live per-request
// result with no fixed response shape across templates, the same "no static
// artifact" category as /api/v1/graphql -- see workers/api.mjs's own comment
// on why this sits outside the API_ROUTES/contracts.mjs registry.
import { errorResponse } from "../http.ts";
import { dataResponse } from "../responses.ts";
import { runSavedQuery } from "../../src/saved-queries.mjs";

export const SAVED_QUERIES_PATH_PREFIX = "/api/v1/queries/";

function paramsFromSearch(url: URL): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    params[key] = value;
  }
  return params;
}

export async function handleSavedQueryRequest(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  if (!["GET", "HEAD"].includes(request.method)) {
    return errorResponse(
      "method_not_allowed",
      "Only GET, HEAD, and OPTIONS are supported.",
      405,
      {},
      { allow: "GET, HEAD, OPTIONS" },
    );
  }
  const queryId = decodeURIComponent(
    url.pathname.slice(SAVED_QUERIES_PATH_PREFIX.length),
  );
  if (!queryId) {
    return errorResponse(
      "not_found",
      "GET /api/v1/queries/{id} requires a query id.",
      404,
    );
  }
  try {
    const result = await runSavedQuery(env, queryId, paramsFromSearch(url));
    return dataResponse(env, result);
  } catch (error) {
    // runSavedQuery's own errors are savedQueryError() (src/saved-queries.mjs)
    // -- a plain Error with `toolError`/`code` bolted on; that file is still
    // .mjs (checkJs is off), so the thrown shape isn't statically visible
    // here. Anything else (a genuine bug, not a caller-facing rejection) is
    // rethrown unchanged.
    const toolError = error as
      { toolError?: boolean; code?: string; message?: string } | undefined;
    if (toolError?.toolError) {
      return errorResponse(
        toolError.code as string,
        toolError.message as string,
        toolError.code === "not_found" ? 404 : 400,
      );
    }
    throw error;
  }
}
