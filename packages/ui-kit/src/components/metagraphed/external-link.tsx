import {
  ExternalLink as ExternalIcon,
  Lock,
  AlertTriangle,
} from "lucide-react";
import { classNames } from "@/lib/format";

interface Props {
  href: string;
  children: React.ReactNode;
  authRequired?: boolean;
  publicSafe?: boolean;
  className?: string;
}

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

export function ExternalLink({
  href,
  children,
  authRequired,
  publicSafe = true,
  className,
}: Props) {
  const safeHref = safeExternalUrl(href);
  const content = (
    <>
      <span className="truncate">{children}</span>
      {safeHref ? (
        <ExternalIcon className="size-3 shrink-0 text-ink-muted" />
      ) : null}
      {authRequired ? (
        <span
          title="Authentication required"
          className="inline-flex items-center gap-0.5 rounded border border-border bg-surface px-1 mg-type-micro text-ink-muted"
        >
          <Lock className="size-2.5" /> auth
        </span>
      ) : null}
      {!publicSafe ? (
        <span
          title="Not public-safe — handle with care"
          className="inline-flex items-center gap-0.5 rounded border border-health-warn/30 bg-health-warn/5 px-1 mg-type-micro text-health-warn"
        >
          <AlertTriangle className="size-2.5" /> private
        </span>
      ) : null}
    </>
  );

  const classes = classNames(
    "inline-flex items-center gap-1 underline decoration-ink/30 underline-offset-2 text-ink-strong",
    safeHref ? "hover:decoration-ink" : "cursor-default decoration-transparent",
    className,
  );

  if (!safeHref) {
    return (
      <span className={classes} title="Blocked unsafe external URL">
        {content}
      </span>
    );
  }

  return (
    <a
      href={safeHref}
      target="_blank"
      rel="noopener noreferrer"
      className={classes}
    >
      {content}
    </a>
  );
}
