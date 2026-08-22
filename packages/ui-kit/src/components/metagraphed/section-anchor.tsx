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
      // No tone bar. A 2px coloured rail down the left of a section is
      // decoration that says "this one matters" — and it was set on so many of
      // the 86 sections using this component that it stopped distinguishing
      // anything and just added a coloured edge to most of the page. `tone` is
      // still accepted so call sites need not change, and it still tints the
      // heading, which is where an emphasis belongs.
      className={classNames("mg-section mg-detail-section scroll-mt-32")}
    >
      <div className="mb-3 flex items-center gap-3">
        <div className="min-w-0 flex-1">
          {/* #8536: bare `flex items-center gap-1.5` was the exact overflow
              fingerprint on /status|/settings|/explorer|/endpoints@375 — the
              title+tooltip+copy cluster had no shrink/truncate contract, so a
              long section title forced the row past the viewport. Mirror the
              #8433 drift-chip pattern: min-w-0 + truncate on the title, keep
              the full value on `title` when it's a string. */}
          <div className="flex min-w-0 max-w-full items-center gap-1.5">
            <h2
              className={classNames(
                "min-w-0 truncate font-mono mg-type-micro font-semibold uppercase",
                tone === "accent" ? "text-accent-text" : "text-ink-muted",
              )}
              title={typeof title === "string" ? title : undefined}
            >
              {title}
            </h2>
            {info ? <InfoTooltip label={info} /> : null}
            <button
              type="button"
              onClick={onCopy}
              aria-label={`Copy link to ${typeof title === "string" ? title : id} section`}
              className="mg-anchor-btn inline-flex shrink-0 items-center justify-center text-ink-muted hover:text-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded min-h-11 min-w-11 p-0.5"
            >
              {copied ? (
                <Check className="size-3.5 text-accent" />
              ) : (
                <Link2 className="size-3.5" />
              )}
            </button>
          </div>
          {subtitle ? (
            <p className="mt-0.5 mg-type-caption text-ink-muted">{subtitle}</p>
          ) : null}
        </div>
        {right ? <div className="shrink-0">{right}</div> : null}
      </div>
      {children}
    </section>
  );
}
