import { Link } from "@tanstack/react-router";
import {
  Search,
  Layers3,
  Plug2,
  Activity,
  Building2,
  ArrowUpRight,
  type LucideIcon,
} from "lucide-react";

interface QuickAction {
  to: string;
  eyebrow: string;
  title: string;
  description: string;
  icon: LucideIcon;
}

const ACTIONS: QuickAction[] = [
  {
    to: "/subnets",
    eyebrow: "Registry",
    title: "Search subnets",
    description: "Filter all 128 active Finney subnets by curation, health, and surfaces.",
    icon: Search,
  },
  {
    to: "/surfaces",
    eyebrow: "Interfaces",
    title: "Browse surfaces",
    description: "Every verified API, schema, dashboard, repo, and SDK in one place.",
    icon: Layers3,
  },
  {
    to: "/endpoints",
    eyebrow: "Live",
    title: "Inspect endpoints",
    description: "Probed endpoints, root RPC pools, incidents, and archive support.",
    icon: Plug2,
  },
  {
    to: "/health",
    eyebrow: "Status",
    title: "Check health",
    description: "Global probes, source freshness, and per-subnet uptime trends.",
    icon: Activity,
  },
  {
    to: "/providers",
    eyebrow: "Sources",
    title: "Discover providers",
    description: "Subnet teams, infrastructure operators, and registry sources.",
    icon: Building2,
  },
];

/**
 * Icon-anchored quick-actions row rendered under the leaderboard module.
 * Five compact tiles linking to the registry's primary destinations, each
 * with an eyebrow, title, and one-line description. Hover microinteractions
 * are defined in styles.css (`.mg-quick-tile`) and respect prefers-reduced-motion.
 */
export function QuickActionsRow() {
  return (
    <nav aria-label="Quick actions" className="mt-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {ACTIONS.map((a) => {
          const Icon = a.icon;
          return (
            <Link
              key={a.to}
              to={a.to}
              className="mg-quick-tile group relative flex flex-col gap-3 rounded-xl border border-border bg-card p-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <div className="flex items-start justify-between">
                <span
                  aria-hidden
                  className="mg-quick-icon inline-flex size-9 items-center justify-center rounded-lg border border-border bg-surface/60 text-ink-strong"
                >
                  <Icon className="size-4" />
                </span>
                <ArrowUpRight aria-hidden className="mg-quick-arrow size-3.5 text-ink-subtle" />
              </div>
              <div className="space-y-1">
                <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
                  {a.eyebrow}
                </div>
                <div className="font-display text-sm font-semibold text-ink-strong">{a.title}</div>
                <p className="text-[12px] leading-relaxed text-ink-muted">{a.description}</p>
              </div>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
