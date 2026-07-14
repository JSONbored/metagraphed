// Wallet-connect persistence (#5236, native-staking epic #5229). Read-only connect
// flow — the address persisted here is never used to sign anything; the wallet
// standard (@polkadot/extension-dapp injection) and the "no signing in v1 connect"
// scope are both locked by docs/adr/0018-native-staking-architecture.md. This module
// has zero @polkadot/* imports by design — see lib/metagraphed/wallet-injected.ts for
// the actual extension boundary.

import { isValidSs58 } from "./accounts";

export interface ConnectedWallet {
  /** ss58 account address, the only identifier ever persisted. */
  address: string;
  /** account.meta.source from web3Accounts(), e.g. "polkadot-js" | "talisman" | "subwallet-js". */
  source: string;
}

const STORAGE_KEY = "metagraphed:wallet";
const EVT = "metagraphed:wallet-changed";

// Unlike config.ts's API base / network (where the default is a truthy value, so a
// falsy cache slot unambiguously means "not yet read"), this module's default state
// IS null (disconnected) — a plain `ConnectedWallet | null` cache can't distinguish
// "not yet read" from "read as disconnected." `undefined` = unread, `null` = read and
// disconnected, matching the single-read-then-cache guarantee config.ts's cache gives.
let cached: ConnectedWallet | null | undefined;

function isConnectedWallet(value: unknown): value is ConnectedWallet {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.address === "string" &&
    isValidSs58(v.address) &&
    typeof v.source === "string" &&
    v.source.length > 0
  );
}

function readStored(): ConnectedWallet | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isConnectedWallet(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Currently connected wallet (address + extension source), or null if disconnected. Safe in both SSR and CSR. */
export function getConnectedWallet(): ConnectedWallet | null {
  if (cached !== undefined) return cached;
  const next = readStored();
  cached = next;
  return next;
}

/**
 * Connect (persist) or disconnect (pass null) a wallet. Dispatches an event
 * subscribers can react to. Disconnecting removes the localStorage key entirely
 * rather than storing a null sentinel, matching config.ts's "default value removes
 * the key" convention — disconnected genuinely is this module's default state.
 */
export function setConnectedWallet(wallet: ConnectedWallet | null) {
  const next = wallet && isConnectedWallet(wallet) ? wallet : null;
  cached = next;
  if (typeof window !== "undefined") {
    try {
      if (next === null) window.localStorage.removeItem(STORAGE_KEY);
      else window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
    window.dispatchEvent(new CustomEvent(EVT, { detail: next }));
  }
}

export function onConnectedWalletChange(cb: (next: ConnectedWallet | null) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (e: Event) => cb((e as CustomEvent<ConnectedWallet | null>).detail);
  window.addEventListener(EVT, handler);
  return () => window.removeEventListener(EVT, handler);
}
