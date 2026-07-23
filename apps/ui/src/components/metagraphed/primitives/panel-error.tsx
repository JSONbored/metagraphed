import { AlertTriangle, RefreshCw, Copy, Check } from "lucide-react";
import { useState, type ReactNode } from "react";
import { classNames } from "@/lib/metagraphed/format";
import { GhostButton } from "./ghost-button";

export interface PanelErrorProps {
  title?: string;
  message?: string;
  /** Error / correlation id shown as copyable mono text. */
  errorId?: string;
  onRetry?: () => void;
  /** Content-panel height — matches PanelSkeleton conventions. */
  height?: "sm" | "md" | "lg";
  trailing?: ReactNode;
  className?: string;
}

const HEIGHTS: Record<NonNullable<PanelErrorProps["height"]>, string> = {
  sm: "min-h-[120px]",
  md: "min-h-[200px]",
  lg: "min-h-[320px]",
};

/**
 * PanelError — consistent hairline error card for any panel that fails to
 * load. Matches PanelSkeleton height presets so swap-in is zero-jump.
 */
export function PanelError({
  title = "Couldn't load this panel",
  message = "Something went wrong fetching this data. Retry, or try again in a moment.",
  errorId,
  onRetry,
  height = "md",
  trailing,
  className,
}: PanelErrorProps) {
  const [copied, setCopied] = useState(false);

  return (
    <div
      role="alert"
      className={classNames(
        "mg-panel-error flex flex-col items-center justify-center gap-3 rounded-xl",
        "border border-border/70 bg-card p-6 text-center",
        HEIGHTS[height],
        className,
      )}
    >
      <div className="grid size-9 place-items-center rounded-full bg-surface-2 text-health-warn">
        <AlertTriangle className="size-4" aria-hidden />
      </div>
      <div className="max-w-sm space-y-1">
        <div className="font-display text-[13px] font-semibold text-ink-strong">{title}</div>
        <p className="text-[12px] leading-relaxed text-ink-muted">{message}</p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
        {onRetry ? (
          <GhostButton size="sm" onClick={onRetry} icon={<RefreshCw className="size-3" />}>
            Retry
          </GhostButton>
        ) : null}
        {errorId ? (
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(errorId).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1400);
              });
            }}
            className="mg-focus-ring inline-flex items-center gap-1.5 rounded border border-border bg-paper px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-ink-muted hover:text-ink-strong"
            aria-label={`Copy error id ${errorId}`}
          >
            {copied ? (
              <Check className="size-3" aria-hidden />
            ) : (
              <Copy className="size-3" aria-hidden />
            )}
            <span className="tracking-normal normal-case">id · {errorId.slice(0, 8)}</span>
          </button>
        ) : null}
        {trailing}
      </div>
    </div>
  );
}
