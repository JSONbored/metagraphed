import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/metagraphed/client";
import { describeApiError } from "@/components/metagraphed/watch-alert-form";

// #6558: the backend (src/alert-triggers.mjs) already validates netuid-scoped
// alert triggers, but only the validator page had a Watch UI. WatchSubnetAlert
// extends the same pattern to subnets — same #4984 endpoint, create-token gate,
// and one-time owner-token result — sending `netuid` instead of `account`.
const subnetForm = readFileSync(
  fileURLToPath(new URL("./watch-subnet-alert.tsx", import.meta.url)),
  "utf8",
);

describe("WatchSubnetAlert posts a netuid-scoped trigger (#6558)", () => {
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

  it("POSTs to the shared alert-triggers endpoint with the create-token header", () => {
    expect(subnetForm).toContain('"/api/v1/alerts/triggers"');
    expect(subnetForm).toContain("[CREATE_TOKEN_HEADER]: vars.token");
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
