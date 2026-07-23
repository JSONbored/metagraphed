import { useCallback, useState } from "react";
import { Check, Link2 } from "lucide-react";
import { useLocation } from "@tanstack/react-router";
import { cn } from "@/lib/cn";
import { Tooltip, TooltipContent, TooltipTrigger } from "@jsonbored/ui-kit";

export interface CopyLinkButtonProps {
  /** Fragment identifier to append (without the leading #). Optional. */
  hash?: string;
  /** Override the pathname (defaults to the current route). */
  pathname?: string;
  /** Preserve the current URL search string. Defaults to true. */
  preserveSearch?: boolean;
  /** Optional accessible label. Defaults to "Copy link to this row". */
  label?: string;
  /** Optional tooltip text override. */
  tooltip?: string;
  className?: string;
  size?: "xs" | "sm";
}

/**
 * CopyLinkButton — copies a shareable deep link to a specific row/section
 * (path + preserved search + #hash) using the same clipboard fallback as
 * the standard CopyButton primitive. SSR-safe: reads the location via
 * TanStack Router state so it works during hydration.
 */
export function CopyLinkButton({
  hash,
  pathname,
  preserveSearch = true,
  label = "Copy link to this row",
  tooltip,
  className,
  size = "xs",
}: CopyLinkButtonProps) {
  const location = useLocation();
  const [copied, setCopied] = useState(false);

  const onCopy = useCallback(async () => {
    if (typeof window === "undefined") return;
    const origin = window.location.origin;
    const path = pathname ?? location.pathname;
    const search = preserveSearch ? window.location.search : "";
    const url = `${origin}${path}${search}${hash ? `#${hash}` : ""}`;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        const ta = document.createElement("textarea");
        ta.value = url;
        ta.setAttribute("readonly", "");
        ta.style.position = "absolute";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked (permissions / iframe) — silent */
    }
  }, [hash, pathname, preserveSearch, location.pathname]);

  const dim = size === "sm" ? "size-8" : "size-7";
  const icon = size === "sm" ? "size-4" : "size-3.5";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onCopy}
          aria-label={copied ? `${label} — copied` : label}
          aria-live="polite"
          className={cn(
            "inline-flex items-center justify-center rounded-md text-ink-muted transition-colors",
            "hover:text-ink-strong hover:bg-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            dim,
            className,
          )}
        >
          {copied ? <Check className={cn(icon, "text-health-ok")} /> : <Link2 className={icon} />}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">
        {copied ? "Copied" : (tooltip ?? "Copy share link")}
      </TooltipContent>
    </Tooltip>
  );
}
