import { useState } from "react";
import { ChevronDown, Info } from "lucide-react";
import { classNames } from "@/lib/metagraphed/format";

/**
 * Collapsible, strictly-neutral explainer for the validator directory. It says
 * what each visible column measures and how to read it — it does not rank,
 * score, or recommend any validator. Sits near the top of /validators so a
 * first-time visitor can orient before reading the table.
 */

type MetricNote = { title: string; body: string };

const METRIC_NOTES: MetricNote[] = [
  {
    title: "Total stake (τ)",
    body: "The TAO staked to this hotkey, summed across every subnet it validates on. More stake carries more weight in consensus and in dividend share — it measures size, not trustworthiness.",
  },
  {
    title: "Dominance",
    body: "This hotkey's total stake as a share of all validator stake network-wide. It is a concentration figure: a high value means a large slice of the network's validating stake sits behind one operator.",
  },
  {
    title: "Validator trust (avg / max)",
    body: "The on-chain validator_trust for the hotkey, averaged and at its peak across the subnets it validates. It reflects how much of the validator's weight is corroborated by consensus, on a 0–1 scale.",
  },
  {
    title: "Total emission (τ)",
    body: "The TAO emitted to the hotkey over the current window across its subnets — the reward flow it is currently earning. It tracks both stake and validating performance.",
  },
  {
    title: "Active subnets / UIDs",
    body: "How many distinct subnets the hotkey validates on, and how many UID registrations it holds across them. A wider footprint is broader participation, not necessarily stronger performance on any one subnet.",
  },
  {
    title: "Commission & nominators",
    body: "Not shown in this directory yet. Where you find them, commission is the cut a validator keeps before rewards reach its nominators (trading off against a delegator's net yield), and nominator count is how many delegators stake to it.",
  },
];

export function ValidatorMetricsExplainer({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);

  return (
    <aside
      aria-label="How to read the validator directory"
      className={classNames("rounded-lg border border-border bg-card/60", className)}
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
            How to read this table
          </span>
          <span className="mt-0.5 block font-mono text-[10px] text-ink-muted/80">
            What each column means, and how to weigh it — neutral, no recommendation.
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
          <div className="grid gap-3 text-[11.5px] leading-relaxed text-ink-muted md:grid-cols-2">
            {METRIC_NOTES.map((note) => (
              <div key={note.title}>
                <div className="font-mono text-[10px] uppercase tracking-widest text-ink-strong">
                  {note.title}
                </div>
                <p className="mt-1">{note.body}</p>
              </div>
            ))}
          </div>
          <p className="mt-3 border-t border-border pt-3 text-[11.5px] leading-relaxed text-ink-muted">
            These signals describe a validator's scale and consensus standing — not its reliability,
            custody practices, or future returns. Read them together, and weigh a validator's own
            track record and the subnets it serves. Metagraphed does not rank or recommend
            validators.
          </p>
        </div>
      ) : null}
    </aside>
  );
}
