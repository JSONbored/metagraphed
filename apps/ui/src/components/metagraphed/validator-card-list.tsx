import { Link } from "@tanstack/react-router";
import { CopyButton } from "@jsonbored/ui-kit";

import { taoCompact, SponsoredBadge } from "@/components/metagraphed/neuron-format";
import { AccountAddress } from "@/components/metagraphed/account-address";
import { resolveValidatorCard } from "@/lib/metagraphed/validator-card-fields";
import type { GlobalValidator } from "@/lib/metagraphed/types";

export interface ValidatorCardListProps {
  validators: GlobalValidator[];
  /** Layout classes for the wrapper — e.g. a responsive grid, or `md:hidden`
   *  when the list is only a mobile fallback for the desktop table. */
  className?: string;
}

/**
 * Renders the global validator directory as cards — the mobile fallback for the
 * 12-column desktop table, whose columns are unreadable on a narrow viewport
 * (see #5320). Each metric is labelled by its data field, so the cards read
 * correctly on their own.
 */
export function ValidatorCardList({ validators, className }: ValidatorCardListProps) {
  return (
    <div className={className}>
      {validators.map((v) => {
        const f = resolveValidatorCard(v);
        return (
          <div
            key={v.hotkey}
            className="min-w-0 space-y-2 rounded-lg border border-border bg-card p-3"
          >
            <div className="flex min-w-0 items-center gap-1.5">
              {v.featured ? <SponsoredBadge /> : null}
              <Link
                to="/validators/$hotkey"
                params={{ hotkey: v.hotkey }}
                title={v.hotkey}
                className="truncate font-mono text-[12px] text-ink-strong hover:text-accent hover:underline"
              >
                {f.hotkeyShort}
              </Link>
              <CopyButton value={v.hotkey} label="hotkey" compact />
            </div>
            {/* Mirrors the hotkey row above: a flex row so the copy button's 44px
                touch target centers against the value. `compact` folds that height
                back into the row so it does not add vertical spacing. */}
            <div className="flex min-w-0 items-center gap-1.5 font-mono text-[11px] text-ink-muted">
              <span className="uppercase tracking-widest text-[10px]">coldkey</span>
              {/* Same AccountAddress hover-card treatment as the desktop column (#6338). */}
              <AccountAddress ss58={v.coldkey} compact fallback="—" />
            </div>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px]">
              <Stat label="Active subnets" value={f.subnetsLabel} />
              <Stat label="UIDs" value={f.uidsLabel} />
              <Stat label="Nominators" value={f.nominatorsLabel} />
              <Stat label="Dominance" value={f.dominanceLabel} />
              <Stat label="Total stake" value={taoCompact(v.total_stake_tao)} />
              <Stat label="Total emission" value={taoCompact(v.total_emission_tao)} />
              <Stat label="Est. APY" value={f.apyLabel} />
            </dl>
          </div>
        );
      })}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="font-mono tabular-nums text-ink">{value}</dd>
    </div>
  );
}
