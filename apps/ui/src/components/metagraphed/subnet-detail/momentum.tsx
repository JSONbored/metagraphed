import { useQuery } from "@tanstack/react-query";
import {
  AnalyticsSection,
  FactStrip,
  LineWithWindow,
  RangeControl,
  type FactCells,
} from "@jsonbored/ui-kit";
import { subnetHistoryQuery, subnetOhlcQuery } from "@/lib/metagraphed/queries";
import { deltaCell, formatTao } from "@/lib/metagraphed/format";
import { useHydrated } from "@/hooks/use-hydrated";
import { ErrorState } from "@/components/metagraphed/states";
import { taoCompact } from "@/components/metagraphed/neuron-format";
import {
  WINDOW_OPTIONS,
  changeOver,
  closePoints,
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
  const hydrated = useHydrated();
  const loading = !hydrated || ohlc.isPending || history.isPending;
  const showPriceLoading = hydrated && ohlc.isPending;

  const candles = ohlc.data?.data.candles ?? [];
  const points = closePoints(candles, days);
  const historyPoints = trailing(history.data?.data.points ?? [], days);

  const priceChange = changeOver(points.map((p) => p.v));
  const stakeChange = changeOver(seriesOf(historyPoints, (p) => p.total_stake_alpha));
  const emissionChange = changeOver(seriesOf(historyPoints, (p) => p.total_emission_alpha));
  const volume = volumeOver(candles, days);
  const latest = historyPoints[historyPoints.length - 1];

  // The WINDOW'S OPENING level, not the current one (#11693). Both of these
  // cells used to print the window's last point under the same label the hero
  // prints two inches above -- and the stake read a different series from the
  // hero's, so the page said "Total stake 2.63M α" and "Total stake 2.62M α"
  // about one subnet at one moment. The hero owns where a number IS; this
  // section owns where it CAME FROM and how far it moved.
  const opening = points[0];
  const openingStake = historyPoints[0];
  const cells: FactCells = [
    {
      label: `Alpha price ${window} ago`,
      value: opening ? formatTao(opening.v) : "—",
      loading: ohlc.isPending,
      delta: deltaCell(priceChange),
    },
    {
      label: `Total stake ${window} ago`,
      value: openingStake ? `${taoCompact(openingStake.total_stake_alpha)} α` : "—",
      loading: history.isPending,
      delta: deltaCell(stakeChange),
    },
    {
      // Value and delta read the SAME series. Showing the current emission
      // SHARE beside a delta computed from emitted ALPHA put two different
      // measurements in one cell, and the delta then described a number the
      // cell was not displaying. The share is a hero fact; this is the flow.
      label: "Daily emission",
      value: latest ? `${taoCompact(latest.total_emission_alpha)} α` : "—",
      loading: history.isPending,
      delta: deltaCell(emissionChange),
    },
    {
      label: `Volume ${window}`,
      value: volume != null ? `${taoCompact(volume)} τ` : "—",
      loading: ohlc.isPending,
    },
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
        showPriceLoading ? (
          <LineWithWindow
            id={`sn-${netuid}-price`}
            points={[]}
            window={{ from: 0, to: 0 }}
            unit="τ"
            formatValue={(v) => formatTao(v)}
            ariaLabel={`Subnet ${netuid} alpha price, ${window}`}
            source={`sn-${netuid}-price`}
            loading
          />
        ) : ohlc.isError ? (
          <ErrorState
            error={ohlc.error}
            onRetry={() => void ohlc.refetch()}
            context={`${window} alpha price history`}
          />
        ) : points.length > 1 ? (
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
      legend={
        history.isError ? (
          <ErrorState
            error={history.error}
            onRetry={() => void history.refetch()}
            context={`${window} subnet stake and emission history`}
          />
        ) : (
          <FactStrip cells={cells} />
        )
      }
      footnote={
        loading
          ? `Loading ${window} price and stake readings · chain-direct`
          : ohlc.isError || history.isError
            ? "chain-direct · retry the affected record above"
            : `${window} · daily close, chain-direct`
      }
    />
  );
}
