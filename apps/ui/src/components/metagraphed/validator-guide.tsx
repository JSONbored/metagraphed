import { useState } from "react";
import { ChevronDown, Info } from "lucide-react";
import { classNames } from "@/lib/metagraphed/format";

/**
 * Neutral explainer near the top of /validators so a first-time visitor can
 * understand what the directory's columns mean before choosing a validator to
 * delegate to (#5168).
 *
 * Strictly factual — it explains the on-chain signals, it does not rank or
 * recommend any specific validator. Desktop is a collapsible callout (mirrors
 * MethodologyCallout); mobile is an FAQ-style accordion where each metric
 * expands on tap.
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
    term: "Operator",
    def: "The coldkey's self-declared on-chain identity (name, logo, links) joined server-side (#5234). It belongs to the operator's coldkey, not the hotkey — the same operator can run multiple validators.",
  },
  {
    term: "Take",
    def: "The validator's commission (#2548): the fraction of delegator rewards the validator keeps (0–100%). Lower take means nominators keep more of the emission flow.",
  },
  {
    term: "Est. APY",
    def: "Annualized delegator yield estimated from emission÷stake, net of take. On the directory this uses the latest metagraph snapshot; on a validator detail page, 7d/30d/90d windows use daily neuron_daily history. Server-side modelling (#2551) will supersede these client estimates.",
  },
  {
    term: "Nominators",
    def: "How many distinct coldkeys currently have stake delegated to this hotkey, network-wide (#2549). Sourced from a lower-frequency chain scan than the other columns, so it can lag them briefly — a dash means no count has been captured for this hotkey yet, not zero nominators.",
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
    term: "Est. APY",
    def: "An estimated annualized yield (#2551): projects the validator's most recently captured epoch payout across a full year, using each subnet's own epoch length. It's a snapshot-based estimate, not a forecast or a guarantee — it can swing between refreshes, especially for validators concentrated on short-epoch subnets. A dash means none of the validator's subnets have a captured epoch length yet.",
  },
  {
    term: "Validator trust (Sort)",
    def: "Available from the Sort control: how consistently a subnet's consensus scores the validator as trustworthy. Steadier trust points to reliable participation.",
  },
];

const GUIDANCE =
  "Read these signals together, not in isolation — a large validator concentrates stake and influence, while a smaller one spreads it. This directory describes the on-chain data; it does not rank or recommend any validator.";

const HEADING = "How to evaluate a validator";
const SUBHEADING = "What each column means and how to read them together";

export function ValidatorGuide() {
  const [open, setOpen] = useState(false);

  return (
    <aside aria-label={HEADING} className="mb-6 rounded-lg border border-border bg-card/60">
      {/* Desktop / tablet: collapsible callout with the full grid. */}
      <div className="hidden sm:block">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex w-full items-start gap-2 px-3 py-2 text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Info className="mt-0.5 size-3.5 shrink-0 text-accent" />
          <span className="min-w-0 flex-1">
            <span className="block font-mono text-[10px] uppercase tracking-widest text-ink-muted">
              {HEADING}
            </span>
            <span className="mt-0.5 block font-mono text-[10px] text-ink-muted/80">
              {SUBHEADING}
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
      </div>

      {/* Mobile: FAQ-style accordion — tap a metric to reveal its definition. */}
      <div className="sm:hidden">
        <div className="flex items-start gap-2 px-3 py-2">
          <Info className="mt-0.5 size-3.5 shrink-0 text-accent" />
          <span className="min-w-0 flex-1">
            <span className="block font-mono text-[10px] uppercase tracking-widest text-ink-muted">
              {HEADING}
            </span>
            <span className="mt-0.5 block font-mono text-[10px] text-ink-muted/80">
              {SUBHEADING}
            </span>
          </span>
        </div>
        <div className="divide-y divide-border border-t border-border">
          {METRICS.map((m) => (
            <details key={m.term} className="group px-3">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-2 py-2.5 text-[12px] font-medium text-ink-strong focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                <span>{m.term}</span>
                <ChevronDown className="size-3.5 shrink-0 text-ink-muted transition-transform group-open:rotate-180" />
              </summary>
              <p className="pb-2.5 text-[11.5px] leading-relaxed text-ink-muted">{m.def}</p>
            </details>
          ))}
        </div>
        <p className="border-t border-border px-3 py-3 text-[11.5px] leading-relaxed text-ink-muted">
          {GUIDANCE}
        </p>
      </div>
    </aside>
  );
}
