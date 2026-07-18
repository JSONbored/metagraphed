import { useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  Wallet,
  Check,
  Copy,
  LogOut,
  Loader2,
  ShieldCheck,
  ExternalLink as ExternalLinkIcon,
} from "lucide-react";
import { Popover, PopoverTrigger, safeExternalUrl } from "@jsonbored/ui-kit";
import { ClampedPopoverContent } from "./clamped-popover-content";
import { EmptyState } from "./states";
import { useWallet } from "@/hooks/use-wallet";
import { useCopy } from "@/hooks/use-copy";
import { shortHash } from "@/lib/metagraphed/blocks";
import { classNames } from "@/lib/metagraphed/format";
import type { InjectedAccountWithMeta } from "@/lib/metagraphed/wallet-injected";

// Non-custodial staking rail #5236 — read-only wallet connect (web3Enable →
// web3Accounts → pick → persist). NO signing here; that's a later issue (#5237+),
// see docs/adr/0018-native-staking-architecture.md. Deliberately distinct wording
// from (but consistent with) the About page's non-custodial disclaimer (PR #5282) —
// this copy is scoped to what THIS step does, not the product overall.
const DISCLAIMER =
  "metagraphed never sees your keys. Connecting only shares your public address — signing (a later step) always happens in your wallet, never on our servers.";

// Taostats Wallet added after ADR 0018 was written -- it's a modified
// Talisman wallet (per Taostats' own announcement), so it implements the
// same window.injectedWeb3 standard the other three do; no code change to
// the connect flow itself was needed, only this list. Listed despite
// Taostats being a competing block explorer -- the wallet is a largely
// orthogonal product category, and it's purpose-built for exactly this
// epic's use case (native Bittensor staking), so omitting it would be a
// disservice to users picking a wallet for this specific reason.
const SUPPORTED_WALLETS = [
  { label: "Polkadot{.js}", href: "https://polkadot.js.org/extension/" },
  { label: "Talisman", href: "https://talisman.xyz/" },
  { label: "SubWallet", href: "https://subwallet.app/" },
  { label: "Taostats Wallet", href: "https://taostats.io/bittensor-chrome-wallet" },
];

/**
 * Header trigger + popover. Icon-only when disconnected, shows the truncated
 * connected address when connected (matches NetworkSwitcher's active-state
 * treatment).
 */
export function WalletConnectButton() {
  const { wallet, status } = useWallet();
  const [open, setOpen] = useState(false);
  const connected = status === "connected" && wallet;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={connected ? `Wallet connected: ${wallet.address}` : "Connect wallet"}
          title={connected ? `Connected · ${wallet.source} · ${wallet.address}` : "Connect wallet"}
          className={classNames(
            "inline-flex items-center gap-1.5 rounded border px-2 py-1.5 min-h-11 text-[11px] font-mono transition-colors",
            connected
              ? "border-ink-strong/40 bg-surface text-ink-strong"
              : "border-border bg-card text-ink-muted hover:text-ink-strong hover:border-ink/30",
          )}
        >
          <Wallet className="size-3.5" aria-hidden="true" />
          {connected ? <span>{shortHash(wallet.address, 4)}</span> : null}
        </button>
      </PopoverTrigger>
      <ClampedPopoverContent align="end" className="w-80 p-3">
        <WalletConnectPanel onConnected={() => setOpen(false)} />
      </ClampedPopoverContent>
    </Popover>
  );
}

/**
 * The connect/picker/connected content, without the popover chrome — split out
 * from WalletConnectButton (mirrors SettingsPopover/SettingsPanel) so it can be
 * reused wherever wallet state needs to be surfaced without duplicating markup.
 */
export function WalletConnectPanel({ onConnected }: { onConnected?: () => void }) {
  const { wallet, status, accounts, error, hasExtension, connect, selectAccount, disconnect } =
    useWallet();

  if (status === "connected" && wallet) {
    return <ConnectedView wallet={wallet} onDisconnect={disconnect} />;
  }

  if (status === "picking") {
    return (
      <AccountPicker
        accounts={accounts}
        onSelect={(account) => {
          selectAccount(account);
          onConnected?.();
        }}
      />
    );
  }

  if (!hasExtension || status === "no-extension") {
    return <NoExtensionView />;
  }

  return (
    <div className="space-y-3">
      <Disclaimer />
      {status === "no-accounts" ? (
        <div className="rounded border border-border bg-surface/40 px-2 py-1.5 text-[11px] text-ink-muted">
          No accounts available — open your wallet extension and make sure at least one account is
          shared with this site.
        </div>
      ) : null}
      {status === "error" ? (
        <div
          role="alert"
          className="rounded border border-health-down/30 bg-health-down/5 px-2 py-1.5 text-[11px] text-health-down"
        >
          {error ?? "Failed to connect wallet."}
        </div>
      ) : null}
      <button
        type="button"
        onClick={async () => {
          await connect();
        }}
        disabled={status === "connecting"}
        className="w-full inline-flex items-center justify-center gap-1.5 rounded border border-border bg-card px-3 py-2 text-[12px] font-medium text-ink-strong hover:border-ink/30 transition-colors disabled:opacity-60"
      >
        {status === "connecting" ? (
          <>
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            Connecting…
          </>
        ) : (
          <>
            <Wallet className="size-3.5" aria-hidden="true" />
            Connect Wallet
          </>
        )}
      </button>
    </div>
  );
}

function Disclaimer() {
  return (
    <div className="flex items-start gap-1.5 text-[10px] text-ink-muted">
      <ShieldCheck className="mt-0.5 size-3 shrink-0 text-ink-muted" aria-hidden="true" />
      <span>{DISCLAIMER}</span>
    </div>
  );
}

function NoExtensionView() {
  return (
    <div className="space-y-3">
      <Disclaimer />
      <EmptyState
        title="No wallet extension found"
        description="Install a supported extension, then reopen this menu."
      />
      <ul className="space-y-1">
        {SUPPORTED_WALLETS.map((w) => {
          const href = safeExternalUrl(w.href);
          if (!href) return null;
          return (
            <li key={w.label}>
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-between gap-2 rounded border border-border bg-card px-2 py-1.5 text-[11px] text-ink-strong hover:border-ink/30 transition-colors"
              >
                {w.label}
                <ExternalLinkIcon className="size-3 text-ink-muted" aria-hidden="true" />
              </a>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function AccountPicker({
  accounts,
  onSelect,
}: {
  accounts: InjectedAccountWithMeta[];
  onSelect: (account: InjectedAccountWithMeta) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="mg-label mb-1">Choose an account</div>
      <ul className="space-y-1">
        {accounts.map((account) => (
          <li key={account.address}>
            <button
              type="button"
              onClick={() => onSelect(account)}
              className="w-full flex items-center gap-2 rounded border border-border bg-card px-2 py-1.5 text-left transition-colors hover:border-ink/30 min-h-9"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-[12px] font-medium text-ink-strong truncate">
                  {account.meta.name || shortHash(account.address, 6)}
                </span>
                <span className="block text-[10px] text-ink-muted truncate">
                  {shortHash(account.address, 6)} · {account.meta.source}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ConnectedView({
  wallet,
  onDisconnect,
}: {
  wallet: { address: string; source: string };
  onDisconnect: () => void;
}) {
  const { copied, copy } = useCopy({ label: "address" });

  return (
    <div className="space-y-3">
      <div className="rounded border border-ink-strong/40 bg-surface px-2 py-2">
        <div className="flex items-center gap-2">
          <Check className="size-3.5 text-health-ok shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="block text-[12px] font-medium text-ink-strong font-mono truncate">
              {shortHash(wallet.address, 6)}
            </span>
            <span className="block text-[10px] text-ink-muted">Connected via {wallet.source}</span>
          </span>
          <button
            type="button"
            onClick={() => copy(wallet.address)}
            aria-label="Copy address"
            title="Copy address"
            className="shrink-0 rounded p-1 text-ink-muted hover:text-ink-strong"
          >
            {copied ? (
              <Check className="size-3.5 text-health-ok" aria-hidden="true" />
            ) : (
              <Copy className="size-3.5" aria-hidden="true" />
            )}
          </button>
        </div>
      </div>
      {/* #5243: the connected wallet's read-side entry point into its portfolio. */}
      <Link
        to="/portfolio"
        className="w-full inline-flex items-center justify-center gap-1.5 rounded border border-accent/40 bg-primary-soft px-3 py-1.5 text-[11px] font-medium text-ink-strong hover:bg-primary-soft/80 transition-colors"
      >
        <Wallet className="size-3.5" aria-hidden="true" />
        Your positions
      </Link>
      <button
        type="button"
        onClick={onDisconnect}
        className="w-full inline-flex items-center justify-center gap-1.5 rounded border border-border bg-card px-3 py-1.5 text-[11px] font-medium text-ink-muted hover:text-ink-strong hover:border-ink/30 transition-colors"
      >
        <LogOut className="size-3.5" aria-hidden="true" />
        Disconnect
      </button>
      <p className="flex items-start gap-1.5 text-[9px] text-ink-muted">
        <ShieldCheck className="mt-0.5 size-2.5 shrink-0" aria-hidden="true" />
        <span>metagraphed never sees your keys.</span>
      </p>
    </div>
  );
}
