import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { DataTable, type DataTableColumn } from "@jsonbored/ui-kit";
import { Chip, EmptyState } from "@/components/metagraphed/primitives";
import {
  PageSizeSelect,
  ResetFiltersButton,
  SelectFilter,
} from "@/components/metagraphed/table-controls";
import { RouterLink } from "@/components/metagraphed/router-link";
import {
  emissionRowState,
  filterEmissionSubnets,
  gateDirection,
  ineligibleReasonLabel,
  sortEmissionSubnets,
  taoChannelMix,
  type EmissionSortKey,
  type EmissionStateFilter,
} from "@/lib/metagraphed/emission-pipeline";
import { formatNumber } from "@/lib/metagraphed/format";
import type { EmissionPipelineSubnet } from "@/lib/metagraphed/types";

export interface EmissionTableSearch {
  state: EmissionStateFilter;
  sort: EmissionSortKey;
  dir: "asc" | "desc";
  limit: number;
  netuid: string;
}

const STATE_OPTIONS: { value: EmissionStateFilter; label: string }[] = [
  { value: "all", label: "All subnets" },
  { value: "eligible", label: "In the pipeline" },
  { value: "disabled", label: "Emission disabled" },
  { value: "ineligible", label: "Outside the pipeline" },
];

const share = (value: number | null, digits = 3) =>
  value == null ? "—" : `${(value * 100).toFixed(digits)}%`;

const signedShare = (value: number | null) =>
  value == null ? "—" : `${value >= 0 ? "+" : ""}${(value * 100).toFixed(3)}%`;

const tao = (value: number | null) => (value == null ? "—" : value.toFixed(6));

const shareFormat =
  (digits = 3) =>
  (value: unknown) =>
    share(typeof value === "number" ? value : null, digits);

/** The state chip. A disabled subnet and a gate-zeroed one both show zero TAO
 * and mean different things, so the state is its own column-adjacent signal
 * rather than something a reader has to infer from a row of zeros. */
function StateChip({ subnet }: { subnet: EmissionPipelineSubnet }) {
  const state = emissionRowState(subnet);
  if (state === "eligible") return null;
  if (state === "disabled") {
    return (
      <Chip tone="warn" title="SubnetEmissionEnabled is false — receiving nothing by configuration">
        disabled
      </Chip>
    );
  }
  return (
    <Chip tone="muted" title={ineligibleReasonLabel(subnet.ineligible_reason ?? "")}>
      outside pipeline
    </Chip>
  );
}

function movedToneClass(subnet: EmissionPipelineSubnet): string {
  const direction = gateDirection(subnet);
  if (direction === "gained") return "text-health-ok";
  if (direction === "lost") return "text-health-warn";
  return "text-ink-muted";
}

// Column order follows the pipeline itself — price share → miner-burn weight →
// post-gate share → final share, then the TAO split — so a row reads left to
// right as the sequence of decisions that produced it.
const COLUMNS: Array<DataTableColumn<EmissionPipelineSubnet>> = [
  {
    key: "netuid",
    label: "Subnet",
    sortable: true,
    value: (s) => s.netuid,
    render: (s) => (
      <span className="inline-flex items-center gap-2">
        <Link
          to="/subnets/$netuid"
          params={{ netuid: s.netuid }}
          className="font-mono text-11 text-ink-strong hover:text-accent mg-focus-ring"
        >
          SN{s.netuid}
        </Link>
        <StateChip subnet={s} />
      </span>
    ),
  },
  {
    key: "emission_share",
    label: "Price share",
    kind: "number",
    sortable: true,
    value: (s) => s.emission_share,
    format: shareFormat(),
  },
  {
    key: "miner_burned",
    label: "Miner burn",
    kind: "number",
    value: (s) => s.miner_burned,
    format: shareFormat(1),
  },
  {
    key: "weighted_share",
    label: "Weighted",
    kind: "number",
    value: (s) => s.weighted_share,
    format: shareFormat(),
  },
  {
    key: "gated_share",
    label: "Post-gate",
    kind: "number",
    value: (s) => s.gated_share,
    format: shareFormat(),
  },
  {
    key: "final_share",
    label: "Final share",
    kind: "number",
    sortable: true,
    value: (s) => s.final_share,
    format: shareFormat(),
  },
  {
    key: "gate_delta",
    label: "Moved",
    kind: "number",
    sortable: true,
    value: (s) => s.gate_delta,
    format: (v) => signedShare(typeof v === "number" ? v : null),
    render: (s) => <span className={movedToneClass(s)}>{signedShare(s.gate_delta ?? null)}</span>,
  },
  {
    key: "tao_total",
    label: "TAO/block",
    kind: "number",
    sortable: true,
    value: (s) => s.tao_total,
    format: (v) => tao(typeof v === "number" ? v : null),
  },
  {
    key: "liquidity_fraction",
    label: "Pool",
    kind: "number",
    sortable: true,
    value: (s) => s.liquidity_fraction,
    format: shareFormat(1),
    render: (s) =>
      taoChannelMix(s) === "chain-buys-only"
        ? "0% (chain buys)"
        : share(s.liquidity_fraction ?? null, 1),
  },
];

/**
 * The per-subnet pipeline decomposition (#8745).
 *
 * The sort/order selects are gone: the columns themselves carry the sort, and
 * the header click writes the same `sort`/`dir` search params the selects used
 * to, so a shared URL still restores the same view.
 */
export function EmissionPipelineTable({
  subnets,
  search,
  setSearch,
}: {
  subnets: EmissionPipelineSubnet[];
  search: EmissionTableSearch;
  setSearch: (patch: Partial<EmissionTableSearch>) => void;
}) {
  const filtered = useMemo(
    () => filterEmissionSubnets(subnets, search.state, search.netuid),
    [subnets, search.state, search.netuid],
  );
  const rows = useMemo(
    () => sortEmissionSubnets(filtered, search.sort, search.dir).slice(0, search.limit),
    [filtered, search.sort, search.dir, search.limit],
  );
  const filtersActive = search.state !== "all" || search.netuid !== "";

  return (
    <div className="space-y-2">
      <DataTable
        rows={rows}
        columns={COLUMNS}
        rowKey={(s) => String(s.netuid)}
        caption="Emission pipeline"
        total={filtered.length}
        link={RouterLink}
        storageKey="emission-pipeline"
        // The route's own `limit` bounds the list; a second pager over an
        // already-truncated slice would page a page.
        paginate={false}
        // Nine numeric stages per row: on a narrow viewport a labelled card is
        // the only shape that keeps the whole pipeline readable.
        mobile="cards"
        sort={{ key: search.sort, dir: search.dir }}
        onSort={(next) =>
          setSearch({
            sort: (next?.key ?? "final_share") as EmissionSortKey,
            dir: next?.dir ?? "desc",
          })
        }
        search={{
          value: search.netuid,
          onChange: (v) => setSearch({ netuid: v }),
          placeholder: "Netuid…",
        }}
        filters={
          <>
            {/* Always-selected, hence allowEmpty={false}: the blank option
                SelectFilter adds by default would set an out-of-enum value that
                the route's zod schema silently falls back from, so the control
                would appear to do something and then do nothing. */}
            <SelectFilter
              label="State"
              allowEmpty={false}
              value={search.state}
              onChange={(v) => setSearch({ state: v as EmissionStateFilter })}
              options={STATE_OPTIONS}
            />
            <PageSizeSelect
              value={search.limit}
              onChange={(n) => setSearch({ limit: n })}
              options={[25, 50, 100, 200]}
            />
            <ResetFiltersButton
              active={filtersActive}
              onReset={() => setSearch({ state: "all", netuid: "" })}
            />
          </>
        }
        empty={
          <EmptyState
            title="No subnets match"
            hint="Clear the netuid filter or switch back to all subnets."
          />
        }
      />
      <p className="text-11 text-ink-muted">
        Showing {formatNumber(rows.length)} of {formatNumber(filtered.length)}
        {filtered.length === subnets.length ? "" : ` (${formatNumber(subnets.length)} total)`} ·
        point sample — not a window average
      </p>
    </div>
  );
}
