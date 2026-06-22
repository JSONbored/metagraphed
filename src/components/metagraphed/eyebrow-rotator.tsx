import { useEffect, useState } from "react";

/**
 * Crossfading eyebrow chip. Rotates `items` every `intervalMs`.
 * Static when prefers-reduced-motion is set.
 */
export function EyebrowRotator({
  items,
  intervalMs = 4500,
  className = "",
}: {
  items: string[];
  intervalMs?: number;
  className?: string;
}) {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (items.length <= 1) return;
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;
    const t = window.setInterval(() => setI((v) => (v + 1) % items.length), intervalMs);
    return () => window.clearInterval(t);
  }, [items.length, intervalMs]);

  const longest = Math.max(...items.map((s) => s.length));
  return (
    <span className={`mg-eyebrow-rot ${className}`} style={{ minWidth: `${longest * 0.62}em` }}>
      {items.map((label, idx) => (
        <span key={label} data-active={idx === i ? "true" : "false"}>
          {label}
        </span>
      ))}
    </span>
  );
}
