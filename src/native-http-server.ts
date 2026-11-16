import { createAdaptorServer } from "@hono/node-server";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import type { NativeApiProcess } from "./native-api-process.ts";
import { errorResponse } from "../workers/http.ts";
import { ipv6ToBytes } from "./ip-safety.ts";

export interface NativeHttpOptions {
  origin: string;
  hostname: string;
  port: number;
  maxRequestBytes: number;
  requestTimeoutMillis: number;
  headersTimeoutMillis: number;
  onError(error: unknown): void;
  upgrade?: NativeHttpUpgrade;
  /** Absent: every client identity is the TCP peer (direct exposure). */
  clientIdentity?: NativeClientIdentityPolicy;
}

/**
 * Trusted-ingress client identity (#13118). Behind a TLS-terminating reverse
 * proxy every TCP peer is the proxy, so socket-derived identity collapses all
 * clients into one for rate limits and the WebSocket per-IP cap. When the
 * peer's address is listed here, the client identity is taken from the single
 * `X-Real-IP` value the proxy wrote instead; every other peer keeps the
 * socket-derived identity, and all forwarding/Cloudflare headers are stripped
 * either way.
 *
 * The proxy MUST overwrite any incoming `X-Real-IP` with the address of ITS
 * peer -- a proxy that forwards a client-supplied value hands every client a
 * chosen identity. Entries are exact IP literals (at most 32); IPv4-mapped
 * IPv6 normalizes to the IPv4 form so a dual-stack peer matches either
 * spelling. Hostnames, CIDR ranges, wildcards, zone-scoped addresses and the
 * unspecified address are refused at listen time.
 */
export interface NativeClientIdentityPolicy {
  trustedProxyAddresses: readonly string[];
}

const NATIVE_TRUSTED_PROXY_LIMIT = 32;

/** Exact IP literal -> canonical identity key, or null when it is anything
 * else (hostname, CIDR, wildcard, zone-scoped, embedded whitespace). */
function canonicalIpLiteral(value: string): string | null {
  if (value === "" || /[\s%*/]/.test(value)) return null;
  if (!value.includes(":")) {
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return null;
    const octets = value.split(".").map(Number);
    if (octets.some((octet) => octet > 255)) return null;
    return octets.join(".");
  }
  const bytes = ipv6ToBytes(value);
  if (bytes === null) return null;
  // IPv4-mapped (::ffff:0:0/96) normalizes to the IPv4 form: Node reports a
  // dual-stack peer as ::ffff:a.b.c.d, and one client must stay one identity.
  if (
    bytes.slice(0, 10).every((byte) => byte === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff
  )
    return bytes.slice(12).join(".");
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2)
    groups.push(((bytes[i]! << 8) | bytes[i + 1]!).toString(16));
  return groups.join(":");
}

function isUnspecifiedIp(key: string): boolean {
  return key === "0.0.0.0" || key === "0:0:0:0:0:0:0:0";
}

/** Validate and SNAPSHOT the policy before binding, so later mutation of the
 * caller's array cannot broaden trust while the listener is serving. */
function compileTrustedProxies(
  policy: NativeClientIdentityPolicy,
): ReadonlySet<string> {
  const entries = [...policy.trustedProxyAddresses];
  if (entries.length === 0 || entries.length > NATIVE_TRUSTED_PROXY_LIMIT) {
    throw new Error(
      `Native client identity policy must list 1-${NATIVE_TRUSTED_PROXY_LIMIT} trusted proxy addresses`,
    );
  }
  const trusted = new Set<string>();
  for (const entry of entries) {
    const key = typeof entry === "string" ? canonicalIpLiteral(entry) : null;
    if (key === null || isUnspecifiedIp(key)) {
      throw new Error(
        "Native trusted proxy entries must be exact unicast IP literals " +
          "(no hostname, wildcard, CIDR, zone or unspecified address)",
      );
    }
    trusted.add(key);
  }
  return trusted;
}

class NativeClientIdentityError extends Error {}

/** The client identity for one connection: the single proxy-written
 * `X-Real-IP` when the peer is a configured trusted proxy, otherwise the TCP
 * peer unchanged. Throws (refusing the request before dispatch or upgrade
 * admission) when a trusted proxy failed its one obligation. */
function deriveClientAddress(
  remoteAddress: string | undefined,
  headers: Headers,
  trustedProxies: ReadonlySet<string> | null,
): string | undefined {
  if (trustedProxies === null || remoteAddress === undefined)
    return remoteAddress;
  const peer = canonicalIpLiteral(remoteAddress);
  if (peer === null || !trustedProxies.has(peer)) return remoteAddress;
  const declared = headers.get("x-real-ip");
  // Repeated headers arrive comma-joined, so one get() sees every value.
  if (declared === null || declared.includes(",")) {
    throw new NativeClientIdentityError(
      "Trusted proxy must write exactly one X-Real-IP client identity",
    );
  }
  const client = canonicalIpLiteral(declared);
  if (client === null || isUnspecifiedIp(client)) {
    throw new NativeClientIdentityError(
      "Trusted proxy wrote an invalid X-Real-IP client identity",
    );
  }
  return client;
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

export function trustedHeaders(
  original: Headers,
  remoteAddress: string | undefined,
  origin: URL,
) {
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
  if (remoteAddress) headers.set("cf-connecting-ip", remoteAddress);
  return headers;
}

class NativePayloadTooLargeError extends Error {}

/** Explicit listener for an already verified composition; no implicit bind address. */
export async function listenNativeApi(
  process: NativeHttpApplication,
  requested: NativeHttpOptions,
): Promise<{ address: AddressInfo; close(): Promise<void> }> {
  const options = { ...requested };
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
  // Validated and snapshotted before the listener binds (#13118).
  const trustedProxies =
    options.clientIdentity === undefined
      ? null
      : compileTrustedProxies(options.clientIdentity);
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
          deriveClientAddress(
            incoming.socket.remoteAddress,
            request.headers,
            trustedProxies,
          ),
          origin,
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
        reportError(error);
        if (error instanceof NativeClientIdentityError) {
          return errorResponse(
            "invalid_client_identity",
            "Missing or invalid proxied client identity.",
            400,
          );
        }
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
                  deriveClientAddress(
                    incoming.socket.remoteAddress,
                    headers,
                    trustedProxies,
                  ),
                  origin,
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
