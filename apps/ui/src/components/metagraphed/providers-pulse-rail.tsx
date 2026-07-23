import { useMemo } from "react";
import { formatNumber } from "@/lib/metagraphed/format";
import type { Provider } from "@/lib/metagraphed/types";

/**
 * Compact 4-tile pulse rail summarizing the providers directory:
 * total, official/claimed, tracked endpoints, tracked surfaces.
 * Mirrors the endpoints priority strip visual language.
 */
export function ProvidersPulseRail({ providers }: { providers: Provider[] }) {
  const stats = useMemo(() => {
    let official = 0;
    let claimed = 0;
    let endpoints = 0;
    let surfaces = 0;
    for (const p of providers) {
      const a = String(p.authority ?? "");
      if (a === "official") official++;
      else if (a === "provider-claimed") claimed++;
      endpoints += p.endpoints_count ?? 0;
      surfaces += p.surfaces_count ?? 0;
    }
    return {
      total: providers.length,
      trusted: official + claimed,
      endpoints,
      surfaces,
    };
  }, [providers]);

  return (
    <div className="mg-kpi-strip">
      <Tile label="Providers" value={stats.total} />
      <Tile
        label="Official + claimed"
        value={stats.trusted}
        hint={`${stats.total > 0 ? Math.round((stats.trusted / stats.total) * 100) : 0}% of total`}
      />
      <Tile label="Endpoints tracked" value={stats.endpoints} />
      <Tile label="Surfaces tracked" value={stats.surfaces} />
    </div>
  );
}

function Tile({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div>
      <div className="mg-label">{label}</div>
      <div className="mt-1 font-display text-xl tabular-nums text-ink-strong">
        {formatNumber(value)}
      </div>
      {hint ? <div className="mt-0.5 font-mono text-[10px] text-ink-muted">{hint}</div> : null}
    </div>
  );
}
