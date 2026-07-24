import { useCallback, useEffect, useState } from "react";
import { apiFetch, ApiError } from "@/lib/metagraphed/client";
import { signMessage } from "@/lib/metagraphed/wallet-injected";
import type { ConnectedWallet } from "@/lib/metagraphed/wallet";

const SESSION_STORAGE_KEY = "metagraphed:api-session";

interface StoredSession {
  token: string;
  ss58: string;
  tier: string;
  expiresAtMs: number;
}

export type ApiSessionStatus = "idle" | "signing-in" | "active" | "error";

interface WalletChallengeResponse {
  message: string;
  expires_in_seconds: number;
}

interface WalletVerifyResponse {
  session_token: string;
  expires_in_seconds: number;
  account: { ss58: string; tier: string };
}

export function readStoredSession(ss58: string): StoredSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSession;
    if (parsed.ss58 !== ss58 || parsed.expiresAtMs <= Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeStoredSession(session: StoredSession | null) {
  if (typeof window === "undefined") return;
  try {
    if (session) window.sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
    else window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * The pure challenge -> sign -> verify -> session-shape half of signIn, split
 * out so it's testable without a DOM/renderHook (this suite is plain-node): POST
 * the wallet-signature challenge, sign it with the injected signer, verify the
 * signature, and shape the resulting short-lived session. Deps default to the
 * real apiFetch/signMessage/Date.now; tests inject fakes. Throws (ApiError or
 * otherwise) on any step's failure, exactly as the hook's catch expects.
 */
export async function performWalletSignIn(
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
): Promise<StoredSession> {
  const challenge = await fetchImpl<WalletChallengeResponse>("/api/v1/auth/wallet/challenge", {
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ss58: wallet.address }),
    },
  });
  const signature = await signImpl(wallet.source, wallet.address, challenge.data.message);
  const verify = await fetchImpl<WalletVerifyResponse>("/api/v1/auth/wallet/verify", {
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ss58: wallet.address, signature }),
    },
  });
  return {
    token: verify.data.session_token,
    ss58: wallet.address,
    tier: verify.data.account.tier,
    expiresAtMs: now() + verify.data.expires_in_seconds * 1000,
  };
}

/**
 * Wallet-signature login for key-management routes (/api/v1/keys) -- distinct
 * from use-wallet.ts's read-only connect flow. Challenge -> sign
 * (signMessage, wallet-injected.ts) -> verify -> a short-lived session token,
 * persisted in sessionStorage (cleared on tab close) so a reload within the
 * token's lifetime doesn't force re-signing. Resets whenever the connected
 * wallet address changes -- a session is scoped to the address that signed
 * it (server-side too, see src/wallet-auth.ts's verifySessionToken).
 */
export function useApiSession(wallet: ConnectedWallet | null) {
  const [status, setStatus] = useState<ApiSessionStatus>("idle");
  const [session, setSession] = useState<StoredSession | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!wallet) {
      setSession(null);
      setStatus("idle");
      return;
    }
    const stored = readStoredSession(wallet.address);
    setSession(stored);
    setStatus(stored ? "active" : "idle");
  }, [wallet]);

  const signIn = useCallback(async () => {
    if (!wallet) return;
    setStatus("signing-in");
    setError(null);
    try {
      const next = await performWalletSignIn(wallet);
      writeStoredSession(next);
      setSession(next);
      setStatus("active");
    } catch (err) {
      setStatus("error");
      setError(err instanceof ApiError ? err.message : "Sign-in failed. Try again.");
    }
  }, [wallet]);

  const signOut = useCallback(() => {
    writeStoredSession(null);
    setSession(null);
    setStatus("idle");
  }, []);

  return {
    status,
    tier: session?.tier ?? null,
    token: session?.token ?? null,
    error,
    signIn,
    signOut,
  };
}
