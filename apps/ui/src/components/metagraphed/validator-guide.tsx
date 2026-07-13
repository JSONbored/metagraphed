import { useState } from "react";
import { ChevronDown, Info } from "lucide-react";
import { classNames } from "@/lib/metagraphed/format";

/**
 * Neutral, collapsible explainer that sits near the top of /validators so a
 * first-time visitor can understand what the directory's columns mean and how
 * to read them together before choosing a validator to delegate to (#5168).
 *
 * Strictly factual — it explains the on-chain signals, it does not rank or
 * recommend any specific validator. Mirrors the collapsible-callout visual
 * language of MethodologyCallout.
 */
const METRICS: Array<{ term: string; def: string }> = [
  {
    term: "Active subnets",
    def: "How many subnets this hotkey is registered and validating on. A validator may operate broadly across many subnets or concentrate on a few.",
  },
  {
    term: "UIDs",
    def: "The total neuron slots the hotkey holds across those subnets — one registration is one UID.",
  },
  {
    term: "Dominance",
    def: "The validator's share of total network stake, as a percentage. Higher dominance means more influence over consensus and emission — and more of that influence concentrated in one operator.",
  },
  {
    term: "Total stake",
    def: "The TAO backing the validator: its own stake plus TAO delegated to it by nominators. Stake sets how much weight the validator's votes carry.",
  },
  {
    term: "Total emission",
    def: "The TAO the validator earned over the window. Emission is split between the validator and its nominators via commission — it reflects reward flow, not profit.",
  },
  {
    term: "Validator trust (Sort)",
    def: "Available from the Sort control: how consistently a subnet's consensus scores the validator as trustworthy. Steadier trust points to reliable participation.",
  },
];

const GUIDANCE =
  "Read these signals together, not in isolation — a large validator concentrates stake and influence, while a smaller one spreads it. Commission and nominator counts (coming in #2548/#2549) will add to this picture. This directory describes the on-chain data; it does not rank or recommend any validator.";

export function ValidatorGuide() {
  const [open, setOpen] = useState(false);

  return (
    <aside
      aria-label="How to evaluate a validator"
      className="mb-6 rounded-lg border border-border bg-card/60"
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-start gap-2 px-3 py-2 text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <Info className="mt-0.5 size-3.5 shrink-0 text-accent" />
        <span className="min-w-0 flex-1">
          <span className="block font-mono text-[10px] uppercase tracking-widest text-ink-muted">
            How to evaluate a validator
          </span>
          <span className="mt-0.5 block font-mono text-[10px] text-ink-muted/80">
            What each column means and how to read them together
          </span>
        </span>
        <ChevronDown
          className={classNames(
            "mt-0.5 size-3.5 shrink-0 text-ink-muted transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      {open ? (
        <div className="border-t border-border px-3 py-3">
          <dl className="grid gap-3 text-[11.5px] leading-relaxed text-ink-muted md:grid-cols-2">
            {METRICS.map((m) => (
              <div key={m.term}>
                <dt className="font-medium text-ink-strong">{m.term}</dt>
                <dd className="mt-0.5">{m.def}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 border-t border-border pt-3 text-[11.5px] leading-relaxed text-ink-muted">
            {GUIDANCE}
          </p>
        </div>
      ) : null}
    </aside>
  );
}
