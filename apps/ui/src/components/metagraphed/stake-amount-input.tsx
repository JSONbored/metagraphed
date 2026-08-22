import { RangeControl } from "@jsonbored/ui-kit";
import { AlertCircle, Loader2 } from "lucide-react";
import { SearchInput } from "@/components/metagraphed/table-controls";
import { formatNumber } from "@/lib/metagraphed/format";
import { raoToTao, type Rao } from "@/lib/metagraphed/units";
import type { SubnetStakeQuote } from "@/lib/metagraphed/types";
import type { StakeFlowAction, StakeFlowUnit } from "@/hooks/use-stake-flow";
import { MAX_UNSTAKE_UNAVAILABLE_ROOT_MESSAGE } from "@/hooks/use-stake-flow";

// The amount-entry step (#5242's "amount" phase): action tablist + amount
// field + TAO/alpha toggle + Max button, wired to useStakeFlow's already-
// tested pure logic rather than owning any fund-safety-relevant computation
// itself. Mirrors subnets.$netuid.tsx's StakeQuoteCalculator's SearchInput/
// tablist treatment so the two live-amount inputs in this app read the same.

const STAKE_FLOW_ACTIONS: StakeFlowAction[] = ["stake", "unstake"];

/** τ for TAO, α for alpha -- this app's established unit glyphs (StakeQuoteCalculator, PreSignConfirmation). */
export function unitSymbol(unit: StakeFlowUnit): string {
  return unit === "tao" ? "τ" : "α";
}

/** Stake has no unit toggle (TAO is both the mental model and the on-chain unit) -- see use-stake-flow.ts's header comment. */
export function shouldShowUnitToggle(action: StakeFlowAction): boolean {
  return action === "unstake";
}

/**
 * A relative-age label for the Max prefill's captured_at, e.g. "as of ~14h
 * ago" -- situational awareness that the figure is a daily/weekly snapshot,
 * never presented as authoritative (see AccountPositions' doc comment).
 * `nowMs` is injectable for deterministic testing, defaulting to the real
 * clock at call time.
 */
export function formatPositionAge(
  capturedAt: string | null,
  nowMs: number = Date.now(),
): string | null {
  if (!capturedAt) return null;
  const capturedMs = Date.parse(capturedAt);
  if (!Number.isFinite(capturedMs)) return null;
  const diffMs = nowMs - capturedMs;
  if (diffMs < 0) return "as of just now";
  const hours = diffMs / (1000 * 60 * 60);
  if (hours < 1) return "as of <1h ago";
  if (hours < 48) return `as of ~${Math.round(hours)}h ago`;
  return `as of ~${Math.round(hours / 24)}d ago`;
}

/** Whether/why the unstake Max button is unavailable -- root's zero coverage takes priority over a merely-absent position. */
export function describeUnstakeMaxState(
  maxUnstakeUnavailable: boolean,
  maxUnstakeAmountInput: string | null,
): { disabled: boolean; note: string | null } {
  if (maxUnstakeUnavailable) {
    return { disabled: true, note: MAX_UNSTAKE_UNAVAILABLE_ROOT_MESSAGE };
  }
  if (maxUnstakeAmountInput == null) {
    return { disabled: true, note: "No recorded position for this validator yet." };
  }
  return { disabled: false, note: null };
}

/** A compact single-line summary of a resolved quote -- expected output + slippage/root context. */
export function formatQuoteHint(quote: SubnetStakeQuote | null): string | null {
  if (!quote) return null;
  const outUnit = quote.expected_out_unit === "tao" ? "τ" : "α";
  const impact = quote.is_root
    ? "root subnet · 1:1"
    : `${quote.price_impact_pct.toFixed(2)}% price impact`;
  return `≈ ${formatNumber(quote.expected_out)} ${outUnit} · ${impact}`;
}

export interface StakeAmountInputProps {
  action: StakeFlowAction;
  onActionChange: (action: StakeFlowAction) => void;
  unit: StakeFlowUnit;
  onUnitChange: (unit: StakeFlowUnit) => void;
  amountInput: string;
  onAmountInputChange: (value: string) => void;

  maxStakeRao: Rao | null;
  onApplyMaxStake: () => void;
  maxUnstakeAmountInput: string | null;
  maxUnstakeUnavailable: boolean;
  positionCapturedAt: string | null;
  onApplyMaxUnstake: () => void;

  quote: SubnetStakeQuote | null;
  quoteIsPending: boolean;
  quoteError: string | null;
  validationMessages: string[];
}

export function StakeAmountInput({
  action,
  onActionChange,
  unit,
  onUnitChange,
  amountInput,
  onAmountInputChange,
  maxStakeRao,
  onApplyMaxStake,
  maxUnstakeAmountInput,
  maxUnstakeUnavailable,
  positionCapturedAt,
  onApplyMaxUnstake,
  quote,
  quoteIsPending,
  quoteError,
  validationMessages,
}: StakeAmountInputProps) {
  const showUnitToggle = shouldShowUnitToggle(action);
  const unstakeMax = describeUnstakeMaxState(maxUnstakeUnavailable, maxUnstakeAmountInput);
  const positionAge = formatPositionAge(positionCapturedAt);
  const hasValidAmount =
    amountInput.trim() !== "" && Number.isFinite(Number(amountInput)) && Number(amountInput) > 0;

  return (
    <div className="space-y-4">
      <RangeControl
        label="Stake or unstake"
        options={STAKE_FLOW_ACTIONS.map((a) => ({ value: a, label: a }))}
        value={action}
        onChange={onActionChange}
      />

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <span aria-hidden="true" className="text-13 text-ink-muted">
            Amount ({unitSymbol(unit)})
          </span>
          <SearchInput
            value={amountInput}
            onChange={onAmountInputChange}
            placeholder={`0.00 ${unitSymbol(unit)}`}
            inputMode="decimal"
            className="w-40 flex-none font-mono tabular-nums"
          />
        </div>

        {showUnitToggle ? (
          <div className="flex flex-col gap-1">
            <span className="text-13 text-ink-muted">Unit</span>
            <RangeControl
              label="TAO or alpha"
              options={(["tao", "alpha"] as const).map((u) => ({ value: u, label: unitSymbol(u) }))}
              value={unit}
              onChange={onUnitChange}
            />
          </div>
        ) : null}

        {action === "stake" ? (
          <button
            type="button"
            onClick={onApplyMaxStake}
            disabled={maxStakeRao == null}
            className="min-h-8 rounded border border-border bg-card px-3 py-1.5 text-11 text-ink-muted hover:text-ink-strong hover:border-ink/30 transition-colors disabled:opacity-50"
          >
            Max{maxStakeRao != null ? ` (${raoToTao(maxStakeRao)} τ)` : ""}
          </button>
        ) : (
          <button
            type="button"
            onClick={onApplyMaxUnstake}
            disabled={unstakeMax.disabled}
            className="min-h-8 rounded border border-border bg-card px-3 py-1.5 text-11 text-ink-muted hover:text-ink-strong hover:border-ink/30 transition-colors disabled:opacity-50"
          >
            Max
          </button>
        )}
      </div>

      {action === "unstake" ? (
        <p className="text-10 text-ink-muted">
          {unstakeMax.note ?? (positionAge ? `Recorded position ${positionAge}.` : null)}
        </p>
      ) : null}

      {!hasValidAmount ? (
        <p className="text-11 text-ink-muted">Enter an amount to see the expected outcome.</p>
      ) : quoteError ? (
        <p className="inline-flex items-center gap-1.5 text-11 text-health-down">
          <AlertCircle className="size-3.5 shrink-0" aria-hidden />
          {quoteError}
        </p>
      ) : quoteIsPending ? (
        <p className="inline-flex items-center gap-1.5 text-11 text-ink-muted">
          <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
          Calculating…
        </p>
      ) : quote ? (
        <p className="text-11 text-ink-strong">{formatQuoteHint(quote)}</p>
      ) : null}

      {validationMessages.length > 0 ? (
        <ul className="space-y-1">
          {validationMessages.map((message) => (
            <li key={message} className="inline-flex items-center gap-1.5 text-11 text-health-down">
              <AlertCircle className="size-3.5 shrink-0" aria-hidden />
              {message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
