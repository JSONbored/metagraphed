import { useCallback, useEffect, useState } from "react";
import {
  getConnectedWallet,
  setConnectedWallet,
  onConnectedWalletChange,
  type ConnectedWallet,
} from "@/lib/metagraphed/wallet";
import {
  hasInjectedWallet,
  connectWallet,
  type InjectedAccountWithMeta,
} from "@/lib/metagraphed/wallet-injected";

export type WalletStatus =
  "idle" | "connecting" | "no-extension" | "no-accounts" | "picking" | "connected" | "error";

/** How many accounts a connectWallet() call returned determines the next UI state. */
export function resolveConnectOutcome(accounts: InjectedAccountWithMeta[]): {
  status: "no-accounts" | "picking" | "connected";
  account?: InjectedAccountWithMeta;
} {
  if (accounts.length === 0) return { status: "no-accounts" };
  if (accounts.length === 1) return { status: "connected", account: accounts[0] };
  return { status: "picking" };
}

/**
 * The minimal persisted shape for a picked/auto-picked injected account.
 * `meta.source` is typed as a required string, but falls back to "unknown" in
 * case a misbehaving extension reports an empty one — this is a system
 * boundary (third-party extension data), not a case the type can rule out.
 */
export function toConnectedWallet(account: InjectedAccountWithMeta): ConnectedWallet {
  return { address: account.address, source: account.meta.source || "unknown" };
}

/**
 * True when a persisted wallet's address is no longer among a freshly-fetched
 * account list — the extension was uninstalled, or this site's access was
 * revoked, since the address was last persisted.
 */
export function isStaleWallet(
  wallet: ConnectedWallet,
  accounts: InjectedAccountWithMeta[],
): boolean {
  return !accounts.some((account) => account.address === wallet.address);
}

/**
 * The wallet-connect flow (#5236): connect → pick an account (if more than one) →
 * persist. Read-only — never constructs or signs anything (see wallet-injected.ts's
 * header comment and docs/adr/0018-native-staking-architecture.md).
 */
export function useWallet() {
  const [wallet, setWallet] = useState<ConnectedWallet | null>(() => getConnectedWallet());
  const [status, setStatus] = useState<WalletStatus>(() => (wallet ? "connected" : "idle"));
  const [accounts, setAccounts] = useState<InjectedAccountWithMeta[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(
    () =>
      onConnectedWalletChange((next) => {
        setWallet(next);
        setStatus(next ? "connected" : "idle");
      }),
    [],
  );

  // Re-verify a persisted wallet is still exposed on mount, client-only. An
  // extension can be uninstalled or have this site's access revoked between
  // visits; blindly trusting the persisted value would show a falsely-connected
  // UI. Best-effort — a transient failure here keeps the persisted wallet as-is
  // rather than disconnecting on a fluke.
  useEffect(() => {
    const persisted = getConnectedWallet();
    if (!persisted) return;
    let cancelled = false;
    connectWallet()
      .then((fresh) => {
        if (!cancelled && isStaleWallet(persisted, fresh)) {
          setConnectedWallet(null);
        }
      })
      .catch(() => {
        /* best-effort re-verify; keep the persisted wallet on a transient failure */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const connect = useCallback(async () => {
    if (!hasInjectedWallet()) {
      setStatus("no-extension");
      return;
    }
    setStatus("connecting");
    setError(null);
    try {
      const fresh = await connectWallet();
      setAccounts(fresh);
      const outcome = resolveConnectOutcome(fresh);
      setStatus(outcome.status);
      if (outcome.status === "connected" && outcome.account) {
        setConnectedWallet(toConnectedWallet(outcome.account));
      }
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Failed to connect wallet");
    }
  }, []);

  const selectAccount = useCallback((account: InjectedAccountWithMeta) => {
    setConnectedWallet(toConnectedWallet(account));
    setStatus("connected");
  }, []);

  const disconnect = useCallback(() => {
    setConnectedWallet(null);
    setAccounts([]);
    setStatus("idle");
  }, []);

  return {
    wallet,
    status,
    accounts,
    error,
    hasExtension: hasInjectedWallet(),
    connect,
    selectAccount,
    disconnect,
  };
}
