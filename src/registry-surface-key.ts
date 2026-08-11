// The registry surface KEY, and the URL normalisation it is built from
// (#10026).
//
// WHY THIS LIVES IN src/ AND NOT scripts/. `surface_key` is the locator every
// registry write derives, and the registry sync that derives it is moving from
// a node script into a Worker (#9779). A Worker cannot import scripts/lib.ts:
// that module pulls in node:fs, node:child_process and undici at the top
// level. So the derivation has to be reachable from both sides, and this is
// that module.
//
// MOVED, NOT REWRITTEN, and the distinction is the whole point. The key is
// `netuid|kind|normalised-url` lowercased, and it is what joins a surface to
// its probe history. A re-implementation that normalised even ONE url
// differently would mint a key matching nothing -- the surface would look new,
// its history would look orphaned, and neither would raise an error.
// scripts/lib.ts re-exports every name below, so there is exactly one
// implementation and no caller changes.
//
// node:net WORKS IN WORKERS, which is what makes this possible rather than
// forcing an approximation of the SSRF guards. `isIP` and `BlockList` are both
// natively supported under nodejs_compat (Cloudflare changelog 2025-01-28).
import { BlockList, isIP } from "node:net";

// Mirrors scripts/lib.ts's own Row: registry overlays are validated against
// the surface schema, not against a TS type, and threading `unknown` through
// every `?.` would add casts without adding safety.
type Row = Record<string, unknown>;

const credentialedUrlParams = new Set([
  "access_key",
  "access-token",
  "access_token",
  "app_domain",
  "api-key",
  "api_key",
  "apikey",
  "auth",
  "authorization",
  "authuser",
  "bearer",
  "client_id",
  "code_challenge",
  "code_challenge_method",
  "continue",
  "cookie",
  "credential",
  "dsh",
  "flowname",
  "jwt",
  "key",
  "nonce",
  "opparams",
  "part",
  "password",
  "prompt",
  "rart",
  "redirect_uri",
  "refresh-token",
  "refresh_token",
  "response_type",
  "scope",
  "secret",
  "service",
  "session",
  "sig",
  "signature",
  "state",
  "token",
  "x-amz-credential",
  "x-amz-signature",
  "x-amz-security-token",
  "x-goog-credential",
  "x-goog-signature",
  "x-goog-security-token",
  "x-goog-signedheaders",
  "x-goog-expires",
  "x-oss-signature",
  "x-oss-credential",
]);

const unsafeIpBlocks = new BlockList();
unsafeIpBlocks.addSubnet("0.0.0.0", 8);
unsafeIpBlocks.addSubnet("10.0.0.0", 8);
unsafeIpBlocks.addSubnet("100.64.0.0", 10);
unsafeIpBlocks.addSubnet("127.0.0.0", 8);
unsafeIpBlocks.addSubnet("169.254.0.0", 16);
unsafeIpBlocks.addSubnet("172.16.0.0", 12);
unsafeIpBlocks.addSubnet("192.0.0.0", 24);
unsafeIpBlocks.addSubnet("192.168.0.0", 16);
unsafeIpBlocks.addSubnet("198.18.0.0", 15);
unsafeIpBlocks.addSubnet("224.0.0.0", 4);
unsafeIpBlocks.addSubnet("255.255.255.255", 32);
unsafeIpBlocks.addSubnet("::", 128, "ipv6");
unsafeIpBlocks.addSubnet("::1", 128, "ipv6");
unsafeIpBlocks.addSubnet("64:ff9b:1::", 48, "ipv6");
unsafeIpBlocks.addSubnet("100::", 64, "ipv6");
unsafeIpBlocks.addSubnet("fc00::", 7, "ipv6");
unsafeIpBlocks.addSubnet("fe80::", 10, "ipv6");
unsafeIpBlocks.addSubnet("fec0::", 10, "ipv6"); // deprecated site-local (RFC 3879)
unsafeIpBlocks.addSubnet("ff00::", 8, "ipv6");

// metagraphed's own public domain. Candidate base_urls that impersonate it must
// never enter the discovery bundle.
const SELF_DOMAIN = "metagraph.sh";

export function isUnsafeUrl(value: unknown): boolean {
  try {
    const url = new URL(value as string);
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
      return true;
    }
    if (url.username || url.password) {
      return true;
    }

    const host = normalizeHostname(url.hostname);
    return isUnsafeHostname(host);
  } catch {
    return true;
  }
}

function isUnsafeHostname(host: string): boolean {
  if (
    !host ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "local" ||
    host.endsWith(".local")
  ) {
    return true;
  }

  return isUnsafeIpAddress(host);
}

// Reject candidate URLs that trade on metagraphed's own identity. The SSRF guard
// (isUnsafeUrl/isUnsafeResolvedUrl) passes for an attacker-registered PUBLIC
// domain, so a base_url that reads as "metagraph.sh" — metagraph.sh.evil.com,
// metagraphsh.com, metagraph-sh.io — would clear it yet could get an agent to
// trust and call it. The real metagraph.sh and its subdomains are exempt; this
// targets squats of our exact domain, not the generic "metagraph" Bittensor term
// (a subnet legitimately named "…metagraph…" is unaffected).
export function isBrandImpersonationUrl(value: unknown): boolean {
  let url: URL;
  try {
    url = new URL(value as string);
  } catch {
    return false;
  }

  // A trailing dot is the FQDN-canonical form of the same hostname, so strip it
  // before the self-domain exemption — otherwise "metagraph.sh." (and real
  // subdomains like "api.metagraph.sh.") fail the `=== SELF_DOMAIN` / `.endsWith`
  // check and get wrongly flagged as impersonating our own domain.
  const host = url.hostname
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^www\./, "");
  if (host === SELF_DOMAIN || host.endsWith(`.${SELF_DOMAIN}`)) {
    return false;
  }

  const userinfo = `${url.username}:${url.password}`.toLowerCase();
  return (
    /metagraph\.sh(?:[.-]|$)|metagraph-?sh(?:[.-]|$)|metagraphsh/.test(host) ||
    /metagraph\.sh|metagraph-?sh|metagraphsh/.test(userinfo)
  );
}

export function isUnsafeIpAddress(address: string): boolean {
  const normalized = normalizeHostname(address);
  const family = isIP(normalized);
  return (
    family !== 0 &&
    unsafeIpBlocks.check(normalized, family === 4 ? "ipv4" : "ipv6")
  );
}

export function normalizeHostname(hostname: unknown): string {
  return String(hostname || "")
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1")
    .replace(/\.$/, "");
}

export function isCredentialedUrl(value: unknown): boolean {
  try {
    const url = new URL(value as string);
    if (url.username || url.password) {
      return true;
    }
    for (const key of url.searchParams.keys()) {
      if (credentialedUrlParams.has(key.toLowerCase())) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

export function normalizePublicUrl(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  let candidate = value
    .trim()
    .replace(/^[<`"']+|[>`"',.;:!]+$/g, "")
    .split("](")[0]
    .replace(/[\]`"',.;:!]+$/g, "");
  if (!candidate) {
    return null;
  }

  if (
    !/^(https?|wss?):\/\//i.test(candidate) &&
    /^[a-z0-9.-]+\.[a-z]{2,}(?:\/.*)?$/i.test(candidate)
  ) {
    candidate = `https://${candidate}`;
  }

  try {
    const url = new URL(candidate);
    if (
      !["http:", "https:", "ws:", "wss:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      isCredentialedUrl(url.toString()) ||
      isUnsafeUrl(url.toString()) ||
      // #5990: the brand-impersonation guard (ADR 0004) previously ran only on
      // the deprecated discovery path's local copy; run it here too so every
      // contributor-submitted surface URL -- the path that actually ships today
      // (validate-surface.ts / surface-add.ts) -- is checked, not just
      // auto-discovered candidates.
      isBrandImpersonationUrl(url.toString())
    ) {
      return null;
    }
    url.hash = "";
    if (url.pathname !== "/") {
      url.pathname = url.pathname.replace(/\/+$/, "");
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function normalizePublicHttpUrl(value: unknown): string | null {
  const normalized = normalizePublicUrl(value);
  if (!normalized) {
    return null;
  }

  const protocol = new URL(normalized).protocol;
  return ["http:", "https:"].includes(protocol) ? normalized : null;
}

export function registrySurfaceKey(entry: Row): string {
  const normalizedUrl = normalizePublicUrl(entry?.url);
  return [
    entry?.netuid ?? "unknown",
    entry?.kind || "unknown",
    normalizedUrl || entry?.url || "unknown",
  ]
    .join("|")
    .toLowerCase();
}

// Locator key for a surface stored under a subnet. Stored surfaces have no
// netuid (it lives on the parent), so inject it before keying — otherwise
// registrySurfaceKey degrades to "unknown|kind|url" and never matches.
export function subnetSurfaceKey(surface: Row, netuid: unknown): string {
  return registrySurfaceKey({ ...surface, netuid });
}
