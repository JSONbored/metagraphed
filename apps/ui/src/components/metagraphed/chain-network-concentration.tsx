import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Sparkline } from "@jsonbored/ui-kit";
import {
  chainBurnQuery,
  chainHoldersQuery,
  chainConcentrationSubnetsQuery,
  chainConcentrationHistoryQuery,
} from "@/lib/metagraphed/queries";
import { Skeleton, EmptyState, ErrorState } from "@/components/metagraphed/states";
import { DataPageModule } from "@/components/metagraphed/primitives";
import { formatNumber, formatTao, formatRelative } from "@/lib/metagraphed/format";
import {
  coverageNote,
  spansBuilderVersions,
  capturesDiverge,
} from "@/lib/metagraphed/network-coverage.functions";
import type {
  ChainBurn,
  ChainHolders,
  NetworkConcentrationHistory,
  NetworkConcentrationSubnets,
} from "@/lib/metagraphed/types";

const TOP_SHOWN = 8;
const RANK_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
  "var(--chart-7)",
  "var(--chart-8)",
];

/**
 * Network-wide concentration is a continuous part of the analytics document,
 * not a grid of secondary cards. Each module answers a single question and
 * keeps its coverage caveat beside the measurement it qualifies.
 */
export function ChainNetworkConcentration() {
  return (
    <div className="contents">
      <BurnSpread />
      <HolderConcentration />
      <ConcentrationRanking />
      <ConcentrationDrift />
    </div>
  );
}

/** What it costs to register, cheapest to dearest. */
function BurnSpread() {
  const { data, isLoading, isError, error, refetch } = useQuery(chainBurnQuery());
  const b = data?.data;

  return (
    <DataPageModule
      title="Registration cost"
      caption="The current price of entry across the subnets that were read. The rank rail makes the expensive end easy to compare."
      kind="question"
    >
      {isLoading ? <Skeleton className="h-[15rem] w-full" /> : null}
      {isError ? <ErrorState error={error} onRetry={() => void refetch()} /> : null}
      {!isLoading && !isError && !b ? (
        <EmptyState title="No registration costs" description="Nothing has been read yet." />
      ) : null}
      {b ? <BurnSpreadData data={b} /> : null}
    </DataPageModule>
  );
}

function BurnSpreadData({ data: b }: { data: ChainBurn }) {
  const note = coverageNote(b.subnet_count, b.read_count);
  const dearest = [...b.subnets]
    .filter((s) => s.burn_tao != null)
    .sort((a, z) => (z.burn_tao ?? 0) - (a.burn_tao ?? 0))
    .slice(0, TOP_SHOWN);

  return (
    <>
      <div className="mg-data-measure-grid mg-data-measure-grid--3">
        <Figure
          label="cheapest"
          value={formatTao(b.cheapest_burn_tao)}
          hint="Lowest current registration cost across the subnets read."
        />
        <Figure
          label="median"
          value={formatTao(b.median_burn_tao)}
          hint="The typical current price of entry."
        />
        <Figure
          label="dearest"
          value={formatTao(b.dearest_burn_tao)}
          hint="Highest current registration cost across the subnets read."
        />
      </div>
      {dearest.length > 0 ? (
        <RankedRows
          label="Subnets with the highest registration costs"
          entries={dearest.map((s) => ({
            id: String(s.netuid),
            label: `SN${s.netuid}`,
            netuid: s.netuid,
            value: s.burn_tao ?? 0,
            valueLabel: formatTao(s.burn_tao),
          }))}
        />
      ) : null}
      {note ? <p className="mg-data-module-note">{note}</p> : null}
    </>
  );
}

/** Who holds the alpha, and where one account holds all of it. */
function HolderConcentration() {
  const { data, isLoading, isError, error, refetch } = useQuery(chainHoldersQuery());
  const h = data?.data;

  return (
    <DataPageModule
      title="Alpha holders"
      caption="How concentrated alpha ownership is across measured subnets — including the cases where a single account holds it all."
      kind="question"
    >
      {isLoading ? <Skeleton className="h-[13rem] w-full" /> : null}
      {isError ? <ErrorState error={error} onRetry={() => void refetch()} /> : null}
      {!isLoading && !isError && !h ? (
        <EmptyState title="No holder data" description="Nothing has been read yet." />
      ) : null}
      {h ? <HolderConcentrationData data={h} /> : null}
    </DataPageModule>
  );
}

function HolderConcentrationData({ data: h }: { data: ChainHolders }) {
  const note = coverageNote(h.subnet_count, h.subnets_measured);
  const split = capturesDiverge(h.captured_at, h.positions_captured_at);

  return (
    <>
      <div className="mg-data-measure-grid mg-data-measure-grid--3">
        <Figure
          label="median top-1 share"
          value={h.median_top1_share == null ? "—" : `${formatNumber(h.median_top1_share * 100)}%`}
          hint="In the typical subnet, the share held by its largest holder."
        />
        <Figure
          label="majority-held"
          value={formatNumber(h.subnets_with_majority_holder)}
          hint="Subnets where one account holds over half of the alpha."
        />
        <Figure
          label="single-holder"
          value={formatNumber(h.subnets_with_single_holder)}
          hint="Subnets where one account holds all alpha."
        />
      </div>
      {split ? (
        <p className="mg-data-module-note">
          Subnet set read {formatRelative(h.captured_at)}; holder positions{" "}
          {formatRelative(h.positions_captured_at)}. The two halves describe different moments.
        </p>
      ) : null}
      {note ? <p className="mg-data-module-note">{note}</p> : null}
    </>
  );
}

/** Concentration ranked per subnet, with the unmeasured ones named as such. */
function ConcentrationRanking() {
  const { data, isLoading, isError, error, refetch } = useQuery(chainConcentrationSubnetsQuery());
  const c = data?.data;

  return (
    <DataPageModule
      title="Most concentrated subnets"
      caption="A ranked view of stake inequality. Unmeasured subnets are excluded rather than presented as perfectly even."
      kind="question"
    >
      {isLoading ? <Skeleton className="h-[18rem] w-full" /> : null}
      {isError ? <ErrorState error={error} onRetry={() => void refetch()} /> : null}
      {!isLoading && !isError && !c ? (
        <EmptyState title="No concentration data" description="Nothing has been read yet." />
      ) : null}
      {c ? <ConcentrationRankingData data={c} /> : null}
    </DataPageModule>
  );
}

function ConcentrationRankingData({ data: c }: { data: NetworkConcentrationSubnets }) {
  const note = coverageNote(c.subnet_count, c.measured_subnet_count);
  const ranked = c.subnets.filter((s) => !s.unmeasured).slice(0, TOP_SHOWN);

  return (
    <>
      <div className="mg-data-measure-grid mg-data-measure-grid--3">
        <Figure
          label="median gini"
          value={formatNumber(c.median_gini)}
          hint="Median inequality of stake across measured subnets. Zero is even; one is one holder."
        />
        <Figure
          label="median nakamoto"
          value={formatNumber(c.median_nakamoto_coefficient)}
          hint="How many accounts it typically takes to reach a controlling share."
        />
        <Figure
          label="single-holder"
          value={formatNumber(c.single_holder_subnet_count)}
          hint="Measured subnets whose stake sits with one account."
        />
      </div>
      {ranked.length > 0 ? (
        <RankedRows
          label="Subnet concentration ranking"
          entries={ranked.map((s) => ({
            id: String(s.netuid),
            label: `SN${s.netuid}`,
            netuid: s.netuid,
            value: s.gini ?? 0,
            valueLabel: `gini ${formatNumber(s.gini)}`,
            detail: `nakamoto ${formatNumber(s.nakamoto_coefficient)}`,
          }))}
        />
      ) : null}
      {note ? <p className="mg-data-module-note">{note}</p> : null}
    </>
  );
}

/** Concentration over time, and whether the series is one computation. */
function ConcentrationDrift() {
  const { data, isLoading, isError, error, refetch } = useQuery(
    chainConcentrationHistoryQuery("30d"),
  );
  const hist = data?.data;

  return (
    <DataPageModule
      title="Concentration drift"
      caption="The network-wide stake Gini over time. The definition seam is surfaced rather than smoothed into a false trend."
      kind="question"
    >
      {isLoading ? <Skeleton className="h-[20rem] w-full" /> : null}
      {isError ? <ErrorState error={error} onRetry={() => void refetch()} /> : null}
      {!isLoading && !isError && (!hist || hist.points.length === 0) ? (
        <EmptyState
          title="No concentration history"
          description="The daily concentration series has no points in this window."
        />
      ) : null}
      {hist && hist.points.length > 0 ? <ConcentrationDriftData data={hist} /> : null}
    </DataPageModule>
  );
}

function ConcentrationDriftData({ data: hist }: { data: NetworkConcentrationHistory }) {
  const first = hist.points[0];
  const last = hist.points[hist.points.length - 1];
  const mixed = spansBuilderVersions(hist.builder_versions);
  const giniPoints = hist.points
    .filter((point): point is typeof point & { gini: number } => point.gini != null)
    .map((point) => ({ t: point.day, v: point.gini }));

  return (
    <>
      <div className="mg-data-wide-chart">
        <Sparkline
          values={giniPoints.map((point) => point.v)}
          points={giniPoints}
          width={1100}
          height={168}
          color="var(--chart-3)"
          ariaLabel="Network stake Gini over time"
          formatValue={formatNumber}
        />
      </div>
      <div className="mg-data-measure-grid mg-data-measure-grid--4">
        <Figure label="days" value={formatNumber(hist.point_count)} hint="Days in this series." />
        <Figure
          label="gini then"
          value={formatNumber(first?.gini)}
          hint={`Stake Gini on ${hist.oldest_day ?? "the oldest day"}.`}
        />
        <Figure
          label="gini now"
          value={formatNumber(last?.gini)}
          hint={`Stake Gini on ${hist.newest_day ?? "the newest day"}.`}
        />
        <Figure
          label="nakamoto now"
          value={formatNumber(last?.nakamoto_coefficient)}
          hint="Accounts needed to reach a controlling share on the newest day."
        />
      </div>
      {mixed ? (
        <p className="mg-data-module-note">
          This window spans builder versions {hist.builder_versions.join(", ")} — points either side
          were computed differently, so movement across the seam is a definition change, not a
          network change.
        </p>
      ) : null}
    </>
  );
}

function Figure({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="mg-data-measure" title={hint}>
      <div>{label}</div>
      <div>{value}</div>
    </div>
  );
}

interface RankedEntry {
  id: string;
  label: string;
  netuid: number;
  value: number;
  valueLabel: string;
  detail?: string;
}

function RankedRows({ label, entries }: { label: string; entries: RankedEntry[] }) {
  const cap = Math.max(1, ...entries.map((entry) => entry.value));

  return (
    <ol className="mg-data-rank-list" aria-label={label}>
      {entries.map((entry, index) => {
        const width = Math.max(2, Math.round((entry.value / cap) * 100));
        return (
          <li key={entry.id}>
            <Link
              to="/subnets/$netuid"
              params={{ netuid: entry.netuid }}
              className="mg-data-rank-row mg-focus-ring"
              aria-label={`${entry.label}: ${entry.valueLabel}${entry.detail ? `, ${entry.detail}` : ""}`}
            >
              <span className="mg-data-rank-index">{String(index + 1).padStart(2, "0")}</span>
              <span className="mg-data-rank-label">{entry.label}</span>
              <span className="mg-data-rank-track" aria-hidden="true">
                <span
                  className="mg-data-rank-fill"
                  style={{
                    width: `${width}%`,
                    background: RANK_COLORS[index % RANK_COLORS.length],
                  }}
                />
              </span>
              <span className="mg-data-rank-value">
                {entry.valueLabel}
                {entry.detail ? <small>{entry.detail}</small> : null}
              </span>
            </Link>
          </li>
        );
      })}
    </ol>
  );
}
