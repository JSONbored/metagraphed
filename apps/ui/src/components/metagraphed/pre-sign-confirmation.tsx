import { ArrowRight, Loader2, ShieldCheck } from "lucide-react";
import { shortHash } from "@/lib/metagraphed/blocks";
import { classNames } from "@/lib/metagraphed/format";

// The primary blind-signing mitigation (#5239, native-staking epic #5229).
// Subtensor isn't a top-tier chain in wallet metadata registries, so a user
// likely sees a raw/generic extension prompt for add_stake_limit etc, not a
// friendly one -- this screen is the real, human-readable checkpoint, shown
// BEFORE handoff to the extension. Purely presentational: every value is a
// prop, not fetched here -- data wiring (identity join, stake-quote, fee
// dry-run via lib/metagraphed/tx-fee.ts) is the caller's job, keeping this
// component trivial to test and reuse regardless of which flow drives it.

export type StakeAction = "stake" | "unstake" | "move";

const ACTION_COPY: Record<StakeAction, { verb: string; noun: string }> = {
  stake: { verb: "Stake", noun: "staking" },
  unstake: { verb: "Unstake", noun: "unstaking" },
  move: { verb: "Move stake", noun: "moving stake" },
};

export interface PreSignConfirmationProps {
  action: StakeAction;
  /** Display amount in TAO, e.g. "10.5". */
  amountTao: string;
  /** Display amount in alpha -- present for unstake/move, where the on-chain amount is alpha-denominated. */
  amountAlpha?: string;
  hotkey: string;
  /** From the identity join (#5234) -- falls back to the truncated hotkey when no identity is known. */
  validatorName?: string;
  netuid: number;
  subnetName?: string;
  /** Display fee in TAO, from lib/metagraphed/tx-fee.ts's estimateFee(). Null while the dry-run is still loading. */
  feeTao: string | null;
  /** From the stake-quote endpoint (#5235) -- the estimated result of this exact amount. */
  expectedOut?: { amount: string; unit: "tao" | "alpha" };
  priceImpactPct?: number;
  /** The slippage tolerance this transaction's limit_price was computed with (ADR 0018 §3, default 5%). */
  tolerancePct: number;
  confirming: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function PreSignConfirmation({
  action,
  amountTao,
  amountAlpha,
  hotkey,
  validatorName,
  netuid,
  subnetName,
  feeTao,
  expectedOut,
  priceImpactPct,
  tolerancePct,
  confirming,
  onConfirm,
  onCancel,
}: PreSignConfirmationProps) {
  const copy = ACTION_COPY[action];

  return (
    <div className="space-y-4">
      <div>
        <div className="mg-label mb-1">{copy.verb}</div>
        <div className="font-display text-lg font-medium text-ink-strong">
          {amountTao} τ
          {amountAlpha ? (
            <span className="ml-1.5 text-sm font-normal text-ink-muted">
              ({amountAlpha} α on subnet {netuid})
            </span>
          ) : null}
        </div>
      </div>

      <SummaryRow
        label="Validator"
        value={validatorName ?? shortHash(hotkey, 6) ?? hotkey}
        detail={validatorName ? shortHash(hotkey, 6) : undefined}
      />
      <SummaryRow
        label="Subnet"
        value={subnetName ? `${subnetName} (SN${netuid})` : `SN${netuid}`}
      />
      <SummaryRow
        label="Network fee"
        value={feeTao === null ? "Estimating…" : `${feeTao} τ`}
        loading={feeTao === null}
      />
      {expectedOut ? (
        <SummaryRow
          label="Expected outcome"
          value={`${expectedOut.amount} ${expectedOut.unit === "tao" ? "τ" : "α"}`}
          detail={
            priceImpactPct !== undefined
              ? `${priceImpactPct.toFixed(2)}% price impact · protected to ±${tolerancePct}%`
              : `protected to ±${tolerancePct}%`
          }
        />
      ) : null}

      <div className="flex items-start gap-1.5 rounded border border-border bg-surface/40 px-2.5 py-2 text-[11px] text-ink-muted">
        <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
        <span>
          metagraphed builds this transaction for your wallet to sign — we never see your keys and
          cannot move funds without your extension&rsquo;s approval.
        </span>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={confirming}
          className="flex-1 rounded border border-border bg-card px-3 py-2 text-[12px] font-medium text-ink-muted hover:text-ink-strong hover:border-ink/30 transition-colors disabled:opacity-60"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={confirming || feeTao === null}
          className="flex-1 inline-flex items-center justify-center gap-1.5 rounded border border-ink-strong/40 bg-surface px-3 py-2 text-[12px] font-medium text-ink-strong hover:border-ink-strong/60 transition-colors disabled:opacity-60"
        >
          {confirming ? (
            <>
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              Awaiting signature…
            </>
          ) : (
            <>
              {copy.verb}
              <ArrowRight className="size-3.5" aria-hidden="true" />
            </>
          )}
        </button>
      </div>
    </div>
  );
}

function SummaryRow({
  label,
  value,
  detail,
  loading,
}: {
  label: string;
  value: string;
  detail?: string;
  loading?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/60 py-1.5 last:border-b-0">
      <span className="text-[11px] text-ink-muted">{label}</span>
      <span className="text-right">
        <span
          className={classNames(
            "block text-[12px] font-medium text-ink-strong",
            loading && "animate-pulse text-ink-muted",
          )}
        >
          {value}
        </span>
        {detail ? <span className="block text-[10px] text-ink-muted">{detail}</span> : null}
      </span>
    </div>
  );
}
