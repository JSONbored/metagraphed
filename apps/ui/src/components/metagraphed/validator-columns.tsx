import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useInView } from "@/hooks/use-in-view";
import { formatNumber, classNames } from "@/lib/metagraphed/format";
import { taoCompact, SponsoredBadge } from "@/components/metagraphed/neuron-format";
import { ValidatorIdentityChip } from "@/components/metagraphed/validator-identity-chip";
import { AddressDisplay } from "@/components/metagraphed/address-display";
import { validatorHistoryQuery } from "@/lib/metagraphed/queries";
import {
  formatApyPct,
  formatTakePct,
  isImplausibleApyPct,
  IMPLAUSIBLE_APY_NOTE,
} from "@/lib/metagraphed/validator-apy";
import type { GlobalValidator } from "@/lib/metagraphed/types";

const TH_BASE = "px-3 py-2 mg-type-caption text-ink-muted";
const TD_BASE = "px-3 py-2 mg-type-data";
const TD_NUM = `${TD_BASE} text-right tabular-nums`;

/**
 * One column of the global-validators table. Both the `<thead>` and every
 * `<tbody>` row map over the SAME array, so the header count and per-row cell
 * count are equal by construction — the header/cell misalignment that #5307
 * fixed (12 headers over 9 cells, columns showing another column's data) is
 * structurally impossible here. `header` values are unique (asserted in tests).
 */
/**
 * Optional per-row render context. `group` is present when the page has
 * operator grouping on: `index` 0 is the group's anchor row (carries the
 * operator name and, when the group has several keys, the ×N chip); later
 * indexes are continuation rows rendered without repeating the name.
 */
export interface ValidatorCellContext {
  group?: { size: number; index: number };
}

export interface ValidatorColumn {
  /** Stable key for column visibility (ColumnDef-compatible). */
  id: string;
  /** ColumnDef uses `label`; kept in sync with `header` below. */
  label: string;
  /** Cannot be hidden -- the row's identity. */
  required?: boolean;
  /** Part of the default-visible core set. */
  defaultVisible?: boolean;
  header: string;
  thClassName: string;
  tdClassName: string;
  cell: (v: GlobalValidator, ctx?: ValidatorCellContext) => ReactNode;
  /** #8251: sorting is client-side over the full fetched set now, so any
   *  numeric row field is a valid key — this names the `GlobalValidator`
   *  field the column ranks by. Columns without one (identity, derived-on-
   *  scroll cells) render a plain, non-interactive header. */
  sortKey?: string;
  /** Relative width for the table's <colgroup>; see TableColGroup. Weights
   *  follow what auto-layout settled on at 1280px, so pinning them keeps the
   *  table looking as it does today rather than retuning it. */
  width: number;
}

const numeric = (
  id: string,
  header: string,
  width: number,
  defaultVisible = true,
): Pick<
  ValidatorColumn,
  "id" | "label" | "header" | "thClassName" | "tdClassName" | "width" | "defaultVisible"
> => ({
  id,
  label: header,
  header,
  thClassName: `${TH_BASE} text-right`,
  tdClassName: `${TD_NUM} text-ink`,
  width,
  defaultVisible,
});

// #8251: 30d stake trend, lazily fetched per row only once it scrolls into
// view — the identical in-view-gated pattern the /subnets table's
// FinancialTrendCell established, bounded by virtualization to the ~20 rows
// actually visible rather than one request per directory row.
function Stake30dDeltaCell({ hotkey }: { hotkey: string }) {
  const [ref, inView] = useInView<HTMLSpanElement>();
  const { data } = useQuery({
    ...validatorHistoryQuery(hotkey, "30d"),
    enabled: inView,
    staleTime: 60_000,
  });
  // /history points are NEWEST-FIRST (verified live: 2026-07-26 at index 0,
  // 2026-07-10 last) -- so [0] is the current value and the tail is the
  // window's start. delta = (newest - oldest) / oldest.
  const points = data?.data?.points ?? [];
  const stakes = points
    .map((p) => p.total_stake_tao)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const newest = stakes[0];
  const oldest = stakes.length ? stakes[stakes.length - 1] : undefined;
  const delta =
    newest != null && oldest != null && oldest !== 0 && stakes.length > 1
      ? (newest - oldest) / oldest
      : null;
  const tone =
    delta == null || Math.abs(delta) < 0.0005
      ? "text-ink-muted"
      : delta > 0
        ? "text-health-ok"
        : "text-health-down";
  return (
    <span ref={ref} className={classNames("tabular-nums", tone)} title="30d total-stake change">
      {delta == null ? "—" : `${delta > 0 ? "+" : ""}${(delta * 100).toFixed(1)}%`}
    </span>
  );
}

// #8251 column diet: Operator (now carrying the detail link + hotkey the
// dropped Hotkey/Coldkey columns used to) · Take · Est. APY · Active subnets
// · Nominators · Dominance · Total stake · 30d Δ. UIDs and Total emission
// left the directory (near-duplicates of Active subnets / Total stake for
// ranking purposes); coldkey and the full per-subnet story live on the
// detail page.
export const VALIDATOR_COLUMNS: ValidatorColumn[] = [
  {
    id: "operator",
    label: "Operator",
    required: true,
    defaultVisible: true,
    header: "Operator",
    width: 350,
    thClassName: TH_BASE,
    tdClassName: TD_BASE,
    cell: (v, ctx) => {
      const group = ctx?.group;
      // A continuation row of a multi-key operator: same operator as the row
      // above, so the name is not repeated — the icon + hotkey identify the
      // key, and the indent reads as "still the same operator".
      const continuation = group != null && group.size > 1 && group.index > 0;
      return (
        <div className={classNames("flex items-center gap-1.5 min-w-0", continuation && "pl-6")}>
          {v.featured ? <SponsoredBadge /> : null}
          <Link
            to="/validators/$hotkey"
            params={{ hotkey: v.hotkey }}
            className="flex min-w-0 items-center gap-2 hover:underline"
            title={v.hotkey}
          >
            <ValidatorIdentityChip
              hotkey={v.hotkey}
              identity={v.coldkey_identity}
              size={20}
              showName={!continuation}
            />
          </Link>
          {group != null && group.size > 1 && group.index === 0 ? (
            <span
              className="shrink-0 rounded-full border border-border bg-surface px-1.5 mg-type-caption tabular-nums text-ink-muted"
              title={`This operator runs ${group.size} validator keys — grouped under its best-ranked one`}
            >
              ×{group.size}
            </span>
          ) : null}
          {/* Own AddressDisplay outside the operator Link (not inside it) --
              AddressDisplay's CopyButton doesn't stop click propagation, so
              nesting it inside the /validators/$hotkey Link above would make a
              copy click also navigate away. */}
          <AddressDisplay
            ss58={v.hotkey}
            fallback={<>{v.hotkey}</>}
            compact
            linkToAccount={false}
            valueClassName="shrink-0 font-mono mg-type-data-sm text-ink-muted"
          />
        </div>
      );
    },
  },
  {
    ...numeric("take", "Take", 72),
    sortKey: "take",
    tdClassName: `${TD_NUM} text-ink-muted`,
    cell: (v) => formatTakePct(v.take),
  },
  {
    ...numeric("apy", "Est. APY", 89),
    sortKey: "apy_estimate",
    // apy_estimate (#2551) is a 0..1 fraction; formatApyPct takes a percentage.
    cell: (v) => {
      const pct = v.apy_estimate != null ? v.apy_estimate * 100 : null;
      // Tiny-stake estimates annualize into nonsense (#8242) — formatApyPct
      // buckets them as ">100%"; explain why on hover rather than in-cell.
      return (
        <span title={isImplausibleApyPct(pct) ? IMPLAUSIBLE_APY_NOTE : undefined}>
          {formatApyPct(pct)}
        </span>
      );
    },
  },
  {
    ...numeric("subnets", "Active subnets", 139),
    sortKey: "subnet_count",
    cell: (v) => formatNumber(v.subnet_count),
  },
  {
    ...numeric("nominators", "Nominators", 115),
    sortKey: "nominator_count",
    tdClassName: `${TD_NUM} text-ink-muted`,
    cell: (v) => (v.nominator_count != null ? formatNumber(v.nominator_count) : "—"),
  },
  {
    ...numeric("dominance", "Dominance", 113),
    sortKey: "stake_dominance",
    cell: (v) => (v.stake_dominance != null ? `${(v.stake_dominance * 100).toFixed(2)}%` : "—"),
  },
  {
    ...numeric("totalStake", "Total stake", 129),
    sortKey: "total_stake_tao",
    cell: (v) => taoCompact(v.total_stake_tao),
  },
  {
    ...numeric("delta30d", "30d Δ", 75),
    tdClassName: `${TD_NUM}`,
    cell: (v) => <Stake30dDeltaCell hotkey={v.hotkey} />,
  },
  {
    ...numeric("emission", "Emission", 110, false),
    sortKey: "total_emission_tao",
    cell: (v) => (v.total_emission_tao != null ? taoCompact(v.total_emission_tao) : "—"),
  },
  {
    ...numeric("trust", "Avg trust", 100, false),
    sortKey: "avg_validator_trust",
    cell: (v) =>
      v.avg_validator_trust != null ? `${(v.avg_validator_trust * 100).toFixed(1)}%` : "—",
  },
  {
    ...numeric("realized1w", "Realized 7d", 110, false),
    sortKey: "realized_return_1w",
    cell: (v) =>
      v.realized_return_1w != null ? `${(v.realized_return_1w * 100).toFixed(2)}%` : "—",
  },
  {
    ...numeric("rootStake", "Root stake", 115, false),
    sortKey: "root_stake_tao",
    cell: (v) => (v.root_stake_tao != null ? taoCompact(v.root_stake_tao) : "—"),
  },
  {
    ...numeric("alphaStake", "Alpha stake", 118, false),
    sortKey: "alpha_stake_tao",
    cell: (v) => (v.alpha_stake_tao != null ? taoCompact(v.alpha_stake_tao) : "—"),
  },
];
