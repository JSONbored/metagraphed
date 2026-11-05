import { createAdaptorServer } from "@hono/node-server";
import { createServer, type IncomingMessage } from "node:http";
import { isIP, type AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import type { NativeApiProcess } from "./native-api-process.ts";
import { errorResponse } from "../workers/http.ts";
import { ipv6ToBytes } from "./ip-safety.ts";

export interface NativeClientIdentity {
  readonly trustedProxyAddresses: readonly string[];
}

export interface NativeHttpOptions {
  origin: string;
  hostname: string;
  port: number;
  maxRequestBytes: number;
  requestTimeoutMillis: number;
  headersTimeoutMillis: number;
  onError(error: unknown): void;
  upgrade?: NativeHttpUpgrade;
  clientIdentity?: NativeClientIdentity;
}

export interface NativeHttpUpgrade {
  handle(
    request: Request,
    incoming: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void>;
  /** Stop upgrade admission and sockets; shared application adapters stay open. */
  close(): Promise<void>;
}

export type NativeHttpApplication = Pick<
  NativeApiProcess<never, never>,
  "state" | "fetch" | "close"
>;

function canonicalAddress(value: unknown): string | undefined {
  if (typeof value !== "string" || value.includes("%")) return;
  const family = isIP(value);
  if (family === 4) return value === "0.0.0.0" ? undefined : value;
  if (family !== 6) return;
  const bytes = ipv6ToBytes(value)!;
  if (bytes.every((byte) => byte === 0)) return;
  if (
    bytes.slice(0, 10).every((byte) => byte === 0) &&
    bytes[10] === 255 &&
    bytes[11] === 255
  )
    return canonicalAddress(bytes.slice(12).join("."));
  return new URL(`http://[${value}]`).hostname.slice(1, -1);
}

function clientIdentityPolicy(
  requested: NativeClientIdentity | undefined,
): NativeClientIdentity | undefined {
  if (requested === undefined) return;
  if (
    !requested ||
    typeof requested !== "object" ||
    Array.isArray(requested) ||
    Object.keys(requested).length !== 1 ||
    !Object.hasOwn(requested, "trustedProxyAddresses") ||
    !Array.isArray(requested.trustedProxyAddresses) ||
    requested.trustedProxyAddresses.length < 1 ||
    requested.trustedProxyAddresses.length > 32
  )
    throw new TypeError(
      "Native client identity requires 1 to 32 exact proxy IPs",
    );
  const addresses = Array.from(requested.trustedProxyAddresses, (value) => {
    const address = canonicalAddress(value);
    if (!address) throw new TypeError("Native trusted proxy IP is invalid");
    return address;
  });
  if (new Set(addresses).size !== addresses.length)
    throw new TypeError("Native trusted proxy IPs must be distinct");
  return Object.freeze({ trustedProxyAddresses: Object.freeze(addresses) });
}

class NativeClientIdentityError extends Error {}

export function trustedHeaders(
  original: Headers,
  remoteAddress: string | undefined,
  origin: URL,
  clientIdentity?: NativeClientIdentity,
) {
  let clientAddress = remoteAddress;
  const peer = clientIdentity && canonicalAddress(remoteAddress);
  if (peer && clientIdentity?.trustedProxyAddresses.includes(peer)) {
    clientAddress = canonicalAddress(original.get("x-real-ip"));
    if (!clientAddress)
      throw new NativeClientIdentityError("Invalid trusted ingress client IP");
  }
  const headers = new Headers(original);
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
  if (clientAddress) headers.set("cf-connecting-ip", clientAddress);
  return headers;
}

class NativePayloadTooLargeError extends Error {}

/** Explicit listener for an already verified composition; no implicit bind address. */
export async function listenNativeApi(
  process: NativeHttpApplication,
  requested: NativeHttpOptions,
): Promise<{ address: AddressInfo; close(): Promise<void> }> {
  const options = {
    ...requested,
    clientIdentity: clientIdentityPolicy(requested.clientIdentity),
  };
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
  if (
    options.upgrade !== undefined &&
    (typeof options.upgrade?.handle !== "function" ||
      typeof options.upgrade?.close !== "function")
  )
    throw new Error("Native HTTP upgrade handler must own admission and close");
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
        const headers = trustedHeaders(
          request.headers,
          incoming.socket.remoteAddress,
          origin,
          options.clientIdentity,
        );
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
        if (error instanceof NativeClientIdentityError)
          return errorResponse(
            "invalid_client_identity",
            "Trusted ingress requires one valid client IP.",
            400,
          );
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
  if (options.upgrade)
    server.on(
      "upgrade",
      (incoming: IncomingMessage, socket: Duplex, head: Buffer) => {
        const aborted = new AbortController();
        socket.once("close", () =>
          aborted.abort(new Error("Native upgrade socket closed")),
        );
        void Promise.resolve()
          .then(async () => {
            if (process.state !== "ready")
              throw new Error("Native composition is not ready");
            const headers = new Headers();
            for (const [name, value] of Object.entries(incoming.headers)) {
              if (Array.isArray(value))
                for (const item of value) headers.append(name, item);
              else if (value !== undefined) headers.set(name, value);
            }
            const path = new URL(incoming.url ?? "/", origin);
            const request = new Request(
              `${origin.origin}${path.pathname}${path.search}`,
              {
                method: incoming.method,
                headers: trustedHeaders(
                  headers,
                  incoming.socket.remoteAddress,
                  origin,
                  options.clientIdentity,
                ),
                signal: aborted.signal,
              },
            );
            await options.upgrade!.handle(request, incoming, socket, head);
          })
          .catch((error) => {
            reportError(error);
            socket.destroy();
          });
      },
    );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.hostname, () => {
      server.removeListener("error", reject);
      resolve();
    });
  }).catch(async (error) => {
    if (options.upgrade) await options.upgrade.close().catch(reportError);
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
      const attempt = Promise.resolve()
        .then(() => options.upgrade?.close())
        .then(() => Promise.all([stopped, process.close()]))
        .then(() => undefined);
      closing = attempt;
      void attempt.catch(() => {
        closing = undefined;
      });
      return attempt;
    },
  };
}
