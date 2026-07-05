import { useQuery } from "@tanstack/react-query";
import type { LucideIcon } from "lucide-react";
import { Scale, Users, BarChart3, Activity, Percent, Coins, ShieldCheck } from "lucide-react";
import { chainConcentrationQuery, chainPerformanceQuery } from "@/lib/metagraphed/queries";
import { StatTile } from "@/components/metagraphed/charts/stat-tile";
import { EmptyState } from "@/components/metagraphed/states";
import {
  networkDecentralizationModel,
  type DecentralizationTile,
} from "@/lib/metagraphed/network-decentralization";

// #3471: network-scope decentralization scorecard — the chain-wide twin of the
// per-subnet concentration panel. Feeds from the already-shipped-but-unwired
// chainConcentrationQuery + chainPerformanceQuery (#3609). The data layer is
// untouched; this only consumes the normalized shape via useQuery and maps it
// through the pure networkDecentralizationModel helper.

const TILE_ICONS: Record<string, LucideIcon> = {
  "stake-gini": Scale,
  "stake-hhi": BarChart3,
  "stake-nakamoto": Users,
  "stake-entropy": Activity,
  "stake-top1": Percent,
  "emission-gini": Coins,
  "trust-median": ShieldCheck,
  "consensus-median": ShieldCheck,
  "validator-trust-median": ShieldCheck,
};

function Notice({ children }: { children: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 text-xs text-ink-muted">
      {children}
    </div>
  );
}

function Tile({ tile }: { tile: DecentralizationTile }) {
  return (
    <StatTile
      icon={TILE_ICONS[tile.key]}
      eyebrow={tile.label}
      value={tile.value}
      hint={tile.hint}
      tone={tile.tone}
    />
  );
}

/**
 * Chain-wide decentralization scorecard: stake/emission concentration (Gini,
 * HHI, Nakamoto coefficient, entropy, top-1% share) plus the 0-1 trust /
 * consensus / validator-trust score spread — the same KPI-tile grid as the
 * per-subnet concentration panel, at network scope. Fetches both snapshots
 * once (shared cache) and renders through the pure view-model helper.
 */
export function NetworkDecentralizationPanel() {
  const { data: cRes, isPending: cPending } = useQuery(chainConcentrationQuery());
  const { data: pRes, isPending: pPending } = useQuery(chainPerformanceQuery());

  const model = networkDecentralizationModel(cRes?.data, pRes?.data);

  if ((cPending || pPending) && !model.hasData) {
    return <Notice>Loading network decentralization…</Notice>;
  }

  if (!model.hasData) {
    return (
      <EmptyState
        title="No network decentralization metrics"
        description="Chain-wide stake- and emission-distribution metrics (Gini, HHI, Nakamoto coefficient, entropy, top-1% share) plus the 0-1 trust/consensus score spread are computed from the metagraph snapshot and will appear here once captured."
        lastChecked={cRes?.meta?.generated_at ?? pRes?.meta?.generated_at}
      />
    );
  }

  return (
    <div className="space-y-4">
      {/* Stake & emission concentration — the headline distribution scorecard. */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {model.concentrationTiles.map((tile) => (
          <Tile key={tile.key} tile={tile} />
        ))}
      </div>

      {/* 0-1 trust / consensus / validator-trust score spread. */}
      <div>
        <div className="mb-3 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
          Trust &amp; consensus score spread
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          {model.scoreTiles.map((tile) => (
            <Tile key={tile.key} tile={tile} />
          ))}
        </div>
      </div>
    </div>
  );
}
