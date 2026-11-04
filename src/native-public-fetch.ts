import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import type { Dispatcher } from "undici";
import {
  createPinnedAddressDispatcher,
  resolveUrlSafety,
  SAFE_FETCH_REDIRECT_CODES,
  type PublicUrlResolver,
} from "./native-url-safety.ts";
import {
  normalizeHostname,
  isUnsafeIpAddress,
} from "./registry-surface-key.ts";
import { ipv6EmbeddedIpv4, ipv6ToBytes } from "./ip-safety.ts";

// Additional non-public ranges beyond the shared registry's private-network
// guard. Native metadata must never route into reserved/documentation space.
const reserved = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const)
  reserved.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  reserved.addSubnet(address, prefix, "ipv6");

export function isPublicInternetAddress(address: string): boolean {
  const family = isIP(address);
  if (!family || isUnsafeIpAddress(address)) return false;
  const embedded = ipv6EmbeddedIpv4(address);
  if (embedded) {
    const bytes = ipv6ToBytes(address)!;
    const mapped =
      bytes.slice(0, 10).every((value) => value === 0) &&
      bytes[10] === 255 &&
      bytes[11] === 255;
    return mapped && isPublicInternetAddress(embedded.join("."));
  }
  // Globally routable IPv6 unicast currently occupies 2000::/3. Refuse
  // unspecified, transition and future allocations until explicitly reviewed.
  if (family === 6 && !/^[23][0-9a-f]{3}:/i.test(address)) return false;
  return !reserved.check(address, family === 4 ? "ipv4" : "ipv6");
}

export interface NativePublicFetchOptions {
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxRedirects?: number;
  /** Dependency seams for isolated, network-free qualification. */
  resolver?: PublicUrlResolver;
  transport?: typeof fetch;
  dispatcher?: typeof createPinnedAddressDispatcher;
}

const defaults = {
  timeoutMs: 10_000,
  maxResponseBytes: 1024 * 1024,
  maxRedirects: 5,
};

/** Public metadata GET/HEAD with DNS pinning and one bounded response lifetime.
 * Each invocation owns and drains/destroys its dispatcher; no process globals
 * or other clients' fetch behavior are changed. */
export function createNativePublicFetch(
  options: NativePublicFetchOptions = {},
): typeof fetch {
  const limits = { ...defaults, ...options };
  for (const key of [
    "timeoutMs",
    "maxResponseBytes",
    "maxRedirects",
  ] as const) {
    if (
      !Number.isSafeInteger(limits[key]) ||
      limits[key] < (key === "maxRedirects" ? 0 : 1) ||
      limits[key] > defaults[key]
    ) {
      throw new RangeError(`Invalid public fetch ${key}`);
    }
  }
  const transport = options.transport ?? globalThis.fetch;
  const resolver = options.resolver ?? lookup;
  const makeDispatcher = options.dispatcher ?? createPinnedAddressDispatcher;
  return async (input, init) => {
    const request = new Request(input, init);
    if (request.method !== "GET" && request.method !== "HEAD") {
      throw new TypeError("Public metadata fetch supports GET and HEAD only");
    }
    const deadline = new AbortController();
    const signal = AbortSignal.any([request.signal, deadline.signal]);
    const timer = setTimeout(
      () => deadline.abort(new Error("Public fetch deadline exceeded")),
      limits.timeoutMs,
    );
    let dispatcher: Dispatcher | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let ended = false;
    const discard = (error: unknown) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      bodyController?.error(error);
      void reader?.cancel(error).catch(() => undefined);
      void dispatcher?.destroy().catch(() => undefined);
    };
    const onAbort = () => discard(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    const bounded = <T>(operation: () => Promise<T>): Promise<T> => {
      signal.throwIfAborted();
      return new Promise<T>((resolve, reject) => {
        const cancel = () => reject(signal.reason);
        signal.addEventListener("abort", cancel, { once: true });
        void Promise.resolve()
          .then(() => {
            signal.throwIfAborted();
            return operation();
          })
          .then(resolve, reject)
          .finally(() => signal.removeEventListener("abort", cancel));
      });
    };
    const finish = async () => {
      if (ended) return;
      await bounded(() => dispatcher!.close());
      ended = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    let target = request.url;
    const headers = new Headers(request.headers);
    let redirected = false;
    try {
      for (let hop = 0; ; hop += 1) {
        signal.throwIfAborted();
        const url = new URL(target);
        if (url.protocol !== "https:" && url.protocol !== "http:") {
          throw new TypeError("Public metadata fetch requires HTTP or HTTPS");
        }
        const resolution = await bounded(() =>
          resolveUrlSafety(target, resolver),
        );
        if (
          resolution.failure ||
          !resolution.addresses.every((item) =>
            isPublicInternetAddress(item.address),
          )
        ) {
          throw new TypeError(
            "Public metadata destination is not publicly routable",
          );
        }
        const address = resolution.addresses[0];
        dispatcher = makeDispatcher(
          normalizeHostname(url.hostname),
          address.address,
          address.family,
        );
        headers.delete("host");
        const response = await bounded(() =>
          transport(target, {
            method: request.method,
            headers: new Headers(headers),
            redirect: "manual",
            signal,
            dispatcher,
          } as RequestInit & { dispatcher: Dispatcher }),
        );
        const location = response.headers.get("location");
        if (
          SAFE_FETCH_REDIRECT_CODES.has(response.status) &&
          location &&
          request.redirect !== "manual"
        ) {
          if (request.redirect === "error")
            throw new TypeError("Public metadata redirect refused");
          if (hop >= limits.maxRedirects)
            throw new TypeError("Public metadata redirect limit exceeded");
          const next = new URL(location, target);
          if (next.origin !== url.origin) {
            for (const name of [
              "authorization",
              "proxy-authorization",
              "cookie",
              "cookie2",
            ])
              headers.delete(name);
          }
          await bounded(() => response.body?.cancel() ?? Promise.resolve());
          await bounded(() => dispatcher!.close());
          dispatcher = undefined;
          target = next.href;
          redirected = true;
          continue;
        }
        const declared = response.headers.get("content-length");
        if (
          declared !== null &&
          (!/^\d+$/.test(declared) ||
            Number(declared) > limits.maxResponseBytes)
        ) {
          throw new RangeError("Public metadata response exceeds byte budget");
        }
        const describe = (value: Response): Response => {
          const clone = value.clone.bind(value);
          Object.defineProperties(value, {
            url: { value: target },
            redirected: { value: redirected },
            type: { value: response.type },
            clone: { value: () => describe(clone()) },
          });
          return value;
        };
        if (!response.body) {
          await finish();
          return describe(response);
        }
        reader = response.body.getReader();
        let bytes = 0;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            bodyController = controller;
          },
          async pull(controller) {
            try {
              const next = await bounded(() => reader!.read());
              if (next.done) {
                await finish();
                reader!.releaseLock();
                controller.close();
                return;
              }
              bytes += next.value.byteLength;
              if (bytes > limits.maxResponseBytes)
                throw new RangeError(
                  "Public metadata response exceeds byte budget",
                );
              controller.enqueue(next.value);
            } catch (error) {
              discard(error);
            }
          },
          cancel(reason) {
            // Cancellation can be requested after the output stream has closed.
            bodyController = undefined;
            discard(reason);
          },
        });
        const output = new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
        return describe(output);
      }
    } catch (error) {
      discard(error);
      throw error;
    }
  };
}
