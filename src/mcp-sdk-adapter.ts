// The @modelcontextprotocol/sdk migration (#9647), CUT OVER: the SDK owns the
// ENVELOPE, src/mcp-server.ts still owns every METHOD.
//
// THIS SERVES ALL PRODUCTION TRAFFIC. Every well-formed request to `/mcp`
// arrives here -- no flag, no second envelope, nothing to fall back to. The
// single exception is malformed JSON-RPC, which dispatchMcpRequest answers
// itself because the SDK handles it measurably worse: wrong error code, wrong
// HTTP status, and it drops the valid members of a mixed batch. That carve-out
// is a permanent part of the design, not a rollback path.
//
// ## Total delegation, which is the whole design
//
// Every JSON-RPC method -- INCLUDING `initialize` and `ping`, which the SDK
// registers for itself -- is routed back into dispatchMessage() through
// `fallbackRequestHandler`. Nothing about what a method returns is restated
// here. That matters for three reasons, each of which was a real bug in the
// partial-delegation version of this file:
//
//   telemetry   dispatchMessage's `finally` emits scheduleMcpProtocolUsageEvent
//               for EVERY method (#8993). A method the SDK answered internally
//               would be a method that silently stopped being counted --
//               `initialize` most of all, which carries the client
//               attribution (#8994) and the session identity (#9054).
//   validation  setRequestHandler() wraps a handler in a zod parse of the
//               SDK's own request schema. Registering one for `initialize`
//               would REJECT a sloppy handshake we accept today (ours
//               negotiates a missing protocolVersion; the SDK's schema
//               requires it) and would answer with zod's text. Stricter
//               validation is not a behaviour-neutral port.
//   drift       one funnel is the property the whole instrumentation story
//               rests on. Two places that answer methods is the shape that
//               goes wrong quietly.
//
// removeRequestHandler / removeNotificationHandler are public API on the SDK's
// Protocol, so this needs no private-state access to achieve it.
//
// ## Why there are no response shims
//
// An earlier draft of this migration needed two: one to restore the
// `initialize` `_meta` the SDK dropped, and one to strip the `MCP error -N: `
// prefix McpError bakes into its message. Total delegation removes the first
// (our own initialize result is returned verbatim, `_meta` included) and
// JsonRpcFailure removes the second -- the SDK serialises `code`/`message`
// off whatever is thrown, so a plain Error carrying a numeric `code` produces
// a byte-identical error object. McpError is a convenience class, not the
// contract. Measured, both ways, in tests/mcp-sdk-parity.test.ts.
//
// ## What the SDK is actually being trusted with
//
// The envelope, and only the envelope: JSON-RPC parse + shape validation,
// batch fan-out and response correlation, 202-on-notification, and the
// JSON/SSE framing choice. Those are the parts that track spec revisions, and
// the parts a hand-rolled implementation has to re-derive every time the spec
// moves. Everything metagraphed-specific -- the rate limit, the cost-weighted
// quota, the body cap, the batch ceiling, session minting -- runs BEFORE this
// in dispatchMcpRequest and is untouched.
//
// ## The constraint that shapes the per-request construction
//
// The web-standard transport refuses reuse ("Stateless transport cannot be
// reused across requests"), so each request builds its own Server and
// transport. That is 0.28 ms measured against a ~140 ms p50 tool call, and it
// is why `dispatch` arrives as an argument rather than being read from module
// state: a per-request object that reads module state is the shape that goes
// wrong when one request mutates it.
//
// ## No import from mcp-server.ts, on purpose
//
// Everything metagraphed-specific -- the server identity, the capabilities,
// the instructions, the dispatch funnel -- arrives as an ARGUMENT. That keeps
// this module a generic "serve JSON-RPC through the MCP SDK" envelope with no
// knowledge of this project, and it keeps mcp-server.ts (which imports this)
// out of an import cycle. A 16K-line hub module in a cycle with the thing it
// calls is a bundler problem waiting to happen on the hottest public path we
// have.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

type Row = Record<string, unknown>;

/** JSON-RPC 2.0's own internal-error code, not a choice this project makes. */
const RPC_INTERNAL_ERROR = -32603;

/**
 * The methods the SDK registers a handler for and that we take back.
 *
 * Hand-listed because removeRequestHandler takes a method name and the
 * registry itself is private. That makes the list a drift risk -- an SDK
 * upgrade adding a handler would silently recapture that method and stop it
 * being instrumented -- so tests/mcp-sdk-parity.test.ts asserts by reflection
 * that NOTHING remains registered after these run. The production path uses
 * only public API; the gate proves the list is complete.
 */
const SDK_REGISTERED_REQUEST_METHODS = ["initialize", "ping"];

/** Same, for notifications: Server registers one and Protocol two. */
const SDK_REGISTERED_NOTIFICATION_METHODS = [
  "notifications/initialized",
  "notifications/cancelled",
  "notifications/progress",
];

/**
 * A JSON-RPC error, thrown so the SDK serialises it verbatim.
 *
 * The SDK's Protocol builds an error response from `code` (when it is a safe
 * integer), `message`, and `data` (when present) off whatever the handler
 * threw. So this reproduces our rpcError() output exactly -- unlike McpError,
 * whose constructor rewrites the message to `MCP error ${code}: ${message}`.
 */
export class JsonRpcFailure extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "JsonRpcFailure";
    this.code = code;
    this.data = data;
  }
}

/**
 * One dispatched JSON-RPC message, in dispatchMessage()'s own shape: a
 * response object for a request, or null for a notification.
 */
export type SdkDispatch = (message: Row) => Promise<Row | null>;

/**
 * Turn dispatchMessage()'s response object into what an SDK handler must
 * return -- the bare `result` -- or throw the error it reported.
 *
 * Exported for the parity test: this is the one place the two envelopes'
 * conventions are translated, so it is the one place a mistranslation could
 * hide.
 */
export function unwrapDispatchResponse(response: Row | null): unknown {
  const error = response?.error as Row | undefined;
  if (error) {
    throw new JsonRpcFailure(
      error.code as number,
      error.message as string,
      error.data,
    );
  }
  if (response && "result" in response) return response.result;
  // Unreachable through dispatchMessage, which answers every request with a
  // result or an error. Not left to fall through as `undefined`: an SDK
  // handler returning undefined publishes `{"result":undefined}`, which
  // JSON.stringify drops, producing a response with neither result nor error
  // -- a malformed JSON-RPC reply. Failing loudly is the lesser harm.
  throw new JsonRpcFailure(RPC_INTERNAL_ERROR, "Internal error.");
}

export interface SdkServeOptions {
  /** The server identity the SDK reports; ours, not restated here. */
  serverInfo: { name: string; version: string } & Row;
  /** What assertRequestHandlerCapability checks registrations against. */
  capabilities: Row;
  /** The model-facing description of what this server is for. */
  instructions?: string;
  /** The single funnel every method passes through. */
  dispatch: SdkDispatch;
}

/** Answer one MCP request through the SDK, dispatching every method to `dispatch`. */
export async function serveWithSdk(
  request: Request,
  { serverInfo, capabilities, instructions, dispatch }: SdkServeOptions,
): Promise<Response> {
  // The handshake constants are passed through even though our own dispatch is
  // what answers `initialize`: `capabilities` is what the SDK's
  // assertRequestHandlerCapability checks against, and a second copy of the
  // server's identity is exactly the drift this migration must not introduce.
  const server = new Server(serverInfo, { capabilities, instructions });

  // Take back everything the SDK claimed, so the fallbacks below see all of it.
  for (const method of SDK_REGISTERED_REQUEST_METHODS) {
    server.removeRequestHandler(method);
  }
  for (const method of SDK_REGISTERED_NOTIFICATION_METHODS) {
    server.removeNotificationHandler(method);
  }

  // Rebuilt rather than forwarded: the SDK hands a handler its PARSED request,
  // and dispatchMessage takes a whole JSON-RPC message. `jsonrpc` is restated
  // because a message that reached a handler has already been validated as
  // 2.0 by the transport.
  server.fallbackRequestHandler = async (req) =>
    unwrapDispatchResponse(
      await dispatch({
        jsonrpc: "2.0",
        id: (req as Row).id,
        method: req.method,
        params: (req as Row).params,
      }),
    ) as never;

  // Notifications are dispatched for their SIDE EFFECT ONLY -- the protocol
  // usage event dispatchMessage emits in its `finally`. The return value is
  // discarded because a notification has no reply by definition, but dropping
  // the CALL would drop the telemetry, which for an id-less message is the
  // only signal that can ever exist (#8995).
  //
  // AWAITED BEFORE THE RESPONSE, via this array. The SDK's Protocol dispatches
  // a notification fire-and-forget -- `Promise.resolve().then(() =>
  // handler(n))`, never awaited -- so on Workers the 202 would return while
  // the handler was still mid-flight, and the request context would be torn
  // down with the telemetry write unfinished. Measured: at response time the
  // dispatch had started and not completed. The hand-rolled path awaits it, so
  // without this the flag would quietly stop counting every
  // notifications/initialized the server receives.
  const pendingNotifications: Array<Promise<unknown>> = [];
  server.fallbackNotificationHandler = async (notification) => {
    // Pushed synchronously, before the first await, so the promise is visible
    // to the drain below however the SDK schedules this handler.
    const pending = dispatch({
      jsonrpc: "2.0",
      method: notification.method,
      params: (notification as Row).params,
    });
    pendingNotifications.push(pending);
    await pending;
  };

  const transport = new WebStandardStreamableHTTPServerTransport({
    // Stateless: session minting stays in dispatchMcpRequest, which registers
    // the id with McpSessionHub before it reaches the client. Letting the
    // transport mint one too would create a second id the hub never heard of.
    sessionIdGenerator: undefined,
    // A BARE JSON BODY, not an SSE frame. Both are legal for Streamable HTTP,
    // but the hand-rolled dispatcher answers `{"jsonrpc":...}` directly and
    // this migration is an envelope swap, not a transport change -- a client
    // parsing our responses today must not have to learn `event: message\n
    // data: ` to keep working.
    enableJsonResponse: true,
  });

  try {
    await server.connect(transport);
    const response = await transport.handleRequest(request);
    // Drain the fire-and-forget notification handlers before answering (see
    // pendingNotifications above). allSettled, not all: a telemetry write that
    // rejects must not become the caller's response.
    await Promise.allSettled(pendingNotifications);
    // BUFFERED BEFORE TEARDOWN, and the ordering is the whole point. The body
    // is written by the transport; closing it first truncates whatever has not
    // been flushed, which reads downstream as an empty body and parses as
    // "Unexpected end of JSON input" -- how this was found. Reading to
    // completion here makes the payload independent of the objects that
    // produced it.
    const body = await response.text();
    return new Response(body || null, {
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
 * exercise is a guard nobody can trust.
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

/** Exported for the completeness gate in tests/mcp-sdk-parity.test.ts. */
export const SDK_RECLAIMED_METHODS = {
  requests: SDK_REGISTERED_REQUEST_METHODS,
  notifications: SDK_REGISTERED_NOTIFICATION_METHODS,
};
