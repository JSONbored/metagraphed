import { useState } from "react";
import { Check, Share2 } from "lucide-react";
import { toast } from "sonner";
import { classNames } from "@/lib/metagraphed/format";

interface Props {
  /** Optional explicit URL; defaults to current window.location.href. */
  url?: string;
  label?: string;
  className?: string;
}

export function ShareButton({ url, label = "Share view", className }: Props) {
  const [copied, setCopied] = useState(false);
  const [announcement, setAnnouncement] = useState("");

  const onClick = async () => {
    try {
      const href = url ?? (typeof window !== "undefined" ? window.location.href : "");
      if (!href) return;
      await navigator.clipboard.writeText(href);
      setCopied(true);
      setAnnouncement(`Link copied to clipboard: ${href}`);
      toast.success("Link copied", {
        description: "Filters, sort, and pagination are preserved in the URL.",
      });
      window.setTimeout(() => setCopied(false), 1400);
      window.setTimeout(() => setAnnouncement(""), 2000);
    } catch {
      toast.error("Couldn't copy link", {
        description: "Your browser blocked clipboard access.",
      });
      setAnnouncement("Couldn't copy link to clipboard.");
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={onClick}
        aria-label="Copy link with current filters, sort, and page"
        title="Copy link with current filters, sort, and page"
        className={classNames(
          "inline-flex items-center gap-1.5 rounded border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-ink hover:border-ink/30 transition-colors",
          className,
        )}
      >
        {copied ? <Check className="size-3 text-health-ok" /> : <Share2 className="size-3 text-ink-muted" />}
        {copied ? "Link copied" : label}
      </button>
      {/* Screen-reader status — visually hidden, polite live region. */}
      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </>
  );
}
