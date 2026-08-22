import { useSuspenseQuery } from "@tanstack/react-query";
import { RankedRails } from "@jsonbored/ui-kit";
import { validatorsQuery } from "@/lib/metagraphed/queries";
import { EmptyState } from "@/components/metagraphed/states";
import { Panel } from "@/components/metagraphed/primitives";
import {
  VALIDATOR_DOMINANCE_TOP_N,
  buildValidatorDominanceChartData,
} from "./validator-dominance-ranking";
import { formatTao } from "@/lib/metagraphed/format";

/**
 * Network-wide validator-dominance chart (#2565) — the network-wide
 * counterpart to `ValidatorsTableLoader`'s per-subnet stake-dominance block
 * (src/components/metagraphed/validators-panel.tsx): ranked rails of the
 * top-N operators by network stake share. Reads GET /api/v1/validators?sort=stake_dominance
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

  // Sum of the top-N shares only — not full network coverage (the API caps
  // this fetch to VALIDATOR_DOMINANCE_TOP_N rows), so the label says "top N"
  // rather than implying it accounts for every validator.
  const coveredPct = rows.reduce((sum, r) => sum + r.share, 0) * 100;

  return (
    <Panel>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="text-13 text-ink-muted">Stake dominance · top {rows.length}</span>
        <span className="text-10 text-ink-muted">{coveredPct.toFixed(1)}% of network stake</span>
      </div>
      <RankedRails
        items={rows.map((r) => ({
          key: r.hotkey,
          label: r.label,
          value: r.value,
          href: `/validators/${r.hotkey}`,
          detail: [
            { key: "stake", label: "Stake", value: formatTao(r.stakeTao) },
            { key: "subnets", label: "Subnets", value: String(r.subnetCount) },
          ],
        }))}
        formatValue={(v) => `${v.toFixed(2)}%`}
        ariaLabel={`Validator stake dominance, top ${rows.length} operators ranked by network stake share`}
      />
    </Panel>
  );
}
