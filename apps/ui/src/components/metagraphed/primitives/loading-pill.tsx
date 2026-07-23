import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { Chip } from "./chip";

export type LoadingPillProps = {
  children?: ReactNode;
  /** Chip tone (default = muted). */
  tone?: "default" | "muted" | "accent";
  className?: string;
};

/**
 * Small inline "loading…" pill used in headers / toolbars while background
 * refetches are in flight. Extracted from the ad-hoc
 * `<Chip icon={<Loader2 className="animate-spin"/>}>Loading…</Chip>`
 * that appeared in ~8 places.
 */
export function LoadingPill({ children = "Loading", tone = "muted", className }: LoadingPillProps) {
  return (
    <Chip tone={tone} icon={<Loader2 className="size-3 animate-spin" />} className={className}>
      {children}
    </Chip>
  );
}
