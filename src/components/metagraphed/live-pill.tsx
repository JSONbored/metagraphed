import { useEffect, useState } from "react";
import { useLiveSse } from "@/lib/metagraphed/sse-context";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { classNames } from "@/lib/metagraphed/format";
import { TimeAgo } from "./time-ago";

/**
 * Tiny status pill that reflects the live SSE snapshot stream. Pulses on
 * each incoming snapshot, dims when the connection is closed/errored.
 */
export function LivePill() {
  const { status, lastEventAt } = useLiveSse();
  const [flash, setFlash] = useState(false);

  useEffect(() => {
    if (!lastEventAt) return;
    setFlash(true);
    const t = window.setTimeout(() => setFlash(false), 1200);
    return () => window.clearTimeout(t);
  }, [lastEventAt]);

  const tone =
    status === "open"
      ? "text-health-ok border-health-ok/30 bg-health-ok/5"
      : status === "connecting"
        ? "text-ink-muted border-border bg-surface/50"
        : status === "error"
          ? "text-health-warn border-health-warn/30 bg-health-warn/5"
          : "text-ink-muted border-border bg-surface/50";

  const label =
    status === "open"
      ? "live"
      : status === "connecting"
        ? "linking"
        : status === "error"
          ? "retry"
          : "idle";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="status"
          aria-live="polite"
          className={classNames(
            "hidden md:inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest transition-colors",
            tone,
          )}
        >
          <span
            aria-hidden
            className={classNames(
              "relative size-1.5 rounded-full",
              status === "open"
                ? "bg-health-ok"
                : status === "error"
                  ? "bg-health-warn"
                  : "bg-ink-muted",
              status === "open" || flash ? "mg-pulse" : "",
            )}
          >
            {status === "open" ? (
              <span
                aria-hidden
                className="absolute inset-0 -m-1 rounded-full ring-1 ring-health-ok/40 motion-safe:animate-ping"
              />
            ) : null}
          </span>
          <span>{label}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-[11px]">
        {status === "open" ? (
          lastEventAt ? (
            <>
              Live registry stream · last snapshot <TimeAgo at={lastEventAt} />
            </>
          ) : (
            <>Connected to live registry stream</>
          )
        ) : status === "connecting" ? (
          <>Opening live snapshot stream…</>
        ) : status === "error" ? (
          <>Stream disconnected — auto-retrying</>
        ) : (
          <>Live snapshot stream</>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
