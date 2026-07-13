import { AnimatedNumber } from "metagraphed-ui";

export function Default() {
  return (
    <span className="font-display text-3xl font-semibold text-ink-strong">
      <AnimatedNumber value={12483} />
    </span>
  );
}

export function Percent() {
  return (
    <span className="font-display text-3xl font-semibold text-health-ok">
      <AnimatedNumber value={98.6} format={(n) => `${n.toFixed(1)}%`} />
    </span>
  );
}

export function Missing() {
  return (
    <span className="font-display text-3xl font-semibold text-ink-muted">
      <AnimatedNumber value={null} />
    </span>
  );
}
