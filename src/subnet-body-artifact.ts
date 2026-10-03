import { createHash } from "node:crypto";
import { publicCommitArtifactUrl } from "./public-commit-artifact.ts";
import { MAX_SUBNET_BODY_ARTIFACT_BYTES } from "./subnet-body-artifact-policy.ts";

export interface SubnetBodyArtifact {
  url: string;
  sha256: string;
  bytes: number;
}

class BodyArtifactError extends Error {}

/** Race even injected transports/streams that ignore cancellation. */
async function withinSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  let abort: () => void;
  const expired = new Promise<never>((_, reject) => {
    abort = () =>
      reject(new BodyArtifactError("Request body artifact timed out"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    signal.removeEventListener("abort", abort!);
  }
}

/** Resolve one exact request payload after the target's permission/URL checks.
 * Allocate its verified declared length once, and send it only after integrity
 * succeeds. No storage, provider credential or caller header reaches the source. */
export async function fetchSubnetBodyArtifact(
  artifact: SubnetBodyArtifact,
  options: {
    signal: AbortSignal;
    fetchImpl: typeof fetch;
    isUnsafeUrl: (url: string) => Promise<boolean>;
  },
): Promise<Uint8Array<ArrayBuffer>> {
  const { signal, fetchImpl, isUnsafeUrl } = options;
  if (signal.aborted)
    throw new BodyArtifactError("Request body artifact timed out");
  const url = publicCommitArtifactUrl(
    artifact.url,
    "Request body requires a public commit-pinned artifact URL",
  );
  if (
    !Number.isInteger(artifact.bytes) ||
    artifact.bytes < 0 ||
    artifact.bytes > MAX_SUBNET_BODY_ARTIFACT_BYTES ||
    !/^[0-9a-f]{64}$/.test(artifact.sha256)
  )
    throw new BodyArtifactError(
      "Invalid request body artifact length or checksum",
    );
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    if (await withinSignal(isUnsafeUrl(url), signal))
      throw new BodyArtifactError("Request body artifact URL is unsafe");
    response = await withinSignal(
      fetchImpl(url, {
        method: "GET",
        redirect: "manual",
        signal,
        headers: { accept: "application/octet-stream" },
      }).then((result) => {
        if (signal.aborted) {
          void result.body?.cancel().catch(() => {});
          throw new BodyArtifactError("Request body artifact timed out");
        }
        return result;
      }),
      signal,
    );
    if (!response.ok)
      throw new BodyArtifactError(
        `Request body artifact response failed: ${response.status}`,
      );
    const declared = response.headers.get("content-length");
    const encoding = response.headers.get("content-encoding");
    const compressed = encoding !== null && encoding !== "identity";
    if (
      declared !== null &&
      (!/^\d+$/.test(declared) ||
        Number(declared) > MAX_SUBNET_BODY_ARTIFACT_BYTES ||
        (!compressed && Number(declared) !== artifact.bytes))
    )
      throw new BodyArtifactError(
        "Request body artifact declared length mismatch",
      );
    reader = response.body?.getReader();
    if (!reader)
      throw new BodyArtifactError("Request body artifact body is absent");
    const body = new Uint8Array(artifact.bytes);
    let bytes = 0,
      chunks = 0;
    for (;;) {
      const part = await withinSignal(reader.read(), signal);
      if (part.done) break;
      if (++chunks > 65_536 || bytes + part.value.byteLength > body.byteLength)
        throw new BodyArtifactError(
          "Request body artifact exceeds its stream budget",
        );
      body.set(part.value, bytes);
      bytes += part.value.byteLength;
      if (chunks % 64 === 0)
        await withinSignal(
          new Promise<void>((resolve) => setTimeout(resolve, 0)),
          signal,
        );
    }
    if (bytes !== artifact.bytes)
      throw new BodyArtifactError("Request body artifact length mismatch");
    if (createHash("sha256").update(body).digest("hex") !== artifact.sha256)
      throw new BodyArtifactError("Request body artifact checksum mismatch");
    return body;
  } catch (error) {
    if (error instanceof BodyArtifactError) throw error;
    // A source fetch/stream error may contain the full URL. Keep it out of the
    // provider receipt and telemetry; known validation messages are safe above.
    throw new BodyArtifactError("Request body artifact could not be read");
  } finally {
    // Cleanup must not extend the invocation deadline when cancel stalls.
    if (reader) {
      void reader.cancel().catch(() => {});
      try {
        reader.releaseLock();
      } catch {
        /* pending read owns the lock */
      }
    } else void response?.body?.cancel().catch(() => {});
  }
}
