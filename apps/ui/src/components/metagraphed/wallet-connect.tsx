import { Link } from "@tanstack/react-router";
import { Wallet, Check, LogOut, Loader2, ShieldCheck } from "lucide-react";
import { ExternalLink } from "@jsonbored/ui-kit";
import { EmptyState } from "./states";
import { AddressDisplay } from "@/components/metagraphed/address-display";
import { AddressLabelEditor } from "@/components/metagraphed/address-label-editor";
import { useWallet } from "@/hooks/use-wallet";
import { shortHash } from "@/lib/metagraphed/blocks";
import type { InjectedAccountWithMeta } from "@/lib/metagraphed/wallet-injected";

// Non-custodial staking rail #5236 — read-only wallet connect (web3Enable →
// web3Accounts → pick → persist). NO signing here; that's a later issue (#5237+),
// see docs/adr/0018-native-staking-architecture.md. Deliberately distinct wording
// from (but consistent with) the About page's non-custodial disclaimer (PR #5282) —
// this copy is scoped to what THIS step does, not the product overall.
const DISCLAIMER =
  "metagraphed never sees your keys. Connecting only shares your public address — signing (a later step) always happens in your wallet, never on our servers.";

const SUPPORTED_WALLETS = [
  { label: "Polkadot{.js}", href: "https://polkadot.js.org/extension/" },
  { label: "Talisman", href: "https://talisman.xyz/" },
  { label: "SubWallet", href: "https://subwallet.app/" },
];

/**
 * The connect/picker/connected content, without the popover chrome — split out
 * from WalletConnectButton (mirrors SettingsPopover/SettingsPanel) so it can be
 * reused wherever wallet state needs to be surfaced without duplicating markup.
 */
export function WalletConnectPanel({ onConnected }: { onConnected?: () => void }) {
  const { wallet, status, accounts, error, hasExtension, connect, selectAccount, disconnect } =
    useWallet();

  if (status === "connected" && wallet) {
    // #8484: pre-fill "Label this as mine" with the extension's own account
    // name where present -- only populated this session, after an actual
    // connect() call (accounts resets to [] on reload), so this is a
    // best-effort convenience, not something the editor depends on.
    const accountName = accounts.find((a) => a.address === wallet.address)?.meta.name;
    return <ConnectedView wallet={wallet} accountName={accountName} onDisconnect={disconnect} />;
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
        <div className="rounded border border-border bg-surface px-2 py-1.5 text-13 text-ink-muted">
          No accounts available — open your wallet extension and make sure at least one account is
          shared with this site.
        </div>
      ) : null}
      {status === "error" ? (
        <div
          role="alert"
          className="rounded border border-health-down/30 bg-health-down/5 px-2 py-1.5 text-13 text-health-down"
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
        className="w-full inline-flex items-center justify-center gap-1.5 rounded border border-border bg-card px-3 py-2 text-13 font-medium text-ink-strong hover:border-ink/30 transition-colors disabled:opacity-60"
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
    <div className="flex items-start gap-1.5 text-13 text-ink-muted">
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
        {SUPPORTED_WALLETS.map((w) => (
          <li key={w.label}>
            <ExternalLink
              href={w.href}
              className="w-full justify-between gap-2 rounded border border-border bg-card px-2 py-1.5 text-13 text-ink-strong hover:border-ink/30 transition-colors"
            >
              {w.label}
            </ExternalLink>
          </li>
        ))}
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
      <div className="text-10 text-ink-muted mb-1">Choose an account</div>
      <ul className="space-y-1">
        {accounts.map((account) => (
          <li key={account.address}>
            <button
              type="button"
              onClick={() => onSelect(account)}
              className="w-full flex items-center gap-2 rounded border border-border bg-card px-2 py-1.5 text-left transition-colors hover:border-ink/30 min-h-9"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-13 font-medium text-ink-strong truncate">
                  {account.meta.name || shortHash(account.address, 6)}
                </span>
                <span className="block text-13 text-ink-muted truncate">
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
  accountName,
  onDisconnect,
}: {
  wallet: { address: string; source: string };
  accountName?: string;
  onDisconnect: () => void;
}) {
  return (
    <div className="space-y-3">
      <div className="rounded border border-ink-strong/40 bg-surface px-2 py-2">
        <div className="flex items-center gap-2">
          <Check className="size-3.5 text-health-ok shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <AddressDisplay
              ss58={wallet.address}
              fallback={<>{wallet.address}</>}
              keep={6}
              valueClassName="block text-13 font-medium text-ink-strong font-mono truncate"
            />
            <span className="block text-13 text-ink-muted">Connected via {wallet.source}</span>
          </span>
        </div>
      </div>
      {/* #8484: one-click entry point into the private-label editor, pre-filled
          from the extension's own account name where available. */}
      <AddressLabelEditor ss58={wallet.address} defaultName={accountName} trigger="button" />
      {/* Public account details need the selected address, without a signed session. */}
      <Link
        to="/accounts/$ss58"
        params={{ ss58: wallet.address }}
        className="w-full min-h-11 inline-flex items-center justify-center gap-1.5 rounded border border-accent/40 bg-primary-soft px-3 py-1.5 text-13 font-medium text-ink-strong hover:bg-primary-soft/80 transition-colors"
      >
        <Wallet className="size-3.5" aria-hidden="true" />
        View your account
      </Link>
      <button
        type="button"
        onClick={onDisconnect}
        className="w-full inline-flex items-center justify-center gap-1.5 rounded border border-border bg-card px-3 py-1.5 text-13 font-medium text-ink-muted hover:text-ink-strong hover:border-ink/30 transition-colors"
      >
        <LogOut className="size-3.5" aria-hidden="true" />
        Disconnect
      </button>
      <p className="flex items-start gap-1.5 text-13 text-ink-muted">
        <ShieldCheck className="mt-0.5 size-2.5 shrink-0" aria-hidden="true" />
        <span>metagraphed never sees your keys.</span>
      </p>
    </div>
  );
}
