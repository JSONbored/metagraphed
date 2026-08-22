import { ChartTooltip, useEntityMark } from "@jsonbored/ui-kit";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { subnetsQuery } from "@/lib/metagraphed/queries";
import { classNames } from "@/lib/metagraphed/format";
import { ErrorState } from "@/components/metagraphed/states";
import type { HealthState, Subnet } from "@/lib/metagraphed/types";

const TONE: Record<HealthState, string> = {
  ok: "bg-health-ok/80 hover:bg-health-ok",
  warn: "bg-health-warn/75 hover:bg-health-warn",
  down: "bg-health-down/75 hover:bg-health-down",
  unknown: "bg-ink-subtle/30 hover:bg-ink-subtle/60",
};

// Netuid-label contrast per tone, mirroring the latency-heatmap convention:
// light text on the saturated health fills, dark text on the amber warn fill
// and the pale "unknown" fill.
const TONE_TEXT: Record<HealthState, string> = {
  ok: "text-paper",
  warn: "text-ink-strong",
  down: "text-paper",
  unknown: "text-ink-strong",
};

/**
 * Heatmap of every active application subnet colored by health. Clicking a
 * cell deep-links to that subnet. Renders a tooltip with the subnet name +
 * health state on hover. Falls back to a static skeleton on first paint.
 */
export function SubnetHealthMatrix() {
  const { data, isLoading, isError, error, refetch } = useQuery({
    ...subnetsQuery({ limit: 256, sort: "netuid", order: "asc" }),
  });
  const rows = ((data?.data ?? []) as Subnet[]).slice().sort((a, b) => a.netuid - b.netuid);

  if (isError) {
    return <ErrorState error={error} onRetry={() => refetch()} context="subnet health matrix" />;
  }

  if (isLoading) {
    return (
      <div className="grid grid-cols-[repeat(auto-fill,minmax(28px,1fr))] gap-1.5">
        {Array.from({ length: 128 }).map((_, i) => (
          <div key={i} className="aspect-square rounded bg-surface-2/60 animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div
        className="relative grid grid-cols-[repeat(auto-fill,minmax(28px,1fr))] gap-1.5"
        data-marks
      >
        <ChartTooltip top={0} />
        {rows.map((s) => (
          <MatrixCell key={s.netuid} subnet={s} />
        ))}
      </div>
      <Legend />
    </div>
  );
}

function MatrixCell({ subnet: s }: { subnet: Subnet }) {
  const health = s.health ?? "unknown";
  const mark = useEntityMark(`subnet:${s.netuid}`, {
    source: "subnet-health-matrix",
    label: `SN${s.netuid}${s.name ? ` — ${s.name}` : ""} — ${health}`,
    data: {
      title: `SN${s.netuid}${s.name ? ` · ${s.name}` : ""}`,
      rows: [{ key: "health", label: "health", value: health }],
    },
  });
  return (
    <Link
      to="/subnets/$netuid"
      params={{ netuid: s.netuid }}
      {...mark}
      role="link"
      className={classNames(
        "group flex aspect-square items-center justify-center rounded transition-colors ring-0 data-[active=true]:ring-2 data-[active=true]:ring-accent",
        TONE[health],
        TONE_TEXT[health],
      )}
    >
      <span className="text-10 font-semibold leading-none tabular-nums">{s.netuid}</span>
    </Link>
  );
}

function Legend() {
  const items: Array<{ label: string; state: HealthState }> = [
    { label: "OK", state: "ok" },
    { label: "Warn", state: "warn" },
    { label: "Down", state: "down" },
    { label: "Unknown", state: "unknown" },
  ];
  return (
    <div className="flex flex-wrap items-center gap-3 text-13 text-ink-muted">
      {items.map((i) => (
        <span key={i.state} className="inline-flex items-center gap-1.5">
          <span className={classNames("size-2 rounded", TONE[i.state])} aria-hidden />
          {i.label}
        </span>
      ))}
    </div>
  );
}
