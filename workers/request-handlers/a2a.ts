// A2A: the registry as an agent other agents can talk to (#11175).
//
// ## WHY THIS EXISTS, AND WHY IT IS THIS SMALL
//
// The agent-readiness scan asks for an A2A agent card, and the rule this repo
// holds discovery documents to is that every advertised capability has a
// working endpoint behind it -- a card pointing at nothing is the same
// dishonesty as a registered mutation URL the prober GETs (#11146). So the
// card ships WITH the endpoint, and the card advertises exactly one skill:
// `ask`, the grounded Q&A the MCP surface already serves. One skill because we
// have one capability that fits A2A's conversational shape; the 240 MCP tools
// are tools, and pretending each is an agent "skill" would advertise a
// delegation interface nobody built.
//
// ## ONE IMPLEMENTATION
//
// The message handler translates A2A text parts to a question, calls the SAME
// `askQuestion` behind /api/v1/ask and the `ask` MCP tool, and translates the
// answer back. No second retrieval path, no second prompt, no second rate
// limit vocabulary: the tiered AI limit and the ai-enabled gate are the ones
// every other AI surface reads. Improving ask improves all three surfaces.
//
// ## WHAT IS DELIBERATELY NOT IMPLEMENTED
//
// Tasks. A2A lets a server answer `message/send` with a bare Message instead
// of a Task, which is the truthful shape for a stateless Q&A: there is nothing
// to poll, cancel, or resubscribe to. The task methods therefore answer the
// spec's own TaskNotFoundError / UnsupportedOperationError codes rather than
// simulating a lifecycle this server does not have, and the card declares
// streaming and push notifications unsupported so a conformant client never
// tries.
import { asJsonObject } from "../../schemas-src/json-request.ts";

import {
  aiEnabled,
  askQuestion,
  AI_TIERED_RATE_LIMIT,
  type AskQuestionResult,
} from "../../src/ai-search.ts";
import { applyTieredRateLimit } from "../tiered-rate-limit.ts";
import {
  ifNoneMatchSatisfied,
  readBoundedRequestText,
  weakEtag,
} from "../http.ts";
import { discoveryHeaders } from "./discovery.ts";

type Row = Record<string, unknown>;

import { A2A_CARD_PATH, A2A_ENDPOINT_PATH } from "./a2a-paths.ts";
export { A2A_CARD_PATH, A2A_ENDPOINT_PATH };

/** Same ceiling as /api/v1/ask -- one question is one question, whichever
 * protocol carried it. */
const MAX_A2A_BODY_BYTES = 64 * 1024;

// A2A's own JSON-RPC error codes (spec §8): the spec reserves -32001..-32006
// for A2A-specific failures beside the standard JSON-RPC range.
const RPC_PARSE_ERROR = -32700;
const RPC_INVALID_REQUEST = -32600;
const RPC_METHOD_NOT_FOUND = -32601;
const RPC_INVALID_PARAMS = -32602;
const RPC_INTERNAL = -32603;
const A2A_TASK_NOT_FOUND = -32001;
const A2A_UNSUPPORTED_OPERATION = -32004;
const A2A_CONTENT_TYPE_NOT_SUPPORTED = -32005;

export interface A2ADeps {
  /** Injection seam for tests; production uses the real askQuestion. */
  askQuestionImpl?: typeof askQuestion;
}

/**
 * The agent card, worker-computed like the MCP server card so a version bump
 * or skill change never needs a committed-artifact regen.
 *
 * `url` is absolute and points at the API host: the card is also proxied on
 * the apex, and a relative url would advertise an endpoint on whichever host
 * served the card.
 */
export function buildAgentCard(serverVersion: string): Row {
  return {
    protocolVersion: "0.3.0",
    name: "metagraphed",
    description:
      "Live operational + integration registry for Bittensor subnets. " +
      "Ask grounded questions about subnets, their APIs, health, and " +
      "economics; answers carry bracketed citations into the registry. " +
      "The full tool surface (240 tools) is MCP at https://api.metagraph.sh/mcp " +
      "-- this A2A skill is the conversational front door, not the catalogue.",
    url: `https://api.metagraph.sh${A2A_ENDPOINT_PATH}`,
    preferredTransport: "JSONRPC",
    provider: {
      organization: "metagraphed",
      url: "https://metagraph.sh",
    },
    version: serverVersion,
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain", "application/json"],
    skills: [
      {
        id: "ask",
        name: "Ask about the Bittensor subnet registry",
        description:
          "Natural-language Q&A grounded in the live registry (RAG over " +
          "subnets, surfaces, health, and economics). Returns an answer with " +
          "bracketed [n] citations, plus the citation records as a data part.",
        tags: ["bittensor", "subnets", "registry", "search", "grounded-qa"],
        examples: [
          "Which subnets expose an inference API I can call today?",
          "What does it cost to register a miner on subnet 3?",
        ],
        inputModes: ["text/plain"],
        outputModes: ["text/plain", "application/json"],
      },
    ],
    supportsAuthenticatedExtendedCard: false,
  };
}

export async function agentCardResponse(request: Request): Promise<Response> {
  // Deferred for the same reason discovery.ts defers it (#10424): the version
  // constant lives with the MCP server, and a static import would drag the
  // whole tool registry into every consumer of this module. One string does
  // not justify that; card requests are rare and /mcp isolates have the module
  // loaded already.
  const { MCP_SERVER_VERSION } = await import("../../src/mcp-server.ts");
  const body = `${JSON.stringify(buildAgentCard(MCP_SERVER_VERSION), null, 2)}\n`;
  const headers = discoveryHeaders("application/json");
  headers.set("etag", await weakEtag(body));
  // etag was just set from a non-empty body; the fallback only satisfies the
  // `string | null` of Headers.get, same as the sibling discovery handlers.
  const etag = /* v8 ignore next */ headers.get("etag") || "";
  if (ifNoneMatchSatisfied(request, etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === "HEAD" ? null : body, {
    status: 200,
    headers,
  });
}

function rpcError(
  id: unknown,
  code: number,
  message: string,
  status = 200,
): Response {
  // JSON-RPC errors ride a 200 by convention; only transport-level failures
  // (rate limit, parse) carry an HTTP status, matching how /mcp answers.
  return Response.json(
    { jsonrpc: "2.0", id: id ?? null, error: { code, message } },
    { status },
  );
}

/** Every text part's text, joined -- the question as the caller composed it. */
function questionFromMessage(message: Row | null | undefined): string {
  const parts = Array.isArray(message?.parts) ? (message.parts as Row[]) : [];
  return parts
    .filter((part) => part?.kind === "text" && typeof part.text === "string")
    .map((part) => (part.text as string).trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function answerMessage(result: AskQuestionResult): Row {
  return {
    kind: "message",
    role: "agent",
    messageId: crypto.randomUUID(),
    parts: [
      { kind: "text", text: result.answer },
      // The citations as structured data, so a consuming agent can follow
      // them without re-parsing bracket references out of prose.
      {
        kind: "data",
        data: { citations: result.citations, model: result.model },
      },
    ],
  };
}

/**
 * POST /a2a/v1 -- the JSON-RPC endpoint behind the card.
 *
 * Supported: `message/send` (blocking, answers a Message). Everything else
 * answers the spec's own code for "this server does not do that", which is
 * strictly more useful to a conformant client than a 404: the error names the
 * contract instead of the router.
 */
export async function handleA2ARequest(
  request: Request,
  env: Env,
  deps: A2ADeps = {},
): Promise<Response> {
  if (request.method !== "POST") {
    return rpcError(
      null,
      RPC_INVALID_REQUEST,
      `POST JSON-RPC to ${A2A_ENDPOINT_PATH}; see /.well-known/agent-card.json.`,
      405,
    );
  }
  if (!aiEnabled(env)) {
    return rpcError(
      null,
      RPC_INTERNAL,
      "The ask capability is not available on this deployment.",
      503,
    );
  }
  // The SAME tiered limit as /api/v1/ask and semantic search: one question is
  // one AI call, whichever protocol carried it, and a separate budget here
  // would be the loophole callers migrate to.
  const rateLimit = await applyTieredRateLimit(
    request,
    env,
    AI_TIERED_RATE_LIMIT,
  );
  if (!rateLimit.allowed) {
    return rpcError(null, RPC_INTERNAL, "Rate limited. Retry later.", 429);
  }
  const bounded = await readBoundedRequestText(request, MAX_A2A_BODY_BYTES);
  if (!bounded.ok) {
    return rpcError(null, RPC_INVALID_REQUEST, "Request body too large.", 413);
  }
  let rpc: Row | null;
  try {
    rpc = asJsonObject(JSON.parse(bounded.text));
  } catch {
    return rpcError(null, RPC_PARSE_ERROR, "Body must be valid JSON.");
  }
  // `null`, `42` and `"method"` all PARSE. None of them is a request object,
  // and the cast this replaces let every one of them through to the method
  // switch as a call with no method -- answered as "method not found" rather
  // than as the malformed request it was.
  if (!rpc) {
    return rpcError(null, RPC_INVALID_REQUEST, "Body must be a JSON object.");
  }
  const id = rpc.id;
  const method = rpc.method;
  const params = asJsonObject(rpc.params) ?? {};

  switch (method) {
    case "message/send": {
      const message = params.message as Row | undefined;
      const question = questionFromMessage(message);
      if (!question) {
        const hasNonText = Array.isArray(message?.parts)
          ? (message.parts as Row[]).some((part) => part?.kind !== "text")
          : false;
        // A file-only or data-only message is a content-type problem and gets
        // the spec's code for it; an empty message is an invalid-params one.
        return rpcError(
          id,
          hasNonText ? A2A_CONTENT_TYPE_NOT_SUPPORTED : RPC_INVALID_PARAMS,
          hasNonText
            ? "This skill accepts text parts only."
            : "params.message.parts must include at least one non-empty text part.",
        );
      }
      try {
        const ask = deps.askQuestionImpl ?? askQuestion;
        const result = await ask(env, question, {}, {});
        return Response.json({
          jsonrpc: "2.0",
          id: id ?? null,
          result: answerMessage(result),
        });
      } catch (error) {
        return rpcError(
          id,
          RPC_INTERNAL,
          error instanceof Error ? error.message : "ask failed",
        );
      }
    }
    case "message/stream":
    case "tasks/resubscribe":
      // The card says streaming: false; a conformant client never gets here.
      return rpcError(
        id,
        A2A_UNSUPPORTED_OPERATION,
        "Streaming is not supported; the agent card declares streaming: false.",
      );
    case "tasks/get":
    case "tasks/cancel":
      // message/send answers a bare Message, so no task ever exists to find.
      return rpcError(
        id,
        A2A_TASK_NOT_FOUND,
        "This agent answers message/send directly and never creates tasks.",
      );
    default:
      return rpcError(
        id,
        RPC_METHOD_NOT_FOUND,
        `Unknown method ${JSON.stringify(method ?? null)}.`,
      );
  }
}
