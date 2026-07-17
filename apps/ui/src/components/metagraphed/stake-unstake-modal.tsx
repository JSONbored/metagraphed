import { useRef, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@jsonbored/ui-kit";
import { WalletConnectPanel } from "@/components/metagraphed/wallet-connect";
import { StakeAmountInput } from "@/components/metagraphed/stake-amount-input";
import { PreSignConfirmation } from "@/components/metagraphed/pre-sign-confirmation";
import { shortHash } from "@/lib/metagraphed/blocks";
import { rawAlphaToAlpha } from "@/lib/metagraphed/units";
import type { BroadcastStatus } from "@/lib/metagraphed/broadcast";
import type { DecodedTxError } from "@/lib/metagraphed/tx-errors";
import {
  useStakeFlow,
  type StakeFlowAction,
  type UseStakeFlowResult,
} from "@/hooks/use-stake-flow";

// #5242: the native-staking epic's MVP centerpiece -- wires every primitive
// from #5236-#5241 into one real stake/unstake flow for a concrete
// (hotkey, netuid) pair. Self-contained open/setOpen, mirroring
// subnet-compare-drawer.tsx's pattern: `trigger` is a render prop so the
// caller controls what opens this (a table-row action, in the first usage)
// without this file needing to know its markup.
//
// useStakeFlow is called unconditionally here, above <Sheet>, so its state
// (typed amount, in-flight tx, session id) survives the Sheet visually
// closing and reopening rather than resetting on every click -- only a
// guarded close() or a completed flow actually clears it.

const ACTION_VERB: Record<StakeFlowAction, string> = { stake: "Stake", unstake: "Unstake" };

/** Human copy for every in-flight broadcast status between "signing" and a terminal state. */
export function broadcastStatusLabel(status: BroadcastStatus): string {
  switch (status) {
    case "future":
    case "ready":
      return "Preparing to broadcast…";
    case "broadcast":
      return "Broadcasting to the network…";
    case "in-block":
      return "Included in a block — waiting for finality…";
    case "finalized":
      return "Finalized.";
    case "retracted":
      return "The including block was retracted — waiting to be re-included…";
    case "finality-timeout":
      return "Taking longer than expected to finalize.";
    case "usurped":
      return "Replaced by another transaction with the same nonce.";
    case "dropped":
      return "Dropped from the transaction pool.";
    case "invalid":
      return "Rejected as invalid by the network.";
    case "error":
      return "Something went wrong broadcasting this transaction.";
  }
}

export interface StakeUnstakeModalProps {
  hotkey: string;
  netuid: number;
  subnetName?: string;
  validatorName?: string;
  trigger: (open: () => void) => ReactNode;
}

export function StakeUnstakeModal({
  hotkey,
  netuid,
  subnetName,
  validatorName,
  trigger,
}: StakeUnstakeModalProps) {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // A ref, not just the `submitting` state: React batches the state update
  // from a click handler, so the DOM button's `disabled` attribute doesn't
  // actually flip until the next render -- a genuine double-click can fire a
  // second handler invocation before that happens. A ref mutates immediately,
  // synchronously, closing that window at the earliest possible point.
  // broadcast.ts's idempotency-key check is still the real, provable
  // fund-safety guard underneath this (see submitStakeExtrinsic's own
  // concurrent-race test) -- this ref only prevents the confusing UX of a
  // benign duplicate click surfacing as a transient "submit-error" flash
  // while the real submission is still awaiting a signature.
  const confirmInFlightRef = useRef(false);
  const flow = useStakeFlow(hotkey, netuid);

  const handleOpenChange = (next: boolean) => {
    if (next) {
      setOpen(true);
      return;
    }
    if (!flow.canClose) return; // signAndSend runs outside React's control -- see useStakeFlow's canClose doc comment
    flow.close();
    setOpen(false);
  };

  const handleConfirm = async () => {
    if (confirmInFlightRef.current) return;
    confirmInFlightRef.current = true;
    setSubmitting(true);
    try {
      await flow.submit();
    } finally {
      confirmInFlightRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      {/* #6415: the trigger was a plain sibling of <Sheet>, not its trigger, so
          Radix had no trigger node to restore focus to on close -- closing the
          modal dropped focus to <body>. Wrapping the caller's render-prop element
          in <SheetTrigger asChild> inside <Sheet> is the same fix landed for
          SubnetCompareDrawer (#6527) and TakeManagementModal (#6531): Radix
          tracks it and returns focus. */}
      <SheetTrigger asChild>{trigger(() => setOpen(true))}</SheetTrigger>
      <SheetContent side="right" className="flex w-full flex-col overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="font-display text-lg">
            {ACTION_VERB[flow.action]} · {validatorName ?? shortHash(hotkey, 6)}
          </SheetTitle>
          <SheetDescription>
            {subnetName ? `${subnetName} (SN${netuid})` : `Subnet ${netuid}`}
            {!flow.canClose ? " — this can't be closed while a signature is in flight." : ""}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 flex-1">
          <StakeFlowBody
            hotkey={hotkey}
            netuid={netuid}
            subnetName={subnetName}
            validatorName={validatorName}
            flow={flow}
            submitting={submitting}
            onConfirm={handleConfirm}
            onClose={() => handleOpenChange(false)}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}

function StakeFlowBody({
  hotkey,
  netuid,
  subnetName,
  validatorName,
  flow,
  submitting,
  onConfirm,
  onClose,
}: {
  hotkey: string;
  netuid: number;
  subnetName?: string;
  validatorName?: string;
  flow: UseStakeFlowResult;
  submitting: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  switch (flow.phase) {
    case "connect":
      return <WalletConnectPanel />;

    case "amount":
      return (
        <div className="flex h-full flex-col">
          <div className="flex-1">
            <StakeAmountInput
              action={flow.action}
              onActionChange={flow.setAction}
              unit={flow.unit}
              onUnitChange={flow.setUnit}
              amountInput={flow.amountInput}
              onAmountInputChange={flow.setAmountInput}
              maxStakeRao={flow.maxStakeRao}
              onApplyMaxStake={flow.applyMaxStake}
              maxUnstakeAmountInput={flow.maxUnstakeAmountInput}
              maxUnstakeUnavailable={flow.maxUnstakeUnavailable}
              positionCapturedAt={flow.positionCapturedAt}
              onApplyMaxUnstake={flow.applyMaxUnstake}
              quote={flow.quote}
              quoteIsPending={flow.quoteIsPending}
              quoteError={flow.quoteError}
              validationMessages={flow.validationMessages}
            />
          </div>
          <SheetFooter className="mt-4">
            <button
              type="button"
              onClick={flow.confirm}
              disabled={!flow.canConfirm}
              className="w-full rounded border border-ink-strong/40 bg-surface px-3 py-2 text-[12px] font-medium text-ink-strong transition-colors hover:border-ink-strong/60 disabled:opacity-50"
            >
              Review {ACTION_VERB[flow.action].toLowerCase()}
            </button>
          </SheetFooter>
        </div>
      );

    case "confirm":
      return (
        <PreSignConfirmation
          action={flow.action}
          amountTao={confirmAmountTao(flow)}
          amountAlpha={confirmAmountAlpha(flow)}
          hotkey={hotkey}
          validatorName={validatorName}
          netuid={netuid}
          subnetName={subnetName}
          feeTao={flow.feeTao}
          expectedOut={
            flow.quote
              ? { amount: String(flow.quote.expected_out), unit: flow.quote.expected_out_unit }
              : undefined
          }
          priceImpactPct={flow.quote?.price_impact_pct}
          tolerancePct={flow.tolerancePct}
          confirming={submitting}
          onConfirm={onConfirm}
          onCancel={flow.editAmount}
        />
      );

    case "signing":
    case "broadcasting":
      return (
        <StatusView
          icon={<Loader2 className="size-6 animate-spin text-ink-muted" aria-hidden />}
          message={
            flow.phase === "signing"
              ? "Awaiting your signature…"
              : broadcastStatusLabel(flow.txStatus.status as BroadcastStatus)
          }
          txHash={flow.txStatus.txHash}
        />
      );

    case "failed":
      return (
        <div className="flex flex-col items-center gap-4 py-10 text-center">
          <AlertTriangle className="size-6 text-health-down" aria-hidden />
          <p className="text-[13px] text-ink-strong">{describeTxError(flow.txStatus.error)}</p>
          <button
            type="button"
            onClick={flow.editAmount}
            className="rounded border border-border bg-card px-3 py-2 text-[12px] font-medium text-ink-strong transition-colors hover:border-ink/30"
          >
            Edit amount and try again
          </button>
        </div>
      );

    case "done":
      return (
        <StatusView
          icon={<CheckCircle2 className="size-6 text-health-ok" aria-hidden />}
          message="Finalized."
          txHash={flow.txStatus.txHash}
          onClose={onClose}
        />
      );
  }
}

function StatusView({
  icon,
  message,
  txHash,
  onClose,
}: {
  icon: ReactNode;
  message: string;
  txHash: string | null;
  onClose?: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-4 py-10 text-center">
      {icon}
      <p className="text-[13px] text-ink-strong">{message}</p>
      {txHash ? (
        <div className="space-y-1">
          <Link
            to="/extrinsics/$hash"
            params={{ hash: txHash }}
            className="font-mono text-[11px] text-accent hover:underline"
          >
            {shortHash(txHash, 8)}
          </Link>
          <p className="text-[10px] text-ink-muted">
            May take a few moments to appear once indexed.
          </p>
        </div>
      ) : null}
      {onClose ? (
        <button
          type="button"
          onClick={onClose}
          className="rounded border border-border bg-card px-3 py-2 text-[12px] font-medium text-ink-strong transition-colors hover:border-ink/30"
        >
          Done
        </button>
      ) : null}
    </div>
  );
}

function describeTxError(error: DecodedTxError | null): string {
  return error?.message ?? "The transaction failed.";
}

/** The confirm screen's TAO display -- always the typed value for stake; for unstake, the typed value in TAO mode or the live quote's TAO estimate in alpha mode. */
function confirmAmountTao(flow: UseStakeFlowResult): string {
  if (flow.action === "stake") return flow.amountInput;
  if (flow.unit === "tao") return flow.amountInput;
  return flow.quote?.expected_out != null ? String(flow.quote.expected_out) : flow.amountInput;
}

/** The confirm screen's alpha display -- for unstake, reconstructed from the exact RawAlpha this params object will submit (never a re-derived estimate), so what's shown is exactly what gets signed. */
function confirmAmountAlpha(flow: UseStakeFlowResult): string | undefined {
  if (flow.params?.call === "remove_stake_limit") {
    return rawAlphaToAlpha(flow.params.amountUnstaked);
  }
  if (flow.action === "stake" && flow.quote?.expected_out_unit === "alpha") {
    return String(flow.quote.expected_out);
  }
  return undefined;
}
