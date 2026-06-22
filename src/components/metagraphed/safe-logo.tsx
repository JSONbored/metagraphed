import { useState, type ImgHTMLAttributes } from "react";

interface Props extends Omit<ImgHTMLAttributes<HTMLImageElement>, "onError"> {
  /** Text used to derive initials fallback. */
  fallbackText?: string;
  size?: number;
}

const LOCAL_HOSTNAMES = new Set(["localhost", "localhost.localdomain"]);

function normaliseImageHostname(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
}

function isBlockedIpv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    return value >= 0 && value <= 255 ? value : null;
  });
  if (octets.some((v) => v === null)) return false;
  const [a, b] = octets as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b! >= 64 && b! <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && octets[2] === 100) ||
    (a === 203 && b === 0 && octets[2] === 113) ||
    a! >= 224
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

function safeImageUrl(input?: string | null): string | null {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    if (parsed.username || parsed.password) return null;
    const hostname = normaliseImageHostname(parsed.hostname);
    if (!hostname) return null;
    if (LOCAL_HOSTNAMES.has(hostname)) return null;
    if (hostname.endsWith(".localhost") || hostname.endsWith(".local")) return null;
    if (isBlockedIpv4(hostname) || isBlockedIpv6(hostname)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * <img> with a CORS-safe fallback to an initials avatar. Useful for
 * external provider/subnet logos that may 404 or be blocked.
 */
export function SafeLogo({ src, alt, fallbackText, size = 24, className, ...rest }: Props) {
  const [failed, setFailed] = useState(false);
  const safeSrc = safeImageUrl(src);
  const initials =
    (fallbackText ?? alt ?? "?")
      .trim()
      .split(/\s+/)
      .map((w) => w[0])
      .filter(Boolean)
      .slice(0, 2)
      .join("")
      .toUpperCase() || "?";

  if (!safeSrc || failed) {
    return (
      <span
        aria-label={alt}
        className={
          "inline-flex shrink-0 items-center justify-center rounded-full border border-border bg-surface text-[10px] font-mono font-semibold uppercase text-ink-muted " +
          (className ?? "")
        }
        style={{ width: size, height: size }}
      >
        {initials}
      </span>
    );
  }
  return (
    <img
      {...rest}
      src={safeSrc}
      alt={alt}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={className}
    />
  );
}
