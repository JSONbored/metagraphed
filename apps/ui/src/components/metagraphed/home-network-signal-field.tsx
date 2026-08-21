import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type CSSProperties, type ReactNode, useState } from "react";
import { InteractiveDataField, type InteractiveDataFieldTone } from "@jsonbored/ui-kit";
import { useHydrated } from "@/hooks/use-hydrated";
import {
  economicsQuery,
  SUBNETS_ALL_LIMIT,
  subnetHealthMapQuery,
  subnetsQuery,
  type SubnetHealthEntry,
} from "@/lib/metagraphed/queries";
import type { HealthState, Subnet, SubnetEconomics } from "@/lib/metagraphed/types";

/** A fast desktop read, with the exhaustive ranking one explicit step away. */
export const HOME_NETWORK_SIGNAL_LIMIT = 24;
const HOME_NETWORK_SIGNAL_LEADER_LIMIT = 6;

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
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const hydrated = useHydrated();
  // These keys are shared by the homepage chrome and directory routes. React
  // Query resolves an already-warm visit without another request, while a cold
  // visit fetches the same small, cacheable registry artifacts those routes use.
  // Do not query live economics while SSR is producing the initial document:
  // the price field belongs to the client-owned live read and must hydrate from
  // the same deterministic loading state the server sent.
  const economics = useQuery({ ...economicsQuery(), enabled: hydrated, retry: 0 });
  const subnets = useQuery({
    ...subnetsQuery({ limit: SUBNETS_ALL_LIMIT }),
    enabled: hydrated,
    retry: 0,
  });
  const health = useQuery({ ...subnetHealthMapQuery(), enabled: hydrated, retry: 0 });

  if (!hydrated || economics.isPending || subnets.isPending) {
    return <HomeNetworkSignalFieldLoading />;
  }

  if (economics.isError) {
    return (
      <section className="mg-home-signal-field" aria-labelledby="home-price-share-field-title">
        <SignalFieldHeader />
        <p className="mg-home-signal-status" role="status">
          Current price-share data is unavailable. Try again in a moment.
        </p>
      </section>
    );
  }

  const allRows = buildHomeNetworkSignalRows({
    economics: economics.data?.data ?? [],
    subnets: subnets.data?.data ?? [],
    healthByNetuid: health.data?.data ?? {},
    limit: economics.data?.data.length ?? 0,
  });
  const rows = allRows.slice(0, HOME_NETWORK_SIGNAL_LIMIT);

  if (rows.length === 0) {
    return (
      <section className="mg-home-signal-field" aria-labelledby="home-price-share-field-title">
        <SignalFieldHeader />
        <p className="mg-home-signal-status" role="status">
          No current subnet price-share data has been published yet.
        </p>
      </section>
    );
  }

  const leaders = rows.slice(0, HOME_NETWORK_SIGNAL_LEADER_LIMIT);
  const leader = leaders[0];
  const inspectedId = hoveredId ?? activeId;
  const categories = [
    ...new Map(
      rows.map((row) => [row.category, { label: row.categoryLabel, tone: row.seriesTone }]),
    ).values(),
  ];
  const chartSummary = `Top ${rows.length} of ${allRows.length} subnets ranked by stage-one alpha-price share. ${leader.name} is largest at ${formatHomePriceShare(leader.priceShare)}.`;

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
          onHoverChange={setHoveredId}
          axisStart="Price share · registry family color"
          axisEnd={`Top ${rows.length} of ${allRows.length}`}
          data={rows.map((row, index) => ({
            id: String(row.netuid),
            label: `SN${row.netuid} · ${row.name}`,
            value: row.priceShare,
            valueLabel: formatHomePriceShare(row.priceShare),
            tone: row.seriesTone,
            ariaLabel: `Rank ${String(index + 1).padStart(2, "0")}. Subnet ${row.netuid}, ${row.name}. ${formatHomePriceShare(row.priceShare)} stage-one alpha-price share. Registry family ${row.categoryLabel}. Registry tags ${row.categoryTags.join(", ") || "unclassified"}. Probe health ${row.health}.`,
          }))}
          renderInspector={(datum, index) => {
            const row = rows[index];
            if (!row) return null;
            return (
              <HomeSignalInspector
                rank={index + 1}
                name={datum.label}
                priceShare={datum.valueLabel}
                category={row.categoryLabel}
                categoryTags={row.categoryTags}
                health={row.health}
              />
            );
          }}
        />
      </div>

      <ul className="mg-home-signal-legend" aria-label="Subnet registry family color legend">
        {categories.map((category) => (
          <li key={category.label} data-tone={category.tone}>
            <span
              aria-hidden="true"
              className="mg-home-signal-series"
              style={
                {
                  "--mg-home-signal-series-color": `var(--${category.tone})`,
                } as CSSProperties
              }
            />
            {category.label}
          </li>
        ))}
      </ul>

      <div className="mg-home-signal-leaders-wrap">
        <div className="mg-home-signal-readout">
          <span className="mg-home-signal-readout-label">Largest price share</span>
          <strong className="mg-home-signal-readout-value">
            {formatHomePriceShare(leader.priceShare)}
          </strong>
          <span className="mg-home-signal-readout-name">
            SN{leader.netuid} · {leader.name}
          </span>
        </div>

        <ol
          className="mg-home-signal-leaders"
          aria-label="Leading subnets by stage-one alpha-price share"
        >
          {leaders.map((row, index) => (
            <li
              key={row.netuid}
              data-active={inspectedId === String(row.netuid) || undefined}
              style={
                {
                  "--mg-home-signal-series-color": `var(--${row.seriesTone})`,
                } as CSSProperties
              }
            >
              <Link
                to="/subnets/$netuid"
                params={{ netuid: row.netuid }}
                className="mg-home-signal-leader"
                onFocus={() => setActiveId(String(row.netuid))}
                onPointerEnter={() => setHoveredId(String(row.netuid))}
                onPointerLeave={() => setHoveredId(null)}
                aria-label={`Subnet ${row.netuid} · ${row.name} · ${formatHomePriceShare(row.priceShare)} stage-one alpha-price share · probe health ${row.health}`}
              >
                <span className="mg-home-signal-rank" aria-hidden="true">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="mg-home-signal-leader-name">
                  <span className="mg-home-signal-series" aria-hidden="true" />
                  <span className="truncate">
                    SN{row.netuid} · {row.name}
                  </span>
                </span>
                <span className="mg-home-signal-leader-share">
                  {formatHomePriceShare(row.priceShare)}
                </span>
              </Link>
            </li>
          ))}
        </ol>
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

function HomeSignalInspector({
  rank,
  name,
  priceShare,
  category,
  categoryTags,
  health,
}: {
  rank: number;
  name: ReactNode;
  priceShare: ReactNode;
  category: string;
  categoryTags: readonly string[];
  health: HealthState;
}) {
  return (
    <div className="mg-home-signal-inspector">
      <span className="mg-home-signal-inspector-rank">
        {String(rank).padStart(2, "0")} · Price-share readout
      </span>
      <strong>{name}</strong>
      <dl>
        <div>
          <dt>Price share</dt>
          <dd>{priceShare}</dd>
        </div>
        <div>
          <dt>Registry family</dt>
          <dd>{category}</dd>
        </div>
        <div>
          <dt>Registry tags</dt>
          <dd>{categoryTags.join(", ") || "Unclassified"}</dd>
        </div>
        <div>
          <dt>Probe</dt>
          <dd>{health}</dd>
        </div>
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
          Market pulse.
        </h2>
      </div>
      <p className="mg-home-signal-description">Where price share is concentrating now.</p>
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
