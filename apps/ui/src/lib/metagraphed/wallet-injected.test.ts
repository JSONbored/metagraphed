import { describe, it, expect, vi, afterEach } from "vitest";
import { hasInjectedWallet, connectWallet, getSigner, signMessage } from "./wallet-injected";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("hasInjectedWallet", () => {
  it("is false when window is undefined (SSR)", () => {
    expect(hasInjectedWallet()).toBe(false);
  });

  it("is false when window.injectedWeb3 is absent", () => {
    vi.stubGlobal("window", {});
    expect(hasInjectedWallet()).toBe(false);
  });

  it("is false when window.injectedWeb3 is an empty object", () => {
    vi.stubGlobal("window", { injectedWeb3: {} });
    expect(hasInjectedWallet()).toBe(false);
  });

  it("is true when at least one extension has injected a provider", () => {
    vi.stubGlobal("window", { injectedWeb3: { "polkadot-js": {} } });
    expect(hasInjectedWallet()).toBe(true);
  });
});

// connectWallet's only path exercised here is its SSR early return. The real
// dynamic-import path (loading @polkadot/extension-dapp, which transitively
// triggers @polkadot/util-crypto's WASM init) is deliberately NOT exercised in this
// unit suite — that would defeat the point of keeping it off the SSR/unit-test
// critical path. Real coverage for the connect flow is manual QA with an actual
// browser extension (Polkadot.js / Talisman / SubWallet); see the PR description.
describe("connectWallet (SSR safety only)", () => {
  it("resolves to an empty array under SSR without ever touching @polkadot/extension-dapp", async () => {
    // No window stubbed at all — matches how this module is actually invoked during
    // server rendering, where `window` is genuinely undefined, not merely falsy.
    await expect(connectWallet()).resolves.toEqual([]);
  });
});

// Same posture as connectWallet above: only the SSR guard is exercised here. The real
// web3FromSource dynamic-import path is deliberately NOT exercised in this unit suite
// for the same WASM-avoidance reason. Real coverage is manual QA with an actual browser
// extension; see the PR description.
describe("getSigner (SSR safety only)", () => {
  it("rejects under SSR without ever touching @polkadot/extension-dapp", async () => {
    // No window stubbed at all — matches how this module is actually invoked during
    // server rendering, where `window` is genuinely undefined, not merely falsy.
    await expect(getSigner("polkadot-js")).rejects.toThrow(
      "getSigner() is client-only and must not be called during SSR",
    );
  });
});

// Same posture as getSigner above: signMessage() calls getSigner() first, so the SSR
// guard is the only path exercised here. The real signRaw path is deliberately NOT
// unit-tested for the same WASM-avoidance reason; see the PR description for manual QA.
describe("signMessage (SSR safety only)", () => {
  it("rejects under SSR without ever touching @polkadot/extension-dapp", async () => {
    await expect(
      signMessage("polkadot-js", "5Fake...", "metagraphed wallet login"),
    ).rejects.toThrow("getSigner() is client-only and must not be called during SSR");
  });
});
