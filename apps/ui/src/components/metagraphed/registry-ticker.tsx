import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  buildQuery,
  freshnessQuery,
  gapsQuery,
  healthQuery,
  subnetsQuery,
} from "@/lib/metagraphed/queries";
import { API_BASE } from "@/lib/metagraphed/config";
import { CopyButton } from "./copy-button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { classNames } from "@/lib/metagraphed/format";
import { TimeAgo } from "./time-ago";

interface Stat {
  label: string;
  value: React.ReactNode;
  to?: string;
  search?: Record<string, string>;
  tooltip: string;
}

export function RegistryTicker() {
  const subnets = useQuery({ ...subnetsQuery(), retry: 0 });
  const health = useQuery({ ...healthQuery(), retry: 0 });
  const fresh = useQuery({ ...freshnessQuery(), retry: 0 });
  const gaps = useQuery({ ...gapsQuery(), retry: 0 });
  const build = useQuery({ ...buildQuery(), retry: 0 });

  const all = subnets.data?.data ?? [];
  const curated = all.filter((s) => {
    const c = (s as { curation_level?: string }).curation_level;
    return c && c !== "native";
  }).length;
  const machineVerified = all.filter(
    (s) => (s as { curation_level?: string }).curation_level === "machine-verified",
  ).length;
  const h = health.data?.data;
  const f = fresh.data?.data;
  const openGaps = gaps.data?.data?.length ?? 0;
  const b = build.data?.data as { version?: string } | undefined;

  // Freshness “live” pulse only when latest source < 5 minutes old.
  const isFresh = typeof f?.avg_age_seconds === "number" ? f.avg_age_seconds < 300 : false;

  const stats: Stat[] = [
    {
      label: "Active subnets",
      value: all.length || "—",
      to: "/subnets",
      tooltip: "Active Finney netuids (incl. root)",
    },
    {
      label: "Curated",
      value: curated || "—",
      to: "/subnets",
      search: { curation: "verified" },
      tooltip: "Subnets with maintainer-reviewed overlay",
    },
    {
      label: "Machine-verified",
      value: machineVerified || "—",
      to: "/subnets",
      search: { curation: "machine-verified" },
      tooltip: "Subnets verified by automated probes",
    },
    {
      label: "Endpoints up",
      value: typeof h?.ok === "number" && typeof h?.total === "number" ? `${h.ok}/${h.total}` : "—",
      to: "/health",
      tooltip: "OK endpoints out of total probed",
    },
    {
      label: "Open gaps",
      value: openGaps || "—",
      to: "/gaps",
      search: { status: "open" },
      tooltip: "Registry items missing evidence or review",
    },
  ];

  // Rotate on small screens; full row on xl+.
  const [rot, setRot] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setRot((i) => (i + 1) % stats.length), 6000);
    return () => window.clearInterval(t);
  }, [stats.length]);

  const lastSeen =
    f?.sources && f.sources.length
      ? f.sources
          .map((s) => s.last_seen)
          .filter(Boolean)
          .sort()
          .pop()
      : undefined;

  return (
    <div className="hidden md:block border-t border-border/60 bg-surface/40">
      <div className="max-w-[1400px] mx-auto px-4 md:px-8 h-9 flex items-center justify-between gap-4">
        {/* Left: rotating stat on md, full row on xl */}
        <div className="flex items-center gap-5 min-w-0">
          <span className="inline-flex items-center gap-1.5">
            <span
              className={classNames(
                "size-1.5 rounded-full",
                isFresh ? "bg-health-ok mg-pulse" : "bg-ink-muted/60",
              )}
              aria-hidden
            />
            <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-muted">
              registry pulse
            </span>
          </span>
          <span className="hidden xl:flex items-center gap-5">
            {stats.map((s) => (
              <StatChip key={s.label} stat={s} />
            ))}
          </span>
          <span className="xl:hidden inline-flex">
            <StatChip stat={stats[rot]!} />
          </span>
        </div>

        {/* Right: build + api */}
        <div className="flex items-center gap-3 text-[11px] font-mono text-ink-muted shrink-0">
          {lastSeen ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="hidden lg:inline">
                  <span className="text-ink-muted">last snapshot</span>{" "}
                  <span className="text-ink-strong">
                    <TimeAgo at={lastSeen} />
                  </span>
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-[11px]">
                Most recent source capture
              </TooltipContent>
            </Tooltip>
          ) : null}
          {b?.version ? (
            <span className="hidden lg:inline">
              <span className="text-ink-muted">build</span>{" "}
              <span className="text-ink-strong">{b.version}</span>
            </span>
          ) : null}
          <span className="inline-flex items-center gap-1">
            <span className="text-ink-muted">api</span>
            <span className="text-ink-strong">v1</span>
            <CopyButton value={`${API_BASE}/api/v1`} label="API base" />
          </span>
        </div>
      </div>
    </div>
  );
}

function StatChip({ stat }: { stat: Stat }) {
  const content = (
    <span className="inline-flex items-baseline gap-1.5 text-[11px] font-mono">
      <span className="text-ink-muted">{stat.label}</span>
      <span className="text-ink-strong mg-num">{stat.value}</span>
    </span>
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {stat.to ? (
          <Link
            to={stat.to}
            search={(stat.search ?? undefined) as never}
            className="hover:opacity-80 transition-opacity"
          >
            {content}
          </Link>
        ) : (
          <span>{content}</span>
        )}
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-[11px]">
        {stat.tooltip}
      </TooltipContent>
    </Tooltip>
  );
}
