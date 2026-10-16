import { test } from "@playwright/test";

/** Opt-in native diagnostic only; the normal project patterns do not select it. */
export function registerDiagnosticRetry() {
  test("diagnostic retention keeps a deterministic first failure after retry success", async ({}, info) => {
    await info.attach("diagnostic-retention-attempt", {
      body: JSON.stringify({ fixture: "successful-retry-retention-v1", retry: info.retry }),
      contentType: "application/json",
    });
    if (info.retry === 0) throw new Error("Intentional diagnostic first-attempt failure");
  });
}
