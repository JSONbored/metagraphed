import { Clock } from "lucide-react";
import { formatFreshness, formatFreshnessAbsolute } from "@/lib/metagraphed/freshness";
import { useHydrated } from "@/hooks/use-hydrated";
import { Chip } from "./chip";

export interface FreshnessPillProps {
  updatedAt?: string | null;
  /** Data window label, e.g. "24h", "7d". */
  windowLabel?: string | null;
  /** Override tone (e.g. "warn" if the caller knows data is stale). */
  tone?: "default" | "muted" | "warn";
  className?: string;
}

/**
 * Small mono pill rendering "updated Xm ago" via the centralized freshness
 * formatter. Tooltip carries the absolute timestamp so hover reveals
 * exact provenance. Renders nothing when both inputs are absent.
 *
 * The relative "Xm ago" label depends on `Date.now()`, so it would produce a
 * different string on the server and the client and trigger a React
 * hydration mismatch — which cascades into the Suspense-stream
 * "Cannot read properties of undefined (reading 'return')" crash observed
 * on /subnets and /subnets/:netuid. Gate the time-dependent label behind
 * {@link useHydrated} so SSR and the first client render emit a stable
 * placeholder, and the real "updated Xm ago" value swaps in post-hydration.
 */
export function FreshnessPill({
  updatedAt,
  windowLabel,
  tone = "muted",
  className,
}: FreshnessPillProps) {
  const hydrated = useHydrated();
  if (!hydrated) {
    if (!updatedAt && !windowLabel) return null;
    // Placeholder preserves layout without any time-derived text.
    return (
      <Chip tone={tone} icon={<Clock className="size-3" />} className={className}>
        <span aria-hidden className="opacity-0">
          updated —
        </span>
      </Chip>
    );
  }
  const label = formatFreshness(updatedAt, windowLabel);
  if (!label) return null;
  const abs = formatFreshnessAbsolute(updatedAt);
  return (
    <Chip
      tone={tone}
      icon={<Clock className="size-3" />}
      title={abs ? `As of ${abs}` : undefined}
      className={className}
    >
      {label}
    </Chip>
  );
}
