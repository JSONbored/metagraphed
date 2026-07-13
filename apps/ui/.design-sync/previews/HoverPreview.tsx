import { HoverPreview } from "metagraphed-ui";

export function Default() {
  return (
    <HoverPreview
      content={<div>Subnet 64 · Chutes — GPU inference marketplace. 256 validators, healthy.</div>}
    >
      <span className="underline decoration-dotted cursor-help text-ink-strong">Subnet 64</span>
    </HoverPreview>
  );
}
