import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/metagraphed/client";
import { describeApiError } from "@/components/metagraphed/watch-alert-form";

// #6558: the backend (src/alert-triggers.ts) already validates netuid-scoped
// alert triggers, but only the validator page had a Watch UI. WatchSubnetAlert
// extends the same pattern to subnets — same #4984 endpoint, create-token gate,
// and one-time owner-token result — sending `netuid` instead of `account`.
const subnetForm = readFileSync(
  fileURLToPath(new URL("./watch-subnet-alert.tsx", import.meta.url)),
  "utf8",
);

describe("WatchSubnetAlert posts a netuid-scoped trigger", () => {
  it("sends netuid, not account, to the alert-triggers endpoint", () => {
    const body = subnetForm.slice(
      subnetForm.indexOf("body: JSON.stringify"),
      subnetForm.indexOf("body: JSON.stringify") + 260,
    );
    expect(body).toContain("netuid,");
    expect(body).not.toContain("account:");
    // event_kind stays optional, matching the validator form's shape.
    expect(body).toContain("...(vars.eventKind ? { event_kind: vars.eventKind } : {})");
  });

  it("POSTs to the shared alert-triggers endpoint, choosing the operator or wallet-verified header by source", () => {
    expect(subnetForm).toContain('"/api/v1/alerts/triggers"');
    // #8374: the header is now picked at request time -- CREATE_TOKEN_HEADER
    // for an operator-issued token, WATCH_TRIGGER_TOKEN_HEADER for a
    // wallet-verified one -- rather than always the operator header.
    expect(subnetForm).toContain(
      "[vars.usingWalletToken ? WATCH_TRIGGER_TOKEN_HEADER : CREATE_TOKEN_HEADER]: vars.token",
    );
  });
});

describe("WatchSubnetAlert #8374 wallet-verified token wiring", () => {
  it("wires WalletVerifyForToken's callback to auto-fill the token field and track its source", () => {
    expect(subnetForm).toContain("<WalletVerifyForToken");
    expect(subnetForm).toContain("setUsingWalletToken(true)");
    // Editing the token field manually falls back off the wallet-verified
    // path -- the header choice above must follow the field's real source.
    expect(subnetForm).toContain("setUsingWalletToken(false)");
  });
});

// The error mapping is shared between both watch forms and drives the token-gate
// / rate-limit / not-enabled messaging, so it's worth pinning directly.
describe("describeApiError (shared alert-form helper)", () => {
  const err = (status: number, message = "") =>
    new ApiError(message, { status, url: "/api/v1/alerts/triggers" });

  it("maps the create-token gate (401) to an actionable message", () => {
    expect(describeApiError(err(401))).toMatch(/creation token/i);
  });

  it("maps rate-limit (429) and not-enabled (503) distinctly", () => {
    expect(describeApiError(err(429))).toMatch(/too many requests/i);
    expect(describeApiError(err(503))).toMatch(/aren't enabled/i);
  });

  it("maps a 400 to a config/destination hint", () => {
    expect(describeApiError(err(400))).toMatch(/invalid alert configuration/i);
  });

  it("falls back for a non-ApiError", () => {
    expect(describeApiError(new Error("boom"))).toBe("Request failed.");
  });
});
