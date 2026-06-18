import { useQuery } from "@tanstack/react-query";
import { economicsQuery } from "@/lib/metagraphed/queries";
import { StatTile } from "@/components/metagraphed/charts/stat-tile";
import { formatNumber } from "@/lib/metagraphed/format";

// #1112: per-subnet on-chain economics (emission share, alpha price, stake,
// validators, volume) from the previously-unused /api/v1/economics. The artifact
// carries all subnets; we fetch once (shared cache) and find this netuid.

function fmtTao(v?: number): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M τ`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k τ`;
  if (v >= 1) return `${v.toFixed(2)} τ`;
  return `${v.toFixed(4)} τ`;
}

function Notice({ children }: { children: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 text-xs text-ink-muted">
      {children}
    </div>
  );
}

export function EconomicsPanel({ netuid }: { netuid: number }) {
  const { data: res, isPending } = useQuery(economicsQuery());
  const e = res?.data.find((x) => x.netuid === netuid);

  if (isPending && !e) return <Notice>Loading economics…</Notice>;
  if (!e) return <Notice>No on-chain economic data for this subnet.</Notice>;

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <StatTile
        eyebrow="Emission share"
        tone="accent"
        value={e.emission_share != null ? `${(e.emission_share * 100).toFixed(3)}%` : "—"}
      />
      <StatTile
        eyebrow="Alpha price"
        value={e.alpha_price_tao != null ? `${e.alpha_price_tao.toFixed(4)} τ` : "—"}
      />
      <StatTile
        eyebrow="Validators"
        value={
          e.validator_count != null
            ? `${e.validator_count}${e.max_validators ? ` / ${e.max_validators}` : ""}`
            : "—"
        }
      />
      <StatTile
        eyebrow="Miners"
        value={formatNumber(e.miner_count)}
        hint={e.max_uids ? `${e.max_uids} max UIDs` : undefined}
      />
      <StatTile eyebrow="Total stake" value={fmtTao(e.total_stake_tao)} />
      <StatTile eyebrow="Volume" value={fmtTao(e.subnet_volume_tao)} />
      <StatTile eyebrow="Max stake" value={fmtTao(e.max_stake_tao)} />
      <StatTile
        eyebrow="Registration"
        tone={e.registration_allowed === false ? "down" : "default"}
        value={e.registration_cost_tao != null ? `${e.registration_cost_tao} τ` : "—"}
        hint={e.registration_allowed === false ? "closed" : "open"}
      />
    </div>
  );
}
