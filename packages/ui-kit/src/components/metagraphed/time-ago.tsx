import { useEffect, useState } from "react";
import {
  formatFreshnessAbsolute,
  formatRelative,
  isUsableTimestamp,
} from "@/lib/format";

/** Absolute local-time tooltip for {@link TimeAgo}, gated like the visible relative text. */
export function timeAgoAbsoluteTitle(at?: string | null): string | undefined {
  if (!isUsableTimestamp(at)) return undefined;
  return formatFreshnessAbsolute(at) ?? undefined;
}

/**
 * Renders a relative timestamp ("2m ago") only after mount.
 * Server output is an empty string with suppressHydrationWarning so the
 * client can swap in the live value without a hydration mismatch.
 */
export function TimeAgo({
  at,
  className,
  fallback = "—",
}: {
  at?: string | null;
  className?: string;
  fallback?: string;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const text = !at ? fallback : mounted ? formatRelative(at) : "";
  return (
    <span
      className={className}
      title={timeAgoAbsoluteTitle(at)}
      suppressHydrationWarning
    >
      {text}
    </span>
  );
}
