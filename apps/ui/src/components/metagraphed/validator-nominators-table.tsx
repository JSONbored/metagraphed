import { useSuspenseQuery } from "@tanstack/react-query";
import { EmptyState } from "@/components/metagraphed/states";
import { ListShell, CopyableCode, TimeAgo, PagerBar } from "@jsonbored/ui-kit";
import {
  PageSizeSelect,
  ResetFiltersButton,
  SearchInput,
  SelectFilter,
} from "@/components/metagraphed/table-controls";
import { taoCompact } from "@/components/metagraphed/neuron-format";
import { formatNumber } from "@/lib/metagraphed/format";
import type { validatorNominatorsQuery } from "@/lib/metagraphed/queries";
import type { ValidatorNominatorEntry } from "@/lib/metagraphed/types";

const WINDOWS = ["7d", "30d", "90d"] as const;
const SORTS = [
  { value: "net_staked", label: "Net staked" },
  { value: "gross_staked", label: "Gross staked" },
  { value: "last_activity", label: "Last activity" },
] as const;

export interface ValidatorNominatorsSearch {
  window: "7d" | "30d" | "90d";
  sort: "net_staked" | "gross_staked" | "last_activity";
  limit: number;
  offset: number;
  coldkey: string;
}

interface Props {
  queryOptions: ReturnType<typeof validatorNominatorsQuery>;
  search: ValidatorNominatorsSearch;
  setSearch: (patch: Partial<ValidatorNominatorsSearch>) => void;
}

/** Nominator list + search for a validator (#4336/7.2) — derived from
 * stake-delegation account_events, no new capture. Embedded within
 * /validators/$hotkey, mirroring how /sudo embeds CallModuleExtrinsicsTable. */
export function ValidatorNominatorsTable({ queryOptions, search, setSearch }: Props) {
  const rows = useSuspenseQuery(queryOptions).data.data ?? [];

  const hasPrev = search.offset > 0;
  const hasNext = rows.length === search.limit;

  const goPrev = () => setSearch({ offset: Math.max(0, search.offset - search.limit) });
  const goNext = () => setSearch({ offset: search.offset + search.limit });

  const filtersActive = Boolean(search.coldkey);

  const filters = (
    <>
      <SearchInput
        value={search.coldkey}
        onChange={(v) => setSearch({ coldkey: v, offset: 0 })}
        placeholder="Coldkey ss58…"
      />
      <SelectFilter
        label="Window"
        value={search.window}
        onChange={(v) => setSearch({ window: v as ValidatorNominatorsSearch["window"], offset: 0 })}
        options={WINDOWS.map((w) => ({ value: w, label: w }))}
      />
      <SelectFilter
        label="Sort"
        value={search.sort}
        onChange={(v) => setSearch({ sort: v as ValidatorNominatorsSearch["sort"], offset: 0 })}
        options={[...SORTS]}
      />
      <PageSizeSelect
        value={search.limit}
        onChange={(n) => setSearch({ limit: n, offset: 0 })}
        options={[10, 20, 50, 100]}
      />
      <ResetFiltersButton
        active={filtersActive}
        onReset={() => setSearch({ coldkey: "", offset: 0 })}
      />
    </>
  );

  const emptyNode = (
    <EmptyState
      title="No nominators in this window"
      description="Nominators are derived from stake-delegation events — widen the window or check back once new delegations land."
    />
  );

  const footerNode = (
    <div className="flex items-center justify-between gap-3 border-t border-border bg-surface/30 px-4 py-2 text-[11px] font-mono text-ink-muted">
      <span>
        {rows.length
          ? `${formatNumber(search.offset + 1)}–${formatNumber(search.offset + rows.length)}`
          : "0"}
      </span>
      <PagerBar
        hasPrev={hasPrev}
        hasNext={hasNext}
        onPrev={goPrev}
        onNext={goNext}
        prevLabel="Prev"
        nextLabel="Next"
      />
    </div>
  );

  return (
    <ListShell
      filters={filters}
      isEmpty={rows.length === 0}
      empty={emptyNode}
      cards={rows.map((n) => (
        <NominatorCard key={n.coldkey} n={n} />
      ))}
      table={
        <table className="w-full text-left text-sm">
          <thead className="sticky top-0 z-10 bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80 shadow-[0_1px_0_0_var(--border)]">
            <tr>
              <th className="px-4 py-2.5">Coldkey</th>
              <th className="px-4 py-2.5 text-right">Net staked</th>
              <th className="px-4 py-2.5 text-right">Gross staked</th>
              <th className="px-4 py-2.5 text-right">Unstaked</th>
              <th className="px-4 py-2.5 text-right">Events</th>
              <th className="px-4 py-2.5 text-right">Last activity</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((n) => (
              <tr key={n.coldkey} className="mg-row-accent hover:bg-surface/40">
                <td className="px-4 py-2.5 font-mono text-[11px]">
                  <CopyableCode value={n.coldkey} className="max-w-full" />
                </td>
                <td className="px-4 py-2.5 text-right font-mono text-[12px] tabular-nums text-ink-strong">
                  {taoCompact(n.net_staked_tao)}
                </td>
                <td className="px-4 py-2.5 text-right font-mono text-[12px] tabular-nums text-ink">
                  {taoCompact(n.gross_staked_tao)}
                </td>
                <td className="px-4 py-2.5 text-right font-mono text-[12px] tabular-nums text-ink-muted">
                  {taoCompact(n.unstaked_tao)}
                </td>
                <td className="px-4 py-2.5 text-right font-mono text-[11px] text-ink-muted">
                  {formatNumber(n.event_count)}
                </td>
                <td className="px-4 py-2.5 text-right font-mono text-[11px] text-ink-muted">
                  <TimeAgo at={n.last_observed_at} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      }
      footer={footerNode}
    />
  );
}

function NominatorCard({ n }: { n: ValidatorNominatorEntry }) {
  return (
    <div className="block rounded border border-border bg-card p-3 min-h-11">
      <div className="flex items-center justify-between gap-2">
        <CopyableCode value={n.coldkey} className="max-w-[70%]" />
        <span className="font-mono text-[11px] text-ink-muted shrink-0">
          <TimeAgo at={n.last_observed_at} />
        </span>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 text-[11px] font-mono text-ink-muted">
        <span>net {taoCompact(n.net_staked_tao)}</span>
        <span>gross {taoCompact(n.gross_staked_tao)}</span>
        <span>{formatNumber(n.event_count)} events</span>
      </div>
    </div>
  );
}
