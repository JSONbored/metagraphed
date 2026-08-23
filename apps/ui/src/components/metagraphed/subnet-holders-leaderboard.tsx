import { FactStrip, FactCell, DataTable, type DataTableColumn } from "@jsonbored/ui-kit";
import { useQuery } from "@tanstack/react-query";
import { Database } from "lucide-react";
import { subnetHoldersQuery } from "@/lib/metagraphed/queries";
import { AddressDisplay } from "@/components/metagraphed/address-display";
import { Skeleton, EmptyState, ErrorState } from "@/components/metagraphed/states";
import { RouterLink } from "@/components/metagraphed/router-link";
import { formatNumber } from "@/lib/metagraphed/format";
import type { SubnetHolderEntry } from "@/lib/metagraphed/types";

/**
 * Alpha, already in WHOLE UNITS.
 *
 * Deliberately NOT the `fmtAlpha` in subnet-conviction-leaderboard.tsx, which
 * divides by 1e9 because conviction/locked_mass arrive rao-scale. This route's
 * producer converts before writing (`rao_to_alpha_f64` in the poller's
 * hotkey_alpha job), so `total_alpha` is stored in whole alpha and
 * `share_fraction * total_alpha` comes out the same way. Dividing again would
 * report every holder as a billionth of its real size, which looks like a
 * plausible dust balance rather than an obvious bug.
 */
function fmtAlpha(alpha: number): string {
  if (!Number.isFinite(alpha)) return "—";
  const magnitude = Math.abs(alpha);
  if (magnitude >= 1_000_000) return `${(alpha / 1_000_000).toFixed(2)}M α`;
  if (magnitude >= 1_000) return `${(alpha / 1_000).toFixed(1)}k α`;
  if (magnitude >= 1) return `${alpha.toFixed(2)} α`;
  if (alpha === 0) return "0 α";
  return `${alpha.toFixed(4)} α`;
}

/** A share as a percentage, or an em dash. Null is "no share to state" -- with
 * no measured total there is no denominator -- and must never render as 0%. */
function pctStr(share: number | null): string {
  if (share == null || !Number.isFinite(share)) return "—";
  const pct = share * 100;
  if (pct >= 10) return `${pct.toFixed(1)}%`;
  if (pct >= 1) return `${pct.toFixed(2)}%`;
  return `${pct.toFixed(3)}%`;
}

/** One holder, carrying the rank its position in the ranked list gives it. */
type RankedHolder = SubnetHolderEntry & { rank: number };

const COLUMNS: Array<DataTableColumn<RankedHolder>> = [
  // Rank, because this is a leaderboard -- the order carries meaning and a
  // reader should not have to count rows.
  { key: "rank", label: "#", kind: "number", value: (entry) => entry.rank },
  {
    key: "coldkey",
    label: "Coldkey",
    value: (entry) => entry.coldkey,
    render: (entry) => <AddressDisplay ss58={entry.coldkey} fallback="—" compact />,
  },
  {
    key: "alpha",
    label: "Alpha",
    kind: "number",
    sortable: true,
    value: (entry) => entry.alpha,
    format: (v) => (typeof v === "number" ? fmtAlpha(v) : "—"),
  },
  // Concentration is the question this section exists to answer, and a column
  // of percentages does not answer it at a glance -- `tint` paints the cell
  // in proportion to the share, so the shape of the distribution is legible
  // without a second encoding of its own.
  {
    key: "share",
    label: "Share",
    kind: "tint",
    sortable: true,
    value: (entry) => entry.share_of_total,
    tint: (entry) => entry.share_of_total,
    format: (v) => pctStr(typeof v === "number" ? v : null),
  },
  {
    key: "hotkeys",
    label: "Hotkeys",
    kind: "number",
    sortable: true,
    value: (entry) => entry.hotkey_count,
    format: (v) => formatNumber(typeof v === "number" ? v : null),
  },
];

/**
 * Why the ranking could not be produced, in the caller's words.
 *
 * Rendered as an informational notice rather than a red ErrorState or a dashed
 * EmptyState, matching DataTierUnavailableNotice/NativeOnlyNotice: nothing has
 * failed and nothing is missing -- the route is declining to rank data it
 * cannot prove. An EmptyState here would read as "this subnet has no holders",
 * which is the one thing a decline specifically does not claim.
 */
const DECLINE_COPY: Record<string, { title: string; body: string }> = {
  pool_totals_unproven: {
    title: "Holder ranking not available yet",
    body: "Ranking holders needs the per-hotkey alpha pool totals, and the ledger that carries them has not completed a full pass yet. A partial ledger would under-price holders rather than visibly omit them, so this ranking is withheld instead of shown wrong. It appears on its own once a pass lands.",
  },
  root_not_in_alpha_map: {
    title: "Root has no alpha holders",
    body: "Root stake is not denominated in alpha and does not appear in the chain's Alpha map, so there is no holder set to rank here. This is a property of root, not a gap in the data.",
  },
  unavailable: {
    title: "Holder ranking could not be read",
    body: "The ledger behind this ranking could not be reached for this request. It is unrelated to the rest of this page.",
  },
};

function DeclineNotice({ reason }: { reason: string }) {
  const copy = DECLINE_COPY[reason] ?? {
    title: "Holder ranking not available",
    body: "This ranking is being withheld rather than shown from data that cannot be verified.",
  };
  return (
    <div role="status" className="rounded border border-border bg-surface p-4">
      <div className="flex items-start gap-3">
        <Database className="size-4 shrink-0 text-ink-muted" />
        <div className="min-w-0 flex-1">
          <div className="mb-1 font-display text-13 font-medium text-ink-strong">{copy.title}</div>
          <p className="text-13 leading-relaxed text-ink-muted">{copy.body}</p>
        </div>
      </div>
    </div>
  );
}

/**
 * Who owns a subnet's alpha (#9557, frontend companion #9597).
 *
 * The reverse index of an account's own positions: this asks a subnet who
 * holds it, where /accounts/{ss58}/positions asks a wallet what it holds. It is
 * NOT the same question as the concentration panel beside it -- that one reads
 * registered UIDs' stake and emits scalars (Gini/HHI/Nakamoto), so it cannot
 * see alpha parked on hotkeys that hold no UID on this subnet. On netuid 74
 * that is 82 of the 92 hotkeys carrying positions.
 *
 * THREE OUTCOMES, AND THEY ARE NOT INTERCHANGEABLE. A decline (a `degraded`
 * block) renders an informational notice; a genuine empty holder set renders an
 * EmptyState; a fetch failure renders an ErrorState. The decline branch is
 * checked FIRST precisely because both it and the measurement arrive as
 * `holders: []` -- ordering them the other way would report "no holders" for a
 * subnet nobody has ranked yet.
 */
export function SubnetHoldersLeaderboard({ netuid }: { netuid: number }) {
  const { data: res, isLoading, isError, error, refetch } = useQuery(subnetHoldersQuery(netuid));
  const data = res?.data;

  if (isError) {
    return <ErrorState error={error} onRetry={() => refetch()} context="subnet holders" />;
  }

  if (isLoading) {
    return <Skeleton className="h-40 w-full" />;
  }

  // BEFORE the empty check: a decline also carries an empty `holders`.
  if (data?.degraded?.reason) {
    return <DeclineNotice reason={data.degraded.reason} />;
  }

  const holders = data?.holders ?? [];

  if (holders.length === 0) {
    return (
      <EmptyState
        title="No alpha holders"
        description="No account currently holds alpha on this subnet through a stake position. This is a measurement, not a missing ranking."
      />
    );
  }

  const ranked: RankedHolder[] = holders.map((entry, i) => ({ ...entry, rank: i + 1 }));
  const conc = data?.concentration;
  const shown =
    data?.holder_count != null ? Math.min(holders.length, data.holder_count) : holders.length;

  return (
    <div className="space-y-3">
      {/* LABELLED TILES, NOT A RUN-ON STRIP.

          This was a dot-separated line -- `520 holders · 152.3k α held · top 5
          shown` -- with the three concentration ranks tacked underneath as
          `TOP 5 31.4% 10 44.1% 20 58.7%`. Every number was correct and none of
          them was legible: three different KINDS of fact (a population, a
          magnitude, a pagination note) ran together in one sentence, and the
          rank row read as unpaired digits because the label sat outside the
          pairs it was labelling.

          Each figure now carries its own label, and only the three that answer
          a question a reader actually has get tile weight. The other two --
          how many rows are on screen, and how fresh the pool pass is -- are
          about the LIST rather than about the subnet, so they moved to a
          caption under it. */}
      <FactStrip variant="grid">
        <FactCell
          label="Holders"
          value={data?.holder_count == null ? "—" : formatNumber(data.holder_count)}
          hint="Distinct coldkeys holding alpha on this subnet through a stake position, across the whole subnet rather than the rows shown below."
        />
        <FactCell
          label="Alpha held"
          value={data?.total_alpha == null ? "—" : fmtAlpha(data.total_alpha)}
          hint="The alpha these positions account for on this subnet. It is the denominator every share below is taken over, not the subnet's SubnetAlphaOut."
        />
        <FactCell
          label="Top 10 share"
          value={pctStr(conc?.top10_share ?? null)}
          hint={
            conc?.top5_share == null && conc?.top20_share == null
              ? undefined
              : [
                  conc?.top5_share == null ? null : `top 5 ${pctStr(conc.top5_share)}`,
                  conc?.top20_share == null ? null : `top 20 ${pctStr(conc.top20_share)}`,
                ]
                  .filter(Boolean)
                  .join(" · ")
          }
          className="col-span-2 md:col-span-1"
        />
      </FactStrip>
      <DataTable
        rows={ranked}
        columns={COLUMNS}
        rowKey={(entry) => entry.coldkey}
        caption="Alpha holders"
        link={RouterLink}
        storageKey="subnet-holders"
      />
      {/* About the LIST, not about the subnet -- which is why it sits with the
          list rather than in the tiles above. */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-13 text-ink-muted">
        <span>
          {data?.holder_count != null && shown < data.holder_count
            ? `Showing the top ${formatNumber(shown)} of ${formatNumber(data.holder_count)}`
            : `Showing all ${formatNumber(shown)}`}
        </span>
        {data?.captured_at ? (
          <span className="inline-flex items-center gap-1.5">Pool totals</span>
        ) : null}
      </div>
    </div>
  );
}
