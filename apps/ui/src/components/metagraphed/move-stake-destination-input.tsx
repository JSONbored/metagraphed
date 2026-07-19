import { AlertCircle, AlertTriangle, Loader2 } from "lucide-react";
import { SearchInput } from "@/components/metagraphed/table-controls";
import { formatQuoteHint } from "@/components/metagraphed/stake-amount-input";
import { shortHash } from "@/lib/metagraphed/blocks";
import type { SubnetStakeQuote, Subnet } from "@/lib/metagraphed/types";
import type { MoveStakeAxis } from "@/hooks/use-move-stake-flow";

// The "amount" step for the move/re-delegate flow (#5244's destination
// picker): origin summary + destination hotkey/subnet fields + amount, wired
// to useMoveStakeFlow's already-tested pure logic rather than owning any
// fund-safety-relevant computation itself -- mirrors StakeAmountInput's own
// posture for the original stake/unstake flow.

export interface MoveStakeDestinationInputProps {
  originHotkey: string;
  originNetuid: number;
  originValidatorName?: string;
  originSubnetName?: string;

  destinationHotkeyInput: string;
  onDestinationHotkeyChange: (value: string) => void;
  destinationNetuidInput: string;
  onDestinationNetuidChange: (value: string) => void;
  knownSubnets: Subnet[];

  amountInput: string;
  onAmountInputChange: (value: string) => void;
  maxAmountInput: string | null;
  onApplyMax: () => void;

  axis: MoveStakeAxis | "unchanged" | "both";
  axisIssueMessage: string | null;

  quote: SubnetStakeQuote | null;
  quoteIsPending: boolean;
  quoteError: string | null;
  validationMessages: string[];
}

export function MoveStakeDestinationInput({
  originHotkey,
  originNetuid,
  originValidatorName,
  originSubnetName,
  destinationHotkeyInput,
  onDestinationHotkeyChange,
  destinationNetuidInput,
  onDestinationNetuidChange,
  knownSubnets,
  amountInput,
  onAmountInputChange,
  maxAmountInput,
  onApplyMax,
  axis,
  axisIssueMessage,
  quote,
  quoteIsPending,
  quoteError,
  validationMessages,
}: MoveStakeDestinationInputProps) {
  const hasValidAmount =
    amountInput.trim() !== "" && Number.isFinite(Number(amountInput)) && Number(amountInput) > 0;

  return (
    <div className="space-y-4">
      <div className="rounded border border-border bg-surface/40 px-2.5 py-2 text-[11px] text-ink-muted">
        Moving from{" "}
        <span className="font-medium text-ink-strong">
          {originValidatorName ?? shortHash(originHotkey, 6)}
        </span>{" "}
        on{" "}
        <span className="font-medium text-ink-strong">
          {originSubnetName ? `${originSubnetName} (SN${originNetuid})` : `SN${originNetuid}`}
        </span>
      </div>

      <div className="flex flex-col gap-1">
        <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
          Destination hotkey
        </span>
        <SearchInput
          value={destinationHotkeyInput}
          onChange={onDestinationHotkeyChange}
          placeholder="5…"
          className="font-mono"
        />
      </div>

      <div className="flex flex-col gap-1">
        <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
          Destination subnet
        </span>
        <select
          value={destinationNetuidInput}
          onChange={(e) => onDestinationNetuidChange(e.target.value)}
          className="h-9 rounded border border-border bg-card px-2 font-mono text-[12px] text-ink-strong"
        >
          {knownSubnets.map((s) => (
            <option key={s.netuid} value={s.netuid}>
              {s.netuid === 0 ? "Root" : `SN${s.netuid}`}
              {s.name ? ` — ${s.name}` : ""}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
            Amount (α)
          </span>
          <SearchInput
            value={amountInput}
            onChange={onAmountInputChange}
            placeholder="0.00 α"
            inputMode="decimal"
            className="w-40 flex-none font-mono tabular-nums"
          />
        </div>
        <button
          type="button"
          onClick={onApplyMax}
          disabled={maxAmountInput == null}
          className="min-h-8 rounded border border-border bg-card px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest text-ink-muted hover:text-ink-strong hover:border-ink/30 transition-colors disabled:opacity-50"
        >
          Max
        </button>
      </div>

      {axisIssueMessage ? (
        <p className="inline-flex items-center gap-1.5 font-mono text-[11px] text-health-down">
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
          {axisIssueMessage}
        </p>
      ) : null}

      {axis === "subnet" && hasValidAmount ? (
        quoteError ? (
          <p className="inline-flex items-center gap-1.5 font-mono text-[11px] text-health-down">
            <AlertCircle className="size-3.5 shrink-0" aria-hidden />
            {quoteError}
          </p>
        ) : quoteIsPending ? (
          <p className="inline-flex items-center gap-1.5 font-mono text-[11px] text-ink-muted">
            <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
            Calculating…
          </p>
        ) : quote ? (
          <p className="font-mono text-[11px] text-ink-strong">{formatQuoteHint(quote)}</p>
        ) : null
      ) : null}

      {axis === "hotkey" ? (
        <p className="font-mono text-[10px] text-ink-muted">
          Same-subnet hotkey moves are a pure reassignment — no AMM, no slippage.
        </p>
      ) : null}

      {validationMessages.length > 0 ? (
        <ul className="space-y-1">
          {validationMessages.map((message) => (
            <li
              key={message}
              className="inline-flex items-center gap-1.5 font-mono text-[11px] text-health-down"
            >
              <AlertCircle className="size-3.5 shrink-0" aria-hidden />
              {message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
