import { useEffect, useState } from "react";
import { useLiveSse } from "@/lib/metagraphed/sse-context";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { classNames } from "@/lib/metagraphed/format";
import { TimeAgo } from "./time-ago";

/**
 * Tiny status pill that reflects the live SSE snapshot stream. It surfaces ONLY
 * the positive "live" state — when the stream is connecting, idle, or errored
 * (auto-retrying) the pill renders nothing, so the navbar never shows an alarming
 * "retry" badge for a transient/best-effort stream. Pulses on each snapshot.
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

  // Only show the badge when the stream is genuinely live. Connecting / idle /
  // error (auto-retrying) states are intentionally silent in the navbar.
  if (status !== "open") return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="status"
          aria-live="polite"
          className={classNames(
            "hidden md:inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest transition-colors",
            "text-health-ok border-health-ok/30 bg-health-ok/5",
          )}
        >
          <span
            aria-hidden
            className={classNames(
              "relative size-1.5 rounded-full bg-health-ok",
              flash ? "mg-pulse" : "",
            )}
          >
            <span
              aria-hidden
              className="absolute inset-0 -m-1 rounded-full ring-1 ring-health-ok/40 motion-safe:animate-ping"
            />
          </span>
          <span>live</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-[11px]">
        {lastEventAt ? (
          <>
            Live registry stream · last snapshot <TimeAgo at={lastEventAt} />
          </>
        ) : (
          <>Connected to live registry stream</>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
