import { useCallback, useEffect, useState } from "react";
import { apiFetch, ApiError } from "@/lib/metagraphed/client";
import { signMessage } from "@/lib/metagraphed/wallet-injected";
import type { ConnectedWallet } from "@/lib/metagraphed/wallet";

// #8374: same challenge -> sign -> verify shape as use-api-session.ts's
// wallet login, over the sibling /api/v1/watch/* pair instead of
// /api/v1/auth/wallet/* -- but persisted in localStorage, not
// sessionStorage. A watch token's whole point is a 90-day lifetime (renewal
// is "sign again," not "every visit") so clearing it on tab close would
// defeat the feature; a key-management session is deliberately short-lived
// and re-signed every tab, so that one stays sessionStorage-scoped.
const WATCH_TOKEN_STORAGE_KEY = "metagraphed:watch-token";

interface StoredWatchToken {
  token: string;
  ss58: string;
  expiresAtMs: number;
}

export type WatchTokenStatus = "idle" | "issuing" | "active" | "error";

interface WatchChallengeResponse {
  message: string;
  expires_in_seconds: number;
}

interface WatchTokenMintResponse {
  token: string;
  expires_in_seconds: number;
}

export function readStoredWatchToken(ss58: string): StoredWatchToken | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(WATCH_TOKEN_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredWatchToken;
    if (parsed.ss58 !== ss58 || parsed.expiresAtMs <= Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeStoredWatchToken(token: StoredWatchToken | null) {
  if (typeof window === "undefined") return;
  try {
    if (token) window.localStorage.setItem(WATCH_TOKEN_STORAGE_KEY, JSON.stringify(token));
    else window.localStorage.removeItem(WATCH_TOKEN_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * The pure challenge -> sign -> verify half, split out for the same
 * dependency-injection-friendly testability as use-api-session.ts's
 * performWalletSignIn (see that file's own comment).
 */
export async function performWatchTokenIssuance(
  wallet: ConnectedWallet,
  {
    apiFetch: fetchImpl = apiFetch,
    signMessage: signImpl = signMessage,
    now = Date.now,
  }: {
    apiFetch?: typeof apiFetch;
    signMessage?: typeof signMessage;
    now?: () => number;
  } = {},
): Promise<StoredWatchToken> {
  const challenge = await fetchImpl<WatchChallengeResponse>("/api/v1/watch/challenges", {
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ss58: wallet.address }),
    },
  });
  const signature = await signImpl(wallet.source, wallet.address, challenge.data.message);
  const minted = await fetchImpl<WatchTokenMintResponse>("/api/v1/watch/tokens", {
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ss58: wallet.address, signature }),
    },
  });
  return {
    token: minted.data.token,
    ss58: wallet.address,
    expiresAtMs: now() + minted.data.expires_in_seconds * 1000,
  };
}

/**
 * Self-serve alert-trigger issuance (#8374) -- challenge -> sign
 * (signMessage, wallet-injected.ts) -> mint -> a long-lived (90d)
 * trigger-creation token, persisted in localStorage so it survives across
 * tabs/reloads within its lifetime. Resets whenever the connected wallet
 * address changes -- a token is scoped to the address that signed it
 * (server-side too, see src/wallet-auth.ts's verifyTriggerToken).
 */
export function useWatchToken(wallet: ConnectedWallet | null) {
  const [status, setStatus] = useState<WatchTokenStatus>("idle");
  const [stored, setStored] = useState<StoredWatchToken | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!wallet) {
      setStored(null);
      setStatus("idle");
      return;
    }
    const existing = readStoredWatchToken(wallet.address);
    setStored(existing);
    setStatus(existing ? "active" : "idle");
  }, [wallet]);

  const issue = useCallback(async () => {
    if (!wallet) return;
    setStatus("issuing");
    setError(null);
    try {
      const next = await performWatchTokenIssuance(wallet);
      writeStoredWatchToken(next);
      setStored(next);
      setStatus("active");
    } catch (err) {
      setStatus("error");
      setError(err instanceof ApiError ? err.message : "Wallet verification failed. Try again.");
    }
  }, [wallet]);

  const clear = useCallback(() => {
    writeStoredWatchToken(null);
    setStored(null);
    setStatus("idle");
  }, []);

  return {
    status,
    token: stored?.token ?? null,
    error,
    issue,
    clear,
  };
}
