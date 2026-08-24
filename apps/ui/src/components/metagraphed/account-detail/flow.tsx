import { useQuery } from "@tanstack/react-query";
import {
  AnalyticsSection,
  FactStrip,
  RangeControl,
  RankedRails,
  type FactCells,
} from "@jsonbored/ui-kit";
import { accountStakeFlowQuery } from "@/lib/metagraphed/queries";
import { formatNumber } from "@/lib/metagraphed/format";
import {
  FLOW_WINDOWS,
  flowRails,
  fmtCompactTao,
  fmtSignedTao,
  type FlowWindow,
} from "./account-detail-logic";

/**
 * Section 2 — stake moving in and out, per subnet.
 *
 * Rows are subnets, not weeks: `/stake-flow` publishes a per-subnet total for
 * the window and no series, so a time axis would be invented. The window
 * control changes what is totalled, which is the real dimension available.
 */
export function FlowSection({
  ss58,
  window,
  onWindow,
  nameOf,
}: {
  ss58: string;
  window: FlowWindow;
  onWindow: (next: FlowWindow) => void;
  nameOf: (netuid: number) => string;
}) {
  const { data } = useQuery({ ...accountStakeFlowQuery(ss58, { window }), retry: 0 });
  const flow = data?.data;
  const rails = flowRails(flow?.subnets ?? [], nameOf, (value) => fmtCompactTao(value));

  // A `FactStrip`, not a `RankGrid`. These four are the window's TOTALS -- they
  // are not ranked against each other, and the grid numbered them 01-04 as if
  // they were (#11693).
  const cells: FactCells = [
    { label: "Staked in", value: fmtCompactTao(flow?.total_staked_tao) },
    { label: "Unstaked out", value: fmtCompactTao(flow?.total_unstaked_tao) },
    { label: "Net", value: fmtSignedTao(flow?.net_flow_tao) },
    { label: "Subnets touched", value: formatNumber(flow?.subnet_count ?? 0) },
  ];

  return (
    <AnalyticsSection
      id="flow"
      name="Flow"
      question="Stake moving in and out, by subnet."
      controls={
        <RangeControl label="Window" options={FLOW_WINDOWS} value={window} onChange={onWindow} />
      }
      visual={
        rails.length > 0 ? (
          <RankedRails
            items={rails}
            formatValue={(value) => fmtCompactTao(value)}
            formatSecondary={(value) => fmtCompactTao(value)}
            scale="sqrt"
            columns={{
              value: "Staked in",
              name: "Subnet",
              track: "Against the largest inflow",
              secondary: "Unstaked out",
            }}
            ariaLabel="Stake moved per subnet"
            source="account-flow"
          />
        ) : null
      }
      legend={rails.length > 0 ? <FactStrip cells={cells} /> : null}
      footnote={
        rails.length > 0
          ? `${window} · ${flow?.direction ?? "flat"} · chain-direct`
          : `${window} · no stake moved in this window`
      }
    />
  );
}
