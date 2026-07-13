import { useState } from "react";
import { ChevronDown, Info } from "lucide-react";
import { classNames } from "@/lib/metagraphed/format";

/**
 * Neutral, collapsible "how to read a validator" explainer for #5168. Mirrors
 * the MethodologyCallout pattern used on subnet profiles, but explains the
 * signals a first-time visitor sees on /validators — stake, trust, dominance,
 * breadth, and emission — strictly factually. It describes how to read each
 * column; it does not rank, score, or recommend any specific validator.
 */
const SIGNALS: { term: string; body: string }[] = [
  {
    term: "Total stake",
    body: "TAO backing the hotkey across every subnet it validates — its own stake plus delegations. Stake is what weights a validator in each subnet's consensus, so it is the headline size signal. Larger is not inherently better: it means more influence and more concentration, which delegators weigh differently.",
  },
  {
    term: "Validator trust",
    body: "An on-chain score (0–1) derived from how much other participants' weights agree with this validator, shown here as the average and the max across its subnets. It reflects consensus alignment on the subnets it serves, not honesty or returns — a validator active on one subnet can show a high max with a low average.",
  },
  {
    term: "Dominance",
    body: "The hotkey's share of total network stake — a concentration measure, not a quality score. High dominance means a larger slice of consensus weight sits with one operator; a more decentralized network spreads stake across many.",
  },
  {
    term: "Active subnets & UIDs",
    body: "Active subnets counts how many distinct subnets the hotkey validates on (breadth of participation); UIDs is its total neuron registrations across them. Breadth shows reach, not effectiveness — a specialist on one subnet is not worse than a generalist on many.",
  },
  {
    term: "Total emission",
    body: "TAO emitted to the hotkey over the current window across its subnets — the reward it is currently earning. It tracks present-day flow, which shifts with stake, weights, and subnet activity, so it is a snapshot rather than a guaranteed rate.",
  },
];

export function ValidatorGuide() {
  const [open, setOpen] = useState(false);

  return (
    <aside
      aria-label="How to evaluate a validator"
      className="mb-4 rounded-lg border border-border bg-card/60"
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
            What each column means, and how to read it
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
            {SIGNALS.map((s) => (
              <div key={s.term}>
                <dt className="font-mono text-[10px] uppercase tracking-widest text-ink-strong">
                  {s.term}
                </dt>
                <dd className="mt-1">{s.body}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 border-t border-border pt-3 text-[11px] leading-relaxed text-ink-muted/90">
            These are raw on-chain signals, not a ranking. Higher is not
            inherently better — high dominance, for example, concentrates stake,
            which some delegators weigh against. This explains how to read the
            data; it does not recommend any specific validator.
          </p>
        </div>
      ) : null}
    </aside>
  );
}
