import { Link } from "@tanstack/react-router";
import { Coins } from "lucide-react";
import { CopyButton } from "@jsonbored/ui-kit";
import { classNames } from "@/lib/metagraphed/format";
import { shortHash } from "@/lib/metagraphed/blocks";
import { StakeUnstakeModal } from "@/components/metagraphed/stake-unstake-modal";
import {
  taoCompact,
  scoreStr,
  SponsoredBadge,
  validatorTrustValue,
} from "@/components/metagraphed/neuron-format";
import {
  annualizedDelegatorApyPct,
  formatApyPct,
  formatTakePct,
} from "@/lib/metagraphed/validator-apy";
import type { MetagraphNeuron } from "@/lib/metagraphed/types";

type NeuronCardListProps = {
  netuid: number;
  rows: MetagraphNeuron[];
  isValidator: boolean;
  onSelect?: (uid: number) => void;
  selectedUid?: number | null;
};

/**
 * Mobile card fallback for {@link NeuronTable} (#6335): the 8–10 column
 * neuron/validator table is undiscoverably clipped behind horizontal scroll on
 * a narrow viewport, so below `md` each neuron renders as a stacked card
 * instead — mirroring the `md:hidden` card path every other tabular list page
 * provides. Renders the same `rows` (already sorted by the parent) and the same
 * per-variant field set the table shows, so the mobile view never hides a
 * column the desktop table surfaces.
 */
export function NeuronCardList({
  netuid,
  rows,
  isValidator,
  onSelect,
  selectedUid,
}: NeuronCardListProps) {
  return (
    <div className="md:hidden divide-y divide-border/60">
      {rows.map((n) => {
        const active = selectedUid === n.uid;
        return (
          <div
            key={n.uid}
            className={classNames("space-y-2 px-3 py-3", active && "bg-accent-surface")}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[12px] tabular-nums text-ink-strong">
                {onSelect ? (
                  <button
                    type="button"
                    className="underline underline-offset-2 hover:text-accent"
                    onClick={() => onSelect(n.uid)}
                  >
                    UID {n.uid}
                  </button>
                ) : (
                  <>UID {n.uid}</>
                )}
              </span>
              {n.validator_permit ? (
                <span className="inline-flex items-center rounded border border-accent/40 bg-accent-surface px-1.5 py-0.5 text-[9.5px] font-mono uppercase tracking-wider text-accent-text">
                  Validator
                </span>
              ) : null}
            </div>

            <div className="flex min-w-0 items-center gap-1.5 font-mono text-[11px]">
              {n.featured ? <SponsoredBadge /> : null}
              {n.hotkey ? (
                <>
                  <Link
                    to={isValidator ? "/validators/$hotkey" : "/accounts/$ss58"}
                    params={isValidator ? { hotkey: n.hotkey } : { ss58: n.hotkey }}
                    className="truncate text-ink-muted hover:text-ink hover:underline"
                    title={n.hotkey}
                  >
                    {shortHash(n.hotkey) ?? n.hotkey}
                  </Link>
                  <CopyButton value={n.hotkey} label="hotkey" compact />
                </>
              ) : (
                <span className="text-ink-muted">—</span>
              )}
            </div>

            <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 font-mono text-[11px]">
              <Stat label="Stake τ" value={taoCompact(n.stake_tao)} strong />
              <Stat label="Emission τ" value={taoCompact(n.emission_tao)} />
              {isValidator ? (
                <>
                  <Stat label="Dividends" value={scoreStr(n.dividends)} />
                  <Stat label="Val Trust" value={scoreStr(validatorTrustValue(n))} />
                  <Stat label="Take" value={formatTakePct(n.take)} />
                  <Stat
                    label="Est. APY"
                    value={formatApyPct(
                      annualizedDelegatorApyPct(n.emission_tao ?? 0, n.stake_tao ?? 0, n.take),
                    )}
                  />
                </>
              ) : (
                <>
                  <Stat label="Rank" value={n.rank == null ? "—" : String(n.rank)} />
                  <Stat label="Trust" value={scoreStr(n.trust)} />
                  <Stat label="Consensus" value={scoreStr(n.consensus)} />
                </>
              )}
            </dl>

            {isValidator && n.hotkey ? (
              <StakeUnstakeModal
                hotkey={n.hotkey}
                netuid={netuid}
                trigger={(open) => (
                  <button
                    type="button"
                    onClick={open}
                    className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-ink-strong transition-colors hover:border-accent/50 hover:text-accent"
                  >
                    <Coins className="size-3 text-ink-muted" aria-hidden />
                    Delegate
                  </button>
                )}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function Stat({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-[10px] uppercase tracking-widest text-ink-muted">{label}</dt>
      <dd className={classNames("tabular-nums", strong ? "text-ink-strong" : "text-ink-muted")}>
        {value}
      </dd>
    </div>
  );
}
