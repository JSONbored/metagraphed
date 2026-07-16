import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { subnetMoversQuery } from "@/lib/metagraphed/queries";
import { taoCompact } from "@/components/metagraphed/neuron-format";
import { SelectFilter } from "@/components/metagraphed/table-controls";
import { formatNumber } from "@/lib/metagraphed/format";
import type { SubnetMover } from "@/lib/metagraphed/types";

const WINDOWS = [
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "90d", label: "90d" },
] as const;
type MoversWindow = (typeof WINDOWS)[number]["value"];

const SORTS = [
  { value: "stake", label: "Stake" },
  { value: "emission", label: "Emission" },
  { value: "validators", label: "Validators" },
  { value: "neurons", label: "Neurons" },
] as const;
type MoversSort = (typeof SORTS)[number]["value"];

// Signed TAO delta: taoCompact already carries a leading minus for negatives and
// renders an em-dash for null/non-finite, so we only prepend "+" for gains.
function signedTao(delta: number): string {
  return `${delta >= 0 ? "+" : ""}${taoCompact(delta)} τ`;
}

function signedCount(delta: number): string {
  return `${delta >= 0 ? "+" : ""}${formatNumber(delta)}`;
}

// The active sort dimension's own delta (and, for stake only, a pct-change
// figure — the only dimension the API's normalizer carries one for).
function moverDelta(m: SubnetMover, sort: MoversSort) {
  switch (sort) {
    case "stake":
      return {
        delta: m.stake_delta_tao,
        pct: m.stake_pct_change,
        formatted: signedTao(m.stake_delta_tao),
      };
    case "emission":
      return { delta: m.emission_delta_tao, pct: null, formatted: signedTao(m.emission_delta_tao) };
    case "validators":
      return { delta: m.validators_delta, pct: null, formatted: signedCount(m.validators_delta) };
    case "neurons":
      return { delta: m.neurons_delta, pct: null, formatted: signedCount(m.neurons_delta) };
  }
}

/**
 * #3344: cross-subnet biggest-movers band for the Home page — the top subnets by
 * the selected sort dimension's change over the selected window, each linking to
 * its detail page. Window (7d/30d/90d) and sort (stake/emission/validators/
 * neurons) default to the endpoint's own defaults (30d/stake) and are
 * user-adjustable, wired straight into the same /api/v1/subnets/movers params
 * the sibling subnets-index page uses. Renders nothing when the board is empty
 * (cold store / single snapshot).
 */
export function MoversBand() {
  const [window, setWindow] = useState<MoversWindow>("30d");
  const [sort, setSort] = useState<MoversSort>("stake");
  const res = useSuspenseQuery(subnetMoversQuery({ window, sort })).data;
  const movers = res.data.movers.slice(0, 10);
  const network = res.data.network;

  if (movers.length === 0) return null;

  const sortLabel = SORTS.find((s) => s.value === sort)?.label ?? "Stake";

  return (
    <section className="mt-section-gap">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-display text-lg font-semibold text-ink-strong">Biggest movers</h2>
          <p className="font-mono text-[11px] text-ink-muted">
            Subnets by {sortLabel.toLowerCase()} change · {res.data.window} window
            {network ? ` · ${network.gainers} up · ${network.losers} down` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <SelectFilter
            label="Sort"
            value={sort}
            onChange={(v) => setSort(v as MoversSort)}
            options={[...SORTS]}
            allowEmpty={false}
          />
          <SelectFilter
            label="Window"
            value={window}
            onChange={(v) => setWindow(v as MoversWindow)}
            options={[...WINDOWS]}
            allowEmpty={false}
          />
        </div>
      </div>
      <ul className="grid gap-1.5 sm:grid-cols-2">
        {movers.map((m, i) => {
          const { delta, pct, formatted } = moverDelta(m, sort);
          const up = delta >= 0;
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
                  className={
                    up
                      ? "font-mono text-[11px] tabular-nums text-health-ok"
                      : "font-mono text-[11px] tabular-nums text-health-down"
                  }
                >
                  {formatted}
                  {pct != null ? ` (${pct.toFixed(1)}%)` : ""}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
