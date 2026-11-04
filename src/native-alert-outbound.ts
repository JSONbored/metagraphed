import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Dispatcher } from "undici";
import {
  createPinnedAddressDispatcher,
  type PublicUrlResolver,
} from "./native-url-safety.ts";
import { isPublicInternetAddress } from "./native-public-fetch.ts";
import { isUnsafeUrl, normalizeHostname } from "./registry-surface-key.ts";
import { bufferNativeRequest } from "./native-request.ts";
import { bufferNativeResponse } from "./native-buffered-response.ts";
import type { NativeAlertOutbound } from "./native-alerter.ts";

export interface NativeAlertOutboundOptions {
  timeoutMillis: number;
  maxRequestBytes: number;
  maxResponseBytes: number;
  /** Isolated qualification seams; the live path uses native DNS and fetch. */
  resolver?: PublicUrlResolver;
  transport?: typeof fetch;
  dispatcher?: typeof createPinnedAddressDispatcher;
}

/** POST-only alert transport. Every request pins a vetted address, preserves
 * authentication/body headers, refuses redirects, and drains or destroys its
 * own dispatcher before returning. No process-wide client is modified. */
export function createNativeAlertOutbound(
  options: NativeAlertOutboundOptions,
): NativeAlertOutbound {
  for (const [name, value, max] of [
    ["timeoutMillis", options.timeoutMillis, 8000],
    ["maxRequestBytes", options.maxRequestBytes, 2097152],
    ["maxResponseBytes", options.maxResponseBytes, 1048576],
  ] as const)
    if (!Number.isSafeInteger(value) || value < 1 || value > max)
      throw new RangeError(`Invalid alert outbound ${name}`);
  const resolver: PublicUrlResolver = options.resolver ?? lookup;
  const transport = options.transport ?? fetch,
    dispatcher = options.dispatcher ?? createPinnedAddressDispatcher;
  return {
    async resolve(hostname, signal) {
      signal.throwIfAborted();
      const rows = await resolver(hostname, { all: true, verbatim: true });
      signal.throwIfAborted();
      return rows;
    },
    async send(request, addresses, beforeSend) {
      const url = new URL(request.url);
      if (
        request.method !== "POST" ||
        isUnsafeUrl(url.href) ||
        !["http:", "https:"].includes(url.protocol)
      )
        throw new TypeError("Invalid native alert destination or method");
      if (
        !Array.isArray(addresses) ||
        addresses.length === 0 ||
        addresses.length > 64
      )
        throw new TypeError(
          "Native alert destination is not publicly routable",
        );
      const pins = addresses.map((row) => ({
        address: row.address,
        family: row.family,
      }));
      if (
        pins.some(
          (row) =>
            isIP(row.address) !== row.family ||
            !isPublicInternetAddress(row.address),
        )
      )
        throw new TypeError(
          "Native alert destination is not publicly routable",
        );
      const hostname = normalizeHostname(url.hostname);
      if (
        isIP(hostname) &&
        (!isPublicInternetAddress(hostname) ||
          !pins.some((row) => row.address === hostname))
      )
        throw new TypeError(
          "Native alert literal address does not match its pin",
        );
      const target = pins[0];
      const deadline = new AbortController(),
        signal = AbortSignal.any([request.signal, deadline.signal]);
      const timer = setTimeout(
        () =>
          deadline.abort(new Error("Native alert outbound deadline exceeded")),
        options.timeoutMillis,
      );
      let connection: Dispatcher | undefined,
        finished = false,
        destroying: Promise<void> | undefined;
      const destroy = () =>
        (destroying ??= connection
          ?.destroy()
          .then(() => undefined)
          .catch(() => {}));
      const abort = () => {
        void destroy();
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        signal.throwIfAborted();
        const bounded = await bufferNativeRequest(
          request,
          signal,
          options.maxRequestBytes,
        );
        const headers = new Headers(bounded.headers);
        headers.delete("host");
        connection = dispatcher(hostname, target.address, target.family);
        signal.throwIfAborted();
        beforeSend();
        const response = await transport(
          new Request(bounded, { headers, redirect: "manual", signal }),
          { dispatcher: connection } as RequestInit & {
            dispatcher: Dispatcher;
          },
        );
        const result = await bufferNativeResponse(
          response,
          signal,
          options.maxResponseBytes,
        );
        signal.throwIfAborted();
        await connection.close();
        signal.throwIfAborted();
        finished = true;
        return result;
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        if (!finished) await destroy();
      }
    },
  };
}
