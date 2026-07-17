import { useRef, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Loader2,
  ShieldCheck,
} from "lucide-react";
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
import { SearchInput } from "@/components/metagraphed/table-controls";
import { shortHash } from "@/lib/metagraphed/blocks";
import { classNames } from "@/lib/metagraphed/format";
import { broadcastStatusLabel } from "@/components/metagraphed/stake-unstake-modal";
import type { BroadcastStatus } from "@/lib/metagraphed/broadcast";
import type { DecodedTxError } from "@/lib/metagraphed/tx-errors";
import { takePartsToPercent, type TakeDirection } from "@/lib/metagraphed/take-extrinsics";
import { useTakeFlow, type UseTakeFlowResult } from "@/hooks/use-take-flow";

// #5246: validator self-service take (commission) management -- only ever
// surfaced when the connected wallet is this hotkey's owning coldkey (see
// this file's caller in validators.$hotkey.tsx for the gate). Structurally
// mirrors stake-unstake-modal.tsx (same trigger-render-prop pattern, same
// hook-mounted-above-<Sheet> lifetime, same close-guard, same reentrancy
// guard on the confirm button) but the "amount" and "confirm" screens are
// bespoke to a single network-wide percentage rather than reusing
// StakeAmountInput/PreSignConfirmation, which are shaped around a two-unit
// AMM-quoted TAO/alpha amount that doesn't fit a take percentage at all.

const DIRECTIONS: TakeDirection[] = ["increase", "decrease"];
const DIRECTION_VERB: Record<TakeDirection, string> = {
  increase: "Increase",
  decrease: "Decrease",
};

export interface TakeManagementModalProps {
  hotkey: string;
  ownerColdkey: string | null;
  validatorName?: string;
  trigger: (open: () => void) => ReactNode;
}

export function TakeManagementModal({
  hotkey,
  ownerColdkey,
  validatorName,
  trigger,
}: TakeManagementModalProps) {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Same rationale as stake-unstake-modal.tsx's confirmInFlightRef: React
  // batches the state update that disables the confirm button, so a
  // synchronous ref is what actually closes the double-click window.
  const confirmInFlightRef = useRef(false);
  const flow = useTakeFlow(hotkey, ownerColdkey);

  const handleOpenChange = (next: boolean) => {
    if (next) {
      setOpen(true);
      return;
    }
    if (!flow.canClose) return;
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
      {/* #6419: the trigger was a plain sibling of <Sheet>, not its trigger, so
          Radix had no trigger node to restore focus to on close -- closing the
          modal dropped focus to <body>. Wrapping the caller's render-prop element
          in <SheetTrigger asChild> inside <Sheet> is the same fix #6527 proved
          in-browser for SubnetCompareDrawer: Radix tracks it and returns focus. */}
      <SheetTrigger asChild>{trigger(() => setOpen(true))}</SheetTrigger>
      <SheetContent side="right" className="flex w-full flex-col overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="font-display text-lg">
            Manage take · {validatorName ?? shortHash(hotkey, 6)}
          </SheetTitle>
          <SheetDescription>
            {!flow.canClose
              ? "This can't be closed while a signature is in flight."
              : "Validator commission, network-wide"}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 flex-1">
          <TakeFlowBody
            hotkey={hotkey}
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

function TakeFlowBody({
  hotkey,
  flow,
  submitting,
  onConfirm,
  onClose,
}: {
  hotkey: string;
  flow: UseTakeFlowResult;
  submitting: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  switch (flow.phase) {
    case "connect":
      return <WalletConnectPanel />;

    case "amount":
      return <TakeAmountStep flow={flow} />;

    case "confirm":
      return (
        <TakeConfirmationStep
          hotkey={hotkey}
          flow={flow}
          confirming={submitting}
          onConfirm={onConfirm}
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

function TakeAmountStep({ flow }: { flow: UseTakeFlowResult }) {
  const hasValidPercentInput =
    flow.percentInput.trim() !== "" &&
    Number.isFinite(Number(flow.percentInput)) &&
    Number(flow.percentInput) >= 0;

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 space-y-4">
        <div
          role="tablist"
          aria-label="Increase or decrease take"
          className="inline-flex items-center rounded-md border border-border bg-card p-0.5"
        >
          {DIRECTIONS.map((d) => {
            const active = d === flow.direction;
            return (
              <button
                key={d}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => flow.setDirection(d)}
                className={classNames(
                  "min-h-8 rounded px-4 py-1.5 font-mono text-[11px] uppercase tracking-widest transition-colors",
                  active ? "bg-surface text-ink-strong" : "text-ink-muted hover:text-ink-strong",
                )}
              >
                {d}
              </button>
            );
          })}
        </div>

        <div className="flex flex-col gap-1">
          <span
            aria-hidden="true"
            className="font-mono text-[10px] uppercase tracking-widest text-ink-muted"
          >
            New take (%)
          </span>
          <SearchInput
            value={flow.percentInput}
            onChange={flow.setPercentInput}
            placeholder="0.00 %"
            inputMode="decimal"
            className="w-40 flex-none font-mono tabular-nums"
          />
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded border border-border bg-surface/40 p-3 text-[11px]">
          <dt className="text-ink-muted">Current take</dt>
          <dd className="text-right font-mono text-ink-strong">
            {flow.currentTakePct != null ? `${flow.currentTakePct.toFixed(2)}%` : "—"}
          </dd>
          <dt className="text-ink-muted">Allowed range</dt>
          <dd className="text-right font-mono text-ink-strong">
            {flow.minTakePct != null && flow.maxTakePct != null
              ? `${flow.minTakePct.toFixed(2)}% – ${flow.maxTakePct.toFixed(2)}%`
              : "—"}
          </dd>
        </dl>

        {flow.direction === "increase" && flow.cooldownDurationLabel ? (
          <p className="inline-flex items-center gap-1.5 font-mono text-[11px] text-health-down">
            <AlertCircle className="size-3.5 shrink-0" aria-hidden />
            Take was changed too recently — try again in {flow.cooldownDurationLabel}. (Decreasing
            take has no cooldown.)
          </p>
        ) : null}

        {!hasValidPercentInput ? (
          <p className="font-mono text-[11px] text-ink-muted">
            Enter a new take percentage to continue.
          </p>
        ) : null}

        {flow.validationMessages.length > 0 ? (
          <ul className="space-y-1">
            {flow.validationMessages.map((message) => (
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

      <SheetFooter className="mt-4">
        <button
          type="button"
          onClick={flow.confirm}
          disabled={!flow.canConfirm}
          className="w-full rounded border border-ink-strong/40 bg-surface px-3 py-2 text-[12px] font-medium text-ink-strong transition-colors hover:border-ink-strong/60 disabled:opacity-50"
        >
          Review {DIRECTION_VERB[flow.direction].toLowerCase()}
        </button>
      </SheetFooter>
    </div>
  );
}

function TakeConfirmationStep({
  hotkey,
  flow,
  confirming,
  onConfirm,
}: {
  hotkey: string;
  flow: UseTakeFlowResult;
  confirming: boolean;
  onConfirm: () => void;
}) {
  const newTakePct = flow.params != null ? takePartsToPercent(flow.params.take) : null;

  return (
    <div className="space-y-4">
      <div>
        <div className="mg-label mb-1">{DIRECTION_VERB[flow.direction]} take</div>
        <div className="font-display text-lg font-medium text-ink-strong">
          {newTakePct != null ? `${newTakePct.toFixed(2)}%` : "—"}
        </div>
      </div>

      <SummaryRow label="Validator hotkey" value={shortHash(hotkey, 6) ?? hotkey} />
      <SummaryRow
        label="Current take"
        value={flow.currentTakePct != null ? `${flow.currentTakePct.toFixed(2)}%` : "—"}
      />
      <SummaryRow
        label="Network fee"
        value={flow.feeTao === null ? "Estimating…" : `${flow.feeTao} τ`}
        loading={flow.feeTao === null}
      />

      <div className="flex items-start gap-1.5 rounded border border-border bg-surface/40 px-2.5 py-2 text-[11px] text-ink-muted">
        <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
        <span>
          metagraphed builds this transaction for your wallet to sign — we never see your keys and
          cannot change your take without your extension&rsquo;s approval.
        </span>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={flow.editAmount}
          disabled={confirming}
          className="flex-1 rounded border border-border bg-card px-3 py-2 text-[12px] font-medium text-ink-muted transition-colors hover:border-ink/30 hover:text-ink-strong disabled:opacity-60"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={confirming || flow.feeTao === null}
          className="flex-1 inline-flex items-center justify-center gap-1.5 rounded border border-ink-strong/40 bg-surface px-3 py-2 text-[12px] font-medium text-ink-strong transition-colors hover:border-ink-strong/60 disabled:opacity-60"
        >
          {confirming ? (
            <>
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              Awaiting signature…
            </>
          ) : (
            <>
              {DIRECTION_VERB[flow.direction]}
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
  loading,
}: {
  label: string;
  value: string;
  loading?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/60 py-1.5 last:border-b-0">
      <span className="text-[11px] text-ink-muted">{label}</span>
      <span
        className={classNames(
          "block text-[12px] font-medium text-ink-strong",
          loading && "animate-pulse text-ink-muted",
        )}
      >
        {value}
      </span>
    </div>
  );
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
