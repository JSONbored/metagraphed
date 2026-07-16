import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@jsonbored/ui-kit";
import { validatorsQuery } from "@/lib/metagraphed/queries";
import { shortHash } from "@/lib/metagraphed/blocks";
import { taoCompact } from "@/components/metagraphed/neuron-format";
import { classNames } from "@/lib/metagraphed/format";

// #3495: validator (row) × subnet (column) participation matrix from the global
// validators payload, cells shaded by relative stake. Pure consumer of
// validatorsQuery() — no new query/route. The payload is server-capped (top ~20
// validators, top 10 subnets by stake per validator), so the matrix is a
// concentration snapshot, not exhaustive coverage — the header says so.

const MAX_VALIDATORS = 15;

function stakeTone(ratio: number | null): string {
  if (ratio == null) return "bg-ink-subtle/10"; // non-participating (or beyond top-10)
  if (ratio >= 0.66) return "bg-accent/80";
  if (ratio >= 0.33) return "bg-accent/50";
  if (ratio > 0) return "bg-accent/20";
  return "bg-ink-subtle/10";
}

export function ValidatorSubnetHeatmap() {
  const validators = useSuspenseQuery(
    validatorsQuery({ sort: "total_stake", limit: MAX_VALIDATORS }),
  ).data.data.validators;

  const { rows, netuids, maxStake } = useMemo(() => {
    const rows = validators.slice(0, MAX_VALIDATORS);
    const set = new Set<number>();
    let maxStake = 0;
    for (const v of rows) {
      for (const s of v.subnets ?? []) {
        set.add(s.netuid);
        if (s.stake_tao > maxStake) maxStake = s.stake_tao;
      }
    }
    return { rows, netuids: [...set].sort((a, b) => a - b), maxStake };
  }, [validators]);

  if (rows.length === 0 || netuids.length === 0) {
    return (
      <div className="rounded border border-border bg-card p-4 text-xs text-ink-muted">
        No validator participation data yet.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
          Validator × subnet · stake intensity
        </div>
        <div className="flex flex-wrap items-center gap-2.5 font-mono text-[9.5px] text-ink-muted">
          <span>top {rows.length} validators · top 10 subnets each (server-capped)</span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-2.5 w-2.5 rounded-sm bg-accent/20" />
            <span className="inline-block h-2.5 w-2.5 rounded-sm bg-accent/50" />
            <span className="inline-block h-2.5 w-2.5 rounded-sm bg-accent/80" />
            more stake
          </span>
        </div>
      </div>
      <div className="w-full overflow-x-auto [scrollbar-gutter:stable]">
        <TooltipProvider delayDuration={150}>
          <table className="w-full min-w-[640px] text-[11px] font-mono">
            <thead>
              <tr>
                <th className="sticky left-0 z-10 border-b border-border bg-card px-3 py-2 text-left text-[10px] uppercase tracking-widest text-ink-muted">
                  Validator
                </th>
                {netuids.map((n) => (
                  <th
                    key={n}
                    className="border-b border-border px-1.5 py-2 text-[10px] tabular-nums text-ink-muted"
                  >
                    {n}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((v) => {
                const byNet = new Map((v.subnets ?? []).map((s) => [s.netuid, s]));
                return (
                  <tr key={v.hotkey} className="border-b border-border last:border-b-0">
                    <td className="sticky left-0 z-10 border-r border-border bg-card px-3 py-1.5 text-ink-strong">
                      <Link
                        to="/accounts/$ss58"
                        params={{ ss58: v.hotkey }}
                        className="block max-w-[12ch] truncate hover:text-accent"
                        title={v.hotkey}
                      >
                        {shortHash(v.hotkey) ?? v.hotkey}
                      </Link>
                    </td>
                    {netuids.map((n) => {
                      const s = byNet.get(n);
                      const ratio = s && maxStake > 0 ? s.stake_tao / maxStake : null;
                      const summary = s
                        ? `${shortHash(v.hotkey)} · SN${n} · stake ${taoCompact(s.stake_tao)} τ · emission ${taoCompact(s.emission_tao)} τ · trust ${s.validator_trust ?? "—"}`
                        : `SN${n} · not in this validator's top-10 subnets`;
                      return (
                        <td key={n} className="p-0.5">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span
                                tabIndex={0}
                                role="img"
                                aria-label={summary}
                                className={classNames(
                                  "block h-6 rounded-sm cursor-help focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
                                  stakeTone(ratio),
                                )}
                              />
                            </TooltipTrigger>
                            <TooltipContent side="top" className="text-[11px]">
                              {summary}
                            </TooltipContent>
                          </Tooltip>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TooltipProvider>
      </div>
    </div>
  );
}
