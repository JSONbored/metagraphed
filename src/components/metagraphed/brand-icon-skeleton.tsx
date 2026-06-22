import { classNames } from "@/lib/metagraphed/format";

/**
 * Shimmer placeholder matching BrandIcon's footprint exactly. Use during the
 * initial table load so logos don't pop-in with a monogram-flash on first
 * paint. Honors prefers-reduced-motion via Tailwind's `motion-safe:` variant.
 */
export function BrandIconSkeleton({
  size = 32,
  className,
  rounded = "md",
}: {
  size?: number;
  className?: string;
  rounded?: "sm" | "md" | "lg" | "full";
}) {
  const radius =
    rounded === "full"
      ? "rounded-full"
      : rounded === "lg"
        ? "rounded-lg"
        : rounded === "sm"
          ? "rounded-sm"
          : "rounded-md";
  return (
    <span
      aria-hidden="true"
      role="presentation"
      data-mg-skel
      style={{ width: size, height: size }}
      className={classNames(
        "inline-block shrink-0 border border-border bg-surface motion-safe:animate-pulse",
        radius,
        className,
      )}
    />
  );
}
