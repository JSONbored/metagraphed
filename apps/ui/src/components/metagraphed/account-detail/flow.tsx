import { useQuery } from "@tanstack/react-query";
import {
  AnalyticsSection,
  FactStrip,
  RangeControl,
  RankedRails,
  type FactCells,
} from "@jsonbored/ui-kit";
import { accountStakeFlowQuery } from "@/lib/metagraphed/queries";
import { ErrorState } from "@/components/metagraphed/states";
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
  const query = useQuery({ ...accountStakeFlowQuery(ss58, { window }), retry: 0 });
  const { data } = query;
  const flow = data?.data;
  const rails = flowRails(flow?.subnets ?? [], nameOf, (value) => fmtCompactTao(value));

  // A `FactStrip`, not a `RankGrid`. These four are the window's TOTALS -- they
  // are not ranked against each other, and the grid numbered them 01-04 as if
  // they were (#11693).
  const cells: FactCells = [
    {
      label: "Staked in",
      value: fmtCompactTao(flow?.total_staked_tao),
      loading: query.isPending,
    },
    {
      label: "Unstaked out",
      value: fmtCompactTao(flow?.total_unstaked_tao),
      loading: query.isPending,
    },
    { label: "Net", value: fmtSignedTao(flow?.net_flow_tao), loading: query.isPending },
    {
      label: "Subnets touched",
      value: formatNumber(flow?.subnet_count ?? 0),
      loading: query.isPending,
    },
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
        query.isPending ? (
          <RankedRails
            items={[]}
            formatValue={fmtCompactTao}
            formatSecondary={fmtCompactTao}
            scale="sqrt"
            columns={{
              value: "Staked in",
              name: "Subnet",
              track: "Against the largest inflow",
              secondary: "Unstaked out",
            }}
            ariaLabel="Stake moved per subnet"
            source="account-flow"
            loading
            loadingRows={4}
            loadingSecondary
          />
        ) : query.isError && !data ? (
          <ErrorState
            error={query.error}
            onRetry={() => void query.refetch()}
            context="stake movement"
          />
        ) : rails.length > 0 ? (
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
      legend={query.isPending || (data && rails.length > 0) ? <FactStrip cells={cells} /> : null}
      footnote={
        query.isPending
          ? `${window} · loading stake movement`
          : query.isError
            ? `${window} · stake movement unavailable`
            : rails.length > 0
              ? `${window} · ${flow?.direction ?? "flat"} · chain-direct`
              : `${window} · no stake moved in this window`
      }
    />
  );
}
