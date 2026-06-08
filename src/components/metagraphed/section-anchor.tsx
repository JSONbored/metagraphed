import { Link2, Check } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { classNames } from "@/lib/metagraphed/format";
import { InfoTooltip } from "./info-tooltip";

/**
 * Section header with stable id for deep-linking, plus a hover "copy link"
 * button that writes #id to the URL and clipboard. Wraps content in a
 * <section data-section-anchor> so global scroll-margin applies.
 */
export function SectionAnchor({
  id,
  title,
  subtitle,
  info,
  right,
  children,
}: {
  id: string;
  title: ReactNode;
  subtitle?: ReactNode;
  info?: string;
  right?: ReactNode;
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
      className={classNames("mg-section scroll-mt-32")}
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
              className="mg-anchor-btn inline-flex items-center text-ink-muted hover:text-ink-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded p-0.5"
            >
              {copied ? <Check className="size-3.5" /> : <Link2 className="size-3.5" />}
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
