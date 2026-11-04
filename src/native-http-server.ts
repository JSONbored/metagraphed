import { createAdaptorServer } from "@hono/node-server";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { NativeApiProcess } from "./native-api-process.ts";
import { errorResponse } from "../workers/http.ts";

export interface NativeHttpOptions {
  origin: string;
  hostname: string;
  port: number;
  maxRequestBytes: number;
  requestTimeoutMillis: number;
  headersTimeoutMillis: number;
  onError(error: unknown): void;
}

class NativePayloadTooLargeError extends Error {}

/** Explicit listener for an already verified composition; no implicit bind address. */
export async function listenNativeApi<Scheduled, Queue>(
  process: NativeApiProcess<Scheduled, Queue>,
  options: NativeHttpOptions,
): Promise<{ address: AddressInfo; close(): Promise<void> }> {
  const origin = new URL(options.origin);
  if (
    !/^https?:$/.test(origin.protocol) ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password
  ) {
    throw new Error(
      "Native origin must be an HTTP origin without path or credentials",
    );
  }
  if (
    !options.hostname ||
    !Number.isSafeInteger(options.port) ||
    options.port < 0 ||
    options.port > 65535
  ) {
    throw new Error("Native hostname and port are required");
  }
  for (const value of [
    options.maxRequestBytes,
    options.requestTimeoutMillis,
    options.headersTimeoutMillis,
  ]) {
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error("Native HTTP limits must be positive safe integers");
  }
  if (process.state !== "ready")
    throw new Error("Native composition is not ready");
  if (typeof options.onError !== "function")
    throw new Error("Native HTTP error reporter is required");
  const reportError = (error: unknown) => {
    try {
      options.onError(error);
    } catch {
      /* Preserve the request and server lifecycle. */
    }
  };
  const server = createAdaptorServer({
    createServer,
    serverOptions: {
      requestTimeout: options.requestTimeoutMillis,
      headersTimeout: options.headersTimeoutMillis,
    },
    hostname: options.hostname,
    overrideGlobalObjects: false,
    fetch: async (request, { incoming }) => {
      try {
        const headers = new Headers(request.headers);
        for (const name of [...headers.keys()]) {
          if (
            name === "forwarded" ||
            name === "x-real-ip" ||
            name.startsWith("x-forwarded-") ||
            name.startsWith("cf-")
          )
            headers.delete(name);
        }
        headers.set("host", origin.host);
        if (incoming.socket.remoteAddress)
          headers.set("cf-connecting-ip", incoming.socket.remoteAddress);
        const declaredBytes = headers.get("content-length");
        if (
          declaredBytes !== null &&
          (!/^\d+$/.test(declaredBytes) ||
            Number(declaredBytes) > options.maxRequestBytes)
        ) {
          return errorResponse(
            "payload_too_large",
            "Request body exceeds the configured limit.",
            413,
          );
        }
        let bytes = 0;
        const body = request.body?.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              bytes += chunk.byteLength;
              if (bytes > options.maxRequestBytes)
                throw new NativePayloadTooLargeError(
                  "Request body exceeds the configured limit",
                );
              controller.enqueue(chunk);
            },
          }),
        );
        const path = new URL(request.url);
        const init: RequestInit & { duplex: "half" } = {
          method: request.method,
          headers,
          body,
          duplex: "half",
          signal: request.signal,
        };
        return await process.fetch(
          new Request(`${origin.origin}${path.pathname}${path.search}`, init),
        );
      } catch (error) {
        reportError(error);
        if (error instanceof NativePayloadTooLargeError) {
          return errorResponse(
            "payload_too_large",
            "Request body exceeds the configured limit.",
            413,
          );
        }
        return errorResponse("internal_error", "Request failed.", 500);
      }
    },
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.hostname, () => {
      server.removeListener("error", reject);
      resolve();
    });
  }).catch(async (error) => {
    await process.close().catch(reportError);
    throw error;
  });
  server.on("error", reportError);
  let closing: Promise<void> | undefined;
  let stopped: Promise<void> | undefined;
  return {
    address: server.address() as AddressInfo,
    close() {
      if (closing) return closing;
      stopped ??= new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      const attempt = Promise.all([stopped, process.close()]).then(
        () => undefined,
      );
      closing = attempt;
      void attempt.catch(() => {
        closing = undefined;
      });
      return attempt;
    },
  };
}
