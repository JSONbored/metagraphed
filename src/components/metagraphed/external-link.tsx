import { ExternalLink as ExternalIcon, Lock, AlertTriangle } from "lucide-react";
import { classNames } from "@/lib/metagraphed/format";

interface Props {
  href: string;
  children: React.ReactNode;
  authRequired?: boolean;
  publicSafe?: boolean;
  className?: string;
}

const SAFE_EXTERNAL_PROTOCOLS = new Set(["http:", "https:"]);

function isPrivateHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    (normalized.includes(":") &&
      (normalized === "::1" ||
        normalized.startsWith("fe80:") ||
        normalized.startsWith("fc") ||
        normalized.startsWith("fd")))
  ) {
    return true;
  }

  const octets = normalized.split(".").map((part) => Number(part));
  if (
    octets.length !== 4 ||
    octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }

  const [first, second] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
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
      {safeHref ? <ExternalIcon className="size-3 shrink-0 text-ink-muted" /> : null}
      {authRequired ? (
        <span
          title="Authentication required"
          className="inline-flex items-center gap-0.5 rounded border border-border bg-surface px-1 text-[9px] uppercase tracking-wider text-ink-muted"
        >
          <Lock className="size-2.5" /> auth
        </span>
      ) : null}
      {!publicSafe ? (
        <span
          title="Not public-safe — handle with care"
          className="inline-flex items-center gap-0.5 rounded border border-health-warn/30 bg-health-warn/5 px-1 text-[9px] uppercase tracking-wider text-health-warn"
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
    <a href={safeHref} target="_blank" rel="noopener noreferrer" className={classes}>
      {content}
    </a>
  );
}
