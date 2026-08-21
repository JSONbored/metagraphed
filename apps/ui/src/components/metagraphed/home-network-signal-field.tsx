import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type CSSProperties, useState } from "react";
import { InteractiveDataField, type InteractiveDataFieldTone } from "@jsonbored/ui-kit";
import {
  subnetPriceShareCompositionQuery,
  type SubnetHealthEntry,
} from "@/lib/metagraphed/queries";
import type {
  HealthState,
  Subnet,
  SubnetEconomics,
  SubnetPriceShareCompositionArtifact,
} from "@/lib/metagraphed/types";

/** A fast desktop read, with the exhaustive ranking one explicit step away. */
export const HOME_NETWORK_SIGNAL_LIMIT = 24;

export interface HomeNetworkSignalRow {
  netuid: number;
  name: string;
  priceShare: number;
  health: HealthState;
  /** Canonical visual family for one or more registry tags. */
  category: string;
  /** The family name exposed in the visible color key. */
  categoryLabel: string;
  /** A family color whose meaning is exposed alongside the field. */
  seriesTone: InteractiveDataFieldTone;
  /** All raw registry tags remain available in the hover/focus inspector. */
  categoryTags: string[];
}

export interface BuildHomeNetworkSignalRowsInput {
  economics: readonly SubnetEconomics[];
  subnets: readonly Subnet[];
  healthByNetuid: Readonly<Record<number, SubnetHealthEntry | undefined>>;
  limit?: number;
}

/*
 * A legend is a decoding key, not decoration. The data prism deliberately has
 * eleven tones, while the registry carries fourteen derived tags. These three
 * pairs are intentional *visual families*, so every color the field shows has
 * exactly one name in the key. The exact source tags stay in the inspector.
 */
const HOME_CATEGORY_META = {
  agents: { label: "Agents", tone: "chart-1" },
  inference: { label: "Inference", tone: "chart-2" },
  prediction: { label: "Prediction", tone: "chart-3" },
  finance: { label: "Finance", tone: "chart-4" },
  compute: { label: "Compute", tone: "chart-5" },
  dataSecurity: { label: "Data & security", tone: "chart-6" },
  mediaStorage: { label: "Media & storage", tone: "chart-7" },
  science: { label: "Science", tone: "chart-8" },
  search: { label: "Search", tone: "chart-9" },
  privacy: { label: "Privacy", tone: "chart-10" },
  otherSystems: { label: "Other systems", tone: "chart-11" },
} as const satisfies Record<string, { label: string; tone: InteractiveDataFieldTone }>;

type HomeCategory = keyof typeof HOME_CATEGORY_META;

const HOME_CATEGORY_BY_TAG: Record<string, HomeCategory> = {
  agents: "agents",
  inference: "inference",
  prediction: "prediction",
  finance: "finance",
  compute: "compute",
  data: "dataSecurity",
  security: "dataSecurity",
  media: "mediaStorage",
  storage: "mediaStorage",
  science: "science",
  search: "search",
  privacy: "privacy",
  robotics: "otherSystems",
  other: "otherSystems",
};

/* Registry tag ordering is not an authority signal. Choose a stable family in
 * a declared precedence instead of letting an upstream array's incidental
 * order recolor a subnet from one response to the next. */
const HOME_CATEGORY_PRIORITY: readonly HomeCategory[] = [
  "agents",
  "inference",
  "prediction",
  "finance",
  "compute",
  "dataSecurity",
  "mediaStorage",
  "science",
  "search",
  "privacy",
  "otherSystems",
];

function signalCategory(subnet: Subnet | undefined): {
  category: string;
  categoryLabel: string;
  seriesTone: InteractiveDataFieldTone;
  categoryTags: string[];
} {
  const categoryTags = (subnet?.derived_categories ?? [])
    .filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0)
    .map((tag) => tag.trim().toLowerCase())
    .filter((tag, index, all) => all.indexOf(tag) === index)
    .sort();
  const category =
    HOME_CATEGORY_PRIORITY.find((candidate) =>
      categoryTags.some((tag) => HOME_CATEGORY_BY_TAG[tag] === candidate),
    ) ?? "otherSystems";
  const known = HOME_CATEGORY_META[category];
  return {
    category,
    categoryLabel: known.label,
    seriesTone: known.tone,
    categoryTags,
  };
}

/**
 * Builds the single honest visual claim the homepage makes: stage-one
 * alpha-price share in the v440 emission pipeline, largest first. Registry
 * data only supplies human names; probe health is an independent overlay and
 * never affects rank.
 */
export function buildHomeNetworkSignalRows({
  economics,
  subnets,
  healthByNetuid,
  limit = HOME_NETWORK_SIGNAL_LIMIT,
}: BuildHomeNetworkSignalRowsInput): HomeNetworkSignalRow[] {
  const subnetByNetuid = new Map(subnets.map((subnet) => [subnet.netuid, subnet]));
  const rowsByNetuid = new Map<number, HomeNetworkSignalRow>();

  for (const economicsRow of economics) {
    const share = economicsRow.emission_share;
    // Root is not an application subnet, and a missing/zero share cannot make
    // a price-share bar. Do not turn an absent reading into a tiny visual cue.
    if (
      economicsRow.netuid <= 0 ||
      share == null ||
      !Number.isFinite(share) ||
      share <= 0 ||
      share > 1
    ) {
      continue;
    }

    const previous = rowsByNetuid.get(economicsRow.netuid);
    // The endpoint normally carries one row per subnet. Keeping the larger
    // valid observation makes a duplicated upstream row deterministic rather
    // than silently rendering the same subnet twice.
    if (previous && previous.priceShare >= share) continue;

    const subnet = subnetByNetuid.get(economicsRow.netuid);
    const category = signalCategory(subnet);
    rowsByNetuid.set(economicsRow.netuid, {
      netuid: economicsRow.netuid,
      name: subnet?.name ?? economicsRow.name ?? `Subnet ${economicsRow.netuid}`,
      priceShare: share,
      // Health is a probe-derived overlay. A list-row's lifecycle is not a
      // health signal, so no overlay correctly remains "unknown".
      health: healthByNetuid[economicsRow.netuid]?.health ?? "unknown",
      ...category,
    });
  }

  const safeLimit = Math.max(0, Math.floor(limit));
  return [...rowsByNetuid.values()]
    .sort((a, b) => b.priceShare - a.priceShare || a.netuid - b.netuid)
    .slice(0, safeLimit);
}

/** A compact, stable label for both the visual readout and accessible summary. */
export function formatHomePriceShare(share: number): string {
  const percentage = share * 100;
  return `${percentage >= 10 ? percentage.toFixed(1) : percentage.toFixed(2)}%`;
}

/**
 * OpenCode-style price-share field for the homepage. Every compact column is
 * an inspectable control; the six accompanying leaders are the fast route to
 * a full subnet record, not a substitute for chart interaction.
 */
export function HomeNetworkSignalField() {
  const [activeId, setActiveId] = useState<string | null>(null);
  const composition = useQuery({ ...subnetPriceShareCompositionQuery(), retry: 0 });

  if (composition.isPending) {
    return <HomeNetworkSignalFieldLoading />;
  }

  if (composition.isError) {
    return (
      <section className="mg-home-signal-field" aria-labelledby="home-price-share-field-title">
        <SignalFieldHeader />
        <p className="mg-home-signal-status" role="status">
          Historical price-share composition is unavailable. Try again in a moment.
        </p>
      </section>
    );
  }

  const artifact = composition.data?.data;
  const series = artifact?.series ?? [];
  const days = artifact?.days ?? [];

  if (series.length === 0 || days.length === 0) {
    return (
      <section className="mg-home-signal-field" aria-labelledby="home-price-share-field-title">
        <SignalFieldHeader />
        <p className="mg-home-signal-status" role="status">
          No complete daily price-share snapshots have been published yet.
        </p>
      </section>
    );
  }

  const tones = INTERACTIVE_DATA_FIELD_TONES;
  const seriesById = new Map(series.map((entry) => [entry.id, entry]));
  const toneById = new Map(series.map((entry, index) => [entry.id, tones[index % tones.length]]));
  const chartSummary = `${days.length} daily snapshots of artifact-normalized moving price-share composition. The stable cohort contains ${series.length - 1} subnets plus Other.`;

  return (
    <section
      className="mg-home-signal-field"
      aria-labelledby="home-price-share-field-title"
      data-testid="home-network-signal-field"
    >
      <SignalFieldHeader />

      <div data-testid="home-network-signal-chart" aria-label={chartSummary}>
        <InteractiveDataField
          ariaLabel={chartSummary}
          className="mg-home-signal-chart"
          activeId={activeId}
          onActiveChange={setActiveId}
          axisStart={artifact ? compositionWindowLabel(artifact) : "Daily snapshots"}
          axisEnd={artifact?.newest_day ?? ""}
          data={days.map((day) => ({
            id: day.snapshot_date,
            label: day.snapshot_date,
            value: 1,
            valueLabel: `${day.priced_subnet_count} priced subnets`,
            axisLabel: shortDayLabel(day.snapshot_date),
            ariaLabel: `${day.snapshot_date}. ${day.priced_subnet_count} priced subnets. ${series
              .map((entry) => {
                const value =
                  day.values.find((item) => item.series_id === entry.id)?.price_share ?? 0;
                return `${seriesLabel(entry)} ${formatHomePriceShare(value)}`;
              })
              .join(", ")}.`,
            segments: series.map((entry) => ({
              label: seriesLabel(entry),
              value: day.values.find((item) => item.series_id === entry.id)?.price_share ?? 0,
              valueLabel: formatHomePriceShare(
                day.values.find((item) => item.series_id === entry.id)?.price_share ?? 0,
              ),
              tone: toneById.get(entry.id) ?? "chart-11",
            })),
          }))}
          renderInspector={(_datum, index) => {
            const day = days[index];
            if (!day) return null;
            return (
              <HomeCompositionInspector day={day} seriesById={seriesById} toneById={toneById} />
            );
          }}
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
    </section>
  );
}

const INTERACTIVE_DATA_FIELD_TONES: readonly InteractiveDataFieldTone[] = [
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
  "chart-6",
  "chart-7",
  "chart-8",
  "chart-9",
  "chart-10",
  "chart-11",
];

type CompositionDay = SubnetPriceShareCompositionArtifact["days"][number];
type CompositionSeries = SubnetPriceShareCompositionArtifact["series"][number];

function seriesLabel(series: CompositionSeries): string {
  if (series.kind === "other") return "Other";
  return series.label?.trim() || `SN${series.netuid ?? "?"}`;
}

function shortDayLabel(day: string): string {
  return day.slice(5).replace("-", "/");
}

function compositionWindowLabel(artifact: SubnetPriceShareCompositionArtifact): string {
  return `${artifact.oldest_day ?? ""} — ${artifact.newest_day ?? ""}`;
}

function HomeCompositionInspector({
  day,
  seriesById,
  toneById,
}: {
  day: CompositionDay;
  seriesById: ReadonlyMap<string, CompositionSeries>;
  toneById: ReadonlyMap<string, InteractiveDataFieldTone>;
}) {
  return (
    <div className="mg-home-signal-inspector">
      <span className="mg-home-signal-inspector-rank">{day.snapshot_date}</span>
      <strong>{day.priced_subnet_count} priced subnets</strong>
      <dl>
        {day.values.map((value) => {
          const series = seriesById.get(value.series_id);
          return (
            <div key={value.series_id}>
              <dt>
                <span
                  aria-hidden="true"
                  className="mg-home-signal-series"
                  style={
                    {
                      "--mg-home-signal-series-color": `var(--${toneById.get(value.series_id) ?? "chart-11"})`,
                    } as CSSProperties
                  }
                />
                {series ? seriesLabel(series) : value.series_id}
              </dt>
              <dd>{formatHomePriceShare(value.price_share)}</dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

function SignalFieldHeader() {
  return (
    <header className="mg-home-signal-header">
      <div>
        <span className="mg-home-signal-kicker">Network economics</span>
        <h2 id="home-price-share-field-title" className="mg-home-signal-title">
          Price composition.
        </h2>
      </div>
      <p className="mg-home-signal-description">
        A 56-day view of the selected price-share cohort. Inspect a day for exact values.
      </p>
    </header>
  );
}

function HomeNetworkSignalFieldLoading() {
  return (
    <section
      className="mg-home-signal-field"
      aria-labelledby="home-price-share-field-title"
      aria-busy="true"
    >
      <SignalFieldHeader />
      <div className="mg-home-signal-loading-chart" aria-hidden="true">
        <div className="mg-home-signal-loading-bars">
          {Array.from({ length: HOME_NETWORK_SIGNAL_LIMIT }).map((_, index) => (
            <span key={index} className="mg-home-signal-loading-bar" />
          ))}
        </div>
      </div>
      <p className="sr-only" role="status">
        Loading current subnet price-share data.
      </p>
    </section>
  );
}
