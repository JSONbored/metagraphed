import { ExternalLink as ExternalIcon, Lock, AlertTriangle } from "lucide-react";
import { classNames } from "@/lib/metagraphed/format";

interface Props {
  href: string;
  children: React.ReactNode;
  authRequired?: boolean;
  publicSafe?: boolean;
  className?: string;
}

export function ExternalLink({ href, children, authRequired, publicSafe = true, className }: Props) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={classNames(
        "inline-flex items-center gap-1 underline decoration-ink/30 underline-offset-2 hover:decoration-ink text-ink-strong",
        className,
      )}
    >
      <span className="truncate">{children}</span>
      <ExternalIcon className="size-3 shrink-0 text-ink-muted" />
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
    </a>
  );
}
