import { Link } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { subnetMoversQuery } from "@/lib/metagraphed/queries";
import { classNames } from "@/lib/metagraphed/format";
import { taoCompact } from "@/components/metagraphed/neuron-table";
import type { SubnetMover } from "@/lib/metagraphed/types";

// Signed TAO delta: taoCompact already carries a leading minus for negatives and
// renders an em-dash for null/non-finite, so we only prepend "+" for gains.
function signedTao(delta: number): string {
  return `${delta >= 0 ? "+" : ""}${taoCompact(delta)} τ`;
}

// Signed integer count (validators / neurons dimensions).
function signedCount(delta: number): string {
  return `${delta >= 0 ? "+" : ""}${delta}`;
}

const WINDOWS = ["7d", "30d", "90d"] as const;
type WindowKey = (typeof WINDOWS)[number];

const SORTS = [
  { value: "stake", label: "Stake" },
  { value: "emission", label: "Emission" },
  { value: "validators", label: "Validators" },
  { value: "neurons", label: "Neurons" },
] as const;
type SortKey = (typeof SORTS)[number]["value"];

// The per-row metric shown for each sort dimension. Every mover row already carries
// all four deltas (#5278 context), so switching sort re-labels the displayed value
// without any schema or endpoint change — the endpoint returns rows already ordered
// by the active dimension.
function moverMetric(m: SubnetMover, sort: SortKey): { text: string; up: boolean } {
  switch (sort) {
    case "emission":
      return { text: signedTao(m.emission_delta_tao), up: m.emission_delta_tao >= 0 };
    case "validators":
      return { text: signedCount(m.validators_delta), up: m.validators_delta >= 0 };
    case "neurons":
      return { text: signedCount(m.neurons_delta), up: m.neurons_delta >= 0 };
    case "stake":
    default:
      return {
        text:
          signedTao(m.stake_delta_tao) +
          (m.stake_pct_change != null ? ` (${m.stake_pct_change.toFixed(1)}%)` : ""),
        up: m.stake_delta_tao >= 0,
      };
  }
}

/**
 * #3344: cross-subnet biggest-movers band for the Home page — the top subnets by
 * stake/emission/validator/neuron change over a 7d/30d/90d window, each linking to
 * its detail page. #5278: the interactive window/sort controls (the deliberate
 * #3344 follow-up) drive the already-parameterized `/api/v1/subnets/movers`
 * endpoint; a toggle re-suspends behind the Home page's <Suspense> skeleton.
 * Renders nothing when the default board is empty (cold store / single snapshot).
 */
export function MoversBand() {
  const [window, setWindow] = useState<WindowKey>("30d");
  const [sort, setSort] = useState<SortKey>("stake");
  const res = useSuspenseQuery(subnetMoversQuery({ window, sort })).data;
  const movers = res.data.movers.slice(0, 10);
  const network = res.data.network;
  const sortLabel = SORTS.find((s) => s.value === sort)?.label.toLowerCase() ?? "stake";

  // Cold store on the default view → keep the Home page clean by rendering nothing;
  // once controls are in use we keep the section so the toggles stay reachable.
  if (movers.length === 0 && window === "30d" && sort === "stake") return null;

  const tabClass = (active: boolean) =>
    classNames(
      "rounded px-2 py-0.5 font-mono text-[11px] transition-colors",
      active ? "bg-accent/15 text-accent" : "text-ink-muted hover:text-ink-strong",
    );

  return (
    <section className="mt-section-gap">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-display text-lg font-semibold text-ink-strong">Biggest movers</h2>
          <p className="font-mono text-[11px] text-ink-muted">
            Subnets by {sortLabel} change · {res.data.window} window
            {network ? ` · ${network.gainers} up · ${network.losers} down` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div
            role="tablist"
            aria-label="Movers sort dimension"
            className="flex items-center gap-1"
          >
            {SORTS.map((s) => (
              <button
                key={s.value}
                type="button"
                role="tab"
                aria-selected={s.value === sort}
                onClick={() => setSort(s.value)}
                className={tabClass(s.value === sort)}
              >
                {s.label}
              </button>
            ))}
          </div>
          <div role="tablist" aria-label="Movers window" className="flex items-center gap-1">
            {WINDOWS.map((w) => (
              <button
                key={w}
                type="button"
                role="tab"
                aria-selected={w === window}
                onClick={() => setWindow(w)}
                className={tabClass(w === window)}
              >
                {w}
              </button>
            ))}
          </div>
        </div>
      </div>
      {movers.length === 0 ? (
        <p className="rounded border border-border bg-card px-3 py-6 text-center font-mono text-[11px] text-ink-muted">
          No subnet movement in the {res.data.window} window yet.
        </p>
      ) : (
        <ul className="grid gap-1.5 sm:grid-cols-2">
          {movers.map((m, i) => {
            const metric = moverMetric(m, sort);
            return (
              <li key={m.netuid}>
                <Link
                  to="/subnets/$netuid"
                  params={{ netuid: m.netuid }}
                  className="grid grid-cols-[2rem_1fr_auto] items-center gap-2 rounded border border-border bg-card px-3 py-2 hover:bg-surface/40"
                >
                  <span className="font-mono text-[10px] text-ink-muted">#{i + 1}</span>
                  <span className="font-mono text-[12px] text-ink-strong">SN{m.netuid}</span>
                  <span
                    className={classNames(
                      "font-mono text-[11px] tabular-nums",
                      metric.up ? "text-health-ok" : "text-health-down",
                    )}
                  >
                    {metric.text}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
