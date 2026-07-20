import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { X, BarChart3, ExternalLink } from "lucide-react";
import { useState } from "react";
import { useValidatorsCompareSelection } from "@/lib/metagraphed/validators-compare-selection";
import { compareValidatorsQuery } from "@/lib/metagraphed/queries";
import { classNames, formatNumber } from "@/lib/metagraphed/format";
import { shortHash } from "@/lib/metagraphed/blocks";
import { taoCompact, scoreStr } from "@/components/metagraphed/neuron-format";
import { ValidatorIdentityChip } from "@/components/metagraphed/validator-identity-chip";
import { formatApyPct, formatTakePct } from "@/lib/metagraphed/validator-apy";
import type { CompareValidator } from "@/lib/metagraphed/types";

/**
 * Floating bottom dock + expandable side-by-side compare drawer for selected
 * validators (#6998) — the validator counterpart of SubnetsCompareDrawer, same
 * dock/expand interaction and the same localStorage-backed selection contract
 * (useValidatorsCompareSelection). Pure presentation — does not mutate URL.
 */
export function ValidatorsCompareDrawer() {
  const { selected, max, remove, clear } = useValidatorsCompareSelection();
  const [expanded, setExpanded] = useState(false);

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
              {selected.map((hotkey) => {
                const short = shortHash(hotkey) ?? hotkey;
                return (
                  <span
                    key={hotkey}
                    title={hotkey}
                    className="inline-flex h-6 items-center gap-1 rounded-full border border-border bg-paper pl-2.5 pr-1 font-mono text-[10px] text-ink-strong"
                  >
                    {short}
                    <button
                      type="button"
                      onClick={() => remove(hotkey)}
                      aria-label={`Remove ${short}`}
                      className="ml-0.5 inline-flex size-4 items-center justify-center rounded-full text-ink-muted hover:text-ink-strong hover:bg-surface transition-colors"
                    >
                      <X className="size-2.5" />
                    </button>
                  </span>
                );
              })}
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
          {expanded && selected.length >= 2 ? <CompareValidatorsGrid hotkeys={selected} /> : null}
        </div>
      </div>
    </div>
  );
}

function CompareValidatorsGrid({ hotkeys }: { hotkeys: string[] }) {
  const { data, isPending, isError, refetch } = useQuery({
    ...compareValidatorsQuery(hotkeys),
    retry: 0,
  });

  const byHotkey = new Map<string, CompareValidator>();
  for (const v of data?.data?.validators ?? []) byHotkey.set(v.hotkey, v);

  const rows: Array<{ label: string; render: (hotkey: string) => React.ReactNode }> = [
    {
      label: "Operator",
      render: (hotkey) => (
        <Link
          to="/validators/$hotkey"
          params={{ hotkey }}
          className="inline-flex items-center gap-1 hover:text-accent"
        >
          <ValidatorIdentityChip
            hotkey={hotkey}
            identity={byHotkey.get(hotkey)?.coldkey_identity}
            size={20}
          />
          <ExternalLink className="size-3 opacity-60" />
        </Link>
      ),
    },
    {
      label: "Take",
      render: (hotkey) => (
        <span className="font-mono tabular-nums text-ink-strong">
          {formatTakePct(byHotkey.get(hotkey)?.take)}
        </span>
      ),
    },
    {
      label: "Est. APY",
      render: (hotkey) => {
        // apy_estimate (#2551) is a 0..1 fraction; formatApyPct takes a percentage.
        const apy = byHotkey.get(hotkey)?.apy_estimate;
        return (
          <span className="font-mono tabular-nums text-ink-strong">
            {formatApyPct(apy != null ? apy * 100 : null)}
          </span>
        );
      },
    },
    {
      label: "Nominators",
      render: (hotkey) => (
        <span className="font-mono tabular-nums text-ink-strong">
          {formatNumber(byHotkey.get(hotkey)?.nominator_count)}
        </span>
      ),
    },
    {
      label: "Total stake",
      render: (hotkey) => (
        <span className="font-mono tabular-nums text-ink-strong">
          {taoCompact(byHotkey.get(hotkey)?.total_stake_tao)}
        </span>
      ),
    },
    {
      label: "Total emission",
      render: (hotkey) => (
        <span className="font-mono tabular-nums text-ink-strong">
          {taoCompact(byHotkey.get(hotkey)?.total_emission_tao)}
        </span>
      ),
    },
    {
      label: "Avg trust",
      render: (hotkey) => (
        <span className="font-mono tabular-nums text-ink-strong">
          {scoreStr(byHotkey.get(hotkey)?.avg_validator_trust)}
        </span>
      ),
    },
    {
      label: "Max trust",
      render: (hotkey) => (
        <span className="font-mono tabular-nums text-ink-strong">
          {scoreStr(byHotkey.get(hotkey)?.max_validator_trust)}
        </span>
      ),
    },
    {
      label: "Active subnets",
      render: (hotkey) => (
        <span className="font-mono tabular-nums text-ink-strong">
          {formatNumber(byHotkey.get(hotkey)?.subnet_count)}
        </span>
      ),
    },
  ];

  if (isError) {
    return (
      <div className="border-t border-border px-3 py-6 text-center">
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
    <div className="border-t border-border max-h-[55vh] overflow-auto">
      <table className="min-w-full text-[12px]">
        <thead className="sticky top-0 bg-card/95 backdrop-blur z-[1]">
          <tr>
            <th className="sticky left-0 z-[2] w-40 bg-card/95 px-3 py-2 text-left font-mono text-[10px] uppercase tracking-widest text-ink-muted backdrop-blur">
              Metric
            </th>
            {hotkeys.map((hotkey) => (
              <th
                key={hotkey}
                title={hotkey}
                className="min-w-[8rem] whitespace-nowrap px-3 py-2 text-left font-mono text-[10px] uppercase tracking-widest text-ink-strong"
              >
                {shortHash(hotkey) ?? hotkey}
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
              {hotkeys.map((hotkey) => (
                <td key={hotkey} className="px-3 py-2">
                  {isPending ? (
                    <span className="inline-block h-3 w-12 animate-pulse rounded bg-border/60" />
                  ) : (
                    row.render(hotkey)
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

/** Inline checkbox-style toggle for table/card rows. */
export function ValidatorCompareToggle({ hotkey }: { hotkey: string }) {
  const { has, toggle, selected, max } = useValidatorsCompareSelection();
  const on = has(hotkey);
  const disabled = !on && selected.length >= max;
  const short = shortHash(hotkey) ?? hotkey;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      aria-label={on ? `Remove ${short} from compare` : `Add ${short} to compare`}
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
