import { useQuery } from "@tanstack/react-query";
import { subnetCostToParticipateQuery } from "@/lib/metagraphed/queries";
import { Panel } from "@/components/metagraphed/primitives";
import { Skeleton, ErrorState } from "@/components/metagraphed/states";
import type { DeclaredComputeSpec } from "@/lib/metagraphed/types";
import { formatNumber } from "@/lib/metagraphed/format";

/**
 * What it costs to participate in a subnet (#10932 phase 1).
 *
 * THE ENTRY COSTS ALWAYS RENDER, THE DECLARATION USUALLY DOES NOT. Unlike the
 * treasury panel this is not empty for an unread subnet: the registration burn
 * and the validator floors are exact and available for every subnet. Only the
 * DECLARED half is missing, and it says so in words.
 *
 * Four rules the render holds:
 *
 * 1. `declarations_read: 0` renders as "no declaration read", never as an
 *    absence of requirements. 111 of 128 subnets are in that state.
 * 2. A `null` GPU requirement renders as "not declared", never as "no GPU
 *    needed". `declared-inconsistently` renders as its own answer WITH both
 *    declared values, so a reader can see why it is not a boolean.
 * 3. No cost per day is shown, computed or implied, because none exists.
 * 4. The earnings figure sits beside the cost, never below the fold. A floor
 *    to run without the distribution that says whether running is worth it is
 *    the misreading the whole surface exists to prevent.
 */
export function SubnetCostToParticipatePanel({ netuid }: { netuid: number }) {
  const { data, isLoading, isError, error, refetch } = useQuery(
    subnetCostToParticipateQuery(netuid),
  );

  if (isLoading) return <Skeleton className="h-[180px] w-full" />;
  if (isError) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const card = data?.data ?? null;
  if (!card) return null;
  const miner = card.declared_compute.miner;

  return (
    <Panel>
      <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        <Figure
          label="registration"
          value={taoLabel(card.entry_cost.registration_cost_tao)}
          hint="What one registration costs right now. Exact, on chain, and it moves with demand."
        />
        <Figure
          label="validator earning floor"
          value={taoLabel(card.entry_cost.validator_earning_floor_tao)}
          hint="Stake at which a validator actually starts earning here. A permit is not income."
        />
        <Figure label="miner GPU" value={gpuLabel(miner)} hint={gpuHint(miner)} />
        <Figure
          label="miners earning nothing"
          value={pctLabel(card.earnings?.zero_emission_pct)}
          hint={
            card.earnings?.days_covered
              ? `Most recent day, over ${card.earnings.days_covered} days measured.`
              : "No daily rollup for this subnet yet."
          }
        />
      </div>

      {card.declarations_read === 0 ? (
        <p className="text-13 mt-4 border-t border-border/60 pt-3 text-ink-muted">
          No min_compute declaration has been read for this subnet. That is not a finding that
          running here takes nothing — nobody has looked.
        </p>
      ) : (
        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-1 border-t border-border/60 pt-3 sm:grid-cols-4">
          <Spec label="min cores" value={miner?.cpu.min_cores} />
          <Spec label="min RAM (GB)" value={miner?.memory.min_ram_gb} />
          <Spec label="min disk (GB)" value={miner?.storage.min_space_gb} />
          <Spec label="min VRAM (GB)" value={miner?.gpu.declared_min_vram_gb} />
        </dl>
      )}

      <ul className="text-13 mt-3 space-y-1 border-t border-border/60 pt-3 text-ink-muted">
        {card.not_modelled.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </Panel>
  );
}

/**
 * TAO, or an em dash. Never 0 for a null: a subnet nobody priced is not free.
 *
 * Through `formatNumber` rather than `toLocaleString()`: an unlocalised call
 * resolves to the RUNTIME's default, which the SSR Worker and a non-en-US
 * browser never agree on, and that mismatch is React #418 (#8356).
 */
export function taoLabel(value: number | null | undefined): string {
  return value == null ? "—" : `${formatNumber(value)} τ`;
}

export function pctLabel(value: number | null | undefined): string {
  return value == null ? "—" : `${(value * 100).toFixed(1)}%`;
}

/**
 * The four-valued GPU answer, in words.
 *
 * NULL IS NOT A "NO". Rendering an unread declaration as "not required" would
 * tell someone they can mine here on a laptop on the strength of a file nobody
 * has opened.
 */
export function gpuLabel(spec: DeclaredComputeSpec | null): string {
  const requirement = spec?.gpu.requirement ?? null;
  if (requirement === null) return "not declared";
  if (requirement === "required") return "required";
  if (requirement === "not-required") return "not required";
  return "declared inconsistently";
}

/** The hint carries the EVIDENCE for the inconsistent case, because that is the
 * one a reader will not otherwise believe. */
export function gpuHint(spec: DeclaredComputeSpec | null): string {
  const gpu = spec?.gpu;
  if (!gpu || gpu.requirement === null)
    return "No GPU stanza has been read for this subnet's miner role.";
  if (gpu.requirement === "declared-inconsistently") {
    const vram = gpu.declared_min_vram_gb;
    const model = gpu.declared_model;
    return `Declares required: false alongside${
      vram ? ` a ${vram} GB minimum VRAM` : " a GPU minimum"
    }${model ? ` and ${model}` : ""} — read as neither answer.`;
  }
  if (gpu.requirement === "not-required")
    return "The declaration says no GPU is needed to mine here.";
  return gpu.declared_model
    ? `Declared model: ${gpu.declared_model}.`
    : "The declaration requires a GPU.";
}

function Spec({ label, value }: { label: string; value: number | null | undefined }) {
  return (
    <div>
      <dt className="text-13 text-ink-muted">{label}</dt>
      <dd className="text-13 text-ink-strong">{formatNumber(value)}</dd>
    </div>
  );
}

function Figure({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div>
      <div className="text-13 text-ink-muted">{label}</div>
      <div className="text-13 text-ink-strong">{value}</div>
      <div className="text-13 text-ink-muted">{hint}</div>
    </div>
  );
}
