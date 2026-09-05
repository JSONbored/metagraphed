import { useState, type RefObject } from "react";
import { Wallet } from "lucide-react";
import { Popover, PopoverTrigger } from "@jsonbored/ui-kit";
import { ClampedPopoverContent } from "./clamped-popover-content";
import { WalletConnectPanel } from "./wallet-connect";
import { useWallet } from "@/hooks/use-wallet";
import { shortHash } from "@/lib/metagraphed/blocks";
import { classNames } from "@/lib/metagraphed/format";

/**
 * Header trigger + popover. Icon-only when disconnected, shows the truncated
 * connected address when connected (matches NetworkSwitcher's active-state
 * treatment).
 */
export function WalletConnectButton({
  label,
  returnFocusRef,
}: {
  label?: string;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const { wallet, status } = useWallet();
  const [open, setOpen] = useState(false);
  const connected = status === "connected" && wallet;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={connected ? `Wallet connected: ${wallet.address}` : "Connect wallet"}
          className={classNames(
            "inline-flex items-center gap-1.5 rounded border px-2 py-1.5 min-h-11 text-11 transition-colors",
            connected
              ? "border-ink-strong/40 bg-surface text-ink-strong"
              : "border-border bg-card text-ink-muted hover:text-ink-strong hover:border-ink/30",
          )}
        >
          <Wallet className="size-3.5" aria-hidden="true" />
          {connected ? (
            <span>{shortHash(wallet.address, 4)}</span>
          ) : label ? (
            <span>{label}</span>
          ) : null}
        </button>
      </PopoverTrigger>
      <ClampedPopoverContent
        align="end"
        className="w-80 p-3"
        onCloseAutoFocus={(event) => {
          // A contextual connect prompt unmounts on success. Its replacement
          // supplies the next focus target; Escape still returns to the trigger.
          const target = returnFocusRef?.current;
          if (target) {
            event.preventDefault();
            target.focus();
          }
        }}
      >
        <WalletConnectPanel onConnected={() => setOpen(false)} />
      </ClampedPopoverContent>
    </Popover>
  );
}

/** Keep the connection action beside the feature that requires it. */
export function WalletConnectPrompt({
  description,
  returnFocusRef,
}: {
  description: string;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  return (
    <div className="space-y-3">
      <p className="text-13 text-ink-muted">{description}</p>
      <WalletConnectButton label="Connect wallet" returnFocusRef={returnFocusRef} />
    </div>
  );
}
