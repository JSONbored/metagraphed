import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";

interface CopyOpts {
  label?: string;
  /** ms before the "copied" state resets. Default 1400. */
  resetAfter?: number;
  /** Show a toast on success (default true). */
  toastOnSuccess?: boolean;
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
        if (typeof navigator !== "undefined" && navigator.clipboard) {
          await navigator.clipboard.writeText(value);
        } else if (typeof document !== "undefined") {
          // Fallback for older browsers / SSR-safe access pattern.
          const ta = document.createElement("textarea");
          ta.value = value;
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          document.body.removeChild(ta);
        }
        setCopied(true);
        if (toastOnSuccess) {
          toast.success(label ? `Copied ${label}` : "Copied to clipboard", {
            description: value.length > 64 ? value.slice(0, 64) + "…" : value,
            duration: 1800,
          });
        }
        if (timer.current) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), resetAfter);
        return true;
      } catch (err) {
        toast.error("Copy failed", {
          description: err instanceof Error ? err.message : "Clipboard unavailable",
        });
        return false;
      }
    },
    [label, resetAfter, toastOnSuccess],
  );

  return { copied, copy };
}
