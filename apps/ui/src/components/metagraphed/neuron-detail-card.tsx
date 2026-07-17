import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Coins, Flame, Award, Server, X } from "lucide-react";
import { subnetNeuronQuery } from "@/lib/metagraphed/queries";
import { RealtimeFreshness, StatTile, CopyButton } from "@jsonbored/ui-kit";
import { EmptyState } from "@/components/metagraphed/states";
import { taoCompact } from "@/components/metagraphed/neuron-format";
import { shortHash } from "@/lib/metagraphed/blocks";
import { formatNumber } from "@/lib/metagraphed/format";

function scoreStr(v?: number | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return v.toFixed(3);
}

/**
 * Per-UID snapshot detail card. A StatTile grid (stake / emission / rank /
 * validator-permit / axon / coldkey+hotkey) over the live /neurons/{uid}
 * snapshot. Every field is null-safe — an inactive UID renders em-dashes, not
 * misleading zeros. Sits above the per-UID history sparklines on the drill-in.
 */
export function NeuronDetailCard({
  netuid,
  uid,
  onClose,
}: {
  netuid: number;
  uid: number;
  onClose?: () => void;
}) {
  const { data } = useSuspenseQuery(subnetNeuronQuery(netuid, uid));
  const meta = data.meta;
  const n = data.data.neuron;

  if (!n) {
    return (
      <EmptyState
        title={`No snapshot for UID ${uid}`}
        description="This UID is not present in the current metagraph snapshot for this subnet."
      />
    );
  }

  return (
    <div className="space-y-4 rounded-xl border border-border bg-surface/30 p-4">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
            Neuron
          </span>
          <span className="font-display text-lg font-semibold tabular-nums text-ink-strong leading-none">
            UID {n.uid}
          </span>
          {n.validator_permit ? (
            <span className="inline-flex items-center rounded border border-accent/40 bg-accent-surface px-1.5 py-0.5 text-[9.5px] font-mono uppercase tracking-wider text-accent-text">
              Validator
            </span>
          ) : null}
          {n.active === false ? (
            <span className="inline-flex items-center rounded border border-border px-1.5 py-0.5 text-[9.5px] font-mono uppercase tracking-wider text-ink-muted">
              Inactive
            </span>
          ) : null}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <RealtimeFreshness at={meta?.generated_at} />
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close neuron detail"
              className="inline-flex items-center gap-1 rounded border border-border bg-card px-2 py-1 text-[10px] font-mono uppercase tracking-wider text-ink-muted hover:text-ink-strong"
            >
              <X className="size-3" aria-hidden /> Close
            </button>
          ) : null}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile
          icon={Coins}
          eyebrow="Stake"
          value={taoCompact(n.stake_tao)}
          hint="τ"
          tone="accent"
        />
        <StatTile icon={Flame} eyebrow="Emission" value={taoCompact(n.emission_tao)} hint="τ" />
        <StatTile icon={Award} eyebrow="Rank" value={n.rank == null ? "—" : n.rank} />
        <StatTile
          icon={Server}
          eyebrow="Axon"
          value={n.axon ? "Live" : "—"}
          hint={n.axon ?? "no endpoint"}
          tone={n.axon ? "ok" : "default"}
        />
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Fact label="Trust" value={scoreStr(n.trust)} />
        <Fact label="Consensus" value={scoreStr(n.consensus)} />
        <Fact label="Incentive" value={scoreStr(n.incentive)} />
        <Fact label="Dividends" value={scoreStr(n.dividends)} />
      </div>

      <div className="rounded-lg border border-border bg-card p-4 space-y-2.5">
        <KeyRow label="Hotkey" value={n.hotkey} />
        <KeyRow label="Coldkey" value={n.coldkey} />
        {n.registered_at_block != null ? (
          <div className="flex items-center justify-between gap-3">
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
              Registered
            </span>
            <Link
              to="/blocks/$ref"
              params={{ ref: String(n.registered_at_block) }}
              className="font-mono text-[12px] text-ink hover:text-accent hover:underline"
            >
              #{formatNumber(n.registered_at_block)}
            </Link>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
        {label}
      </div>
      <div className="mt-1 font-display text-base font-semibold tabular-nums text-ink-strong leading-none">
        {value}
      </div>
    </div>
  );
}

function KeyRow({ label, value }: { label: string; value?: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
        {label}
      </span>
      {value ? (
        <span className="inline-flex items-center gap-1">
          <Link
            to="/accounts/$ss58"
            params={{ ss58: value }}
            className="font-mono text-[12px] text-ink hover:text-accent hover:underline"
            title={value}
          >
            {shortHash(value) ?? value}
          </Link>
          <CopyButton value={value} label={label} />
        </span>
      ) : (
        <span className="font-mono text-[12px] text-ink-muted">—</span>
      )}
    </div>
  );
}
