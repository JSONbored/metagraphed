import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConnectedWallet } from "@/lib/metagraphed/wallet";
import { ApiError } from "@/lib/metagraphed/client";

import { performWalletSignIn, readStoredSession, writeStoredSession } from "./use-api-session";

// #7903: use-api-session.ts had zero coverage. This suite is plain-node (no DOM,
// no renderHook — see apps/ui/vitest.config.ts), so we cover the hook's real
// logic through its two extracted, exported pure pieces: the sessionStorage
// read/write helpers (address-scoped, expiry-checked) and performWalletSignIn
// (the challenge -> sign -> verify orchestration, deps injected).

const WALLET: ConnectedWallet = {
  address: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
  source: "polkadot-js",
};
const OTHER_SS58 = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
const SESSION_KEY = "metagraphed:api-session";

type DepArg = Parameters<typeof performWalletSignIn>[1];

// The node env has no window; back one with an in-memory Map so the storage
// helpers exercise their real getItem/parse/expiry/scope path.
function installWindow(overrides: Partial<Storage> = {}) {
  const store = new Map<string, string>();
  const sessionStorage = {
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    ...overrides,
  };
  (globalThis as { window?: unknown }).window = { sessionStorage };
  return store;
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  vi.restoreAllMocks();
});

describe("readStoredSession / writeStoredSession", () => {
  it("round-trips a session scoped to its address", () => {
    installWindow();
    const session = {
      token: "tok-1",
      ss58: WALLET.address,
      tier: "pro",
      expiresAtMs: Date.now() + 60_000,
    };
    writeStoredSession(session);
    expect(readStoredSession(WALLET.address)).toEqual(session);
  });

  it("rejects a session stored under a different address", () => {
    installWindow();
    writeStoredSession({
      token: "tok-1",
      ss58: WALLET.address,
      tier: "pro",
      expiresAtMs: Date.now() + 60_000,
    });
    expect(readStoredSession(OTHER_SS58)).toBeNull();
  });

  it("rejects an expired session", () => {
    installWindow();
    writeStoredSession({
      token: "tok-1",
      ss58: WALLET.address,
      tier: "pro",
      expiresAtMs: Date.now() - 1,
    });
    expect(readStoredSession(WALLET.address)).toBeNull();
  });

  it("returns null when nothing is stored", () => {
    installWindow();
    expect(readStoredSession(WALLET.address)).toBeNull();
  });

  it("returns null (never throws) on malformed stored JSON", () => {
    const store = installWindow();
    store.set(SESSION_KEY, "{not json");
    expect(readStoredSession(WALLET.address)).toBeNull();
  });

  it("returns null (never throws) when storage access throws", () => {
    installWindow({
      getItem: () => {
        throw new Error("blocked");
      },
    });
    expect(readStoredSession(WALLET.address)).toBeNull();
  });

  it("clears the stored session when written null", () => {
    installWindow();
    writeStoredSession({
      token: "tok-1",
      ss58: WALLET.address,
      tier: "pro",
      expiresAtMs: Date.now() + 60_000,
    });
    writeStoredSession(null);
    expect(readStoredSession(WALLET.address)).toBeNull();
  });

  it("no-ops without a window (SSR) instead of throwing", () => {
    expect(readStoredSession(WALLET.address)).toBeNull();
    expect(() => writeStoredSession(null)).not.toThrow();
  });
});

describe("performWalletSignIn", () => {
  function fakeDeps(overrides: Partial<Record<string, unknown>> = {}): DepArg {
    const calls: Array<{ path: string; body: unknown }> = [];
    const apiFetch = async (path: string, opts: { init?: { body?: string } }) => {
      calls.push({ path, body: JSON.parse(opts.init?.body ?? "{}") });
      if (path.endsWith("/challenge")) {
        return { data: { message: "please-sign-this", expires_in_seconds: 60 } };
      }
      return {
        data: {
          session_token: "tok-xyz",
          expires_in_seconds: 900,
          account: { ss58: WALLET.address, tier: "pro" },
        },
      };
    };
    const signMessage = vi.fn(async () => "0xsignature");
    return {
      apiFetch,
      signMessage,
      now: () => 1_000_000,
      __calls: calls,
      ...overrides,
    } as unknown as DepArg;
  }

  it("runs challenge -> sign -> verify and shapes the short-lived session", async () => {
    const deps = fakeDeps();
    const session = await performWalletSignIn(WALLET, deps);

    expect(session).toEqual({
      token: "tok-xyz",
      ss58: WALLET.address,
      tier: "pro",
      expiresAtMs: 1_000_000 + 900 * 1000,
    });

    const calls = (
      deps as unknown as {
        __calls: Array<{ path: string; body: { ss58?: string; signature?: string } }>;
      }
    ).__calls;
    expect(calls[0].path).toBe("/api/v1/auth/wallet/challenge");
    expect(calls[0].body.ss58).toBe(WALLET.address);
    expect(calls[1].path).toBe("/api/v1/auth/wallet/verify");
    expect(calls[1].body.signature).toBe("0xsignature");
    expect(
      (deps as unknown as { signMessage: ReturnType<typeof vi.fn> }).signMessage,
    ).toHaveBeenCalledWith(WALLET.source, WALLET.address, "please-sign-this");
  });

  it("propagates an ApiError from the challenge step", async () => {
    const deps = fakeDeps({
      apiFetch: async () => {
        throw new ApiError("challenge failed", {
          status: 429,
          url: "/api/v1/auth/wallet/challenge",
        });
      },
    });
    await expect(performWalletSignIn(WALLET, deps)).rejects.toBeInstanceOf(ApiError);
  });
});
