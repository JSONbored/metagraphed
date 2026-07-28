import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Mirrors watch-subnet-alert.test.ts's own source-text-assertion shape for
// the sibling form (account-scoped instead of netuid-scoped).
const validatorForm = readFileSync(
  fileURLToPath(new URL("./watch-validator-alert.tsx", import.meta.url)),
  "utf8",
);

describe("WatchValidatorAlert posts an account-scoped trigger", () => {
  it("sends account (the hotkey), not netuid, to the alert-triggers endpoint", () => {
    const body = validatorForm.slice(
      validatorForm.indexOf("body: JSON.stringify"),
      validatorForm.indexOf("body: JSON.stringify") + 260,
    );
    expect(body).toContain("account: hotkey,");
    expect(body).not.toContain("netuid,");
    expect(body).toContain("...(vars.eventKind ? { event_kind: vars.eventKind } : {})");
  });

  it("POSTs to the shared alert-triggers endpoint, choosing the operator or wallet-verified header by source", () => {
    expect(validatorForm).toContain('"/api/v1/alerts/triggers"');
    // #8374: same header-by-source shape as WatchSubnetAlert.
    expect(validatorForm).toContain(
      "[vars.usingWalletToken ? WATCH_TRIGGER_TOKEN_HEADER : CREATE_TOKEN_HEADER]: vars.token",
    );
  });
});

describe("WatchValidatorAlert #8374 wallet-verified token wiring", () => {
  it("wires WalletVerifyForToken's callback to auto-fill the token field and track its source", () => {
    expect(validatorForm).toContain("<WalletVerifyForToken");
    expect(validatorForm).toContain("setUsingWalletToken(true)");
    expect(validatorForm).toContain("setUsingWalletToken(false)");
  });
});
