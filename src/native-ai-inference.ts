import {
  InferenceIdentitySchema,
  InferenceMessageSchema,
  type InferenceIdentity,
} from "../schemas-src/native-inference.ts";
import {
  OpenAiEmbeddingResponseSchema,
  OpenAiCompletionResponseSchema,
} from "../schemas-src/native-inference-http.ts";
import type { AiInference } from "./ai-inference.ts";
import { createNativeWorkGroup } from "./native-work-group.ts";
import { setImmediate as yieldEventLoop } from "node:timers/promises";

export interface NativeInferenceEndpoint {
  /** Operator-configured API base, e.g. an existing internal server's /v1/. */
  baseUrl: string;
  token?: string;
}
export interface NativeInferenceOptions {
  identity: InferenceIdentity;
  embedding: NativeInferenceEndpoint;
  completion: NativeInferenceEndpoint;
  maxConcurrent: number;
  maxRequestBytes: number;
  maxResponseBytes: number;
  maxOutputTokens: number;
  executionTimeoutMillis: number;
  drainTimeoutMillis: number;
  transport?: typeof fetch;
}

const encoder = new TextEncoder();
function endpoint(value: NativeInferenceEndpoint, path: string) {
  const url = new URL(value.baseUrl);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new TypeError("Inference endpoint must be an explicit HTTP API base");
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  url.pathname += path;
  const headers = new Headers({
    "content-type": "application/json",
    accept: "application/json",
  });
  if (value.token !== undefined) {
    if (!value.token || /[\r\n]/.test(value.token))
      throw new TypeError("Invalid inference authentication token");
    headers.set("authorization", `Bearer ${value.token}`);
  }
  return { url: url.href, headers };
}

async function responseJson(
  response: Response,
  limit: number,
  signal: AbortSignal,
): Promise<unknown> {
  if (!response.body) throw new Error("Inference response body is missing");
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) {
    void response.body.cancel().catch(() => {});
    throw new RangeError("Inference response exceeds its byte budget");
  }
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let reads = 0;
  try {
    signal.throwIfAborted();
    for (;;) {
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      if (
        ++reads > Math.min(limit + 1, 65536) ||
        (bytes += next.value.byteLength) > limit
      )
        throw new RangeError("Inference response exceeds its byte budget");
      if (reads % 128 === 0) {
        await yieldEventLoop();
        signal.throwIfAborted();
      }
      if (next.value.byteLength) chunks.push(next.value.slice());
    }
    const result = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
          result,
        ),
      ) as unknown;
    } catch {
      throw new Error("Inference endpoint returned invalid JSON");
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** HTTP transport for explicitly supplied inference servers. No discovery,
 * model installation, listener, credentials lookup or provider fallback. */
export function createNativeAiInference(
  requested: NativeInferenceOptions,
): AiInference & {
  readonly state: "ready" | "closing" | "closed";
  close(): Promise<void>;
} {
  const options = { ...requested };
  const parsed = InferenceIdentitySchema.parse(options.identity);
  const identity = Object.freeze({
    embedding: Object.freeze(parsed.embedding),
    completion: Object.freeze(parsed.completion),
  });
  for (const [name, value, max] of [
    ["maxConcurrent", options.maxConcurrent, 100],
    ["maxRequestBytes", options.maxRequestBytes, 4 * 1024 * 1024],
    ["maxResponseBytes", options.maxResponseBytes, 32 * 1024 * 1024],
    ["maxOutputTokens", options.maxOutputTokens, 4096],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1 || value > max)
      throw new RangeError(`Invalid native inference ${name}`);
  }
  if (
    options.maxConcurrent *
      (options.maxRequestBytes + options.maxResponseBytes) >
    64 * 1024 * 1024
  )
    throw new RangeError(
      "Native inference aggregate buffering exceeds its budget",
    );
  const embedding = endpoint(options.embedding, "embeddings");
  const completion = endpoint(options.completion, "chat/completions");
  const transport = options.transport ?? globalThis.fetch;
  if (typeof transport !== "function")
    throw new TypeError("Inference transport is required");
  const work = createNativeWorkGroup({
    name: "Native inference",
    executionTimeoutMillis: options.executionTimeoutMillis,
    drainTimeoutMillis: options.drainTimeoutMillis,
  });
  const request = (
    target: ReturnType<typeof endpoint>,
    input: unknown,
    callerSignal?: AbortSignal,
  ) =>
    work.run(
      "inference",
      options.maxConcurrent,
      () => {
        throw new Error("Native inference capacity exceeded");
      },
      (scope) =>
        scope.invoke(async (workSignal) => {
          const signal = callerSignal
            ? AbortSignal.any([workSignal, callerSignal])
            : workSignal;
          signal.throwIfAborted();
          const body = JSON.stringify(input);
          if (encoder.encode(body).byteLength > options.maxRequestBytes)
            throw new RangeError("Inference request exceeds its byte budget");
          const response = await transport(target.url, {
            method: "POST",
            headers: new Headers(target.headers),
            body,
            redirect: "manual",
            signal,
          });
          try {
            signal.throwIfAborted();
            if (response.status !== 200)
              throw new Error(
                `Inference endpoint returned HTTP ${response.status}`,
              );
            return await responseJson(
              response,
              options.maxResponseBytes,
              signal,
            );
          } finally {
            void response.body?.cancel().catch(() => {});
          }
        }),
    );
  return {
    identity,
    get state() {
      return work.state;
    },
    async embed(text, signal) {
      if (!Array.isArray(text) || text.length < 1 || text.length > 100)
        throw new TypeError(
          "Inference embedding input requires 1 to 100 strings",
        );
      const inputs = [...text];
      if (inputs.some((value) => typeof value !== "string"))
        throw new TypeError(
          "Inference embedding input requires 1 to 100 strings",
        );
      if (
        inputs.reduce((size, value) => size + value.length, 0) >
        options.maxRequestBytes
      )
        throw new RangeError("Inference request exceeds its byte budget");
      const result = OpenAiEmbeddingResponseSchema.parse(
        await request(
          embedding,
          {
            model: identity.embedding.model,
            input: inputs,
            encoding_format: "float",
          },
          signal,
        ),
      );
      if (result.data.length !== inputs.length)
        throw new Error("Inference embedding count differs");
      const data: number[][] = Array(inputs.length);
      for (const row of result.data) {
        if (
          row.index >= data.length ||
          data[row.index] !== undefined ||
          row.embedding.length !== identity.embedding.dimensions
        )
          throw new Error("Inference embedding shape differs");
        data[row.index] = row.embedding;
      }
      return { data };
    },
    async complete(messages, maxTokens, signal) {
      if (
        !Array.isArray(messages) ||
        messages.length < 1 ||
        messages.length > 100
      )
        throw new TypeError("Inference messages require 1 to 100 entries");
      if (
        !Number.isSafeInteger(maxTokens) ||
        maxTokens < 1 ||
        maxTokens > options.maxOutputTokens
      )
        throw new RangeError("Inference output token limit exceeds its budget");
      const parsedMessages = Array.from(messages, (message) =>
        InferenceMessageSchema.parse(message),
      );
      if (
        parsedMessages.reduce(
          (size, message) => size + message.content.length,
          0,
        ) > options.maxRequestBytes
      )
        throw new RangeError("Inference request exceeds its byte budget");
      const result = OpenAiCompletionResponseSchema.parse(
        await request(
          completion,
          {
            model: identity.completion.model,
            messages: parsedMessages,
            max_tokens: maxTokens,
            n: 1,
            stream: false,
          },
          signal,
        ),
      );
      return {
        response: result.choices[0]!.message.content,
        ...(result.usage ? { usage: result.usage } : {}),
      };
    },
    close: work.close,
  };
}
