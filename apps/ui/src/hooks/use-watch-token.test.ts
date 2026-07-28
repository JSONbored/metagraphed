import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConnectedWallet } from "@/lib/metagraphed/wallet";
import { ApiError } from "@/lib/metagraphed/client";

import {
  performWatchTokenIssuance,
  readStoredWatchToken,
  writeStoredWatchToken,
} from "./use-watch-token";

// #8374: mirrors use-api-session.test.ts's own shape exactly -- same
// plain-node (no DOM) coverage strategy over the two extracted pure pieces
// instead of renderHook.

const WALLET: ConnectedWallet = {
  address: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
  source: "polkadot-js",
};
const OTHER_SS58 = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
const WATCH_TOKEN_KEY = "metagraphed:watch-token";

type DepArg = Parameters<typeof performWatchTokenIssuance>[1];

function installWindow(overrides: Partial<Storage> = {}) {
  const store = new Map<string, string>();
  const localStorage = {
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    ...overrides,
  };
  (globalThis as { window?: unknown }).window = { localStorage };
  return store;
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  vi.restoreAllMocks();
});

describe("readStoredWatchToken / writeStoredWatchToken", () => {
  it("round-trips a token scoped to its address", () => {
    installWindow();
    const token = {
      token: "tok-1",
      ss58: WALLET.address,
      expiresAtMs: Date.now() + 60_000,
    };
    writeStoredWatchToken(token);
    expect(readStoredWatchToken(WALLET.address)).toEqual(token);
  });

  it("rejects a token stored under a different address", () => {
    installWindow();
    writeStoredWatchToken({
      token: "tok-1",
      ss58: WALLET.address,
      expiresAtMs: Date.now() + 60_000,
    });
    expect(readStoredWatchToken(OTHER_SS58)).toBeNull();
  });

  it("rejects an expired token", () => {
    installWindow();
    writeStoredWatchToken({
      token: "tok-1",
      ss58: WALLET.address,
      expiresAtMs: Date.now() - 1,
    });
    expect(readStoredWatchToken(WALLET.address)).toBeNull();
  });

  it("returns null when nothing is stored", () => {
    installWindow();
    expect(readStoredWatchToken(WALLET.address)).toBeNull();
  });

  it("returns null (never throws) on malformed stored JSON", () => {
    const store = installWindow();
    store.set(WATCH_TOKEN_KEY, "{not json");
    expect(readStoredWatchToken(WALLET.address)).toBeNull();
  });

  it("returns null (never throws) when storage access throws", () => {
    installWindow({
      getItem: () => {
        throw new Error("blocked");
      },
    });
    expect(readStoredWatchToken(WALLET.address)).toBeNull();
  });

  it("clears the stored token when written null", () => {
    installWindow();
    writeStoredWatchToken({
      token: "tok-1",
      ss58: WALLET.address,
      expiresAtMs: Date.now() + 60_000,
    });
    writeStoredWatchToken(null);
    expect(readStoredWatchToken(WALLET.address)).toBeNull();
  });

  it("no-ops without a window (SSR) instead of throwing", () => {
    expect(readStoredWatchToken(WALLET.address)).toBeNull();
    expect(() => writeStoredWatchToken(null)).not.toThrow();
  });
});

describe("performWatchTokenIssuance", () => {
  function fakeDeps(overrides: Partial<Record<string, unknown>> = {}): DepArg {
    const calls: Array<{ path: string; body: unknown }> = [];
    const apiFetch = async (path: string, opts: { init?: { body?: string } }) => {
      calls.push({ path, body: JSON.parse(opts.init?.body ?? "{}") });
      if (path.endsWith("/challenges")) {
        return { data: { message: "please-sign-this", expires_in_seconds: 300 } };
      }
      return { data: { token: "watch-tok-xyz", expires_in_seconds: 90 * 24 * 3600 } };
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

  it("runs challenge -> sign -> mint and shapes the long-lived token", async () => {
    const deps = fakeDeps();
    const result = await performWatchTokenIssuance(WALLET, deps);

    expect(result).toEqual({
      token: "watch-tok-xyz",
      ss58: WALLET.address,
      expiresAtMs: 1_000_000 + 90 * 24 * 3600 * 1000,
    });

    const calls = (
      deps as unknown as {
        __calls: Array<{ path: string; body: { ss58?: string; signature?: string } }>;
      }
    ).__calls;
    expect(calls[0].path).toBe("/api/v1/watch/challenges");
    expect(calls[0].body.ss58).toBe(WALLET.address);
    expect(calls[1].path).toBe("/api/v1/watch/tokens");
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
          url: "/api/v1/watch/challenges",
        });
      },
    });
    await expect(performWatchTokenIssuance(WALLET, deps)).rejects.toBeInstanceOf(ApiError);
  });

  it("propagates an ApiError from the mint step", async () => {
    const deps = fakeDeps({
      apiFetch: vi.fn(async (path: string) => {
        if (path.endsWith("/challenges")) {
          return { data: { message: "please-sign-this", expires_in_seconds: 300 } };
        }
        throw new ApiError("invalid or expired token", {
          status: 401,
          url: "/api/v1/watch/tokens",
        });
      }),
    });
    await expect(performWatchTokenIssuance(WALLET, deps)).rejects.toBeInstanceOf(ApiError);
  });
});
