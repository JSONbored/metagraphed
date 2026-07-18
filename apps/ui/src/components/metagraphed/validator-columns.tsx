import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { CopyButton } from "@jsonbored/ui-kit";
import { shortHash } from "@/lib/metagraphed/blocks";
import { formatNumber } from "@/lib/metagraphed/format";
import { taoCompact, SponsoredBadge } from "@/components/metagraphed/neuron-format";
import { AccountAddress } from "@/components/metagraphed/account-address";
import { ValidatorIdentityChip } from "@/components/metagraphed/validator-identity-chip";
import { formatApyPct, formatTakePct } from "@/lib/metagraphed/validator-apy";
import type { GlobalValidator } from "@/lib/metagraphed/types";

const TH_BASE = "px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-ink-muted";
const TD_BASE = "px-3 py-2 font-mono text-[11px]";
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
}

const numeric = (
  header: string,
): Pick<ValidatorColumn, "header" | "thClassName" | "tdClassName"> => ({
  header,
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
        {v.featured ? <SponsoredBadge /> : null}
        <ValidatorIdentityChip hotkey={v.hotkey} identity={v.coldkey_identity} size={20} />
      </div>
    ),
  },
  {
    header: "Hotkey",
    thClassName: TH_BASE,
    tdClassName: `${TD_BASE} text-ink-muted`,
    cell: (v) => (
      <div className="flex items-center gap-1.5">
        <Link
          to="/validators/$hotkey"
          params={{ hotkey: v.hotkey }}
          className="text-ink-strong hover:text-accent hover:underline"
          title={v.hotkey}
        >
          {shortHash(v.hotkey) ?? v.hotkey}
        </Link>
        <CopyButton value={v.hotkey} label="hotkey" compact />
      </div>
    ),
  },
  {
    header: "Coldkey",
    thClassName: TH_BASE,
    tdClassName: `${TD_BASE} text-ink-muted`,
    // Route the coldkey through AccountAddress so it gets the same
    // EntityHoverCard account-preview every other /accounts/$ss58 link has
    // (block author, signer, …) instead of a hand-rolled bare link (#6338).
    cell: (v) => <AccountAddress ss58={v.coldkey} compact fallback="—" />,
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
  { ...numeric("Active subnets"), cell: (v) => formatNumber(v.subnet_count) },
  {
    ...numeric("UIDs"),
    tdClassName: `${TD_NUM} text-ink-muted`,
    cell: (v) => formatNumber(v.uid_count),
  },
  {
    ...numeric("Nominators"),
    tdClassName: `${TD_NUM} text-ink-muted`,
    cell: (v) => (v.nominator_count != null ? formatNumber(v.nominator_count) : "—"),
  },
  {
    ...numeric("Dominance"),
    cell: (v) => (v.stake_dominance != null ? `${(v.stake_dominance * 100).toFixed(2)}%` : "—"),
  },
  { ...numeric("Total stake"), cell: (v) => taoCompact(v.total_stake_tao) },
  {
    ...numeric("Total emission"),
    tdClassName: `${TD_NUM} text-ink-muted`,
    cell: (v) => taoCompact(v.total_emission_tao),
  },
];
