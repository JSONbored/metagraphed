// #6408: validators-panel.tsx and charts/validator-dominance-chart.tsx rendered
// a byte-identical "share within the top {n}" caption, and the two copies had
// already drifted onto the wrong token -- `text-ink-subtle` (the lighter
// border/fill value) rather than `text-ink-subtle-text`, the AA-safe variant
// meant for exactly this small body text. Extracting the caption to one place
// fixes the contrast at both sites and stops the copies drifting again.
export function TopShareCaption({ n }: { n: number }) {
  return (
    <span className="ml-2 normal-case tracking-normal text-ink-subtle-text">
      share within the top {n}
    </span>
  );
}
