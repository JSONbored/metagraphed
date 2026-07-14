import { useNavigate, useSearch } from "@tanstack/react-router";

import { Layers, Coins, Flame, Scale, Shield, TrendingUp, type LucideIcon } from "lucide-react";
import { classNames } from "@/lib/metagraphed/format";
import type { GlobalValidatorSort } from "@/lib/metagraphed/types";

type Patch = {
  sort?: GlobalValidatorSort;
  order?: "asc" | "desc";
};

type Preset = {
  id: string;
  label: string;
  icon: LucideIcon;
  patch: Patch;
  hint?: string;
};

const PRESETS: Preset[] = [
  {
    id: "subnets",
    label: "Most subnets",
    icon: Layers,
    patch: { sort: "subnet_count", order: "desc" },
    hint: "broadest footprint first",
  },
  {
    id: "stake",
    label: "Top stake",
    icon: Coins,
    patch: { sort: "total_stake", order: "desc" },
    hint: "highest total stake",
  },
  {
    id: "emission",
    label: "Top emission",
    icon: Flame,
    patch: { sort: "total_emission", order: "desc" },
    hint: "highest total emission",
  },
  {
    id: "dominance",
    label: "Highest dominance",
    icon: TrendingUp,
    patch: { sort: "stake_dominance", order: "desc" },
    hint: "share of network stake",
  },
  {
    id: "trust",
    label: "Highest trust",
    icon: Shield,
    patch: { sort: "avg_validator_trust", order: "desc" },
    hint: "average validator trust",
  },
  {
    id: "uids",
    label: "Most UIDs",
    icon: Scale,
    patch: { sort: "uid_count", order: "desc" },
    hint: "most validator UIDs",
  },
];

function matches(search: Record<string, unknown>, patch: Patch) {
  return Object.entries(patch).every(([k, v]) => String(search[k] ?? "") === String(v));
}

/** Preset sort chips for /validators — mirrors SubnetsSavedViews (#5344). */
export function ValidatorsSavedViews() {
  const search = useSearch({ from: "/validators/" }) as Record<string, unknown>;
  const navigate = useNavigate({ from: "/validators/" });

  return (
    <div className="-mt-2 mb-6">
      <div className="flex items-center gap-2 mb-2">
        <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
          Saved views
        </span>
        <span aria-hidden className="h-px flex-1 bg-border/60" />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map((p) => {
          const active = matches(search, p.patch);
          const Icon = p.icon;
          return (
            <button
              key={p.id}
              type="button"
              title={p.hint}
              onClick={() =>
                navigate({
                  search: (prev: Record<string, unknown>) => ({ ...prev, ...p.patch }) as never,
                  replace: true,
                })
              }
              className={classNames(
                "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 font-mono text-[10px] uppercase tracking-widest transition-colors",
                active
                  ? "border-accent bg-primary-soft text-ink-strong"
                  : "border-border bg-card text-ink-muted hover:border-accent/50 hover:text-ink-strong",
              )}
              aria-pressed={active}
            >
              <Icon className="size-3" aria-hidden />
              {p.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
