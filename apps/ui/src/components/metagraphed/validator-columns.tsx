import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useInView } from "@/hooks/use-in-view";
import { formatNumber, classNames } from "@/lib/metagraphed/format";
import { taoCompact, SponsoredBadge } from "@/components/metagraphed/neuron-format";
import { ValidatorIdentityChip } from "@/components/metagraphed/validator-identity-chip";
import { ShareCell } from "@jsonbored/ui-kit";
import { AddressDisplay } from "@/components/metagraphed/address-display";
import { validatorHistoryQuery } from "@/lib/metagraphed/queries";
import {
  formatApyPct,
  formatTakePct,
  isImplausibleApyPct,
  IMPLAUSIBLE_APY_NOTE,
} from "@/lib/metagraphed/validator-apy";
import type { GlobalValidator } from "@/lib/metagraphed/types";

// Padding, size and colour now come from `.mg-data-table` so every table on
// the site shares one density instead of each column file restating it. What
// stays here is what is genuinely per-column: alignment and numeral style.
const TH_BASE = "";
const TD_BASE = "";
// LEFT, like the reference. Every column there starts at the same edge —
// mixing right-aligned measures with left-aligned identity is what made our
// rows read as several tables side by side. Tabular figures still line up.
const TD_NUM = "tabular-nums";

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
  /**
   * What this column means, shown as a `?` on its header.
   *
   * These are the definitions that used to sit in a ten-entry glossary beneath
   * the table — a wall of prose a reader had to leave the row to consult. On
   * the header they are one hover from the number they explain.
   */
  help?: string;

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
  thClassName: TH_BASE,
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
// dropped Hotkey/Coldkey columns used to) · Total stake · Take · Est. APY ·
// Subnets · Nominators · 30d Δ. UIDs and Total emission left the directory
// (near-duplicates of Subnets / Total stake for ranking purposes); coldkey
// and the full per-subnet story live on the detail page.
//
// The widths are WEIGHTS, not pixels: TableColGroup divides each by their sum
// and emits percentages, so changing one re-proportions the table rather than
// resizing it. What was actually clipping `30d Δ` at 1280 was a
// `min-w-[1100px]` on the table itself, sized for the nine-column set and
// never revisited — fixed at the call site, not here.
//
// They are still worth right-sizing, because the proportions were set by the
// length of the HEADER rather than the data beneath it: "Active subnets"
// claimed 139 parts to show a number under 128, taking room from the operator
// name, which is the only column here that can actually run out of it.
export const VALIDATOR_COLUMNS: ValidatorColumn[] = [
  {
    id: "operator",
    label: "Operator",
    required: true,
    defaultVisible: true,
    header: "Operator",
    width: 156,
    thClassName: TH_BASE,
    tdClassName: TD_BASE,
    cell: (v, ctx) => {
      const group = ctx?.group;
      // A continuation row of a multi-key operator: same operator as the row
      // above, so the name is not repeated — the icon + hotkey identify the
      // key, and the indent reads as "still the same operator".
      const continuation = group != null && group.size > 1 && group.index > 0;
      // WHO, and nothing else. This cell used to hold seven things — a
      // sponsor badge, an avatar, the name, a bordered ×N pill, the truncated
      // hotkey and its copy button, plus an indent — which is most of why the
      // table read as chaotic while every other column held one value. The
      // hotkey is a column of its own now, the way the reference splits
      // HOTKEY from NODE ID, and the key count is plain muted text rather than
      // a pill.
      return (
        <div className={classNames("flex items-center gap-2 min-w-0", continuation && "pl-6")}>
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
              className="shrink-0 mg-type-data-sm tabular-nums text-ink-subtle"
              title={`This operator runs ${group.size} validator keys — grouped under its best-ranked one`}
            >
              ×{group.size}
            </span>
          ) : null}
        </div>
      );
    },
  },
  {
    // Its own column, the way the reference gives NODE ID one. AddressDisplay
    // stays OUTSIDE any row link: its copy button does not stop propagation,
    // so nesting it in a navigating link made a copy click navigate away.
    id: "hotkey",
    label: "Hotkey",
    defaultVisible: true,
    header: "Hotkey",
    width: 196,
    thClassName: TH_BASE,
    // nowrap: an ss58 is already middle-elided, so letting it wrap produced a
    // two-line cell and a ragged 65px row among 47px ones.
    tdClassName: `${TD_BASE} whitespace-nowrap`,
    cell: (v) => (
      <AddressDisplay
        ss58={v.hotkey}
        fallback={<>{v.hotkey}</>}
        compact
        linkToAccount={false}
        valueClassName="font-mono text-ink-muted"
      />
    ),
  },
  {
    // The sorted measure sits BESIDE the name. The table sorts by total stake
    // by default, and it used to be the sixth column — so the ranking key was
    // four columns away from the thing being ranked, and the eye had to cross
    // take, APY, subnets and nominators to read the order it was already in.
    ...numeric("totalStake", "Total stake", 132),
    help: "The TAO backing the validator: its own stake plus TAO delegated by nominators. Stake sets how much weight the validator’s votes carry.",
    sortKey: "total_stake_tao",
    cell: (v) => taoCompact(v.total_stake_tao),
  },
  {
    // Back on by default, as a rail rather than a number. It was retired when
    // it was a second reading of total stake in digits; drawn as a fixed-width
    // share bar it answers a different question — how much of the network is
    // this one operator — at a glance, down the column, which no column of
    // percentages does.
    // LEFT aligned, unlike the other measures. The cell is a rail followed by
    // its percentage, so right-aligning it pushed the number hard against the
    // next column's own right-aligned figure — two unrelated percentages
    // touching. The rail starts at the column's left edge, the way the
    // reference draws it, and the gap falls where it belongs.
    ...numeric("dominance", "Share", 148),
    help: "The validator’s share of total network stake. Higher share means more influence over consensus and emission — and more of that influence concentrated in one operator.",
    sortKey: "stake_dominance",
    tdClassName: TD_BASE,
    thClassName: TH_BASE,
    cell: (v) => <ShareCell share={v.stake_dominance} />,
  },
  {
    ...numeric("take", "Take", 78),
    help: "The validator’s commission: the fraction of delegator rewards it keeps. Lower take means nominators keep more of the emission flow.",
    sortKey: "take",
    tdClassName: `${TD_NUM} text-ink-muted`,
    cell: (v) => formatTakePct(v.take),
  },
  {
    ...numeric("apy", "Est. APY", 108),
    help: "Annualised delegator yield estimated from emission ÷ stake, net of take — the latest captured rate scaled to a year, not a forecast. Root stake is TAO-denominated; alpha stake is price-exposed, so a positive nominal APY can still net-lose TAO if alpha falls faster than the yield accrues.",
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
    ...numeric("subnets", "Subnets", 88),
    sortKey: "subnet_count",
    cell: (v) => formatNumber(v.subnet_count),
  },
  {
    // Opt-in. Ten columns do not fit a 1,088px measure without clipping their
    // own labels, and this is the one the payload itself describes as coming
    // from "a lower-frequency chain scan than the other columns, so it can lag
    // them" — a lagging count is the fairest thing to move one click away.
    ...numeric("nominators", "Nominators", 116, false),
    sortKey: "nominator_count",
    tdClassName: `${TD_NUM} text-ink-muted`,
    cell: (v) => (v.nominator_count != null ? formatNumber(v.nominator_count) : "—"),
  },
  {
    ...numeric("delta30d", "30d Δ", 92),
    help: "Change in total stake over the last 30 days, from the validator’s own stake history.",
    tdClassName: `${TD_NUM}`,
    cell: (v) => <Stake30dDeltaCell hotkey={v.hotkey} />,
  },
  {
    ...numeric("emission", "Emission", 110, false),
    help: "The TAO the validator earned over the window. Emission is split between the validator and its nominators via commission — it reflects reward flow, not profit.",
    sortKey: "total_emission_tao",
    cell: (v) => (v.total_emission_tao != null ? taoCompact(v.total_emission_tao) : "—"),
  },
  {
    ...numeric("trust", "Avg trust", 100, false),
    help: "How consistently a subnet’s consensus scores the validator as trustworthy. Steadier trust points to reliable participation.",
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
