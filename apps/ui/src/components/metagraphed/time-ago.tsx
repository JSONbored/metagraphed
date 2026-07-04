import { useEffect, useState } from "react";
import { formatRelative } from "@/lib/metagraphed/format";

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
    <span className={className} suppressHydrationWarning>
      {text}
    </span>
  );
}
