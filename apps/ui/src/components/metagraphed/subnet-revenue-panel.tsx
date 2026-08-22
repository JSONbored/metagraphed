import { useQuery } from "@tanstack/react-query";
import { subnetRevenueQuery } from "@/lib/metagraphed/queries";
import { Chip, FactStrip, FactCell } from "@jsonbored/ui-kit";
import { Panel } from "@/components/metagraphed/primitives";
import { Skeleton, ErrorState } from "@/components/metagraphed/states";
import { formatTao } from "@/lib/metagraphed/format";
import {
  coverageLabel,
  coverageNote,
  finite,
  isHeadlineEligible,
  subsidyLabel,
  tierLabel,
  usdLabel,
} from "@/lib/metagraphed/revenue-panel-model";
import { Link } from "@tanstack/react-router";

/**
 * #10477: what this subnet earns from outside Bittensor, against what the
 * network emits to it.
 *
 * THE ONE WAY THIS PANEL DOES HARM is rendering an unmeasured subnet as a
 * measured zero. 127 of 129 subnets have no observable external revenue, and
 * "0% covered" is a false claim about every one of them -- at a scale that
 * makes it defamatory rather than merely wrong. So `null` renders as "not
 * observed" everywhere, in prose that says what was and was not looked at, and
 * an observed 0 (a real reading of zero) renders as a real 0.
 *
 * The provenance tier sits NEXT TO the number, never in a tooltip: a ratio is
 * only as good as the rung it was read from, and hiding the rung behind a hover
 * makes the number look better than it is on a screenshot.
 */

/**
 * The provenance chip.
 *
 * Local rather than ui-kit's `ProvenanceChip`, which takes a `level` from the
 * registry's review vocabulary -- a different ladder with different rungs. The
 * masthead already keeps its own `ReviewProvenanceChip` for the same reason.
 *
 * Neutral tone on purpose, including for the tiers that cannot reach the
 * headline. A subnet that publishes an operator-attested figure has done more
 * than one that publishes nothing, and colouring the lower rungs as a warning
 * would punish disclosure -- the perverse incentive this whole feature has to
 * avoid.
 */
function RevenueProvenanceChip({ provenance }: { provenance: unknown }) {
  const eligible = isHeadlineEligible(provenance);
  return (
    <span className="inline-flex items-center gap-1.5">
      <Chip tone={eligible ? "accent" : "muted"}>{tierLabel(provenance)}</Chip>
      {eligible ? null : <span className="text-13 text-ink-muted">not headline-eligible</span>}
    </span>
  );
}

export function SubnetRevenuePanel({ netuid }: { netuid: number }) {
  const q = useQuery(subnetRevenueQuery(netuid));

  if (q.isError) {
    return (
      <ErrorState error={q.error} onRetry={() => q.refetch()} context="subnet revenue coverage" />
    );
  }
  if (q.isLoading) return <Skeleton className="h-56 w-full" />;

  const data = q.data?.data ?? {};
  const revenue = (data.revenue ?? {}) as Record<string, unknown>;
  const emission = (revenue.emission ?? {}) as Record<string, unknown>;
  const sources = Array.isArray(revenue.sources) ? revenue.sources : [];
  const observedUsd = finite(revenue.revenue_usd);
  const coverage = finite(revenue.coverage_ratio);
  const windowDays = finite(data.window_days);

  return (
    <div className="space-y-4">
      <FactStrip>
        <FactCell
          label="Emission received"
          value={formatTao(finite(emission.tao))}
          hint={usdLabel(emission.usd) ?? "TAO/USD not read for this window"}
        />
        <FactCell
          label="External revenue"
          value={usdLabel(observedUsd) ?? "Not observed"}
          hint={observedUsd == null ? "No readable public figure" : `over ${windowDays ?? 1}d`}
        />
        <FactCell label="Coverage" value={coverageLabel(coverage)} />
        <FactCell
          label="Subsidy multiple"
          value={subsidyLabel(revenue.subsidy_multiple)}
          hint="Emission per dollar earned"
        />
      </FactStrip>

      <Panel>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="text-13 text-ink-muted">Provenance</span>
            <RevenueProvenanceChip provenance={revenue.provenance} />
          </div>
          <Link
            to="/docs/$"
            params={{ _splat: "revenue-coverage" }}
            className="text-13 text-accent hover:underline"
          >
            How this is derived
          </Link>
        </div>
      </Panel>

      {/* The sentence that keeps a null from being read as a zero. It is prose
          rather than a tooltip because it is the most important thing on the
          panel for 127 of 129 subnets. */}
      <Panel bodyClassName="text-13 text-ink-muted">{coverageNote(observedUsd)}</Panel>

      {sources.length > 0 ? (
        <div className="space-y-2">
          <div className="text-13 text-ink-muted">Declared revenue sources ({sources.length})</div>
          <ul className="space-y-1">
            {sources.map((raw, i) => {
              const source = (raw ?? {}) as Record<string, unknown>;
              const id = String(source.id ?? source.surface_id ?? `source-${i}`);
              return (
                <li
                  key={id}
                  className="flex flex-wrap items-center gap-2 rounded border border-border/80 px-3 py-2"
                >
                  <span className="font-mono text-13 text-ink-strong">{id}</span>
                  <RevenueProvenanceChip provenance={source.provenance} />
                  {source.grain ? (
                    <span className="text-13 text-ink-muted">{String(source.grain)}</span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
