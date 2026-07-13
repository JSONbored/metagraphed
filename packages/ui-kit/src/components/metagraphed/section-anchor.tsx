import { Link2, Check } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { classNames } from "@/lib/format";
import { InfoTooltip } from "./info-tooltip";

/**
 * Section header with stable id for deep-linking, plus a hover "copy link"
 * button that writes #id to the URL and clipboard. Wraps content in a
 * <section data-section-anchor> so global scroll-margin applies.
 */
export type SectionTone = "accent" | "warn" | "ink" | "muted";

const TONE_CLASS: Record<SectionTone, string> = {
  accent: "before:bg-accent",
  warn: "before:bg-health-warn",
  ink: "before:bg-ink-strong",
  muted: "before:bg-border",
};

export function SectionAnchor({
  id,
  title,
  subtitle,
  info,
  right,
  tone,
  children,
}: {
  id: string;
  title: ReactNode;
  subtitle?: ReactNode;
  info?: string;
  right?: ReactNode;
  /** Optional left accent rail color. Omitting it renders no rail (back-compat). */
  tone?: SectionTone;
  children: ReactNode;
}) {
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.hash = id;
    history.replaceState(null, "", url.toString());
    try {
      await navigator.clipboard.writeText(url.toString());
      setCopied(true);
      toast.success("Link copied", { description: `#${id}` });
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.message("Link updated", { description: `#${id}` });
    }
  };

  return (
    <section
      id={id}
      data-section-anchor
      className={classNames(
        "mg-section scroll-mt-32",
        tone &&
          classNames(
            "relative pl-3 before:content-[''] before:absolute before:left-0 before:top-1 before:bottom-1 before:w-[2px] before:rounded-full before:opacity-70",
            TONE_CLASS[tone],
          ),
      )}
    >
      <div className="mb-3 flex items-baseline gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-ink-strong">
              {title}
            </h2>
            {info ? <InfoTooltip label={info} /> : null}
            <button
              type="button"
              onClick={onCopy}
              aria-label={`Copy link to ${typeof title === "string" ? title : id} section`}
              className="mg-anchor-btn inline-flex items-center text-ink-muted hover:text-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded p-0.5"
            >
              {copied ? (
                <Check className="size-3.5 text-accent" />
              ) : (
                <Link2 className="size-3.5" />
              )}
            </button>
          </div>
          {subtitle ? (
            <p className="mt-0.5 text-[11px] text-ink-muted">{subtitle}</p>
          ) : null}
        </div>
        {right ? <div className="shrink-0">{right}</div> : null}
      </div>
      {children}
    </section>
  );
}
