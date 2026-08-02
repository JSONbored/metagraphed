import { StatTile } from "@jsonbored/ui-kit";
import { DefinitionList, Panel, SectionLabel } from "@/components/metagraphed/primitives";
import { emissionPipelineCounts, networkTaoSplit } from "@/lib/metagraphed/emission-pipeline";
import { formatNumber } from "@/lib/metagraphed/format";
import type { EmissionPipeline } from "@/lib/metagraphed/types";

const percent = (value: number | null, digits = 1) =>
  value == null ? "—" : `${(value * 100).toFixed(digits)}%`;

const taoPerBlock = (value: number | null) => (value == null ? "—" : `${value.toFixed(4)} τ`);

/**
 * The network headline for /chain/emissions (#8745): where the block emission
 * goes, and under what gate parameters.
 *
 * The one thing this must not say is that emission is throttled or withheld.
 * That was the original, wrong premise (#8740) — the gate decides each
 * subnet's SHARE, and 100% of block emission still reaches subnets. So the
 * split shown here is between two destinations, not between "released" and
 * "held".
 */
export function EmissionNetworkSummary({ pipeline }: { pipeline: EmissionPipeline }) {
  const { poolFraction, buysFraction } = networkTaoSplit(pipeline);
  const counts = emissionPipelineCounts(pipeline.subnets);
  const { chain_state: chainState } = pipeline;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          eyebrow="Pool liquidity injection"
          value={percent(poolFraction)}
          hint="of block emission"
          tone="accent"
          tooltip="The share of each block's TAO that lands in subnet liquidity pools (SubnetTaoInEmission). The rest arrives as chain buys — both are TAO the subnet receives."
        />
        <StatTile
          eyebrow="Chain buys"
          value={percent(buysFraction)}
          hint="of block emission"
          tooltip="The share of each block's TAO that arrives as chain buys (SubnetExcessTao) rather than as pool liquidity."
        />
        <StatTile
          eyebrow="Block emission"
          value={taoPerBlock(pipeline.block_emission_tao)}
          hint={
            pipeline.block_emission_halvings == null
              ? undefined
              : `after ${formatNumber(pipeline.block_emission_halvings)} halving${
                  pipeline.block_emission_halvings === 1 ? "" : "s"
                }`
          }
          tooltip="TAO issued per block, derived from total issuance. All of it reaches subnets; the pipeline decides how it is divided, not whether it is released."
        />
        <StatTile
          eyebrow="Reaching subnets"
          value={percent(pipeline.aggregate.total_final_share, 2)}
          hint="of block emission"
          tone="ok"
          tooltip="Final shares sum to 1 across every eligible subnet. Nothing is withheld — the pipeline redistributes, it does not throttle."
        />
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Panel as="section">
          <SectionLabel as="h2">Gate parameters</SectionLabel>
          <DefinitionList
            className="mt-3"
            items={[
              {
                term: "EmissionBarQuantile",
                detail:
                  chainState.emission_bar_quantile == null
                    ? "—"
                    : chainState.emission_bar_quantile.toFixed(2),
              },
              {
                term: "Emission gate bar",
                detail:
                  chainState.emission_gate_bar == null
                    ? "—"
                    : chainState.emission_gate_bar.toPrecision(6),
              },
              {
                term: "Gate exponent",
                detail:
                  chainState.emission_gate_exponent == null
                    ? "not set on chain"
                    : String(chainState.emission_gate_exponent),
              },
              {
                term: "Total issuance",
                detail:
                  chainState.total_issuance_tao == null
                    ? "—"
                    : `${formatNumber(Math.round(chainState.total_issuance_tao))} τ`,
              },
            ]}
          />
          {/* Provenance, per the issue's "every figure is traceable" rule:
              one block, named, so a reader can check us against the chain. */}
          <p className="mt-3 mg-type-caption text-ink-muted">
            {chainState.block == null
              ? "No pinned block on this capture."
              : `Point sample at block ${formatNumber(chainState.block)}.`}{" "}
            Per-block values are noisy by construction (reservoir + cap) — this is one sample, not a
            window average.
          </p>
        </Panel>

        <Panel as="section">
          <SectionLabel as="h2">Subnet states</SectionLabel>
          <DefinitionList
            layout="stacked"
            className="mt-3"
            items={[
              {
                term: "In the pipeline",
                detail: `${formatNumber(counts.eligible)} competing for a share`,
              },
              {
                term: "Emission disabled",
                detail: `${formatNumber(counts.disabled)} switched off — receiving nothing by configuration, not by competing badly`,
              },
              {
                term: "Outside the pipeline",
                detail: `${formatNumber(counts.ineligible)} (root, never-emitted) — no share to compute, which is why those cells are blank rather than zero`,
              },
              {
                term: "Gated to zero",
                detail: `${formatNumber(counts.gatedToZero)} in the pipeline with a post-gate share of zero — distinct from disabled`,
              },
              {
                term: "Share moved by the pipeline",
                detail: `${formatNumber(counts.gained)} gained · ${formatNumber(counts.lost)} lost, relative to their price share`,
              },
            ]}
          />
        </Panel>
      </div>
    </div>
  );
}
