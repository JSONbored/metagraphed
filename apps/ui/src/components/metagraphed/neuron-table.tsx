import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Coins, Download } from "lucide-react";
import { CopyButton } from "@jsonbored/ui-kit";
import { SortHeader, ariaSort } from "@/components/metagraphed/table-controls";
import { classNames } from "@/lib/metagraphed/format";
import { shortHash } from "@/lib/metagraphed/blocks";
import { buildUrl } from "@/lib/metagraphed/client";
import { StakeUnstakeModal } from "@/components/metagraphed/stake-unstake-modal";
import { taoCompact, scoreStr, SponsoredBadge } from "@/components/metagraphed/neuron-format";
import {
  annualizedDelegatorApyPct,
  formatApyPct,
  formatTakePct,
} from "@/lib/metagraphed/validator-apy";
import type { MetagraphNeuron } from "@/lib/metagraphed/types";

type SortField =
  | "uid"
  | "stake_tao"
  | "emission_tao"
  | "rank"
  | "trust"
  | "consensus"
  | "dividends"
  | "validator_trust"
  | "take";

/** Which scoring columns each variant surfaces, in render order. */
type NeuronTableVariant = "miner" | "validator";

// `featured` (the sponsored-placement pin, #5166) must NEVER be sortable —
// sort/rank stays strictly objective (stake, trust, consensus, etc.) so a
// paid placement can never distort the neutral comparison. `SortField` simply
// has no `featured` member, so it can't be added here without a type error;
// neuron-table.test.ts also asserts this set never contains "featured" at
// runtime as a second line of defense if that type is ever loosened.
export const NUMERIC_FIELDS = new Set<SortField>([
  "uid",
  "stake_tao",
  "emission_tao",
  "rank",
  "trust",
  "consensus",
  "dividends",
  "validator_trust",
  "take",
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

  const csvUrl = useMemo(() => {
    const path = isValidator
      ? `/api/v1/subnets/${netuid}/validators`
      : `/api/v1/subnets/${netuid}/metagraph`;
    return buildUrl(path, { format: "csv" });
  }, [isValidator, netuid]);

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
                  {col("take", "Take")}
                  <th className="px-3 py-2.5 text-right font-mono text-[10px] uppercase tracking-widest">
                    Est. APY
                  </th>
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
              {isValidator ? (
                <th className="px-3 py-2.5 text-right font-mono text-[10px] uppercase tracking-widest">
                  Delegate
                </th>
              ) : null}
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
                    active && "bg-accent-surface",
                  )}
                >
                  <td className="px-3 py-2.5 font-mono text-[12px] tabular-nums text-ink-strong">
                    {onSelect ? (
                      <button
                        type="button"
                        className="underline underline-offset-2 hover:text-accent"
                        onClick={() => onSelect(n.uid)}
                      >
                        {n.uid}
                      </button>
                    ) : (
                      n.uid
                    )}
                  </td>
                  <td className="px-3 py-2.5 font-mono text-[11px]">
                    <div className="flex items-center gap-1.5">
                      {n.featured ? <SponsoredBadge /> : null}
                      {n.hotkey ? (
                        <>
                          {isValidator ? (
                            <Link
                              to="/validators/$hotkey"
                              params={{ hotkey: n.hotkey }}
                              className="text-ink-muted hover:text-ink hover:underline"
                              title={n.hotkey}
                            >
                              {shortHash(n.hotkey) ?? n.hotkey}
                            </Link>
                          ) : (
                            <Link
                              to="/accounts/$ss58"
                              params={{ ss58: n.hotkey }}
                              className="text-ink-muted hover:text-ink hover:underline"
                              title={n.hotkey}
                            >
                              {shortHash(n.hotkey) ?? n.hotkey}
                            </Link>
                          )}
                          <CopyButton value={n.hotkey} label="hotkey" compact />
                        </>
                      ) : (
                        "—"
                      )}
                    </div>
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
                      <td className="px-3 py-2.5 text-right font-mono text-[12px] tabular-nums text-ink-muted">
                        {formatTakePct(n.take)}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-[12px] tabular-nums text-ink-muted">
                        {formatApyPct(
                          annualizedDelegatorApyPct(n.emission_tao ?? 0, n.stake_tao ?? 0, n.take),
                        )}
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
                  {isValidator ? (
                    <td className="px-3 py-2.5 text-right">
                      {n.hotkey ? (
                        <StakeUnstakeModal
                          hotkey={n.hotkey}
                          netuid={netuid}
                          trigger={(open) => (
                            <button
                              type="button"
                              onClick={open}
                              className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-ink-strong transition-colors hover:border-accent/50 hover:text-accent"
                            >
                              <Coins className="size-3 text-ink-muted" aria-hidden />
                              Delegate
                            </button>
                          )}
                        />
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="border-t border-border/60 bg-surface/30 px-3 py-1.5 flex flex-wrap items-center justify-between gap-2 text-[10px] font-mono uppercase tracking-widest text-ink-muted">
        <span>
          {sorted.length} {sorted.length === 1 ? "neuron" : "neurons"} · subnet {netuid}
        </span>
        <a
          href={csvUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded border border-border bg-surface/40 px-2.5 py-1 text-[11px] font-mono uppercase tracking-wider text-ink-muted transition-colors hover:border-ink/30 hover:text-ink-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={(e) => e.stopPropagation()}
        >
          <Download className="size-3" aria-hidden />
          Download CSV
        </a>
      </div>
    </div>
  );
}
