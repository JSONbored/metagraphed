/**
 * Admission counts JSON-RPC operations, including every member of a batch.
 *
 * The public Finney fallback charges response units, whereas the Opentensor
 * capture allowance counts HTTP requests. Applying only the latter permits a
 * lookup followed immediately by a full 50-member batch to exceed the former.
 * https://documentation.onfinality.io/support/batch-requests
 *
 * Single-call and batch transports share this budget in one isolate. It
 * schedules the original request; it never retries, splits, or changes it.
 */
export type ChainRpcAdmission = (url: string, units: number) => Promise<void>;

export function createChainRpcAdmission(
  now: () => number = () => performance.now(),
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
): ChainRpcAdmission {
  const admissions: { at: number; units: number }[] = [];
  let pending = Promise.resolve();
  return async (url, units) => {
    let endpoint: URL;
    try {
      endpoint = new URL(url);
    } catch {
      // Preserve the transport's existing handling of an invalid URL.
      return;
    }
    if (
      endpoint.origin !== "https://bittensor-finney.api.onfinality.io" ||
      !["/public", "/public/"].includes(endpoint.pathname)
    )
      return;
    if (!Number.isInteger(units) || units < 1 || units > 50)
      throw new RangeError("Public Finney RPC admission requires 1–50 units");

    // Serialize reservation, including its wait. Concurrent lanes must not
    // each observe the same unspent capacity and send both requests.
    const admitted = pending.then(async () => {
      for (;;) {
        const at = now();
        while (admissions.length && at - admissions[0]!.at >= 1_000)
          admissions.shift();
        const used = admissions.reduce(
          (sum, request) => sum + request.units,
          0,
        );
        if (used + units <= 50) {
          admissions.push({ at, units });
          return;
        }
        await sleep(admissions[0]!.at + 1_000 - at);
      }
    });
    // A failed timer must fail its caller without poisoning later admission.
    pending = admitted.catch(() => undefined);
    await admitted;
  };
}

export const admitChainRpcRequest = createChainRpcAdmission();
