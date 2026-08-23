import { useQuery } from "@tanstack/react-query";
import {
  AnalyticsSection,
  FactStrip,
  LineWithWindow,
  RangeControl,
  type FactCells,
} from "@jsonbored/ui-kit";
import { subnetHistoryQuery, subnetOhlcQuery } from "@/lib/metagraphed/queries";
import { formatTao } from "@/lib/metagraphed/format";
import { taoCompact } from "@/components/metagraphed/neuron-format";
import {
  WINDOW_OPTIONS,
  changeOver,
  closePoints,
  deltaCell,
  seriesOf,
  trailing,
  volumeOver,
  windowDays,
  type Window,
} from "./subnet-detail-logic";

/**
 * Section 1 — the price line, and the three other numbers that moved with it.
 *
 * One series is drawn, not four: price is the question a reader arrives with,
 * and stake / emission / volume are its context, which is what a legend is
 * for. The window control is the section's, not the page's -- it changes what
 * this chart plots and nothing else on the page.
 */
export function MomentumSection({
  netuid,
  window,
  onWindow,
}: {
  netuid: number;
  window: Window;
  onWindow: (next: Window) => void;
}) {
  const days = windowDays(window);
  const ohlc = useQuery({ ...subnetOhlcQuery(netuid, { interval: "1d", days: 90 }), retry: 0 });
  const history = useQuery({ ...subnetHistoryQuery(netuid, "90d"), retry: 0 });

  const candles = ohlc.data?.data.candles ?? [];
  const points = closePoints(candles, days);
  const historyPoints = trailing(history.data?.data.points ?? [], days);

  const priceChange = changeOver(points.map((p) => p.v));
  const stakeChange = changeOver(seriesOf(historyPoints, (p) => p.total_stake_alpha));
  const emissionChange = changeOver(seriesOf(historyPoints, (p) => p.total_emission_alpha));
  const volume = volumeOver(candles, days);
  const latest = historyPoints[historyPoints.length - 1];

  const cells: FactCells = [
    {
      label: "Alpha price",
      value: points.length > 0 ? formatTao(points[points.length - 1]!.v) : "—",
      delta: deltaCell(priceChange),
    },
    {
      label: "Total stake",
      value: latest ? `${taoCompact(latest.total_stake_alpha)} α` : "—",
      delta: deltaCell(stakeChange),
    },
    {
      // Value and delta read the SAME series. Showing the current emission
      // SHARE beside a delta computed from emitted ALPHA put two different
      // measurements in one cell, and the delta then described a number the
      // cell was not displaying. The share is a hero fact; this is the flow.
      label: "Daily emission",
      value: latest ? `${taoCompact(latest.total_emission_alpha)} α` : "—",
      delta: deltaCell(emissionChange),
    },
    { label: `Volume ${window}`, value: volume != null ? `${taoCompact(volume)} τ` : "—" },
  ];

  return (
    <AnalyticsSection
      id="momentum"
      name="Momentum"
      question="Price, stake and emission over the window."
      controls={
        <RangeControl label="Window" options={WINDOW_OPTIONS} value={window} onChange={onWindow} />
      }
      visual={
        points.length > 1 ? (
          <LineWithWindow
            id={`sn-${netuid}-price`}
            points={points}
            window={{ from: points[0]!.t, to: points[points.length - 1]!.t }}
            unit="τ"
            formatValue={(v) => formatTao(v)}
            ariaLabel={`Subnet ${netuid} alpha price, ${window}`}
            source={`sn-${netuid}-price`}
          />
        ) : null
      }
      legend={<FactStrip cells={cells} />}
      footnote={`${window} · daily close, chain-direct`}
    />
  );
}
