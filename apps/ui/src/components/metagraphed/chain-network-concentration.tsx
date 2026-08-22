import { Definition } from "@jsonbored/ui-kit";
import { useQuery } from "@tanstack/react-query";
import {
  chainBurnQuery,
  chainHoldersQuery,
  chainConcentrationSubnetsQuery,
  chainConcentrationHistoryQuery,
} from "@/lib/metagraphed/queries";
import { Panel } from "@/components/metagraphed/primitives";
import { Skeleton, EmptyState, ErrorState } from "@/components/metagraphed/states";
import { formatNumber, formatTao, formatRelative } from "@/lib/metagraphed/format";
import {
  coverageNote,
  spansBuilderVersions,
  capturesDiverge,
} from "@/lib/metagraphed/network-coverage.functions";

const TOP_SHOWN = 8;

/**
 * The four network-wide surfaces #10300 found rendered nowhere:
 * `/chain/burn`, `/chain/holders`, `/chain/concentration/subnets` and
 * `/chain/concentration/history`.
 *
 * Grouped rather than scattered because they answer one question between them
 * -- how evenly is the network held, and what does it cost to join -- and
 * because they share a caveat that only makes sense stated once per aggregate:
 * EVERY ONE OF THEM PUBLISHES A READ COUNT BESIDE A TOTAL. An aggregate over a
 * partial read describes the subset that was read. The panels say which, rather
 * than presenting a spread over 120 subnets as a fact about 129.
 */
export function ChainNetworkConcentration() {
  return (
    <div className="space-y-6">
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
  if (isLoading) return <Skeleton className="h-[120px] w-full" />;
  if (isError) return <ErrorState error={error} onRetry={() => void refetch()} />;
  const b = data?.data;
  if (!b) return <EmptyState title="No registration costs" description="Nothing read yet." />;

  const note = coverageNote(b.subnet_count, b.read_count);
  const dearest = [...b.subnets]
    .filter((s) => s.burn_tao != null)
    .sort((a, z) => (z.burn_tao ?? 0) - (a.burn_tao ?? 0))
    .slice(0, TOP_SHOWN);

  return (
    <Panel as="section">
      <h3 className="mb-3 text-11 text-ink-muted">Registration cost across subnets</h3>
      <div className="grid grid-cols-3 gap-x-6 gap-y-3">
        <Figure
          label="cheapest"
          value={formatTao(b.cheapest_burn_tao)}
          hint="Lowest current registration cost across the subnets read."
        />
        <Figure
          label="median"
          value={formatTao(b.median_burn_tao)}
          hint="Median registration cost — the typical price of entry."
        />
        <Figure
          label="dearest"
          value={formatTao(b.dearest_burn_tao)}
          hint="Highest current registration cost."
        />
      </div>
      {dearest.length > 0 ? (
        <ul className="mt-4 space-y-1">
          {dearest.map((s) => (
            <li key={s.netuid} className="flex justify-between text-10">
              <span className="text-ink-muted">SN{s.netuid}</span>
              <span className="tabular-nums text-ink">{formatTao(s.burn_tao)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {note ? <p className="mt-3 text-11 text-ink-muted">{note}</p> : null}
    </Panel>
  );
}

/** Who holds the alpha, and where one account holds all of it. */
function HolderConcentration() {
  const { data, isLoading, isError, error, refetch } = useQuery(chainHoldersQuery());
  if (isLoading) return <Skeleton className="h-[120px] w-full" />;
  if (isError) return <ErrorState error={error} onRetry={() => void refetch()} />;
  const h = data?.data;
  if (!h) return <EmptyState title="No holder data" description="Nothing read yet." />;

  const note = coverageNote(h.subnet_count, h.subnets_measured);
  // Two stamps, stated separately only when they actually disagree.
  const split = capturesDiverge(h.captured_at, h.positions_captured_at);

  return (
    <Panel as="section">
      <h3 className="mb-3 text-11 text-ink-muted">Alpha holders across subnets</h3>
      <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
        <Figure
          label="median top-1 share"
          value={h.median_top1_share == null ? "—" : `${formatNumber(h.median_top1_share * 100)}%`}
          hint="In the typical subnet, this is the share held by its largest holder."
        />
        <Figure
          label="majority-held"
          value={formatNumber(h.subnets_with_majority_holder)}
          hint="Subnets where one account holds over half the alpha."
        />
        <Figure
          label="single-holder"
          value={formatNumber(h.subnets_with_single_holder)}
          hint="Subnets where ONE account holds all of it — a stronger claim than a majority, so it is counted separately."
        />
      </div>
      {split ? (
        <p className="mt-3 text-11 text-ink-muted">
          Subnet set read {formatRelative(h.captured_at)}; holder positions{" "}
          {formatRelative(h.positions_captured_at)}. The two halves describe different moments.
        </p>
      ) : null}
      {note ? <p className="mt-2 text-11 text-ink-muted">{note}</p> : null}
    </Panel>
  );
}

/** Concentration ranked per subnet, with the unmeasured ones named as such. */
function ConcentrationRanking() {
  const { data, isLoading, isError, error, refetch } = useQuery(chainConcentrationSubnetsQuery());
  if (isLoading) return <Skeleton className="h-[120px] w-full" />;
  if (isError) return <ErrorState error={error} onRetry={() => void refetch()} />;
  const c = data?.data;
  if (!c) return <EmptyState title="No concentration data" description="Nothing read yet." />;

  const note = coverageNote(c.subnet_count, c.measured_subnet_count);
  // An unmeasured subnet is DROPPED from the ranking rather than ranked at
  // zero: no reading is not perfect equality, and sorting it to one end of the
  // list would put it at an extreme it was never measured to occupy.
  const ranked = c.subnets.filter((s) => !s.unmeasured).slice(0, TOP_SHOWN);

  return (
    <Panel as="section">
      <h3 className="mb-3 text-11 text-ink-muted">Most concentrated subnets</h3>
      <div className="grid grid-cols-3 gap-x-6 gap-y-3">
        <Figure
          label="median gini"
          value={formatNumber(c.median_gini)}
          hint="Median inequality of stake across subnets. 0 is even, 1 is one holder."
        />
        <Figure
          label="median nakamoto"
          value={formatNumber(c.median_nakamoto_coefficient)}
          hint="How many accounts it typically takes to reach a controlling share."
        />
        <Figure
          label="single-holder"
          value={formatNumber(c.single_holder_subnet_count)}
          hint="Subnets whose stake sits with one account."
        />
      </div>
      {ranked.length > 0 ? (
        <ul className="mt-4 space-y-1">
          {ranked.map((s) => (
            <li key={s.netuid} className="flex justify-between text-10">
              <span className="text-ink-muted">SN{s.netuid}</span>
              <span className="tabular-nums text-ink">
                gini {formatNumber(s.gini)} · nakamoto {formatNumber(s.nakamoto_coefficient)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {note ? <p className="mt-3 text-11 text-ink-muted">{note}</p> : null}
    </Panel>
  );
}

/** Concentration over time, and whether the series is one computation. */
function ConcentrationDrift() {
  const { data, isLoading, isError, error, refetch } = useQuery(
    chainConcentrationHistoryQuery("30d"),
  );
  if (isLoading) return <Skeleton className="h-[120px] w-full" />;
  if (isError) return <ErrorState error={error} onRetry={() => void refetch()} />;
  const hist = data?.data;
  if (!hist || hist.points.length === 0) {
    return (
      <EmptyState
        title="No concentration history"
        description="The daily concentration series has no points in this window."
      />
    );
  }

  const first = hist.points[0];
  const last = hist.points[hist.points.length - 1];
  const mixed = spansBuilderVersions(hist.builder_versions);

  return (
    <Panel as="section">
      <h3 className="mb-3 text-11 text-ink-muted">Concentration drift · {hist.window}</h3>
      <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        <Figure label="days" value={formatNumber(hist.point_count)} hint="Days in the series." />
        <Figure
          label="gini then"
          value={formatNumber(first?.gini)}
          hint={`Stake gini on ${hist.oldest_day ?? "the oldest day"}.`}
        />
        <Figure
          label="gini now"
          value={formatNumber(last?.gini)}
          hint={`Stake gini on ${hist.newest_day ?? "the newest day"}.`}
        />
        <Figure
          label="nakamoto now"
          value={formatNumber(last?.nakamoto_coefficient)}
          hint="Accounts needed to reach a controlling share of stake, on the newest day."
        />
      </div>
      {/* THE SEAM. A trend drawn across a builder-version change compares two
          definitions rather than measuring a movement, so it is named rather
          than smoothed over. */}
      {mixed ? (
        <p className="mt-3 text-11 text-ink-muted">
          This window spans builder versions {hist.builder_versions.join(", ")} — points either side
          were computed differently, so a change across the seam is a change of definition, not of
          the network.
        </p>
      ) : null}
    </Panel>
  );
}

function Figure({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div>
      <div className="flex items-center gap-1 text-11 text-ink-muted">
        {label}
        <Definition term={label} sentence={hint} />
      </div>
      <div className="text-11 tabular-nums text-ink">{value}</div>
    </div>
  );
}
