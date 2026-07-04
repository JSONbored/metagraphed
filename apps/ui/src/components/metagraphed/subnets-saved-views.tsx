import { useNavigate, useSearch } from "@tanstack/react-router";
import { Bookmark, Sparkles, AlertTriangle, TrendingUp, Clock, Star } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { classNames } from "@/lib/metagraphed/format";

type Patch = Record<string, string | number | undefined>;

type Preset = {
  id: string;
  label: string;
  icon: LucideIcon;
  patch: Patch;
  hint?: string;
};

const PRESETS: Preset[] = [
  {
    id: "adapter",
    label: "Adapter-backed",
    icon: Sparkles,
    patch: { curation: "adapter-backed", health: undefined, sort: "participants", order: "desc" },
    hint: "pilots with maintained adapters",
  },
  {
    id: "review",
    label: "Needs review",
    icon: Bookmark,
    patch: {
      curation: "candidate-discovered",
      health: undefined,
      sort: "updated_at",
      order: "desc",
    },
    hint: "unverified candidates",
  },
  {
    id: "unhealthy",
    label: "Unhealthy now",
    icon: AlertTriangle,
    patch: { health: "down", curation: undefined, sort: "updated_at", order: "desc" },
    hint: "down or warn endpoints",
  },
  {
    id: "top",
    label: "Top by participants",
    icon: TrendingUp,
    patch: { sort: "participants", order: "desc", curation: undefined, health: undefined },
    hint: "largest networks first",
  },
  {
    id: "fresh",
    label: "Recently updated",
    icon: Clock,
    patch: { sort: "updated_at", order: "desc", curation: undefined, health: undefined },
    hint: "freshest registry edits",
  },
  {
    id: "verified",
    label: "Verified surfaces",
    icon: Star,
    patch: {
      curation: "maintainer-reviewed",
      health: undefined,
      sort: "surfaces_count",
      order: "desc",
    },
    hint: "maintainer-reviewed only",
  },
];

function matches(search: Record<string, unknown>, patch: Patch) {
  return Object.entries(patch).every(([k, v]) => {
    const sv = search[k];
    if (v === undefined) return !sv;
    return String(sv ?? "") === String(v);
  });
}

export function SubnetsSavedViews() {
  const search = useSearch({ from: "/subnets/" }) as Record<string, unknown>;
  const navigate = useNavigate({ from: "/subnets/" });

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
                  search: (prev: Record<string, unknown>) => {
                    const next: Record<string, unknown> = { ...prev, cursor: "" };
                    for (const [k, v] of Object.entries(p.patch)) {
                      if (v === undefined) delete next[k];
                      else next[k] = v;
                    }
                    return next as never;
                  },
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
              <Icon className="size-3" />
              {p.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
