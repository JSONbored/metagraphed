// The one boundary in this codebase that touches @polkadot/extension-dapp (#5236,
// native-staking epic #5229, wallet standard locked by docs/adr/0018). Everything in
// this file is written so that no @polkadot/* code can ever be reached during SSR:
//
//   - @polkadot/util-crypto (a transitive dep of extension-dapp) auto-triggers WASM
//     init as an IMPORT-TIME side effect, not gated behind calling any function — so
//     even a top-level `import { web3Enable } from "@polkadot/extension-dapp"` would
//     be unsafe in an SSR bundle regardless of whether the functions are called.
//   - The fix: every function below that touches the package does so via a dynamic
//     `import()` INSIDE the function body, after a `typeof window === "undefined"`
//     early return. React SSR never executes event handlers or the bodies of
//     `useEffect` callbacks, so as long as callers only invoke these from one of
//     those (never from a component's render body), the dynamic import is never
//     reached during server rendering — this holds independent of how the Nitro/
//     Cloudflare Workers build bundles the eventually-imported package.
//   - `hasInjectedWallet()` needs no import at all — it only reads window.injectedWeb3,
//     which every compliant extension injects synchronously on page load — so the
//     "no extension installed" UI state can render without ever loading the
//     @polkadot/extension-dapp chunk.
//
// `import type` below is compile-time only and erased entirely by the TypeScript
// compiler — it emits no runtime import statement, so it costs nothing and carries
// zero SSR risk.

import type { InjectedAccountWithMeta } from "@polkadot/extension-inject/types";
import type { Signer } from "@polkadot/api/types";

export type { InjectedAccountWithMeta };

/** True when at least one browser extension has injected a Web3 provider. Safe in both SSR and CSR. */
export function hasInjectedWallet(): boolean {
  if (typeof window === "undefined") return false;
  const injected = (window as { injectedWeb3?: Record<string, unknown> }).injectedWeb3;
  return !!injected && Object.keys(injected).length > 0;
}

/**
 * Enable all injected extensions and return every account they expose. Resolves to
 * an empty array under SSR, or if no extension is installed / no account is shared.
 * Call only from a client-only path (a useEffect body or an event handler) — never
 * from a component's render body.
 */
export async function connectWallet(): Promise<InjectedAccountWithMeta[]> {
  if (typeof window === "undefined") return [];
  const { web3Enable, web3Accounts } = await import("@polkadot/extension-dapp");
  const extensions = await web3Enable("Metagraphed");
  if (extensions.length === 0) return [];
  return web3Accounts();
}

/**
 * The Signer for a specific extension source (account.meta.source, e.g.
 * "polkadot-js" | "talisman" | "subwallet-js" | "taostats"), for use with
 * extrinsic.signAndSend()/submitStakeExtrinsic(). Throws under SSR -- unlike
 * connectWallet()/hasInjectedWallet(), which resolve to an empty/false value
 * so callers can render around them, there is no sensible fallback for "give
 * me a signer" with no window -- every caller of this function is itself
 * already client-only (mid-flow after a wallet is already connected).
 */
export async function getSigner(source: string): Promise<Signer> {
  if (typeof window === "undefined") {
    throw new Error("getSigner() is client-only and must not be called during SSR");
  }
  const { web3FromSource } = await import("@polkadot/extension-dapp");
  const extension = await web3FromSource(source);
  return extension.signer;
}

/** Hex-encodes a UTF-8 string's raw bytes, 0x-prefixed -- the `data` shape
 * signRaw({ type: "bytes" }) expects. A local one-liner rather than pulling
 * in @polkadot/util's stringToHex for a single call site. */
function stringToHexBytes(message: string): string {
  const bytes = new TextEncoder().encode(message);
  return "0x" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Signs an opaque login-challenge string via the extension's
 * signRaw({ type: "bytes" }) -- never an extrinsic, never broadcast. This is
 * the exact message/signature shape src/wallet-auth.ts's
 * walletChallengeMessage()/verifyWalletChallenge() expect server-side (see
 * that file's own header comment). A deliberate, narrow evolution of this
 * file's previously extrinsic-only signing surface -- docs/adr/0018 §4.
 *
 * Throws under SSR via getSigner()'s own guard (every caller is already
 * client-only, mid-flow after a wallet is connected) and if the extension
 * doesn't implement signRaw at all (some very old extension builds omit it).
 */
export async function signMessage(
  source: string,
  address: string,
  message: string,
): Promise<string> {
  const signer = await getSigner(source);
  if (!signer.signRaw) {
    throw new Error(`${source} does not support message signing`);
  }
  const { signature } = await signer.signRaw({
    address,
    data: stringToHexBytes(message),
    type: "bytes",
  });
  // src/wallet-auth.ts expects a bare 128-char hex sr25519 signature, no 0x prefix.
  return signature.startsWith("0x") ? signature.slice(2) : signature;
}
