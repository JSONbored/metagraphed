const SAFE_EXTERNAL_PROTOCOLS = new Set(["http:", "https:"]);

function isBlockedIpv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    return value >= 0 && value <= 255 ? value : null;
  });
  if (octets.some((value) => value === null)) return false;
  const [a, b, c] = octets as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function isBlockedIpv6(hostname: string): boolean {
  if (!hostname.includes(":")) return false;
  return (
    hostname === "" ||
    hostname === "::" ||
    hostname === "::1" ||
    hostname.startsWith("fc") ||
    hostname.startsWith("fd") ||
    hostname.startsWith("fe8") ||
    hostname.startsWith("fe9") ||
    hostname.startsWith("fea") ||
    hostname.startsWith("feb") ||
    hostname.startsWith("ff") ||
    hostname.startsWith("::ffff:")
  );
}

function isPrivateHostname(hostname: string) {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local")
  ) {
    return true;
  }
  return isBlockedIpv4(normalized) || isBlockedIpv6(normalized);
}

/** SSRF/private-host barrier for user-supplied external hrefs. */
export function safeExternalUrl(href?: string) {
  if (!href) return undefined;
  try {
    const url = new URL(href.trim());
    if (
      !SAFE_EXTERNAL_PROTOCOLS.has(url.protocol) ||
      url.username ||
      url.password ||
      isPrivateHostname(url.hostname)
    ) {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}
