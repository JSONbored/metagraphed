import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { shortHash } from "@/lib/metagraphed/blocks";
import { formatNumber } from "@/lib/metagraphed/format";
import { taoCompact, FeaturedBadge } from "@/components/metagraphed/neuron-table";
import { ValidatorIdentityChip } from "@/components/metagraphed/validator-identity-chip";
import { formatApyPct, formatTakePct } from "@/lib/metagraphed/validator-apy";
import type { GlobalValidator, GlobalValidatorSort } from "@/lib/metagraphed/types";

const TH_BASE = "font-mono text-[10px] uppercase tracking-widest text-ink-muted";
const TD_BASE = "font-mono";
const TD_NUM = `${TD_BASE} text-right tabular-nums`;

/** Row/header padding for the density toggle (#5344). */
export function validatorTablePad(density: "comfortable" | "compact"): string {
  return density === "compact" ? "px-2 py-1.5" : "px-3 py-2";
}

/** Mono cell size for the density toggle (#5344). */
export function validatorTableMono(density: "comfortable" | "compact"): string {
  return density === "compact" ? "text-[10px]" : "text-[11px]";
}

/**
 * One column of the global-validators table. Both the `<thead>` and every
 * `<tbody>` row map over the SAME array, so the header count and per-row cell
 * count are equal by construction — the header/cell misalignment that #5307
 * fixed (12 headers over 9 cells, columns showing another column's data) is
 * structurally impossible here. `header` values are unique (asserted in tests).
 *
 * Optional `sortField` marks columns that get a clickable `SortHeader` (#5344).
 * Padding / mono size are applied at render via `validatorTablePad` /
 * `validatorTableMono` so density can change without duplicating column defs.
 */
export interface ValidatorColumn {
  header: string;
  sortField?: GlobalValidatorSort;
  thClassName: string;
  tdClassName: string;
  cell: (v: GlobalValidator) => ReactNode;
}

const numeric = (
  header: string,
  sortField?: GlobalValidatorSort,
): Pick<ValidatorColumn, "header" | "sortField" | "thClassName" | "tdClassName"> => ({
  header,
  sortField,
  thClassName: `${TH_BASE} text-right`,
  tdClassName: `${TD_NUM} text-ink`,
});

export const VALIDATOR_COLUMNS: ValidatorColumn[] = [
  {
    header: "Operator",
    thClassName: TH_BASE,
    tdClassName: TD_BASE,
    cell: (v) => (
      <div className="flex items-center gap-1.5">
        {v.featured ? <FeaturedBadge /> : null}
        <ValidatorIdentityChip hotkey={v.hotkey} identity={v.coldkey_identity} size={20} />
      </div>
    ),
  },
  {
    header: "Hotkey",
    thClassName: TH_BASE,
    tdClassName: `${TD_BASE} text-ink-muted`,
    cell: (v) => (
      <Link
        to="/validators/$hotkey"
        params={{ hotkey: v.hotkey }}
        className="text-ink-strong hover:text-accent hover:underline"
        title={v.hotkey}
      >
        {shortHash(v.hotkey) ?? v.hotkey}
      </Link>
    ),
  },
  {
    header: "Coldkey",
    thClassName: TH_BASE,
    tdClassName: `${TD_BASE} text-ink-muted`,
    cell: (v) =>
      v.coldkey ? (
        <Link
          to="/accounts/$ss58"
          params={{ ss58: v.coldkey }}
          className="hover:text-accent hover:underline"
          title={v.coldkey}
        >
          {shortHash(v.coldkey) ?? v.coldkey}
        </Link>
      ) : (
        "—"
      ),
  },
  {
    ...numeric("Take"),
    tdClassName: `${TD_NUM} text-ink-muted`,
    cell: (v) => formatTakePct(v.take),
  },
  {
    ...numeric("Est. APY"),
    // apy_estimate (#2551) is a 0..1 fraction; formatApyPct takes a percentage.
    cell: (v) => formatApyPct(v.apy_estimate != null ? v.apy_estimate * 100 : null),
  },
  {
    ...numeric("Active subnets", "subnet_count"),
    cell: (v) => formatNumber(v.subnet_count),
  },
  {
    ...numeric("UIDs", "uid_count"),
    tdClassName: `${TD_NUM} text-ink-muted`,
    cell: (v) => formatNumber(v.uid_count),
  },
  {
    ...numeric("Nominators"),
    tdClassName: `${TD_NUM} text-ink-muted`,
    cell: (v) => (v.nominator_count != null ? formatNumber(v.nominator_count) : "—"),
  },
  {
    ...numeric("Dominance", "stake_dominance"),
    cell: (v) => (v.stake_dominance != null ? `${(v.stake_dominance * 100).toFixed(2)}%` : "—"),
  },
  { ...numeric("Total stake", "total_stake"), cell: (v) => taoCompact(v.total_stake_tao) },
  {
    ...numeric("Total emission", "total_emission"),
    tdClassName: `${TD_NUM} text-ink-muted`,
    cell: (v) => taoCompact(v.total_emission_tao),
  },
];
