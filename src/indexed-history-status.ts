import { registerModuleStateReset } from "./module-state-registry.ts";

// Keep failure accounting independent of the Parquet reader so shared cache
// helpers do not pull historical decoding into the data Worker's bundle.
let failures = 0;
registerModuleStateReset("src/indexed-history-status.ts", () => {
  failures = 0;
});

export function recordIndexedHistoryFailure(): void {
  failures += 1;
}

export function currentIndexedHistoryFailureGeneration(): number {
  return failures;
}
