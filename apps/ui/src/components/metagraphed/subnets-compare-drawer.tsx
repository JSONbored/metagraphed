import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { X, BarChart3, ExternalLink } from "lucide-react";
import { useState } from "react";
import { useCompareSelection } from "@/lib/metagraphed/compare-selection";
import { compareQuery } from "@/lib/metagraphed/queries";
import { classNames, formatNumber } from "@/lib/metagraphed/format";
import type { CompareSubnet, HealthState } from "@/lib/metagraphed/types";
import { HealthPill, CurationChip } from "@jsonbored/ui-kit";
import { SubnetsCompareHistoryChart } from "@/components/metagraphed/subnets-compare-history-chart";

type CompareView = "grid" | "chart";

/**
 * Floating bottom dock + expandable side-by-side compare drawer for selected
 * subnets. Selection state lives in localStorage via useCompareSelection so
 * it survives navigation. Pure presentation — does not mutate URL.
 */
export function SubnetsCompareDrawer() {
  const { selected, max, remove, clear } = useCompareSelection();
  const [expanded, setExpanded] = useState(false);
  const [view, setView] = useState<CompareView>("grid");

  if (selected.length === 0) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 pointer-events-none">
      <div className="max-w-shell-max mx-auto px-4 md:px-10 pb-3">
        <div
          className={classNames(
            "pointer-events-auto rounded-xl border border-border bg-card/95 backdrop-blur shadow-[0_-8px_32px_-12px_color-mix(in_oklab,var(--ink-strong)_35%,transparent)]",
            "mg-fade-in",
          )}
        >
          {/* Dock */}
          <div className="flex flex-wrap items-center gap-2 px-3 py-2">
            <span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-ink-muted">
              <BarChart3 className="size-3 text-accent" />
              Compare
              <span className="text-ink-strong tabular-nums">
                {selected.length}/{max}
              </span>
            </span>
            <span aria-hidden className="h-4 w-px bg-border" />
            <div className="flex flex-wrap gap-1.5 min-w-0">
              {selected.map((netuid) => (
                <span
                  key={netuid}
                  className="inline-flex h-6 items-center gap-1 rounded-full border border-border bg-paper pl-2.5 pr-1 font-mono text-[10px] text-ink-strong"
                >
                  SN{netuid}
                  <button
                    type="button"
                    onClick={() => remove(netuid)}
                    aria-label={`Remove SN${netuid}`}
                    className="ml-0.5 inline-flex size-4 items-center justify-center rounded-full text-ink-muted hover:text-ink-strong hover:bg-surface transition-colors"
                  >
                    <X className="size-2.5" />
                  </button>
                </span>
              ))}
            </div>
            <div className="ml-auto flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                disabled={selected.length < 2}
                className={classNames(
                  "inline-flex h-7 items-center gap-1.5 rounded-full border border-border bg-paper px-3 font-mono text-[10px] uppercase tracking-widest transition-colors",
                  selected.length < 2
                    ? "opacity-50 cursor-not-allowed"
                    : "hover:border-accent/60 hover:text-accent text-ink-strong",
                )}
              >
                {expanded ? "Hide" : "Compare"}
              </button>
              <button
                type="button"
                onClick={clear}
                className="inline-flex h-7 items-center gap-1 rounded-full border border-border bg-paper px-2.5 font-mono text-[10px] uppercase tracking-widest text-ink-muted hover:text-ink-strong transition-colors"
              >
                Clear
              </button>
            </div>
          </div>

          {/* Expanded side-by-side */}
          {expanded && selected.length >= 2 ? (
            <div className="border-t border-border">
              <CompareViewTabs value={view} onChange={setView} />
              {view === "grid" ? (
                <CompareGrid netuids={selected} />
              ) : (
                <SubnetsCompareHistoryChart netuids={selected} />
              )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Derive a HealthPill state from the compare endpoint's probe counts: it carries
 * ok_count / surface_count (no degraded breakdown), so all-ok is "ok", all-down
 * is "down", a partial mix is "warn", and an absent health block stays "unknown".
 */
function compareHealthState(health: CompareSubnet["health"]): HealthState {
  const total = health?.surface_count;
  const ok = health?.ok_count;
  if (total == null || ok == null || total === 0) return "unknown";
  if (ok >= total) return "ok";
  if (ok === 0) return "down";
  return "warn";
}

function CompareViewTabs({
  value,
  onChange,
}: {
  value: CompareView;
  onChange: (v: CompareView) => void;
}) {
  const tabs: Array<{ id: CompareView; label: string }> = [
    { id: "grid", label: "Metrics" },
    { id: "chart", label: "Overlay chart" },
  ];
  return (
    <div
      role="tablist"
      aria-label="Compare view"
      className="flex items-center gap-1 border-b border-border px-3 py-2"
    >
      {tabs.map((t) => {
        const active = value === t.id;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.id)}
            className={classNames(
              "inline-flex items-center rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase tracking-widest transition-colors",
              active
                ? "border-accent/60 bg-accent/15 text-ink-strong"
                : "border-border bg-paper text-ink-muted hover:text-ink-strong hover:border-ink/30",
            )}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

function CompareGrid({ netuids }: { netuids: number[] }) {
  const { data, isPending, isError, refetch } = useQuery({ ...compareQuery(netuids), retry: 0 });

  const bySubnet = new Map<number, CompareSubnet>();
  for (const s of data?.data?.subnets ?? []) bySubnet.set(s.netuid, s);

  const rows: Array<{ label: string; render: (netuid: number) => React.ReactNode }> = [
    {
      label: "Name",
      render: (netuid) => {
        const s = bySubnet.get(netuid);
        return (
          <Link
            to="/subnets/$netuid"
            params={{ netuid }}
            className="font-medium text-ink-strong hover:text-accent inline-flex items-center gap-1"
          >
            {s?.name ?? `Subnet ${netuid}`}
            <ExternalLink className="size-3 opacity-60" />
          </Link>
        );
      },
    },
    {
      // The compare endpoint composes structure + economics + health, but carries
      // no curation tier — render the neutral placeholder for this row.
      label: "Curation",
      render: () => <CurationChip level={undefined} />,
    },
    {
      label: "Health",
      render: (netuid) => <HealthPill state={compareHealthState(bySubnet.get(netuid)?.health)} />,
    },
    {
      label: "Participants",
      render: (netuid) => {
        const e = bySubnet.get(netuid)?.economics;
        const participants =
          e?.validator_count != null || e?.miner_count != null
            ? (e?.validator_count ?? 0) + (e?.miner_count ?? 0)
            : undefined;
        return (
          <span className="font-mono tabular-nums text-ink-strong">
            {formatNumber(participants)}
          </span>
        );
      },
    },
    {
      label: "Surfaces",
      render: (netuid) => (
        <span className="font-mono tabular-nums text-ink-strong">
          {bySubnet.get(netuid)?.structure?.surface_count ?? "—"}
        </span>
      ),
    },
    {
      label: "Endpoints",
      render: (netuid) => (
        <span className="font-mono tabular-nums text-ink-strong">
          {bySubnet.get(netuid)?.structure?.operational_interface_count ?? "—"}
        </span>
      ),
    },
    {
      label: "Completeness",
      render: (netuid) => {
        const c = bySubnet.get(netuid)?.structure?.completeness_score;
        return (
          <span className="font-mono tabular-nums text-ink-strong">
            {c != null ? `${Math.round(c)}%` : "—"}
          </span>
        );
      },
    },
    {
      label: "Uptime 24h",
      render: (netuid) => {
        const h = bySubnet.get(netuid)?.health;
        const u =
          h?.surface_count && h.surface_count > 0 && h.ok_count != null
            ? h.ok_count / h.surface_count
            : undefined;
        return (
          <span className="font-mono tabular-nums text-ink-strong">
            {u != null ? `${(u * 100).toFixed(2)}%` : "—"}
          </span>
        );
      },
    },
    {
      label: "OK / Down",
      render: (netuid) => {
        const h = bySubnet.get(netuid)?.health;
        if (!h || h.surface_count == null) return <span className="text-ink-muted">—</span>;
        const ok = h.ok_count ?? 0;
        const down = Math.max(0, h.surface_count - ok);
        return (
          <span className="font-mono text-[11px] tabular-nums">
            <span className="text-health-ok">{ok}</span>
            {" · "}
            <span className="text-health-down">{down}</span>
          </span>
        );
      },
    },
  ];

  if (isError) {
    return (
      <div className="px-3 py-6 text-center">
        <p className="font-mono text-[11px] text-ink-muted">Could not load comparison.</p>
        <button
          type="button"
          onClick={() => refetch()}
          className="mt-2 inline-flex h-7 items-center rounded-full border border-border bg-paper px-3 font-mono text-[10px] uppercase tracking-widest text-ink-strong hover:border-accent/60 hover:text-accent transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="max-h-[55vh] overflow-auto">
      <table className="min-w-full text-[12px]">
        <thead className="sticky top-0 bg-card/95 backdrop-blur z-[1]">
          <tr>
            <th className="sticky left-0 z-[2] w-40 bg-card/95 px-3 py-2 text-left font-mono text-[10px] uppercase tracking-widest text-ink-muted backdrop-blur">
              Metric
            </th>
            {netuids.map((n) => (
              <th
                key={n}
                className="min-w-[6rem] whitespace-nowrap px-3 py-2 text-left font-mono text-[10px] uppercase tracking-widest text-ink-strong"
              >
                SN{n}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row) => (
            <tr key={row.label}>
              <td className="sticky left-0 z-[1] bg-card px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                {row.label}
              </td>
              {netuids.map((n) => (
                <td key={n} className="px-3 py-2">
                  {isPending ? (
                    <span className="inline-block h-3 w-12 animate-pulse rounded bg-border/60" />
                  ) : (
                    row.render(n)
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Inline checkbox-style toggle for table/grid rows. */
export function CompareToggle({ netuid }: { netuid: number }) {
  const { has, toggle, selected, max } = useCompareSelection();
  const on = has(netuid);
  const disabled = !on && selected.length >= max;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      aria-label={on ? `Remove SN${netuid} from compare` : `Add SN${netuid} to compare`}
      disabled={disabled}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!disabled) toggle(netuid);
      }}
      title={disabled ? `Compare is full (${max})` : on ? "Remove from compare" : "Add to compare"}
      className={classNames(
        "inline-flex size-4 shrink-0 items-center justify-center rounded border transition-colors",
        on ? "bg-accent border-accent text-paper" : "border-border bg-paper hover:border-accent/60",
        disabled && "opacity-40 cursor-not-allowed",
      )}
    >
      {on ? (
        <svg viewBox="0 0 12 12" fill="none" className="size-2.5" aria-hidden>
          <path
            d="M2 6.5l2.5 2.5L10 3.5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : null}
    </button>
  );
}
