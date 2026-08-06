// Step 1 of the @modelcontextprotocol/sdk migration (#9647): the envelope,
// served by the SDK, over the tools we already have.
//
// NOT WIRED TO PRODUCTION, AND DELIBERATELY TEMPORARY. `/mcp` still answers
// from src/mcp-server.ts's hand-rolled dispatcher, so for now two envelopes
// exist for one contract. That duplication is the cost of proving the port
// before trusting it, and it is not meant to survive: #9647 step 4 deletes the
// hand-rolled dispatcher once the flag has been on through a full deploy
// cycle. If this file and that one are both still here after that, one of them
// is dead code.
//
// The duplication earns its keep by being checkable:
// tests/mcp-sdk-parity.test.ts drives both implementations with the same
// requests and asserts the published responses match. A migration whose first
// observable step is a cutover has no way to be wrong quietly, and this one is
// answering 14K tool calls a month.
//
// ## Why the migration is happening at all
//
// Both reasons the hand-rolled dispatcher's header gives were measured and
// neither survived:
//
//   bundle   73.3 KB gzipped for core Server + the web-standard transport,
//            bundled for workerd with zero Node imports. The 5.9 MB installed
//            figure is the stdio/Express trees, which a web-standard build
//            never reaches.
//   hot path 0.28 ms to construct + connect + dispatch per request with a
//            224-tool catalogue of our shape, warmed, against a ~140 ms p50
//            tool call.
//
// What it buys is spec drift becoming a dependency bump. One audit found four
// conformance items (#9646, #9648, plus `icons` and `execution.taskSupport`
// unemitted); every future revision is hand-work while we own the envelope.
//
// ## The constraint that shapes this file
//
// The web-standard transport REFUSES REUSE -- "Stateless transport cannot be
// reused across requests. Create a new transport per request." So there is no
// long-lived server object to hold; each request builds its own. That is the
// 0.28 ms above, and it is why `serveWithSdk` takes the tool list as an
// argument rather than closing over a module-level singleton: a per-request
// object that reads module state is the shape that goes wrong when one request
// mutates it.
//
// ## What must NOT change in the port
//
// The dispatcher is the single chokepoint for usage_event, $mcp_tool_call,
// trace spans, $exception, pre-dispatch refusals (#9639) and agent intent
// (#9642). #8993's rule -- instrument the loop, not the cases -- depends on
// there being one loop we own. That still holds here: we own the
// CallToolRequestSchema handler, so `dispatch` below is the same funnel under
// a different envelope, and step 2 re-attaches the telemetry to it.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  MCP_CAPABILITIES,
  MCP_INSTRUCTIONS,
  MCP_REGISTRY_META,
  MCP_SERVER_INFO,
} from "./mcp-server.ts";

/** The published tool shape, as listToolDefinitions() already emits it. */
type PublishedTool = Record<string, unknown> & { name: string };

/** What a tools/call must resolve to -- the same result object dispatchTool returns. */
type SdkToolDispatch = (
  name: string,
  args: Record<string, unknown> | undefined,
) => Promise<Record<string, unknown>>;

interface SdkServeOptions {
  /** Already-published definitions; this module does no shaping of its own. */
  tools: PublishedTool[];
  /** The single funnel every tools/call passes through. */
  dispatch: SdkToolDispatch;
}

/**
 * Answer one MCP request through the SDK.
 *
 * A fresh Server and transport per call, because the transport requires it.
 * The body is read to completion and re-wrapped before either is closed, so
 * the returned Response does not depend on objects that no longer exist -- and
 * nothing outlives the request, which on Workers would mean sharing it with
 * the next caller.
 */
export async function serveWithSdk(
  request: Request,
  { tools, dispatch }: SdkServeOptions,
): Promise<Response> {
  // THE HANDSHAKE IS READ FROM THE SAME CONSTANTS THE HAND-ROLLED PATH USES,
  // not restated here. `initialize` is handled inside the SDK's Server rather
  // than by a handler we register, so every field it reports has to arrive
  // through this constructor -- and a second copy of the server's identity is
  // exactly the drift this migration must not introduce.
  //
  // Measured against production before wiring it: our initialize returns
  // `_meta`, `capabilities`, `instructions`, `protocolVersion` and a
  // `serverInfo` carrying name/title/description. The SDK reproduces all of
  // those EXCEPT `_meta`, which it drops -- see mergeInitializeMeta below.
  const server = new Server(MCP_SERVER_INFO, {
    capabilities: MCP_CAPABILITIES,
    instructions: MCP_INSTRUCTIONS,
  });

  // The published definitions are handed back verbatim. Any reshaping here
  // would be a second place that decides what the contract is, and the whole
  // point of the parity test is that there is only one.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    return (await dispatch(
      name,
      args as Record<string, unknown> | undefined,
    )) as never;
  });

  const transport = new WebStandardStreamableHTTPServerTransport({
    // Stateless: no session id. The one stateful path (resources/subscribe,
    // ADR 0015) stays on McpSessionHub and is out of scope for this step.
    sessionIdGenerator: undefined,
    // A BARE JSON BODY, not an SSE frame. Both are legal for Streamable HTTP,
    // but the hand-rolled dispatcher answers `{"jsonrpc":...}` directly and
    // this migration is an envelope swap, not a transport change -- a client
    // parsing our responses today must not have to learn `event: message\n
    // data: ` to keep working. The parity test compares payloads, so without
    // this the framing difference would be invisible there and visible to
    // callers, which is the wrong way round.
    enableJsonResponse: true,
  });

  try {
    await server.connect(transport);
    const response = await transport.handleRequest(request);
    // BUFFERED BEFORE TEARDOWN, and the ordering is the whole point. The
    // response body is written by the transport; closing it first truncates
    // whatever has not been flushed, which reads downstream as an empty body
    // and parses as "Unexpected end of JSON input" -- how this was found.
    // Reading to completion here, then returning a fresh Response, makes the
    // payload independent of the objects that produced it.
    const body = await response.text();
    return new Response(mergeInitializeMeta(body), {
      status: response.status,
      headers: response.headers,
    });
  } finally {
    // Ordered: the transport first, since closing the server can try to write
    // through it. Both are best-effort -- a failure to tear down a per-request
    // object must not become the response, and an unhandled rejection raised
    // in a `finally` would do exactly that: replace the answer the caller was
    // already owed with a teardown error.
    await closeQuietly(transport);
    await closeQuietly(server);
  }
}

/**
 * Close one per-request object, swallowing whatever it throws.
 *
 * Extracted so the swallow is reachable from a test. It only fires when a
 * close() rejects, which the happy path never does -- and a guard nobody can
 * exercise is a guard nobody can trust. Tested with a rejecting closer rather
 * than annotated away.
 */
export async function closeQuietly(target: {
  close?: () => Promise<unknown>;
}): Promise<void> {
  try {
    await target.close?.();
  } catch {
    // Deliberately silent: see the caller.
  }
}

/**
 * Restore the one initialize field the SDK does not carry.
 *
 * Our handshake reports a `_meta` registry backlink alongside `serverInfo`.
 * The SDK's Server builds the initialize result itself and has no way to
 * attach it, so it would silently vanish at cutover -- the kind of loss that
 * shows up as a missing link in a client months later rather than as a failure.
 *
 * Narrow on purpose: it touches ONLY a result that already looks like an
 * initialize response, leaves any other payload byte-identical, and never
 * overwrites a `_meta` the SDK did produce. A parse failure returns the body
 * untouched, because a shim must not be able to turn a valid response into
 * an invalid one.
 */
export function mergeInitializeMeta(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  const payload = parsed as Row | undefined;
  const result = payload?.result as Row | undefined;
  if (
    !result ||
    typeof result !== "object" ||
    !result.serverInfo ||
    !result.protocolVersion ||
    result._meta !== undefined
  ) {
    return body;
  }
  return JSON.stringify({
    ...payload,
    result: { ...result, _meta: MCP_REGISTRY_META },
  });
}

type Row = Record<string, unknown>;
