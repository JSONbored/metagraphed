// Capabilities belong to the selected facilitator, including its Solana fee
// payer. Never reuse another provider's signer or quote short-lived blockhashes.
import { readBoundedRequestText } from "../workers/http.ts";
import { registerModuleStateReset } from "./module-state-registry.ts";
import type { X402Config } from "./x402.ts";

type SupportedKind = {
  x402Version?: unknown;
  scheme?: unknown;
  network?: unknown;
  extra?: unknown;
};
type Entry = {
  expiresAt: number;
  promise: Promise<SupportedKind[] | null>;
};
const capabilities = new Map<string, Entry>();
registerModuleStateReset("src/x402-supported.ts", () => capabilities.clear());

async function loadSupported(
  facilitatorUrl: string,
  fetchImpl: typeof fetch,
): Promise<SupportedKind[] | null> {
  try {
    const response = await fetchImpl(`${facilitatorUrl}/supported`, {
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return null;
    const body = await readBoundedRequestText(response, 65_536);
    if (!body.ok) return null;
    const parsed: unknown = JSON.parse(body.text);
    if (!parsed || typeof parsed !== "object" || !("kinds" in parsed))
      return null;
    if (!Array.isArray(parsed.kinds)) return null;
    return parsed.kinds.filter(
      (kind): kind is SupportedKind =>
        !!kind && typeof kind === "object" && !Array.isArray(kind),
    );
  } catch {
    return null;
  }
}

async function supported(
  facilitatorUrl: string,
  fetchImpl: typeof fetch,
): Promise<SupportedKind[] | null> {
  const previous = capabilities.get(facilitatorUrl);
  if (previous && Date.now() < previous.expiresAt) return previous.promise;
  if (capabilities.size >= 8) {
    capabilities.delete(capabilities.keys().next().value!);
  }
  const entry: Entry = {
    expiresAt: Date.now() + 30_000,
    promise: Promise.resolve(null),
  };
  entry.promise = loadSupported(facilitatorUrl, fetchImpl).then((value) => {
    if (value === null) entry.expiresAt = Date.now() + 5_000;
    return value;
  });
  capabilities.set(facilitatorUrl, entry);
  return entry.promise;
}

/** Resolve only exact-v2 offers supported by this public, credential-free lane. */
export async function resolveX402SupportedConfig(
  config: X402Config,
  fetchImpl: typeof fetch = fetch,
): Promise<X402Config | null> {
  const kinds = await supported(config.facilitatorUrl, fetchImpl);
  if (!kinds) return null;
  const legs = config.legs.flatMap((leg) => {
    const kind = kinds.find(
      (entry) =>
        entry.x402Version === 2 &&
        entry.scheme === "exact" &&
        entry.network === leg.network,
    );
    if (!kind) return [];
    const extra =
      kind.extra && typeof kind.extra === "object" && !Array.isArray(kind.extra)
        ? (kind.extra as Record<string, unknown>)
        : {};
    if (extra.apiKeyRequired === true) return [];
    if (!leg.network.startsWith("solana:")) return [leg];
    const feePayer = extra.feePayer;
    if (
      typeof feePayer !== "string" ||
      !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(feePayer)
    )
      return [];
    return [{ ...leg, extra: { feePayer } }];
  });
  return legs.length ? { ...config, legs } : null;
}
