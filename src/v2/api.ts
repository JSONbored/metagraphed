import { V2OperationError, type V2Operations } from "./operations.ts";
import type { V2OperationName } from "../../schemas-src/v2/contracts.ts";

const headers = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

function error(status: number, code: string, message: string) {
  return new Response(
    JSON.stringify({ api_version: "2", error: { code, message } }),
    { status, headers },
  );
}

function integer(value: string) {
  if (!/^(0|[1-9][0-9]*)$/.test(value))
    throw new V2OperationError(
      "invalid_input",
      "Expected a canonical unsigned integer",
    );
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed))
    throw new V2OperationError(
      "invalid_input",
      "Integer is outside the supported range",
    );
  return parsed;
}

/** Public GET operations. Sharing their matchers keeps CORS scoped
 * to the same paths the read-only REST handler actually owns. */
export function matchV2PublicReadRoute(pathname: string) {
  const route =
    /^\/api\/v2\/networks\/([^/]+)\/(head|blocks(?:\/([^/]+))?)$/.exec(
      pathname,
    );
  const accountRoute =
    /^\/api\/v2\/networks\/([^/]+)\/accounts\/([^/]+)\/(events|stake|balance)$/.exec(
      pathname,
    );
  return route || accountRoute ? { route, accountRoute } : null;
}

export function createV2Handler(operations: V2Operations) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const matched = matchV2PublicReadRoute(url.pathname);
    if (!matched) return error(404, "not_found", "Route not found");
    const { route, accountRoute } = matched;
    if (request.method !== "GET") {
      const response = error(
        405,
        "method_not_allowed",
        "Only GET is supported",
      );
      response.headers.set("allow", "GET");
      return response;
    }
    try {
      const network = decodeURIComponent((route ?? accountRoute)![1]);
      let name: V2OperationName;
      const input: Record<string, unknown> = { network };
      if (accountRoute) {
        name =
          accountRoute[3] === "balance"
            ? "get_account_balance"
            : accountRoute[3] === "stake"
              ? "list_account_stake"
              : "list_account_events";
        input.account_id = decodeURIComponent(accountRoute[2]);
      } else if (route![2] === "head") name = "get_chain_head";
      else if (route![2] === "blocks") name = "list_blocks";
      else {
        name = "get_block";
        input.height = decodeURIComponent(route![3]!);
      }
      for (const [key, value] of url.searchParams) {
        const allowed =
          (name === "get_account_balance" && key === "publication_id") ||
          (name === "list_account_stake" &&
            ["cursor", "publication_id", "limit"].includes(key)) ||
          (name === "list_account_events" &&
            ["from_block", "cursor", "limit"].includes(key)) ||
          (name === "list_blocks" &&
            [
              "anchor_height",
              "anchor_hash",
              "anchor_publication_id",
              "from_block",
              "before",
              "limit",
            ].includes(key)) ||
          (name === "get_block" &&
            [
              "after_event_index",
              "after_extrinsic_index",
              "limit",
              "extrinsic_limit",
              "block_hash",
              "publication_id",
            ].includes(key));
        if (!allowed || Object.hasOwn(input, key))
          throw new V2OperationError(
            "invalid_input",
            "Unexpected or repeated query parameter",
          );
        input[key] = [
          "publication_id",
          "block_hash",
          "anchor_height",
          "anchor_hash",
          "anchor_publication_id",
          "from_block",
          "before",
          "cursor",
        ].includes(key)
          ? value
          : integer(value);
      }
      return new Response(JSON.stringify(await operations[name](input)), {
        headers,
      });
    } catch (caught) {
      if (caught instanceof URIError)
        return error(400, "invalid_input", "Invalid path encoding");
      if (caught instanceof V2OperationError) {
        const statuses = {
          invalid_input: 400,
          not_found: 404,
          data_unavailable: 503,
          authorization_required: 401,
        };
        return error(statuses[caught.code], caught.code, caught.message);
      }
      return error(
        500,
        "internal_error",
        "The requested data could not be verified",
      );
    }
  };
}
