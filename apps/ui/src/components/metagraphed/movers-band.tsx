import { Link } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { subnetMoversQuery } from "@/lib/metagraphed/queries";
import { taoCompact } from "@/components/metagraphed/neuron-table";

// Signed TAO delta: taoCompact already carries a leading minus for negatives and
// renders an em-dash for null/non-finite, so we only prepend "+" for gains.
function signedTao(delta: number): string {
  return `${delta >= 0 ? "+" : ""}${taoCompact(delta)} τ`;
}

/**
 * #3344: cross-subnet biggest-movers band for the Home page — the top subnets by
 * stake change over the endpoint's default 30d window, each linking to its detail
 * page. Ships with the endpoint defaults (window=30d, sort=stake); interactive
 * window/sort controls are a deliberate follow-up. Renders nothing when the
 * board is empty (cold store / single snapshot).
 */
export function MoversBand() {
  const res = useSuspenseQuery(subnetMoversQuery()).data;
  const movers = res.data.movers.slice(0, 10);
  const network = res.data.network;

  if (movers.length === 0) return null;

  return (
    <section className="mt-section-gap">
      <div className="mb-4">
        <h2 className="font-display text-lg font-semibold text-ink-strong">Biggest movers</h2>
        <p className="font-mono text-[11px] text-ink-muted">
          Subnets by stake change · {res.data.window} window
          {network ? ` · ${network.gainers} up · ${network.losers} down` : ""}
        </p>
      </div>
      <ul className="grid gap-1.5 sm:grid-cols-2">
        {movers.map((m, i) => {
          const up = m.stake_delta_tao >= 0;
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
                  {signedTao(m.stake_delta_tao)}
                  {m.stake_pct_change != null ? ` (${m.stake_pct_change.toFixed(1)}%)` : ""}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
