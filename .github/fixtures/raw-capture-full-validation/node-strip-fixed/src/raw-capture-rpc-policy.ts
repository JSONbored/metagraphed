import {
  RAW_CAPTURE_MAX_BYTES,
  RAW_CAPTURE_CHUNK_BYTES,
} from "./raw-capture-retry-intent.ts";
import { MAX_RPC_BATCH_CALLS } from "./raw-chain-capture.ts";

/** Proposed opt-in policy, not an existing RPC contract. A compact maximum
 * resource fixture is 33,550,798 response-body bytes; this 32 MiB ceiling has
 * 3,634 bytes of margin for that fixture, not for arbitrary equivalent JSON.
 * Escapes, whitespace, unknown members and excess replies can now be refused.
 * Nothing in canonical production selects this policy. */
export const RAW_CAPTURE_RPC_POLICY_PROPOSAL = Object.freeze({
  enabled: false,
  maxBodyBytes: RAW_CAPTURE_MAX_BYTES,
  readBytes: RAW_CAPTURE_CHUNK_BYTES,
  maxReplies: MAX_RPC_BATCH_CALLS,
});

export interface RawCaptureRpcInputPolicy {
  readonly enabled: boolean;
  readonly maxBodyBytes: number;
  readonly readBytes: number;
  readonly maxReplies: number;
}

function assertPolicy(policy: RawCaptureRpcInputPolicy) {
  if (!policy.enabled) throw new Error("raw_capture_rpc_policy_disabled");
  if (
    !Number.isSafeInteger(policy.maxBodyBytes) ||
    policy.maxBodyBytes < 1 ||
    policy.maxBodyBytes > RAW_CAPTURE_MAX_BYTES ||
    !Number.isSafeInteger(policy.readBytes) ||
    policy.readBytes < 1 ||
    policy.readBytes > RAW_CAPTURE_CHUNK_BYTES ||
    !Number.isSafeInteger(policy.maxReplies) ||
    policy.maxReplies < 1 ||
    policy.maxReplies > MAX_RPC_BATCH_CALLS
  )
    throw new Error("raw_capture_rpc_policy_bounds");
  return Object.freeze({
    maxBodyBytes: policy.maxBodyBytes,
    readBytes: policy.readBytes,
    maxReplies: policy.maxReplies,
  });
}

/** Consumer-owned reads only. Requiring BYOB avoids silently falling back to
 * a reader which can hand us an arbitrarily large allocated chunk. Fetch and
 * native compression/socket buffers still require actual-owner qualification.
 * This does not parse JSON, concatenate a body, or call Response.json(). */
export async function* readRawCaptureRpcBody(
  response: Response,
  policy: RawCaptureRpcInputPolicy = RAW_CAPTURE_RPC_POLICY_PROPOSAL,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const limits = assertPolicy(policy);
  if (signal?.aborted) throw new Error("raw_capture_rpc_aborted");
  if (!response.body) throw new Error("raw_capture_rpc_body_missing");
  let reader: ReadableStreamBYOBReader;
  try {
    reader = response.body.getReader({ mode: "byob" });
  } catch {
    // No default-reader fallback: the proposed input bound would be false.
    if (!response.body.locked)
      await response.body.cancel().catch(() => undefined);
    throw new Error("raw_capture_rpc_byob_unavailable");
  }
  let finished = false;
  let cancelled: Promise<void> | undefined;
  const cancel = () => (cancelled ??= reader.cancel().catch(() => undefined));
  const abort = () => {
    void cancel();
  };
  signal?.addEventListener("abort", abort, { once: true });
  let bytes = 0;
  try {
    while (true) {
      if (signal?.aborted) throw new Error("raw_capture_rpc_aborted");
      const next = await reader.read(new Uint8Array(limits.readBytes));
      if (signal?.aborted) throw new Error("raw_capture_rpc_aborted");
      if (next.value) {
        bytes += next.value.byteLength;
        if (bytes > limits.maxBodyBytes)
          throw new Error("raw_capture_rpc_body_budget");
        if (next.value.byteLength) yield next.value;
      }
      if (next.done) {
        finished = true;
        return;
      }
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    if (!finished) await cancel();
    reader.releaseLock();
  }
}

/** A parser/spool port owns complete projected JSON values. They are opaque
 * handles, never a full decoded body or unbounded result strings here. The
 * parser must preserve full headers and canonical JSON semantics; this port
 * alone does not implement or qualify that projection. */
export interface RawCaptureProjectedReply<T> {
  readonly id: number;
  readonly result?: T;
  readonly error?: T;
}

export type RawCaptureReorderedReply<T> =
  | { readonly kind: "missing"; readonly id: number }
  | { readonly kind: "error"; readonly id: number; readonly value: T }
  | {
      readonly kind: "result";
      readonly id: number;
      readonly value: T | undefined;
    };

/** A failed cleanup transfers an explicit retryable custody capability to the
 * caller. The source owner must retain it or journal its outstanding handles
 * before ending the session. Release must be idempotent for lost replies. */
export class RawCaptureRpcCleanupError extends Error {
  declare readonly pendingCount: () => number;
  declare readonly retryCleanup: () => Promise<void>;
  constructor(
    pendingCount: () => number,
    retryCleanup: () => Promise<void>,
    hasPrimaryCause: boolean,
    primaryCause: unknown,
  ) {
    super(
      "raw_capture_rpc_cleanup_pending",
      hasPrimaryCause ? { cause: primaryCause } : undefined,
    );
    this.pendingCount = pendingCount;
    this.retryCleanup = retryCleanup;
    this.name = "RawCaptureRpcCleanupError";
  }
}

/** Preserve caller-index correlation and missing/error precedence while
 * retaining at most the existing 50 request slots plus 50 duplicate-ID keys.
 * Values live in an explicitly supplied spool with its own bounds/lifecycle.
 * Unknown numeric IDs remain ignored by results, but count toward the new
 * opt-in reply ceiling; duplicate unknown IDs are still ambiguous. */
export async function reorderRawCaptureRpc<T>(
  replies: AsyncIterable<RawCaptureProjectedReply<T>>,
  callCount: number,
  release: (value: T) => Promise<void>,
  policy: RawCaptureRpcInputPolicy = RAW_CAPTURE_RPC_POLICY_PROPOSAL,
  signal?: AbortSignal,
) {
  const limits = assertPolicy(policy);
  if (
    !Number.isInteger(callCount) ||
    callCount < 0 ||
    callCount > MAX_RPC_BATCH_CALLS
  )
    throw new Error("raw_capture_rpc_call_budget");
  const byId = new Map<number, RawCaptureProjectedReply<T>>();
  const owned = new Set<T>();
  let disposed = false;
  let disposal: Promise<void> | undefined;
  let hasPrimaryCause = false;
  let primaryCause: unknown;
  const dispose = (): Promise<void> => {
    if (disposal) return disposal;
    disposal = (async () => {
      disposed = true;
      byId.clear();
      const values = [...owned];
      // A synchronous callback throw must not prevent later release attempts.
      const outcomes = await Promise.allSettled(
        values.map((value) => Promise.resolve().then(() => release(value))),
      );
      for (const [index, outcome] of outcomes.entries())
        if (outcome.status === "fulfilled") owned.delete(values[index]!);
      if (owned.size)
        throw new RawCaptureRpcCleanupError(
          () => owned.size,
          dispose,
          hasPrimaryCause,
          primaryCause,
        );
    })();
    const attempt = disposal;
    // Concurrent callers await the same attempt; a failure retains only the
    // unreleased handles and makes an explicit idempotent retry possible.
    void attempt.catch(() => {
      if (disposal === attempt) disposal = undefined;
    });
    return attempt;
  };
  try {
    if (signal?.aborted) throw new Error("raw_capture_rpc_aborted");
    for await (const reply of replies) {
      // Take custody before validation so a refused reply cannot leak its
      // already-created spool components. Aliased handles release only once.
      if (reply.result !== undefined) owned.add(reply.result);
      if (reply.error !== undefined) owned.add(reply.error);
      if (signal?.aborted) throw new Error("raw_capture_rpc_aborted");
      if (typeof reply.id !== "number" || !Number.isFinite(reply.id))
        throw new Error("raw_capture_rpc_id");
      if (byId.has(reply.id)) throw new Error("raw_capture_rpc_duplicate_id");
      if (byId.size >= limits.maxReplies)
        throw new Error("raw_capture_rpc_reply_budget");
      byId.set(
        reply.id,
        Object.freeze({
          id: reply.id,
          ...(reply.result !== undefined ? { result: reply.result } : {}),
          ...(reply.error !== undefined ? { error: reply.error } : {}),
        }),
      );
    }
    if (signal?.aborted) throw new Error("raw_capture_rpc_aborted");
  } catch (error) {
    hasPrimaryCause = true;
    primaryCause = error;
    // Completed cleanup preserves the exact primary exception. Failed cleanup
    // preserves it as cause and returns custody through the error capability.
    await dispose();
    throw error;
  }
  return Object.freeze({
    at(id: number): RawCaptureReorderedReply<T> {
      if (disposed) throw new Error("raw_capture_rpc_reorder_disposed");
      if (!Number.isInteger(id) || id < 0 || id >= callCount)
        throw new Error("raw_capture_rpc_call_index");
      const reply = byId.get(id);
      if (!reply) return { kind: "missing", id };
      if (reply.error !== undefined)
        return { kind: "error", id, value: reply.error };
      return { kind: "result", id, value: reply.result };
    },
    dispose,
  });
}
