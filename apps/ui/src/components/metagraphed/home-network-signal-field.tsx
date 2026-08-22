import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  CompositionTimeline,
  compositionToneAt,
  type CompositionTimelineColumn,
  type CompositionTimelineSeries,
} from "@jsonbored/ui-kit";
import { subnetPriceShareCompositionQuery } from "@/lib/metagraphed/queries";
import type { SubnetPriceShareCompositionArtifact } from "@/lib/metagraphed/types";

type CompositionArtifact = SubnetPriceShareCompositionArtifact;
type CompositionSeries = CompositionArtifact["series"][number];

/**
 * Series identity is a netuid, not a project: the endpoint deliberately does
 * not join identity history, so a reused netuid is one series here without any
 * claim that it was one team throughout the span.
 */
export function compositionSeriesLabel(series: CompositionSeries): string {
  if (series.kind === "other") return "Other";
  const label = series.label?.trim();
  if (label) return label;
  return series.netuid == null ? "Unknown" : `SN${series.netuid}`;
}

/** Compact axis text. The full date stays in the inspector and the table. */
export function compositionAxisLabel(day: string): string {
  return day.slice(5).replace("-", "/");
}

export interface CompositionTimelineModel {
  series: CompositionTimelineSeries[];
  columns: CompositionTimelineColumn[];
}

/**
 * Maps one bounded composition artifact onto the shared timeline primitive.
 *
 * Tones are assigned from the artifact's own stable cohort order, which the
 * endpoint fixes from `reference_day`. That is what stops a series changing
 * colour between responses — the palette follows the cohort, never the daily
 * ordering of a single response's values.
 */
export function buildCompositionTimelineModel(
  artifact: CompositionArtifact | null | undefined,
): CompositionTimelineModel {
  const rawSeries = artifact?.series ?? [];
  const rawDays = artifact?.days ?? [];

  let toneIndex = 0;
  const series: CompositionTimelineSeries[] = rawSeries.map((entry) => {
    const base = { id: entry.id, label: compositionSeriesLabel(entry) };
    // The residual takes no categorical slot, so the real cohort's colours do
    // not shift depending on whether a residual is present.
    return entry.kind === "other"
      ? { ...base, residual: true as const }
      : { ...base, tone: compositionToneAt(toneIndex++) };
  });

  const columns: CompositionTimelineColumn[] = rawDays.map((day) => {
    const shares: Record<string, number> = {};
    for (const value of day.values) {
      // A day carries one entry per cohort series; keep the recorded number
      // exactly as published rather than re-deriving or rounding it here.
      shares[value.series_id] = value.price_share;
    }
    return {
      id: day.snapshot_date,
      label: day.snapshot_date,
      axisLabel: compositionAxisLabel(day.snapshot_date),
      caption: `${day.priced_subnet_count} priced subnets`,
      shares,
    };
  });

  return { series, columns };
}

/**
 * The homepage's single live visual: how the priced-subnet cohort's share of
 * the artifact-normalised moving price unit moved across the published span.
 *
 * The wording matters and is load-bearing. This is not stake, not market cap,
 * not final TAO emission, and not the runtime v440 Stage-1 share — it is the
 * legacy economics artifact's own normalisation, and the copy says so.
 */
export function HomeNetworkSignalField() {
  const composition = useQuery({ ...subnetPriceShareCompositionQuery(), retry: 0 });

  if (composition.isPending) return <SignalFieldFrame busy />;

  if (composition.isError) {
    return (
      <SignalFieldFrame>
        <p className="mg-home-signal-status" role="status">
          Historical price-share composition is unavailable right now.
        </p>
      </SignalFieldFrame>
    );
  }

  const artifact = composition.data?.data ?? null;
  const { series, columns } = buildCompositionTimelineModel(artifact);

  if (series.length === 0 || columns.length === 0) {
    return (
      <SignalFieldFrame>
        <p className="mg-home-signal-status" role="status">
          No complete daily price-share snapshots have been published yet.
        </p>
      </SignalFieldFrame>
    );
  }

  const subnetCount = series.filter((entry) => !entry.residual).length;
  const summary =
    `${columns.length} daily snapshots of artifact-normalised moving price share, ` +
    `for a fixed cohort of ${subnetCount} subnets plus a derived residual.`;

  return (
    <SignalFieldFrame>
      <div data-testid="home-network-signal-chart">
        <CompositionTimeline
          ariaLabel={summary}
          tableCaption={summary}
          series={series}
          columns={columns}
          axisStart={artifact?.oldest_day ?? ""}
          axisEnd={artifact?.newest_day ?? ""}
        />
      </div>

      <div className="mg-home-signal-footer">
        <Link
          to="/subnets"
          search={{ section: "rankings" }}
          className="mg-focus-ring mg-home-signal-all-link"
        >
          Open subnet rankings
        </Link>
      </div>
    </SignalFieldFrame>
  );
}

function SignalFieldFrame({ busy, children }: { busy?: boolean; children?: React.ReactNode }) {
  return (
    <section
      className="mg-home-signal-field"
      aria-labelledby="home-price-share-field-title"
      aria-busy={busy || undefined}
      data-testid="home-network-signal-field"
    >
      <header className="mg-home-signal-header">
        <h2 id="home-price-share-field-title" className="mg-home-signal-title">
          <b>Price composition.</b> How the priced cohort's share of the artifact-normalised moving
          price unit moved.
        </h2>
      </header>
      {busy ? (
        <>
          <div className="mg-home-signal-loading-chart" aria-hidden="true">
            <div className="mg-home-signal-loading-bars">
              {/* One placeholder lane per published day, so the skeleton has
                  the shape of the chart it is standing in for. */}
              {Array.from({ length: 56 }).map((_, index) => (
                <span key={index} className="mg-home-signal-loading-bar" />
              ))}
            </div>
          </div>
          <p className="sr-only" role="status">
            Loading daily price-share composition.
          </p>
        </>
      ) : (
        children
      )}
    </section>
  );
}
