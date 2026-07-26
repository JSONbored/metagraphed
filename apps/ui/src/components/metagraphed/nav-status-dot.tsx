import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Tooltip, TooltipContent, TooltipTrigger } from "@jsonbored/ui-kit";
import { useHydrated } from "@/hooks/use-hydrated";
import { classNames } from "@/lib/metagraphed/format";
import { healthQuery } from "@/lib/metagraphed/queries";

/**
 * Header status dot (#8246).
 *
 * /health used to sit in primary navigation, which put a maintainer ops console
 * next to Subnets and Blocks. Most visitors need one bit from it — "is anything
 * wrong right now?" — so that bit becomes a dot, and the console moves behind
 * it.
 *
 * Deliberately scoped like /status's verdict (#8250): red is reserved for
 * metagraphed's own outage. Third-party subnet surfaces being down is amber at
 * worst, because a subnet's API failing is not this site failing — conflating
 * them is what made the old status page announce "Partial outage" for someone
 * else's server.
 */
export function NavStatusDot() {
  // Non-blocking and hydration-gated: the header must never suspend on a health
  // fetch, and a server-rendered dot that disagrees with the client's first
  // paint is a hydration mismatch (#8241).
  const hydrated = useHydrated();
  const { data } = useQuery({ ...healthQuery(), retry: 0, enabled: hydrated });

  const health = data?.data;
  const down = health?.down ?? 0;
  const warn = health?.warn ?? 0;
  const ok = health?.ok ?? 0;
  const tracked = ok + warn + down;

  const tone: "ok" | "warn" | "unknown" =
    !hydrated || !health ? "unknown" : down > 0 || warn > 0 ? "warn" : "ok";

  const label =
    tone === "unknown"
      ? "Checking status"
      : tone === "ok"
        ? `All ${tracked} tracked surfaces healthy`
        : `${down} down · ${warn} slow of ${tracked} tracked surfaces`;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          to="/status"
          aria-label={label}
          className="mg-focus-ring inline-flex size-8 shrink-0 items-center justify-center rounded-md text-ink-muted transition-colors hover:text-ink-strong"
        >
          <span
            aria-hidden
            className={classNames(
              "inline-block size-2 rounded-full",
              tone === "ok"
                ? "bg-health-ok"
                : tone === "warn"
                  ? "bg-health-warn"
                  : "bg-health-unknown",
            )}
          />
        </Link>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="mg-type-caption">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
