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
 * Legacy `execCommand("copy")` fallback for environments without
 * `navigator.clipboard`. Returns execCommand's boolean result verbatim: `false`
 * means the copy was rejected (e.g. no user activation, or a permissions-policy
 * denial) and must NOT be reported to the user as a success.
 */
export function legacyExecCommandCopy(value: string): boolean {
  const ta = document.createElement("textarea");
  ta.value = value;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand("copy");
  document.body.removeChild(ta);
  return ok;
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
          // Fallback for older browsers / SSR-safe access pattern. execCommand
          // returns false (without throwing) when the copy is rejected — route
          // that through the shared catch below so the user sees an accurate
          // failure instead of a false "Copied" success.
          if (!legacyExecCommandCopy(value)) {
            throw new Error("Clipboard copy command was rejected");
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
