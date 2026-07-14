import { useEffect, useState } from "react";
import { Coins } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@jsonbored/ui-kit";
import { shortHash } from "@/lib/metagraphed/blocks";
import {
  STAKE_ACTION_EVT,
  type StakeActionDetail,
  requestStakeAction,
} from "@/lib/metagraphed/stake-actions";

/**
 * Stake-flow shell (#5242). Amount input, quote readout, and signing land in
 * the maintainer-owned modal issue — this shell owns open/close + hotkey context.
 */
export function StakeModal({
  open,
  onOpenChange,
  hotkey,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hotkey: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md bg-paper text-ink border-border">
        <DialogHeader>
          <DialogTitle className="font-display text-lg">Stake to validator</DialogTitle>
          <DialogDescription className="text-[12px] leading-relaxed text-ink-muted">
            Delegate TAO to{" "}
            <span className="font-mono text-ink-strong">{shortHash(hotkey, 8) ?? hotkey}</span>.
            Amount entry, root vs alpha framing, and wallet signing wire through #5242.
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-lg border border-dashed border-border bg-card/60 px-4 py-6 text-center">
          <Coins className="mx-auto mb-2 size-5 text-accent" aria-hidden />
          <p className="text-[12px] text-ink-muted">
            Connect a wallet and enter an amount — the full stake modal ships in #5242.
          </p>
          <button
            type="button"
            className="mt-4 inline-flex items-center justify-center rounded border border-border bg-card px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-ink-muted hover:border-ink/30 hover:text-ink-strong"
            onClick={() => onOpenChange(false)}
          >
            Close
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Listens for `metagraphed:stake-action` stake events and opens the modal. */
export function StakeModalHost() {
  const [open, setOpen] = useState(false);
  const [hotkey, setHotkey] = useState<string | null>(null);

  useEffect(() => {
    function onStakeAction(e: Event) {
      const detail = (e as CustomEvent<StakeActionDetail>).detail;
      if (!detail?.hotkey || detail.kind !== "stake") return;
      setHotkey(detail.hotkey);
      setOpen(true);
    }
    window.addEventListener(STAKE_ACTION_EVT, onStakeAction);
    return () => window.removeEventListener(STAKE_ACTION_EVT, onStakeAction);
  }, []);

  if (!hotkey) return null;
  return <StakeModal open={open} onOpenChange={setOpen} hotkey={hotkey} />;
}

export function openStakeModal(hotkey: string) {
  requestStakeAction("stake", { hotkey });
}
