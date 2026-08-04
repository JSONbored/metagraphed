import { Link } from "@tanstack/react-router";
import { ListShell } from "@jsonbored/ui-kit";
import { Chip, EmptyState, Panel } from "@/components/metagraphed/primitives";
import {
  PageSizeSelect,
  ResetFiltersButton,
  SearchInput,
  SelectFilter,
} from "@/components/metagraphed/table-controls";
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
import { classNames, formatNumber } from "@/lib/metagraphed/format";
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

const SORT_OPTIONS: { value: EmissionSortKey; label: string }[] = [
  { value: "final_share", label: "Final share" },
  { value: "emission_share", label: "Price share" },
  { value: "gate_delta", label: "Share moved" },
  { value: "tao_total", label: "TAO per block" },
  { value: "liquidity_fraction", label: "Pool fraction" },
  { value: "netuid", label: "Netuid" },
];

const share = (value: number | null, digits = 3) =>
  value == null ? "—" : `${(value * 100).toFixed(digits)}%`;

const signedShare = (value: number | null) =>
  value == null ? "—" : `${value >= 0 ? "+" : ""}${(value * 100).toFixed(3)}%`;

const tao = (value: number | null) => (value == null ? "—" : value.toFixed(6));

/**
 * The per-subnet pipeline decomposition (#8745).
 *
 * Column order follows the pipeline itself — price share → miner-burn weight →
 * post-gate share → final share, then the TAO split — so a row reads left to
 * right as the sequence of decisions that produced it. That ordering is the
 * whole point of the table: the interesting fact about a subnet is usually
 * WHERE in the pipeline its share moved, not the endpoint alone.
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
  const filtered = filterEmissionSubnets(subnets, search.state, search.netuid);
  const sorted = sortEmissionSubnets(filtered, search.sort, search.dir);
  const rows = sorted.slice(0, search.limit);
  const filtersActive = search.state !== "all" || search.netuid !== "";

  // Every select here is always-selected, hence allowEmpty={false}: the blank
  // option SelectFilter adds by default would set an out-of-enum value that
  // the route's zod schema silently falls back from, so the control would
  // appear to do something and then do nothing.
  const filters = (
    <>
      <SearchInput
        value={search.netuid}
        onChange={(v) => setSearch({ netuid: v })}
        placeholder="Netuid…"
      />
      <SelectFilter
        label="State"
        allowEmpty={false}
        value={search.state}
        onChange={(v) => setSearch({ state: v as EmissionStateFilter })}
        options={STATE_OPTIONS}
      />
      <SelectFilter
        label="Sort"
        allowEmpty={false}
        value={search.sort}
        onChange={(v) => setSearch({ sort: v as EmissionSortKey })}
        options={SORT_OPTIONS}
      />
      <SelectFilter
        label="Order"
        allowEmpty={false}
        value={search.dir}
        onChange={(v) => setSearch({ dir: v as "asc" | "desc" })}
        options={[
          { value: "desc", label: "Highest first" },
          { value: "asc", label: "Lowest first" },
        ]}
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
  );

  return (
    <ListShell
      filters={filters}
      isEmpty={rows.length === 0}
      empty={
        <EmptyState
          title="No subnets match"
          hint="Clear the netuid filter or switch back to all subnets."
        />
      }
      cards={rows.map((s) => (
        <EmissionCard key={s.netuid} subnet={s} />
      ))}
      table={
        <table className="w-full text-left text-sm">
          <thead className="mg-table-head-pinned">
            <tr>
              <th className="px-4 py-2.5">Subnet</th>
              <th className="px-4 py-2.5 text-right" title="Stage 1: the published price share">
                Price share
              </th>
              <th
                className="px-4 py-2.5 text-right"
                title="Share of the subnet's emission burned by miners"
              >
                Miner burn
              </th>
              <th className="px-4 py-2.5 text-right" title="Price share reweighted by miner burn">
                Weighted
              </th>
              <th className="px-4 py-2.5 text-right" title="After the Hill gate">
                Post-gate
              </th>
              <th
                className="px-4 py-2.5 text-right"
                title="Share of block emission actually received"
              >
                Final share
              </th>
              <th
                className="px-4 py-2.5 text-right"
                title="Final share minus price share — what the pipeline gave or took"
              >
                Moved
              </th>
              <th className="px-4 py-2.5 text-right" title="TAO per block, both channels">
                TAO/block
              </th>
              <th
                className="px-4 py-2.5 text-right"
                title="Share of this subnet's TAO arriving as pool liquidity rather than chain buys"
              >
                Pool
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((s) => (
              <EmissionRow key={s.netuid} subnet={s} />
            ))}
          </tbody>
        </table>
      }
      footer={
        <div className="flex items-center justify-between gap-3 border-t border-border bg-surface/30 px-4 py-2 mg-type-data text-ink-muted">
          <span>
            Showing {formatNumber(rows.length)} of {formatNumber(filtered.length)}
            {filtered.length === subnets.length ? "" : ` (${formatNumber(subnets.length)} total)`}
          </span>
          <span>Point sample — not a window average</span>
        </div>
      }
    />
  );
}

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

function EmissionRow({ subnet }: { subnet: EmissionPipelineSubnet }) {
  const state = emissionRowState(subnet);
  return (
    <tr
      className={classNames(
        "mg-row-accent hover:bg-surface/40",
        // A row outside the pipeline is context, not a competitor — dimmed so
        // the ranked set reads as the ranked set, without hiding it.
        state === "ineligible" && "opacity-70",
      )}
    >
      <td className="px-4 py-2.5">
        <div className="flex items-center gap-2">
          <Link
            to="/subnets/$netuid"
            params={{ netuid: subnet.netuid }}
            className="font-mono mg-type-data text-ink-strong hover:text-accent mg-focus-ring"
          >
            SN{subnet.netuid}
          </Link>
          <StateChip subnet={subnet} />
        </div>
      </td>
      <td className="px-4 py-2.5 text-right font-mono mg-type-caption tabular-nums text-ink">
        {share(subnet.emission_share)}
      </td>
      <td className="px-4 py-2.5 text-right font-mono mg-type-caption tabular-nums text-ink-muted">
        {share(subnet.miner_burned, 1)}
      </td>
      <td className="px-4 py-2.5 text-right font-mono mg-type-caption tabular-nums text-ink-muted">
        {share(subnet.weighted_share)}
      </td>
      <td className="px-4 py-2.5 text-right font-mono mg-type-caption tabular-nums text-ink-muted">
        {share(subnet.gated_share)}
      </td>
      <td className="px-4 py-2.5 text-right font-mono mg-type-caption tabular-nums text-ink-strong">
        {share(subnet.final_share)}
      </td>
      <td
        className={classNames(
          "px-4 py-2.5 text-right font-mono mg-type-caption tabular-nums",
          movedToneClass(subnet),
        )}
      >
        {signedShare(subnet.gate_delta)}
      </td>
      <td className="px-4 py-2.5 text-right font-mono mg-type-caption tabular-nums text-ink">
        {tao(subnet.tao_total)}
      </td>
      <td className="px-4 py-2.5 text-right font-mono mg-type-caption tabular-nums text-ink-muted">
        {taoChannelMix(subnet) === "chain-buys-only"
          ? "0% (chain buys)"
          : share(subnet.liquidity_fraction, 1)}
      </td>
    </tr>
  );
}

function EmissionCard({ subnet }: { subnet: EmissionPipelineSubnet }) {
  return (
    <Panel as="div" dense className="block min-h-11">
      <div className="flex items-center justify-between gap-2">
        <Link
          to="/subnets/$netuid"
          params={{ netuid: subnet.netuid }}
          className="font-mono mg-type-data text-ink-strong mg-focus-ring"
        >
          SN{subnet.netuid}
        </Link>
        <div className="flex items-center gap-2">
          <StateChip subnet={subnet} />
          <span className="font-mono mg-type-caption tabular-nums text-ink-strong">
            {share(subnet.final_share)}
          </span>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 mg-type-data text-ink-muted">
        <span>price {share(subnet.emission_share)}</span>
        <span className={movedToneClass(subnet)}>moved {signedShare(subnet.gate_delta)}</span>
        <span>{tao(subnet.tao_total)} τ/block</span>
        <span>
          {taoChannelMix(subnet) === "chain-buys-only"
            ? "all chain buys"
            : `${share(subnet.liquidity_fraction, 1)} pool`}
        </span>
      </div>
    </Panel>
  );
}
