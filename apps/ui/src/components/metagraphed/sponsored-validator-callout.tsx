import { Coins } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { CopyButton } from "@jsonbored/ui-kit";
import { shortHash } from "@/lib/metagraphed/blocks";
import { taoCompact, SponsoredBadge } from "@/components/metagraphed/neuron-table";
import { StakeUnstakeModal } from "@/components/metagraphed/stake-unstake-modal";
import {
  annualizedDelegatorApyPct,
  formatApyPct,
  formatTakePct,
} from "@/lib/metagraphed/validator-apy";
import type { MetagraphNeuron } from "@/lib/metagraphed/types";

/**
 * Renders a `featured: true` (#5166) validator as its own honestly-disclosed
 * slot — never as an unmarked row inside the objective, stake-ranked list.
 *
 * Deliberately its own component/card, not a table row: the objective
 * NeuronTable below (or beside) this always sorts by real chain metrics only
 * (see NUMERIC_FIELDS in neuron-table.tsx, which structurally excludes
 * `featured`), so a paid placement can be shown prominently without ever
 * being counted as rank #1. This mirrors how search/marketplace "Sponsored"
 * results work: prominent placement is fine, blending into the organic count
 * is not. The featured validator may also appear in the objective list below
 * at its own true, unfavored position — this callout doesn't hide it there.
 */
export function SponsoredValidatorCallout({
  netuid,
  subnetName,
  validator,
}: {
  netuid: number;
  subnetName?: string;
  validator: MetagraphNeuron;
}) {
  if (!validator.hotkey) return null;
  const apy = formatApyPct(
    annualizedDelegatorApyPct(
      validator.emission_tao ?? 0,
      validator.stake_tao ?? 0,
      validator.take,
    ),
  );

  return (
    <div className="rounded-xl border border-ink-muted/30 bg-surface/40 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SponsoredBadge />
        <span className="font-mono text-[10px] text-ink-muted">
          Paid placement — not ranked or endorsed by Metagraphed.
        </span>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-1.5">
          <Link
            to="/validators/$hotkey"
            params={{ hotkey: validator.hotkey }}
            className="truncate font-mono text-[13px] text-ink-strong hover:text-accent hover:underline"
            title={validator.hotkey}
          >
            {shortHash(validator.hotkey, 6) ?? validator.hotkey}
          </Link>
          <CopyButton value={validator.hotkey} label="hotkey" />
        </div>
        <div className="flex flex-wrap items-center gap-4 font-mono text-[11px] text-ink-muted">
          <span>
            Stake{" "}
            <span className="text-ink-strong tabular-nums">
              {taoCompact(validator.stake_tao)} τ
            </span>
          </span>
          <span>
            Take{" "}
            <span className="text-ink-strong tabular-nums">{formatTakePct(validator.take)}</span>
          </span>
          <span>
            Est. APY <span className="text-ink-strong tabular-nums">{apy}</span>
          </span>
        </div>
        <StakeUnstakeModal
          hotkey={validator.hotkey}
          netuid={netuid}
          subnetName={subnetName}
          trigger={(open) => (
            <button
              type="button"
              onClick={open}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-3 py-1.5 text-[11px] font-medium text-ink-strong transition-colors hover:border-accent/50 hover:text-accent"
            >
              <Coins className="size-3 text-ink-muted" aria-hidden />
              Delegate
            </button>
          )}
        />
      </div>
    </div>
  );
}
