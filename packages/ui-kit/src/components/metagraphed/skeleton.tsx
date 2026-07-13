export function Skeleton({ className = "h-4 w-full" }: { className?: string }) {
  // #3993: bg-surface-2 (a step lifted from bg-surface) keeps the pulse visible
  // against the similarly-dark page background in dark mode, where plain
  // bg-surface blended into invisibility.
  return <div className={`animate-pulse rounded bg-surface-2 ${className}`} />;
}
