import { WifiOff } from "lucide-react";
import { useOnlineStatus } from "@/hooks/use-online-status";

/**
 * #8384 requirement 3: "a clear offline banner" -- a fixed strip, not a
 * toast (a toast auto-dismisses; being offline is a persisting condition
 * the visitor should be able to glance at any time, the same reasoning
 * this app's other persistent-state indicators use).
 */
export function OfflineBanner() {
  const online = useOnlineStatus();
  if (online) return null;
  return (
    <div
      role="status"
      className="sticky top-0 z-[var(--mg-z-modal)] flex items-center justify-center gap-2 border-b border-health-warn/30 bg-health-warn/10 px-3 py-1.5 mg-type-caption text-health-warn"
    >
      <WifiOff className="size-3.5 shrink-0" aria-hidden />
      You're offline — showing cached data where available.
    </div>
  );
}
