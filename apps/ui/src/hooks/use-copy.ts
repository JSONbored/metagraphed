import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";

interface CopyOpts {
  label?: string;
  /** ms before the "copied" state resets. Default 1400. */
  resetAfter?: number;
  /** Show a toast on success (default true). */
  toastOnSuccess?: boolean;
}

/** Truncates long copied values for toast previews. */
export function truncateCopyPreview(value: string, max = 64): string {
  return value.length > max ? value.slice(0, max) + "…" : value;
}

export function copySuccessTitle(label?: string): string {
  return label ? `Copied ${label}` : "Copied to clipboard";
}

export function copyErrorDescription(err: unknown): string {
  return err instanceof Error ? err.message : "Clipboard unavailable";
}

export function shouldUseNavigatorClipboard(navigatorValue: Navigator | undefined): boolean {
  return typeof navigatorValue !== "undefined" && !!navigatorValue.clipboard;
}

/**
 * Legacy `execCommand("copy")` fallback for browsers without the async
 * Clipboard API. Returns whether the copy actually succeeded: `execCommand`
 * returns `false` (without throwing) when the copy is rejected -- no user
 * activation, blocked by permissions policy, etc. -- so callers must honor the
 * return value rather than assume success.
 */
export function legacyClipboardCopy(value: string): boolean {
  if (typeof document === "undefined") return false;
  const ta = document.createElement("textarea");
  ta.value = value;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  const succeeded = document.execCommand("copy");
  document.body.removeChild(ta);
  return succeeded;
}

/**
 * Shared copy hook used by every "copy this URL/value" interaction.
 * Returns `copied` (truthy for ~1.4s after success) so callers can swap an
 * icon for a green check, plus a `copy(value)` action.
 */
export function useCopy(opts: CopyOpts = {}) {
  const { label, resetAfter = 1400, toastOnSuccess = true } = opts;
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  const copy = useCallback(
    async (value: string) => {
      if (!value) return false;
      try {
        if (shouldUseNavigatorClipboard(typeof navigator !== "undefined" ? navigator : undefined)) {
          await navigator.clipboard.writeText(value);
        } else if (typeof document !== "undefined") {
          // Fallback for older browsers / SSR-safe access pattern. Honor the
          // return value so a rejected copy is reported as a failure below,
          // instead of falsely toasting success.
          if (!legacyClipboardCopy(value)) {
            throw new Error("The clipboard copy command was rejected.");
          }
        }
        setCopied(true);
        if (toastOnSuccess) {
          toast.success(copySuccessTitle(label), {
            description: truncateCopyPreview(value),
            duration: 1800,
          });
        }
        if (timer.current) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), resetAfter);
        return true;
      } catch (err) {
        toast.error("Copy failed", {
          description: copyErrorDescription(err),
        });
        return false;
      }
    },
    [label, resetAfter, toastOnSuccess],
  );

  return { copied, copy };
}
