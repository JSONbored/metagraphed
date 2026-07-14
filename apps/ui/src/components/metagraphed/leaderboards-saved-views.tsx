import { useNavigate, useSearch } from "@tanstack/react-router";
import { Scale, UserMinus, type LucideIcon } from "lucide-react";
import { classNames } from "@/lib/metagraphed/format";

type Focus = "weights" | "deregistrations";

type Patch = {
  focus: Focus;
  window: "7d" | "30d";
  weightsSort?: string;
  weightsOrder?: "asc" | "desc";
  deregSort?: string;
  deregOrder?: "asc" | "desc";
};

type Preset = {
  id: string;
  label: string;
  icon: LucideIcon;
  patch: Patch;
  hint?: string;
};

// `focus` makes chips mutually exclusive — without it, the default
// weightsSort + deregSort both match their ·7d presets at once (#5344 mobile).
const PRESETS: Preset[] = [
  {
    id: "weights-7d",
    label: "Weights · 7d",
    icon: Scale,
    patch: {
      focus: "weights",
      window: "7d",
      weightsSort: "weight_sets",
      weightsOrder: "desc",
    },
    hint: "highest weight-setting activity this week",
  },
  {
    id: "weights-30d",
    label: "Weights · 30d",
    icon: Scale,
    patch: {
      focus: "weights",
      window: "30d",
      weightsSort: "weight_sets",
      weightsOrder: "desc",
    },
    hint: "highest weight-setting activity this month",
  },
  {
    id: "dereg-7d",
    label: "Dereg · 7d",
    icon: UserMinus,
    patch: {
      focus: "deregistrations",
      window: "7d",
      deregSort: "deregistrations",
      deregOrder: "desc",
    },
    hint: "most evictions this week",
  },
  {
    id: "dereg-30d",
    label: "Dereg · 30d",
    icon: UserMinus,
    patch: {
      focus: "deregistrations",
      window: "30d",
      deregSort: "deregistrations",
      deregOrder: "desc",
    },
    hint: "most evictions this month",
  },
];

function matches(search: Record<string, unknown>, patch: Patch) {
  return Object.entries(patch).every(([k, v]) => String(search[k] ?? "") === String(v));
}

/** Preset window/sort chips for /leaderboards — mirrors SubnetsSavedViews (#5344). */
export function LeaderboardsSavedViews() {
  const search = useSearch({ from: "/leaderboards" }) as Record<string, unknown>;
  const navigate = useNavigate({ from: "/leaderboards" });

  return (
    <div className="mb-4 md:mb-6">
      <div className="flex items-center gap-2 mb-2">
        <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted shrink-0">
          Saved views
        </span>
        <span aria-hidden className="h-px flex-1 min-w-0 bg-border/60" />
      </div>
      <div className="flex flex-wrap justify-start gap-1.5">
        {PRESETS.map((p) => {
          const active = matches(search, p.patch);
          const Icon = p.icon;
          return (
            <button
              key={p.id}
              type="button"
              title={p.hint}
              onClick={() => {
                navigate({
                  search: (prev: Record<string, unknown>) => ({ ...prev, ...p.patch }) as never,
                  replace: true,
                });
                // Nudge into the focused board after the URL lands.
                window.setTimeout(() => {
                  document
                    .getElementById(
                      p.patch.focus === "weights" ? "weights-board" : "deregistrations-board",
                    )
                    ?.scrollIntoView({ behavior: "smooth", block: "start" });
                }, 40);
              }}
              className={classNames(
                "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 font-mono text-[10px] uppercase tracking-widest transition-colors",
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
