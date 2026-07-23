import { Suspense } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Coins, ArrowRight } from "lucide-react";
import { CopyButton } from "@jsonbored/ui-kit";
import { subnetValidatorsQuery } from "@/lib/metagraphed/queries";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { Skeleton } from "@/components/metagraphed/states";
import { Panel } from "@/components/metagraphed/primitives";
import { taoCompact } from "@/components/metagraphed/neuron-format";
import { StakeUnstakeModal } from "@/components/metagraphed/stake-unstake-modal";
import { SponsoredValidatorCallout } from "@/components/metagraphed/sponsored-validator-callout";
import { annualizedDelegatorApyPct, formatApyPct } from "@/lib/metagraphed/validator-apy";
import { shortHash } from "@/lib/metagraphed/blocks";
import type { MetagraphNeuron } from "@/lib/metagraphed/types";

const PREVIEW_N = 3;

/**
 * Hero-adjacent validator preview (#5903 follow-up): the "as few clicks as
 * possible" delegation entry point — a visitor can compare the top few
 * validators and delegate without leaving the masthead. Reads the same
 * subnetValidatorsQuery the Validators tab uses (React Query dedupes the
 * fetch), so this never issues a second network request.
 *
 * Ranking here is always by stake_tao, computed fresh from `validators` —
 * it never reads `featured`. A sponsored validator (if any) renders in its
 * own SponsoredValidatorCallout above this ranked list, never blended into
 * it; see that component's own doc comment for why.
 */
export function SubnetValidatorsPreview({ netuid }: { netuid: number }) {
  return (
    <QueryErrorBoundary fallback={() => null}>
      <Suspense fallback={<Skeleton className="h-32 w-full" />}>
        <SubnetValidatorsPreviewLoader netuid={netuid} />
      </Suspense>
    </QueryErrorBoundary>
  );
}

function SubnetValidatorsPreviewLoader({ netuid }: { netuid: number }) {
  const { data } = useSuspenseQuery(subnetValidatorsQuery(netuid));
  const validators = data.data.validators;
  const navigate = useNavigate();

  if (validators.length === 0) return null;

  const sponsored = validators.find((v) => v.featured && v.hotkey);
  const topByStake = [...validators]
    .filter((v) => v.hotkey)
    .sort((a, b) => (b.stake_tao ?? 0) - (a.stake_tao ?? 0))
    .slice(0, PREVIEW_N);

  return (
    <div className="mt-6 space-y-3">
      {sponsored ? <SponsoredValidatorCallout netuid={netuid} validator={sponsored} /> : null}
      <Panel as="div" dense>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <span className="mg-type-micro text-ink-muted">Top validators · by stake</span>
          <button
            type="button"
            onClick={() =>
              navigate({
                to: ".",
                search: (prev: Record<string, unknown>) => ({ ...prev, tab: "validators" }),
                replace: true,
              })
            }
            className="inline-flex items-center gap-1 mg-type-micro text-ink-muted transition-colors hover:text-accent"
          >
            View all validators
            <ArrowRight className="size-3" aria-hidden />
          </button>
        </div>
        <ul className="divide-y divide-border/60">
          {topByStake.map((v) => (
            <ValidatorPreviewRow key={v.uid} netuid={netuid} validator={v} />
          ))}
        </ul>
      </Panel>
    </div>
  );
}

function ValidatorPreviewRow({
  netuid,
  validator,
}: {
  netuid: number;
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
    <li className="flex flex-wrap items-center justify-between gap-3 py-2.5">
      <div className="flex min-w-0 items-center gap-1.5">
        <Link
          to="/validators/$hotkey"
          params={{ hotkey: validator.hotkey }}
          className="truncate font-mono text-[12px] text-ink-strong hover:text-accent hover:underline"
          title={validator.hotkey}
        >
          {shortHash(validator.hotkey, 6) ?? validator.hotkey}
        </Link>
        <CopyButton value={validator.hotkey} label="hotkey" compact />
      </div>
      <div className="flex flex-wrap items-center gap-3 font-mono text-[11px] text-ink-muted">
        <span>
          <span className="text-ink-strong tabular-nums">{taoCompact(validator.stake_tao)}</span> τ
        </span>
        <span>
          <span className="text-ink-strong tabular-nums">{apy}</span> APY
        </span>
        <StakeUnstakeModal
          hotkey={validator.hotkey}
          netuid={netuid}
          trigger={(open) => (
            <button
              type="button"
              onClick={open}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2.5 py-1 text-[11px] font-medium text-ink-strong transition-colors hover:border-accent/50 hover:text-accent"
            >
              <Coins className="size-3 text-ink-muted" aria-hidden />
              Delegate
            </button>
          )}
        />
      </div>
    </li>
  );
}
