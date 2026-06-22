import { useQueries } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { X, BarChart3, ExternalLink } from "lucide-react";
import { useState } from "react";
import { useCompareSelection } from "@/lib/metagraphed/compare-selection";
import { subnetProfileQuery, subnetHealthQuery } from "@/lib/metagraphed/queries";
import { classNames, formatNumber } from "@/lib/metagraphed/format";
import { HealthPill, CurationChip } from "./chips";

/**
 * Floating bottom dock + expandable side-by-side compare drawer for selected
 * subnets. Selection state lives in localStorage via useCompareSelection so
 * it survives navigation. Pure presentation — does not mutate URL.
 */
export function SubnetsCompareDrawer() {
  const { selected, max, remove, clear } = useCompareSelection();
  const [expanded, setExpanded] = useState(false);

  if (selected.length === 0) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 pointer-events-none">
      <div className="max-w-[1400px] mx-auto px-4 md:px-10 pb-3">
        <div
          className={classNames(
            "pointer-events-auto rounded-xl border border-border bg-card/95 backdrop-blur shadow-[0_-8px_32px_-12px_rgba(0,0,0,0.35)]",
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
          {expanded && selected.length >= 2 ? <CompareGrid netuids={selected} /> : null}
        </div>
      </div>
    </div>
  );
}

function CompareGrid({ netuids }: { netuids: number[] }) {
  const profiles = useQueries({
    queries: netuids.map((n) => ({ ...subnetProfileQuery(n), retry: 0 })),
  });
  const healths = useQueries({
    queries: netuids.map((n) => ({ ...subnetHealthQuery(n), retry: 0 })),
  });

  const rows: Array<{ label: string; render: (i: number) => React.ReactNode }> = [
    {
      label: "Name",
      render: (i) => {
        const p = profiles[i]?.data?.data;
        return (
          <Link
            to="/subnets/$netuid"
            params={{ netuid: netuids[i] }}
            className="font-medium text-ink-strong hover:text-accent inline-flex items-center gap-1"
          >
            {p?.name ?? `Subnet ${netuids[i]}`}
            <ExternalLink className="size-3 opacity-60" />
          </Link>
        );
      },
    },
    {
      label: "Curation",
      render: (i) => <CurationChip level={profiles[i]?.data?.data?.curation_level} />,
    },
    {
      label: "Health",
      render: (i) => <HealthPill state={profiles[i]?.data?.data?.health} />,
    },
    {
      label: "Participants",
      render: (i) => (
        <span className="font-mono tabular-nums text-ink-strong">
          {formatNumber(profiles[i]?.data?.data?.participants)}
        </span>
      ),
    },
    {
      label: "Surfaces",
      render: (i) => (
        <span className="font-mono tabular-nums text-ink-strong">
          {profiles[i]?.data?.data?.surface_count ?? "—"}
        </span>
      ),
    },
    {
      label: "Endpoints",
      render: (i) => (
        <span className="font-mono tabular-nums text-ink-strong">
          {profiles[i]?.data?.data?.endpoint_count ?? "—"}
        </span>
      ),
    },
    {
      label: "Completeness",
      render: (i) => {
        const c = profiles[i]?.data?.data?.completeness;
        return (
          <span className="font-mono tabular-nums text-ink-strong">
            {c != null ? `${Math.round(c * 100)}%` : "—"}
          </span>
        );
      },
    },
    {
      label: "Uptime 24h",
      render: (i) => {
        const u = healths[i]?.data?.data?.uptime_24h;
        return (
          <span className="font-mono tabular-nums text-ink-strong">
            {u != null ? `${(u * 100).toFixed(2)}%` : "—"}
          </span>
        );
      },
    },
    {
      label: "OK / Warn / Down",
      render: (i) => {
        const h = healths[i]?.data?.data;
        if (!h) return <span className="text-ink-muted">—</span>;
        return (
          <span className="font-mono text-[11px] tabular-nums">
            <span className="text-health-ok">{h.ok ?? 0}</span>
            {" · "}
            <span className="text-health-warn">{h.warn ?? 0}</span>
            {" · "}
            <span className="text-health-down">{h.down ?? 0}</span>
          </span>
        );
      },
    },
  ];

  return (
    <div className="border-t border-border max-h-[55vh] overflow-auto">
      <table className="w-full text-[12px]">
        <thead className="sticky top-0 bg-card/95 backdrop-blur z-[1]">
          <tr>
            <th className="px-3 py-2 text-left font-mono text-[10px] uppercase tracking-widest text-ink-muted w-40">
              Metric
            </th>
            {netuids.map((n) => (
              <th
                key={n}
                className="px-3 py-2 text-left font-mono text-[10px] uppercase tracking-widest text-ink-strong"
              >
                SN{n}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row) => (
            <tr key={row.label}>
              <td className="px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-ink-muted bg-paper/30">
                {row.label}
              </td>
              {netuids.map((_, i) => (
                <td key={i} className="px-3 py-2">
                  {row.render(i)}
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
