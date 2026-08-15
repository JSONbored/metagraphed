// One validated JSON-RPC call against a Substrate node (#11194).
//
// A chain RPC response is the most untrusted input this repo takes: it arrives
// from a public archive nobody here operates, over a protocol where the error
// and the result share one envelope. Every caller was CASTING it:
//
//   const body = (await res.json()) as RpcResponse;
//
// `interface RpcResponse { result?: unknown; error?: { message?: string } }`
// was declared twice, byte-identical, in head-poller.ts and raw-chain-capture.ts,
// and three more call sites cast the same shape inline. A cast at this boundary
// is a promise the runtime never checks: a proxy returning an HTML error page
// with a 200, or a node answering `{"result": null}` where a block was expected,
// both satisfy the type and fail somewhere downstream instead.
//
// PARSED, not cast, and this is exactly where the #11189 line falls: Zod belongs
// at boundaries where data arrives from outside the process, and NOT over
// constants the compiler already owns. This is the former. The SCHEMA lives in
// schemas-src/chain-rpc-envelope.ts so the schema gates cover it; only the call
// lives here.
//
// ## WHAT IT DELIBERATELY DOES NOT DO
//
// It does not type `result`. The shape of a result depends on the method, and a
// schema per method would be a second copy of the chain's own types -- which is
// the drift #11207 catalogues. Callers decode their own result; what this
// guarantees is that an ENVELOPE arrived at all, and that an `error` member is
// raised as one rather than read past.
import { ChainRpcEnvelopeSchema } from "../schemas-src/chain-rpc-envelope.ts";

/**
 * An RPC error rendered for a human, preferring `.message` when the node sent
 * one.
 *
 * Both formats were in use -- `body.error.message` in head-poller and
 * raw-chain-capture, `JSON.stringify(body.error)` in safe-mode-watchdog -- and
 * neither is right alone: `.message` on a shapeless error yields `undefined`,
 * and stringifying a well-formed one buries the message in braces. Preferring
 * the message and falling back to JSON is strictly better than either and
 * changes no existing message that was already useful.
 */
/**
 * A non-empty description of an RPC error envelope, always.
 *
 * NEVER EMPTY, and the return type is the reason. `JSON.stringify(undefined)`
 * returns `undefined` -- not the string "undefined" -- so this used to be able
 * to hand back a non-string while declaring `string`, and a node sending
 * `{ message: "" }` produced an empty one. Both reach the caller as
 * `state_getStorage: ` with nothing after the colon: a decline that does not
 * say why, which is the failure the message prefix exists to prevent.
 */
/** What a decline says when the node gave nothing to say it with. */
export const UNDESCRIBED_RPC_ERROR = "rpc error with no description";

export function describeRpcError(error: unknown): string {
  if (
    error !== null &&
    typeof error === "object" &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string" &&
    (error as { message: string }).message.trim() !== ""
  ) {
    return (error as { message: string }).message;
  }
  // `?? String(error)` covers the inputs JSON.stringify returns UNDEFINED for
  // -- undefined itself, a function, a symbol -- which is the case that let
  // this return a non-string while declaring `string`.
  //
  // The literal is the actual floor. Falling back to `String(error)` a second
  // time, as this first did, cannot help: the only way to reach the fallback at
  // all is for `String(error)` to have already produced the empty string (a
  // function whose own `toString` returns one), so it would hand back exactly
  // the value it was called to replace.
  const serialized = JSON.stringify(error) ?? String(error);
  return serialized.trim() === "" ? UNDESCRIBED_RPC_ERROR : serialized;
}

export interface ChainRpcOptions {
  /** Injected for tests and for callers that wrap fetch. */
  fetchImpl?: typeof fetch;
  /**
   * The JSON-RPC request id.
   *
   * subtensor-pinned-storage increments one per call. Over HTTP with one
   * request per response nothing correlates on it, so this changes no
   * behaviour -- it is carried so that consolidating does not silently drop
   * something a caller was deliberately doing.
   */
  id?: number;
  /**
   * Abort after this long.
   *
   * Optional because two of the three callers had no timeout at all and adding
   * one would change their failure mode from "hangs until the platform kills
   * it" to "throws" -- a better behaviour, but not one to introduce silently in
   * the same change that consolidates them. safe-mode-watchdog passes its 20s.
   */
  timeoutMs?: number;
}

/**
 * Call `method` and return the raw `result`, or throw.
 *
 * Throws on a non-2xx, on a body that is not a JSON-RPC envelope, and on an
 * envelope carrying `error`. Every message is prefixed with the method, because
 * these run inside lanes that call several in sequence and "HTTP 500" alone
 * does not say which read failed.
 */
export async function chainRpc(
  url: string,
  method: string,
  params: unknown[],
  options: ChainRpcOptions = {},
): Promise<unknown> {
  const doFetch = options.fetchImpl ?? fetch;
  const res = await doFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(options.timeoutMs === undefined
      ? {}
      : { signal: AbortSignal.timeout(options.timeoutMs) }),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: options.id ?? 1,
      method,
      params,
    }),
  });
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);

  // safeParse over a cast: a proxy or captive portal answering 200 with HTML is
  // the case a cast cannot see, and it reaches here as a JSON parse failure or
  // as a non-object. Either way the caller learns the transport lied rather
  // than reading `undefined` off a string.
  let parsedBody: unknown;
  try {
    parsedBody = await res.json();
  } catch (cause) {
    throw new Error(`${method}: response body was not JSON`, { cause });
  }
  const envelope = ChainRpcEnvelopeSchema.safeParse(parsedBody);
  if (!envelope.success) {
    throw new Error(`${method}: response was not a JSON-RPC envelope`);
  }
  if (envelope.data.error !== undefined) {
    throw new Error(`${method}: ${describeRpcError(envelope.data.error)}`);
  }
  return envelope.data.result;
}
