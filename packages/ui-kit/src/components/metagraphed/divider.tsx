import { cn } from "@/lib/utils";

export type DividerProps = {
  tone?: "default" | "accent";
  /** Show a small mint pip at the start (matches design brief). */
  pip?: boolean;
  className?: string;
};

/**
 * Horizontal hairline divider. Replaces raw `<hr>` and one-off
 * `<div className="h-px bg-border" />` usages so the tone is centralized.
 * When `pip` is true, renders a small mint square at the leading edge — the
 * signature "section divider with accent pip" pattern from the design brief.
 */
export function Divider({
  tone = "default",
  pip = false,
  className,
}: DividerProps) {
  const bar = tone === "accent" ? "bg-accent/40" : "bg-border";
  return (
    <div
      className={cn("relative h-px w-full", bar, className)}
      role="separator"
      aria-hidden
    >
      {pip ? (
        <span className="absolute left-0 top-1/2 -translate-y-1/2 size-1.5 rounded-[1px] bg-accent" />
      ) : null}
    </div>
  );
}
