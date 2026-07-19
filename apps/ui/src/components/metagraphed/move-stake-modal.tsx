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
import { MoveStakeDestinationInput } from "@/components/metagraphed/move-stake-destination-input";
import { PreSignConfirmation } from "@/components/metagraphed/pre-sign-confirmation";
import { broadcastStatusLabel } from "@/components/metagraphed/stake-unstake-modal";
import { shortHash } from "@/lib/metagraphed/blocks";
import { rawAlphaToAlpha } from "@/lib/metagraphed/units";
import type { BroadcastStatus } from "@/lib/metagraphed/broadcast";
import type { DecodedTxError } from "@/lib/metagraphed/tx-errors";
import {
  useMoveStakeFlow,
  formatSpotValueTao,
  type UseMoveStakeFlowResult,
} from "@/hooks/use-move-stake-flow";

// #5244: the move/re-delegate stake flow -- a "Move this position" entry
// point from the your-positions panel. Structurally mirrors
// stake-unstake-modal.tsx / take-management-modal.tsx (same trigger-render-
// prop pattern, same hook-mounted-above-<Sheet> lifetime, same close-guard,
// same reentrancy guard on the confirm button) but its "amount" step is
// bespoke (a destination hotkey+subnet picker, not an action tablist) while
// its "confirm" step reuses PreSignConfirmation completely unchanged -- see
// use-move-stake-flow.ts's header comment for why a single-axis move maps
// cleanly onto that screen's existing single-hotkey/single-netuid shape.
//
// No new signing logic: useMoveStakeFlow composes the same buildExtrinsic /
// broadcast.ts / useTxStatus primitives every other flow in this app uses,
// unchanged.

export interface MoveStakeModalProps {
  hotkey: string;
  netuid: number;
  subnetName?: string;
  validatorName?: string;
  positionAlpha: number | null;
  positionSpotTao: number;
  trigger: (open: () => void) => ReactNode;
}

export function MoveStakeModal({
  hotkey,
  netuid,
  subnetName,
  validatorName,
  positionAlpha,
  positionSpotTao,
  trigger,
}: MoveStakeModalProps) {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Same rationale as StakeUnstakeModal's confirmInFlightRef: a synchronous
  // ref, not just React state, closes the double-click window before the
  // batched state update would.
  const confirmInFlightRef = useRef(false);
  const flow = useMoveStakeFlow(hotkey, netuid, positionAlpha, positionSpotTao);

  const handleOpenChange = (next: boolean) => {
    if (next) {
      setOpen(true);
      return;
    }
    if (!flow.canClose) return; // signAndSend runs outside React's control -- see useMoveStakeFlow's canClose doc comment
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
      {/* Same focus-restoration fix as StakeUnstakeModal (#6415)/TakeManagementModal (#6419): wrap the
          render-prop trigger in <SheetTrigger asChild> inside <Sheet> so Radix has a node to return
          focus to on close. */}
      <SheetTrigger asChild>{trigger(() => setOpen(true))}</SheetTrigger>
      <SheetContent side="right" className="flex w-full flex-col overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="font-display text-lg">
            Move stake · {validatorName ?? shortHash(hotkey, 6)}
          </SheetTitle>
          <SheetDescription>
            {subnetName ? `${subnetName} (SN${netuid})` : `Subnet ${netuid}`}
            {!flow.canClose ? " — this can't be closed while a signature is in flight." : ""}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 flex-1">
          <MoveStakeFlowBody
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

function MoveStakeFlowBody({
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
  flow: UseMoveStakeFlowResult;
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
            <MoveStakeDestinationInput
              originHotkey={hotkey}
              originNetuid={netuid}
              originValidatorName={validatorName}
              originSubnetName={subnetName}
              destinationHotkeyInput={flow.destinationHotkeyInput}
              onDestinationHotkeyChange={flow.setDestinationHotkeyInput}
              destinationNetuidInput={flow.destinationNetuidInput}
              onDestinationNetuidChange={flow.setDestinationNetuidInput}
              knownSubnets={flow.knownSubnets}
              amountInput={flow.amountInput}
              onAmountInputChange={flow.setAmountInput}
              maxAmountInput={flow.maxAmountInput}
              onApplyMax={flow.applyMax}
              axis={flow.axis}
              axisIssueMessage={flow.axisIssueMessage}
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
              Review move
            </button>
          </SheetFooter>
        </div>
      );

    case "confirm":
      return (
        <PreSignConfirmation
          action="move"
          amountTao={confirmAmountTao(flow)}
          amountAlpha={confirmAmountAlpha(flow)}
          hotkey={confirmHotkey(flow)}
          validatorName={flow.axis === "hotkey" ? undefined : validatorName}
          netuid={confirmNetuid(flow)}
          subnetName={flow.axis === "subnet" ? undefined : subnetName}
          feeTao={flow.feeTao}
          expectedOut={
            flow.axis === "subnet" && flow.quote
              ? { amount: String(flow.quote.expected_out), unit: flow.quote.expected_out_unit }
              : undefined
          }
          priceImpactPct={flow.axis === "subnet" ? flow.quote?.price_impact_pct : undefined}
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
            Edit and try again
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

/** The confirm screen's single hotkey -- always the destination, which equals the origin hotkey unchanged when only the subnet axis moved. */
function confirmHotkey(flow: UseMoveStakeFlowResult): string {
  return flow.destinationHotkeyInput.trim() || flow.originHotkey;
}

/** The confirm screen's single netuid -- always the destination, which equals the origin netuid unchanged when only the hotkey axis moved. */
function confirmNetuid(flow: UseMoveStakeFlowResult): number {
  const parsed = Number(flow.destinationNetuidInput);
  return Number.isFinite(parsed) ? parsed : flow.originNetuid;
}

/** The confirm screen's TAO display -- the live unstake-direction quote's TAO estimate for a subnet move (the leg limit_price actually protects), or a spot-mark estimate for a riskless hotkey-only move (no AMM, no quote). canConfirm already requires originSpotPriceTao to be resolved before "confirm" is reachable, so the fallback below is never actually exercised with a null price -- it's a defensive default, not a silent-wrong-number path. */
function confirmAmountTao(flow: UseMoveStakeFlowResult): string {
  if (flow.axis === "subnet" && flow.quote) return String(flow.quote.expected_out);
  if (flow.originSpotPriceTao == null) return "0";
  return formatSpotValueTao(Number(flow.amountInput) || 0, flow.originSpotPriceTao);
}

/** The confirm screen's alpha display -- reconstructed from the exact RawAlpha this params object will submit (never a re-derived estimate), so what's shown is exactly what gets signed. */
function confirmAmountAlpha(flow: UseMoveStakeFlowResult): string | undefined {
  return flow.params ? rawAlphaToAlpha(flow.params.alphaAmount) : undefined;
}
