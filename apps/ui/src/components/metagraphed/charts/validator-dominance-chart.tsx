import { useSuspenseQuery } from "@tanstack/react-query";
import { BarMini, TreemapMini, type TreemapMiniDatum } from "@jsonbored/ui-kit";
import { validatorsQuery } from "@/lib/metagraphed/queries";
import { EmptyState } from "@/components/metagraphed/states";
import { Panel } from "@/components/metagraphed/primitives";
import { TopShareCaption } from "@/components/metagraphed/top-share-caption";
import {
  VALIDATOR_DOMINANCE_TOP_N,
  buildValidatorDominanceChartData,
} from "./validator-dominance-ranking";

const DOMINANCE_COLOR = "var(--accent)";

/**
 * Network-wide validator-dominance chart (#2565) — the network-wide
 * counterpart to `ValidatorsTableLoader`'s per-subnet stake-dominance block
 * (src/components/metagraphed/validators-panel.tsx): a ranked BarMini paired
 * with an area-proportional TreemapMini, both fed by the same top-N rows so
 * the two views never drift. Reads GET /api/v1/validators?sort=stake_dominance
 * directly (self-contained fetch, independent of the leaderboard table's own
 * sort selector above it) so this block always shows the dominance ranking
 * regardless of how the table is currently sorted.
 */
export function ValidatorDominanceChart() {
  const res = useSuspenseQuery(
    validatorsQuery({ sort: "stake_dominance", limit: VALIDATOR_DOMINANCE_TOP_N }),
  ).data;
  const rows = buildValidatorDominanceChartData(res.data.validators);

  if (rows.length === 0) {
    return (
      <EmptyState
        title="No dominance data yet"
        description="Stake-dominance shares haven't been computed for any validator in the current snapshot."
      />
    );
  }

  const barData = rows.map((r) => ({ label: r.label, value: r.value, color: DOMINANCE_COLOR }));
  const tiles: TreemapMiniDatum[] = rows.map((r) => ({
    label: r.label,
    value: r.value,
    color: DOMINANCE_COLOR,
  }));
  // Sum of the top-N shares only — not full network coverage (the API caps
  // this fetch to VALIDATOR_DOMINANCE_TOP_N rows), so the label says "top N"
  // rather than implying it accounts for every validator.
  const coveredPct = rows.reduce((sum, r) => sum + r.share, 0) * 100;

  return (
    <Panel as="div" dense>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="mg-type-micro text-ink-muted">Stake dominance · top {rows.length}</span>
        <span className="font-mono text-[10px] text-ink-muted">
          {coveredPct.toFixed(1)}% of network stake
        </span>
      </div>
      <BarMini
        data={barData}
        formatValue={(v) => `${v.toFixed(2)}%`}
        ariaLabel={`Validator stake dominance, top ${rows.length} operators ranked by network stake share`}
      />
      {tiles.length > 1 ? (
        <div className="mt-4 border-t border-border pt-3">
          <div className="mb-2 mg-type-micro text-ink-muted">
            Concentration
            <TopShareCaption n={tiles.length} />
          </div>
          <TreemapMini
            data={tiles}
            formatValue={(v) => `${v.toFixed(2)}%`}
            ariaLabel={`Validator stake dominance treemap across the top ${tiles.length} operators, sized by network stake share`}
          />
        </div>
      ) : null}
    </Panel>
  );
}
