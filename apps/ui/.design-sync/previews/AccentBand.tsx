import { AccentBand } from "metagraphed-ui";

export function Default() {
  return (
    <AccentBand>
      <div className="text-sm text-ink-strong">
        Full-bleed mint-soft band — used behind page heroes and section breaks.
      </div>
    </AccentBand>
  );
}

export function WithPattern() {
  return (
    <AccentBand pattern>
      <div className="text-sm text-ink-strong">With the dot-grid texture pattern overlaid.</div>
    </AccentBand>
  );
}
