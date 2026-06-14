import { classNames } from "@/lib/metagraphed/format";

/**
 * Decorative SVG ornament for the home hero. Concentric dotted rings evoke
 * a metagraph without literal copy. CSS-only animation (slow rotation +
 * subtle pulse) — respects reduced motion via styles.css.
 */
export function HeroOrnament({ className }: { className?: string }) {
  const rings = [
    { r: 80, dots: 24, op: 0.85, dur: "60s", dir: "normal" as const },
    { r: 130, dots: 36, op: 0.55, dur: "90s", dir: "reverse" as const },
    { r: 180, dots: 48, op: 0.3, dur: "120s", dir: "normal" as const },
    { r: 232, dots: 64, op: 0.18, dur: "160s", dir: "reverse" as const },
  ];
  return (
    <div aria-hidden className={classNames("pointer-events-none relative select-none", className)}>
      <svg viewBox="-260 -260 520 520" className="size-full" role="presentation">
        <defs>
          <radialGradient id="hero-orn-glow" cx="0" cy="0" r="240" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.18" />
            <stop offset="60%" stopColor="var(--accent)" stopOpacity="0.04" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </radialGradient>
        </defs>
        <circle cx="0" cy="0" r="240" fill="url(#hero-orn-glow)" />
        {rings.map((ring, idx) => (
          <g
            key={idx}
            style={{
              transformOrigin: "center",
              animation: `mg-orn-spin ${ring.dur} linear infinite ${ring.dir}`,
            }}
          >
            <circle
              cx="0"
              cy="0"
              r={ring.r}
              fill="none"
              stroke="var(--ink-strong)"
              strokeOpacity={ring.op * 0.18}
              strokeWidth="0.6"
            />
            {Array.from({ length: ring.dots }).map((_, i) => {
              const a = (i / ring.dots) * Math.PI * 2;
              const x = Math.cos(a) * ring.r;
              const y = Math.sin(a) * ring.r;
              const big = i % ((ring.dots / 4) | 0) === 0;
              return (
                <circle
                  key={i}
                  cx={x}
                  cy={y}
                  r={big ? 2.2 : 1.2}
                  fill={big ? "var(--accent)" : "var(--ink-strong)"}
                  fillOpacity={big ? Math.min(1, ring.op + 0.15) : ring.op}
                />
              );
            })}
          </g>
        ))}
        {/* Core */}
        <circle cx="0" cy="0" r="6" fill="var(--accent)" />
        <circle
          cx="0"
          cy="0"
          r="14"
          fill="none"
          stroke="var(--accent)"
          strokeOpacity="0.5"
          strokeWidth="0.8"
        />
        <circle
          cx="0"
          cy="0"
          r="30"
          fill="none"
          stroke="var(--accent)"
          strokeOpacity="0.25"
          strokeWidth="0.6"
        />
      </svg>
    </div>
  );
}
