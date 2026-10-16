import { ApiError, buildUrl } from "./client";
import { extrinsicHashPathSegment } from "./extrinsics";

export const MAX_EXTRINSIC_RAW_BYTES = 1024 * 1024;
export const EXTRINSIC_RAW_TIMEOUT_MS = 15_000;

export function extrinsicRawUrl(ref: string): string {
  return buildUrl(`/api/v1/extrinsics/${extrinsicHashPathSegment(ref)}`);
}

/** The exact decoded UTF-8 response text, never JSON reserialization or chain bytes. */
export async function fetchExtrinsicRaw(url: string, signal?: AbortSignal): Promise<string> {
  const deadline = AbortSignal.timeout(EXTRINSIC_RAW_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let onAbort: (() => void) | undefined;
  const fail = (message: string, status = 0, code = "raw_record_unavailable") =>
    new ApiError(message, { status, code, url });
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: combined,
    });
    if (!response.body) throw fail("The exact API response body is unavailable.", response.status);
    reader = response.body.getReader();
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(combined.reason);
      combined.addEventListener("abort", onAbort, { once: true });
      if (combined.aborted) onAbort();
    });
    const drain = async () => {
      const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
      let bytes = 0;
      let chunks = 0;
      let text = "";
      for (;;) {
        const chunk = await reader!.read();
        if (chunk.done) break;
        if (++chunks > 4096)
          throw fail(
            "The exact API response exceeds the stream chunk limit. No partial copy is offered.",
            response.status,
            "raw_record_chunk_limit",
          );
        bytes += chunk.value.byteLength;
        if (bytes > MAX_EXTRINSIC_RAW_BYTES) {
          throw fail(
            "The exact API response exceeds the 1 MiB display limit. No partial copy is offered.",
            response.status,
            "raw_record_too_large",
          );
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      return text + decoder.decode();
    };
    // One cancellation race for the whole drain, avoiding a retained abort
    // reaction for every tiny chunk. The finite chunk cap also covers empties.
    const text = await Promise.race([drain(), aborted]);
    // Classification only. Return the original text, including whitespace, BOM,
    // escapes and integer tokens which JSON.parse cannot represent losslessly.
    let body: unknown;
    try {
      body = JSON.parse(text.startsWith("\uFEFF") ? text.slice(1) : text);
    } catch {
      throw fail(
        "The API did not return a complete JSON record.",
        response.status,
        "invalid_raw_record",
      );
    }
    const envelope = body as {
      ok?: boolean;
      error?: { code?: string; message?: string };
      meta?: { network?: string };
      data?: { extrinsic?: unknown };
    } | null;
    if (!response.ok || envelope?.ok === false) {
      throw new ApiError(
        envelope?.error?.message || response.statusText || "Exact API record unavailable.",
        {
          status: response.status,
          code: envelope?.error?.code,
          network: envelope?.meta?.network,
          url,
        },
      );
    }
    if (response.headers.get("x-metagraph-degraded") === "tier_unavailable") {
      throw fail(
        "The data tier could not verify this response.",
        response.status,
        "data_tier_unavailable",
      );
    }
    if (!body || typeof body !== "object" || envelope?.data?.extrinsic === null) {
      throw fail("No indexed extrinsic record is available in this response.", response.status);
    }
    return text;
  } catch (error) {
    // Cancellation must not wait on a stalled stream's cancel acknowledgement.
    void reader?.cancel().catch(() => {});
    if (signal?.aborted) throw signal.reason;
    if (deadline.aborted)
      throw fail(
        "The exact API response timed out. Retry to request it again.",
        0,
        "raw_record_timeout",
      );
    if (error instanceof ApiError) throw error;
    throw fail("The exact API response could not be read.");
  } finally {
    if (onAbort) combined.removeEventListener("abort", onAbort);
    reader?.releaseLock();
  }
}
