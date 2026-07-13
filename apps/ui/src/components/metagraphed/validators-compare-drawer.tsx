import { Link } from "@tanstack/react-router";
import { X, BarChart3 } from "lucide-react";
import { useState } from "react";
import { useValidatorCompare } from "@/lib/metagraphed/validator-compare";
import { classNames, formatNumber } from "@/lib/metagraphed/format";
import { shortHash } from "@/lib/metagraphed/blocks";
import { taoCompact } from "@/components/metagraphed/neuron-table";
import type { GlobalValidator } from "@/lib/metagraphed/types";

/**
 * Floating bottom dock + expandable side-by-side compare drawer for selected
 * validators. Selection state lives in localStorage via useValidatorCompare so
 * it survives navigation. Unlike the subnet compare drawer this reads from the
 * validator rows already loaded on the page (passed in) rather than a dedicated
 * compare endpoint — the directory ships the full row set, so no extra fetch is
 * needed. Strictly presentational; it lays values side by side and never ranks
 * or recommends a validator.
 */
export function ValidatorsCompareDrawer({ validators }: { validators: GlobalValidator[] }) {
  const { selected, max, remove, clear } = useValidatorCompare();
  const [expanded, setExpanded] = useState(false);

  if (selected.length === 0) return null;

  const byHotkey = new Map<string, GlobalValidator>();
  for (const v of validators) byHotkey.set(v.hotkey, v);

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 pointer-events-none">
      <div className="max-w-shell-max mx-auto px-4 md:px-10 pb-3">
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
              {selected.map((hotkey) => (
                <span
                  key={hotkey}
                  className="inline-flex h-6 items-center gap-1 rounded-full border border-border bg-paper pl-2.5 pr-1 font-mono text-[10px] text-ink-strong"
                  title={hotkey}
                >
                  {shortHash(hotkey) ?? hotkey}
                  <button
                    type="button"
                    onClick={() => remove(hotkey)}
                    aria-label={`Remove ${shortHash(hotkey) ?? hotkey}`}
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
            <CompareGrid hotkeys={selected} byHotkey={byHotkey} />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function pct(v: number | null | undefined): string {
  return v != null ? `${(v * 100).toFixed(2)}%` : "—";
}

function trust(v: number | null | undefined): string {
  return v != null ? v.toFixed(4) : "—";
}

function CompareGrid({
  hotkeys,
  byHotkey,
}: {
  hotkeys: string[];
  byHotkey: Map<string, GlobalValidator>;
}) {
  const rows: Array<{ label: string; render: (hotkey: string) => React.ReactNode }> = [
    {
      label: "Coldkey",
      render: (hotkey) => {
        const c = byHotkey.get(hotkey)?.coldkey;
        return c ? (
          <Link
            to="/accounts/$ss58"
            params={{ ss58: c }}
            className="font-mono text-ink-strong hover:text-accent"
            title={c}
          >
            {shortHash(c) ?? c}
          </Link>
        ) : (
          <span className="text-ink-muted">—</span>
        );
      },
    },
    {
      label: "Active subnets",
      render: (hotkey) => cell(formatNumber(byHotkey.get(hotkey)?.subnet_count)),
    },
    {
      label: "UIDs",
      render: (hotkey) => cell(formatNumber(byHotkey.get(hotkey)?.uid_count)),
    },
    {
      label: "Dominance",
      render: (hotkey) => cell(pct(byHotkey.get(hotkey)?.stake_dominance)),
    },
    {
      label: "Total stake",
      render: (hotkey) => cell(taoCompact(byHotkey.get(hotkey)?.total_stake_tao)),
    },
    {
      label: "Total emission",
      render: (hotkey) => cell(taoCompact(byHotkey.get(hotkey)?.total_emission_tao)),
    },
    {
      label: "Avg trust",
      render: (hotkey) => cell(trust(byHotkey.get(hotkey)?.avg_validator_trust)),
    },
    {
      label: "Max trust",
      render: (hotkey) => cell(trust(byHotkey.get(hotkey)?.max_validator_trust)),
    },
  ];

  return (
    <div className="border-t border-border max-h-[55vh] overflow-auto">
      <table className="min-w-full text-[12px]">
        <thead className="sticky top-0 bg-card/95 backdrop-blur z-[1]">
          <tr>
            <th className="sticky left-0 z-[2] w-40 bg-card/95 px-3 py-2 text-left font-mono text-[10px] uppercase tracking-widest text-ink-muted backdrop-blur">
              Metric
            </th>
            {hotkeys.map((h) => (
              <th
                key={h}
                className="min-w-[7rem] whitespace-nowrap px-3 py-2 text-left font-mono text-[10px] uppercase tracking-widest text-ink-strong"
              >
                <Link
                  to="/validators/$hotkey"
                  params={{ hotkey: h }}
                  className="hover:text-accent"
                  title={h}
                >
                  {shortHash(h) ?? h}
                </Link>
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
              {hotkeys.map((h) => (
                <td key={h} className="px-3 py-2">
                  {row.render(h)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function cell(value: string) {
  return <span className="font-mono tabular-nums text-ink-strong">{value}</span>;
}

/** Inline checkbox-style toggle for validator table rows. */
export function ValidatorCompareToggle({ hotkey }: { hotkey: string }) {
  const { has, toggle, selected, max } = useValidatorCompare();
  const on = has(hotkey);
  const disabled = !on && selected.length >= max;
  const label = shortHash(hotkey) ?? hotkey;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      aria-label={on ? `Remove ${label} from compare` : `Add ${label} to compare`}
      disabled={disabled}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!disabled) toggle(hotkey);
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
