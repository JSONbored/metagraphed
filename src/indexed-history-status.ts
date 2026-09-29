import { createRequestCounter } from "./request-counters.ts";

// Keep failure accounting independent of the Parquet reader so shared cache
// helpers do not pull historical decoding into the data Worker's bundle.
const failures = createRequestCounter("src/indexed-history-status.ts");

export function recordIndexedHistoryFailure(): void {
  failures.increment();
}

export function currentIndexedHistoryFailureGeneration(): number {
  return failures.current();
}
