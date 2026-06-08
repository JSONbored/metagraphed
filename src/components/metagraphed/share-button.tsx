import { useState } from "react";
import { Check, Share2 } from "lucide-react";
import { classNames } from "@/lib/metagraphed/format";

interface Props {
  /** Optional explicit URL; defaults to current window.location.href. */
  url?: string;
  label?: string;
  className?: string;
}

export function ShareButton({ url, label = "Share view", className }: Props) {
  const [copied, setCopied] = useState(false);
  const onClick = async () => {
    try {
      const href = url ?? (typeof window !== "undefined" ? window.location.href : "");
      if (!href) return;
      await navigator.clipboard.writeText(href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* ignore */
    }
  };
  return (
    <button
      type="button"
      onClick={onClick}
      title="Copy link with current filters, sort, and page"
      className={classNames(
        "inline-flex items-center gap-1.5 rounded border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-ink hover:border-ink/30 transition-colors",
        className,
      )}
    >
      {copied ? <Check className="size-3 text-health-ok" /> : <Share2 className="size-3 text-ink-muted" />}
      {copied ? "Link copied" : label}
    </button>
  );
}
