// Native DNS validation and connection pinning shared by script and process owners.
// Moved from scripts/lib.ts without changing its existing URL safety decisions.
import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { isIP, type LookupFunction } from "node:net";
import { Agent } from "undici";
import {
  isUnsafeIpAddress,
  isUnsafeUrl,
  normalizeHostname,
} from "./registry-surface-key.ts";

export interface ResolvedAddress {
  address: string;
  family: number;
}

export type PublicUrlResolver = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<LookupAddress[]>;

/**
 * Why a URL yielded no address to connect to (#9870).
 *
 * All three refuse the connection, but they are NOT the same claim about the
 * world, and collapsing them is what made us report `unsafe URL` for a host
 * that simply no longer exists:
 *
 *   - `unsafe`        — we looked, and connecting would be a safety problem: the
 *                       literal guard rejected it, or DNS answered with a
 *                       private/loopback/link-local address (rebinding).
 *   - `unresolvable`  — we looked, and the name authoritatively does not exist
 *                       (NXDOMAIN / no records). Nothing unsafe about it; it is
 *                       DEAD, and that is a fact about the target worth
 *                       publishing.
 *   - `resolve-error` — we could not look. A transient resolver error, a
 *                       timeout, our own network. This is a fact about US, and
 *                       must never be scored as the target being dead —
 *                       "absence of evidence is not death"
 *                       (src/surface-verification.ts).
 *
 * The `unsafe` / `resolve-error` split (and those exact names) already exist in
 * `resolvedWebhookUrlStatus` (src/webhooks.ts), for the same reason: a DNS blip
 * must be retryable, not a terminal verdict. This adds the third case webhooks
 * has no use for — an authoritative "no such name".
 */
export type UrlResolutionFailure = "unsafe" | "unresolvable" | "resolve-error";

export interface UrlResolution {
  addresses: ResolvedAddress[];
  /** null exactly when `addresses` is non-empty. */
  failure: UrlResolutionFailure | null;
}

/**
 * The one place each failure is put into words. Every caller that reports a
 * reason to a human or an artifact reads this map, so `api.affine.io` cannot be
 * described as "unsafe URL" in one lane and "dead" in another.
 */
export const URL_RESOLUTION_FAILURE_MESSAGE: Record<
  UrlResolutionFailure,
  string
> = {
  unsafe: "unsafe URL",
  unresolvable: "host does not resolve",
  "resolve-error": "DNS lookup failed",
};

/**
 * Node error codes that mean the resolver got an authoritative "no such name"
 * rather than failing to ask. EAI_AGAIN (temporary failure) is deliberately
 * absent — it is a `resolve-error`, not a death certificate.
 */
const AUTHORITATIVE_DNS_MISS = new Set(["ENOTFOUND", "ENODATA", "EAI_NODATA"]);

/**
 * Resolve a URL to the public addresses it is safe to connect to, and say WHY
 * when there are none. `resolvePublicUrlAddresses`/`isUnsafeResolvedUrl` are
 * thin wrappers so every existing caller keeps its exact signature — only
 * callers that report a reason to a human need the richer result.
 */
export async function resolveUrlSafety(
  value: unknown,
  resolver: PublicUrlResolver = lookup,
): Promise<UrlResolution> {
  let host: string;
  try {
    const url = new URL(value as string);
    if (isUnsafeUrl(url.toString())) {
      return { addresses: [], failure: "unsafe" };
    }
    host = normalizeHostname(url.hostname);
  } catch {
    // Not a URL at all. A malformed input is a safety refusal, not a claim
    // that some host is dead.
    return { addresses: [], failure: "unsafe" };
  }

  if (isIP(host)) {
    return {
      addresses: [{ address: host, family: isIP(host) }],
      failure: null,
    };
  }

  try {
    const records = await resolver(host, { all: true, verbatim: true });
    if (records.length === 0) {
      return { addresses: [], failure: "unresolvable" };
    }
    if (records.some((record) => isUnsafeIpAddress(record.address))) {
      return { addresses: [], failure: "unsafe" };
    }
    return {
      addresses: records.map((record) => ({
        address: record.address,
        family: record.family,
      })),
      failure: null,
    };
  } catch (error) {
    // The resolver threw. ENOTFOUND/ENODATA is how Node reports NXDOMAIN — an
    // authoritative "no such name", i.e. dead. Anything else (EAI_AGAIN,
    // SERVFAIL, timeout) means we failed to ask, which is our problem and must
    // not be recorded against the target.
    const code = (error as NodeJS.ErrnoException)?.code;
    return {
      addresses: [],
      failure: AUTHORITATIVE_DNS_MISS.has(String(code))
        ? "unresolvable"
        : "resolve-error",
    };
  }
}

export async function resolvePublicUrlAddresses(
  value: unknown,
  resolver: PublicUrlResolver = lookup,
): Promise<ResolvedAddress[]> {
  return (await resolveUrlSafety(value, resolver)).addresses;
}

export async function isUnsafeResolvedUrl(
  value: unknown,
  resolver: PublicUrlResolver = lookup,
): Promise<boolean> {
  return (await resolveUrlSafety(value, resolver)).failure !== null;
}

export const SAFE_FETCH_REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

// The connect-time DNS lookup that pins the single validated answer: every
// connection for this hop resolves `hostname` to the exact `address` that
// resolvePublicUrlAddresses already vetted, and rejects a lookup for any other
// host — closing the TOCTOU DNS-rebinding window between the safety check and the
// actual socket. Returns a Node `dns.lookup`-shaped callback (single-answer and
// `{ all: true }` array forms). Exported so its branches are unit-covered.
export function createPinnedLookup(
  hostname: string,
  address: string,
  family: number,
): LookupFunction {
  return (requestedHostname, options, callback): void => {
    if (normalizeHostname(requestedHostname) !== hostname) {
      // `[]` rather than a fabricated address. Every consumer checks the error
      // argument first and never reads this one, and "resolved nothing" is the
      // truthful thing to say -- Node's LookupFunction declares the parameter
      // required, so the choice is between an empty result and a lie.
      callback(
        new Error("safeFetch attempted to resolve an unpinned host"),
        [],
      );
      return;
    }
    if (options?.all) {
      callback(null, [{ address, family }]);
      return;
    }
    callback(null, address, family);
  };
}

export function createPinnedAddressDispatcher(
  hostname: string,
  address: string,
  family: number,
): Agent {
  return new Agent({
    connect: { lookup: createPinnedLookup(hostname, address, family) },
  });
}
