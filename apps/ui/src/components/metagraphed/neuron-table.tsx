import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { SortHeader, ariaSort } from "@/components/metagraphed/table-controls";
import { classNames } from "@/lib/metagraphed/format";
import { shortHash } from "@/lib/metagraphed/blocks";
import type { MetagraphNeuron } from "@/lib/metagraphed/types";

/**
 * Format a TAO value compactly. Stake can run into the millions; emission and
 * incentive are sub-unit. Null/non-finite collapses to an em-dash.
 */
export function taoCompact(v?: number | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  if (Math.abs(v) >= 1) return v.toFixed(2);
  if (v === 0) return "0";
  return v.toFixed(4);
}

/** Format a 0..1 score (trust, consensus, incentive) to three decimals. */
function scoreStr(v?: number | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return v.toFixed(3);
}

type SortField =
  | "uid"
  | "stake_tao"
  | "emission_tao"
  | "rank"
  | "trust"
  | "consensus"
  | "dividends"
  | "validator_trust";

/** Which scoring columns each variant surfaces, in render order. */
type NeuronTableVariant = "miner" | "validator";

const NUMERIC_FIELDS = new Set<SortField>([
  "uid",
  "stake_tao",
  "emission_tao",
  "rank",
  "trust",
  "consensus",
  "dividends",
  "validator_trust",
]);

/**
 * Validator scoring lives in validator_trust, but the chain only populates it
 * for permitted neurons — fall back to plain `trust` when the payload omits it.
 */
function validatorTrustValue(n: MetagraphNeuron): number | null | undefined {
  return n.validator_trust ?? n.trust;
}

function sortValue(n: MetagraphNeuron, field: SortField): number {
  const v = field === "validator_trust" ? validatorTrustValue(n) : n[field];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  // Inactive UIDs have null rank/emission; sink them to the bottom of a desc sort.
  return field === "rank" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
}

/**
 * Shared sortable neuron table for the metagraph + validator panels. Rows
 * drill into a per-UID snapshot via `onSelect` (the parent owns the `?uid=`
 * search param). Every numeric cell is null-safe — inactive UIDs render an
 * em-dash rather than a misleading zero/NaN.
 */
export function NeuronTable({
  netuid,
  rows,
  variant = "miner",
  defaultField = "stake_tao",
  onSelect,
  selectedUid,
}: {
  netuid: number;
  rows: MetagraphNeuron[];
  /**
   * `miner` (default) shows rank/trust/consensus — the metagraph leaderboard.
   * `validator` swaps those for dividends/validator-trust, the metrics that
   * actually score a validator (rank is null, consensus ~0 for validators).
   */
  variant?: NeuronTableVariant;
  defaultField?: SortField;
  onSelect?: (uid: number) => void;
  selectedUid?: number | null;
}) {
  const isValidator = variant === "validator";
  const [field, setField] = useState<SortField>(defaultField);
  const [order, setOrder] = useState<"asc" | "desc">("desc");

  const onSort = (f: string) => {
    const next = f as SortField;
    if (next === field) {
      setOrder((o) => (o === "asc" ? "desc" : "asc"));
    } else {
      setField(next);
      // Default to descending for the heavy metrics, ascending for uid/rank.
      setOrder(next === "uid" || next === "rank" ? "asc" : "desc");
    }
  };

  const sorted = useMemo(() => {
    const dir = order === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      if (!NUMERIC_FIELDS.has(field)) return 0;
      return (sortValue(a, field) - sortValue(b, field)) * dir;
    });
  }, [rows, field, order]);

  const col = (f: SortField, label: string, align: "left" | "right" = "right") => (
    <th
      className={classNames("px-3 py-2.5", align === "right" ? "text-right" : "text-left")}
      aria-sort={ariaSort(field === f, order)}
    >
      <SortHeader
        label={label}
        field={f}
        active={field === f}
        order={order}
        onSort={onSort}
        align={align}
      />
    </th>
  );

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-surface/50 text-[10px] font-mono uppercase tracking-widest text-ink-muted">
            <tr>
              {col("uid", "UID", "left")}
              <th className="px-3 py-2.5 text-left font-mono text-[10px] uppercase tracking-widest">
                Hotkey
              </th>
              {col("stake_tao", "Stake τ")}
              {col("emission_tao", "Emission τ")}
              {isValidator ? (
                <>
                  {col("dividends", "Dividends")}
                  {col("validator_trust", "Val Trust")}
                </>
              ) : (
                <>
                  {col("rank", "Rank")}
                  {col("trust", "Trust")}
                  {col("consensus", "Consensus")}
                </>
              )}
              <th className="px-3 py-2.5 text-center font-mono text-[10px] uppercase tracking-widest">
                Permit
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((n) => {
              const active = selectedUid === n.uid;
              return (
                <tr
                  key={n.uid}
                  className={classNames(
                    "mg-row-hover border-t border-border/60",
                    onSelect && "cursor-pointer",
                    active && "bg-accent-surface",
                  )}
                  onClick={onSelect ? () => onSelect(n.uid) : undefined}
                >
                  <td className="px-3 py-2.5 font-mono text-[12px] tabular-nums text-ink-strong">
                    {onSelect ? (
                      <button
                        type="button"
                        className="hover:text-accent hover:underline"
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelect(n.uid);
                        }}
                      >
                        {n.uid}
                      </button>
                    ) : (
                      n.uid
                    )}
                  </td>
                  <td className="px-3 py-2.5 font-mono text-[11px]">
                    {n.hotkey ? (
                      <Link
                        to="/accounts/$ss58"
                        params={{ ss58: n.hotkey }}
                        className="text-ink-muted hover:text-ink hover:underline"
                        onClick={(e) => e.stopPropagation()}
                        title={n.hotkey}
                      >
                        {shortHash(n.hotkey) ?? n.hotkey}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-[12px] tabular-nums text-ink-strong">
                    {taoCompact(n.stake_tao)}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-[12px] tabular-nums text-ink">
                    {taoCompact(n.emission_tao)}
                  </td>
                  {isValidator ? (
                    <>
                      <td className="px-3 py-2.5 text-right font-mono text-[12px] tabular-nums text-ink">
                        {scoreStr(n.dividends)}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-[12px] tabular-nums text-ink-muted">
                        {scoreStr(validatorTrustValue(n))}
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="px-3 py-2.5 text-right font-mono text-[12px] tabular-nums text-ink-muted">
                        {n.rank == null ? "—" : n.rank}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-[12px] tabular-nums text-ink-muted">
                        {scoreStr(n.trust)}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-[12px] tabular-nums text-ink-muted">
                        {scoreStr(n.consensus)}
                      </td>
                    </>
                  )}
                  <td className="px-3 py-2.5 text-center">
                    {n.validator_permit ? (
                      <span className="inline-flex items-center rounded border border-accent/40 bg-accent-surface px-1.5 py-0.5 text-[9.5px] font-mono uppercase tracking-wider text-accent-text">
                        Validator
                      </span>
                    ) : (
                      <span className="font-mono text-[10px] text-ink-subtle-text">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="border-t border-border/60 bg-surface/30 px-3 py-1.5 text-[10px] font-mono uppercase tracking-widest text-ink-muted">
        {sorted.length} {sorted.length === 1 ? "neuron" : "neurons"} · subnet {netuid}
      </div>
    </div>
  );
}
