import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { CopyButton } from "@jsonbored/ui-kit";
import { useInView } from "@/hooks/use-in-view";
import { shortHash } from "@/lib/metagraphed/blocks";
import { formatNumber, classNames } from "@/lib/metagraphed/format";
import { taoCompact, SponsoredBadge } from "@/components/metagraphed/neuron-format";
import { ValidatorIdentityChip } from "@/components/metagraphed/validator-identity-chip";
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
export interface ValidatorColumn {
  header: string;
  thClassName: string;
  tdClassName: string;
  cell: (v: GlobalValidator) => ReactNode;
  /** #8251: sorting is client-side over the full fetched set now, so any
   *  numeric row field is a valid key — this names the `GlobalValidator`
   *  field the column ranks by. Columns without one (identity, derived-on-
   *  scroll cells) render a plain, non-interactive header. */
  sortKey?: string;
}

const numeric = (
  header: string,
): Pick<ValidatorColumn, "header" | "thClassName" | "tdClassName"> => ({
  header,
  thClassName: `${TH_BASE} text-right`,
  tdClassName: `${TD_NUM} text-ink`,
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
    header: "Operator",
    thClassName: TH_BASE,
    tdClassName: TD_BASE,
    cell: (v) => (
      <div className="flex items-center gap-1.5 min-w-0">
        {v.featured ? <SponsoredBadge /> : null}
        <Link
          to="/validators/$hotkey"
          params={{ hotkey: v.hotkey }}
          className="flex min-w-0 items-center gap-2 hover:underline"
          title={v.hotkey}
        >
          <ValidatorIdentityChip hotkey={v.hotkey} identity={v.coldkey_identity} size={20} />
          <span className="shrink-0 font-mono mg-type-data-sm text-ink-muted">
            {shortHash(v.hotkey)}
          </span>
        </Link>
        <CopyButton value={v.hotkey} label="hotkey" compact />
      </div>
    ),
  },
  {
    ...numeric("Take"),
    sortKey: "take",
    tdClassName: `${TD_NUM} text-ink-muted`,
    cell: (v) => formatTakePct(v.take),
  },
  {
    ...numeric("Est. APY"),
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
    ...numeric("Active subnets"),
    sortKey: "subnet_count",
    cell: (v) => formatNumber(v.subnet_count),
  },
  {
    ...numeric("Nominators"),
    sortKey: "nominator_count",
    tdClassName: `${TD_NUM} text-ink-muted`,
    cell: (v) => (v.nominator_count != null ? formatNumber(v.nominator_count) : "—"),
  },
  {
    ...numeric("Dominance"),
    sortKey: "stake_dominance",
    cell: (v) => (v.stake_dominance != null ? `${(v.stake_dominance * 100).toFixed(2)}%` : "—"),
  },
  {
    ...numeric("Total stake"),
    sortKey: "total_stake_tao",
    cell: (v) => taoCompact(v.total_stake_tao),
  },
  {
    ...numeric("30d Δ"),
    tdClassName: `${TD_NUM}`,
    cell: (v) => <Stake30dDeltaCell hotkey={v.hotkey} />,
  },
];
