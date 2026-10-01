import { chainBlockUnavailable } from "./chain-rpc-read.ts";

/** Existing archive pool; every attempt must read its complete pinned sample. */
export const EMISSION_SAMPLER_ARCHIVE_URLS = [
  "https://archive.chain.opentensor.ai",
  "https://bittensor-finney.api.onfinality.io/public",
] as const;

export function emissionRpcUrls(
  explicit?: string,
  head?: string,
): readonly string[] {
  if (explicit) return [explicit];
  // The generic head default must not silently disable the archive pool.
  // Preserve an operator's custom endpoint, including dedicated lane overrides.
  return head &&
    !(EMISSION_SAMPLER_ARCHIVE_URLS as readonly string[]).includes(head)
    ? [head]
    : EMISSION_SAMPLER_ARCHIVE_URLS;
}

export interface EmissionFailoverOptions {
  urls?: readonly string[];
  offset?: number;
  /** Tests can observe the bounded consistency wait without wall-clock delay. */
  waitForRetry?: () => Promise<void>;
}

export async function withEmissionFailover<T>(
  options: EmissionFailoverOptions,
  sample: (url: string) => Promise<T>,
  label: string,
): Promise<T> {
  const urls = options.urls?.length
    ? options.urls
    : EMISSION_SAMPLER_ARCHIVE_URLS;
  const start = Number.isFinite(options.offset)
    ? Math.abs(Math.trunc(options.offset as number))
    : 0;
  let lastError: unknown;
  const unavailable: string[] = [];
  for (let i = 0; i < urls.length; i += 1) {
    try {
      return await sample(urls[(start + i) % urls.length]!);
    } catch (error) {
      lastError = error;
      if (chainBlockUnavailable(error))
        unavailable.push(urls[(start + i) % urls.length]!);
    }
  }
  // A finalized hash can reach one backend before another behind the SAME
  // archive URL. After trying the whole pool, give only those explicit
  // consistency failures one bounded complete-sample restart. Never splice
  // reads, retry schema/transport errors, or accept an incomplete sample.
  if (unavailable.length) {
    await (
      options.waitForRetry ??
      (() => new Promise<void>((resolve) => setTimeout(resolve, 500)))
    )();
    for (const url of unavailable) {
      try {
        return await sample(url);
      } catch (error) {
        lastError = error;
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`${label} failed on all ${urls.length} endpoint(s)`);
}
