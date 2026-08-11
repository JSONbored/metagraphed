import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Hoisted spies shared by the module mocks below.
const reportLovableError = vi.hoisted(() => vi.fn());
const posthogCaptureException = vi.hoisted(() => vi.fn());

vi.mock("./lovable-error-reporting", () => ({ reportLovableError }));
// analytics.ts is a real, independently-tested module (analytics.test.ts) --
// mocked here purely to isolate reportError's own fan-out logic from
// analytics.ts's own token-gating / lazy-load behavior.
vi.mock("./analytics", () => ({ captureException: posthogCaptureException }));

describe("reportError", () => {
  beforeEach(() => {
    vi.resetModules();
    reportLovableError.mockClear();
    posthogCaptureException.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("forwards to the Lovable channel", async () => {
    const { reportError } = await import("./error-reporting");
    const err = new Error("boom");
    reportError(err, { boundary: "panel_shell" });
    expect(reportLovableError).toHaveBeenCalledWith(err, { boundary: "panel_shell" });
  });

  it("forwards to PostHog (analytics.ts)", async () => {
    const { reportError } = await import("./error-reporting");
    const err = new Error("boom");
    const ctx = { boundary: "panel_shell", componentStack: "<stack>" };
    reportError(err, ctx);
    // analytics.ts's own captureException does its own token-gating/no-op
    // internally (verified in analytics.test.ts) -- reportError must call it
    // unconditionally and let that module decide whether it's a no-op.
    expect(posthogCaptureException).toHaveBeenCalledWith(err, ctx);
  });

  it("passes properties FLAT to PostHog, never nested under `extra`", async () => {
    const { reportError } = await import("./error-reporting");
    const err = new Error("boom");
    const ctx = { boundary: "panel_shell" };
    reportError(err, ctx);
    expect(posthogCaptureException).toHaveBeenCalledWith(err, ctx);
    expect(posthogCaptureException).not.toHaveBeenCalledWith(err, { extra: ctx });
  });

  it("defaults context to {} when the caller omits it", async () => {
    const { reportError } = await import("./error-reporting");
    const err = new Error("boom");
    reportError(err);
    expect(posthogCaptureException).toHaveBeenCalledWith(err, {});
    expect(reportLovableError).toHaveBeenCalledWith(err, {});
  });
});

// A network-partition 404 is the API working correctly, not a fault.
//
// 105 of 188 routes are mainnet-only, so a testnet page that touches one gets a
// documented 404. Three of them were reaching Error Tracking from
// testnet.metagraph.sh (/api/v1/health and /api/v1/domains from /subnets,
// /api/v1/agent-resources from /agents). `ApiError.network` already marked
// them; nothing read it.
describe("reportError and expected network-partition refusals", () => {
  beforeEach(() => {
    vi.resetModules();
    reportLovableError.mockClear();
    posthogCaptureException.mockClear();
  });

  async function partitionError(over: Record<string, unknown> = {}) {
    const { ApiError } = await import("./metagraphed/client");
    return new ApiError(
      "/api/v1/agent-resources is only available on mainnet, not the testnet network.",
      {
        status: 404,
        code: "not_found",
        url: "/api/v1/agent-resources",
        network: "testnet",
        ...over,
      },
    );
  }

  it("captures neither sink for a mainnet-only refusal", async () => {
    const { reportError } = await import("./error-reporting");
    reportError(await partitionError(), { boundary: "panel_shell" });
    expect(posthogCaptureException).not.toHaveBeenCalled();
    // The Lovable channel is suppressed too: it is a reporting sink, and the
    // condition is not worth reporting to either.
    expect(reportLovableError).not.toHaveBeenCalled();
  });

  // The guard has to stay narrow, or it swallows real 404s. Each case below is
  // a reason the refusal is NOT a network partition, and each must still report.
  it("still reports an ordinary 404 that carries no network", async () => {
    const { reportError } = await import("./error-reporting");
    reportError(await partitionError({ network: undefined }), {});
    expect(posthogCaptureException).toHaveBeenCalledTimes(1);
  });

  it("still reports a 404 whose network is an empty string", async () => {
    const { reportError } = await import("./error-reporting");
    reportError(await partitionError({ network: "" }), {});
    expect(posthogCaptureException).toHaveBeenCalledTimes(1);
  });

  it("still reports a 500 even when it carries a network", async () => {
    const { reportError } = await import("./error-reporting");
    reportError(await partitionError({ status: 500 }), {});
    expect(posthogCaptureException).toHaveBeenCalledTimes(1);
  });

  it("still reports a plain Error that merely looks like one", async () => {
    const { reportError } = await import("./error-reporting");
    const impostor = Object.assign(new Error("404"), {
      status: 404,
      network: "testnet",
    });
    reportError(impostor, {});
    expect(posthogCaptureException).toHaveBeenCalledTimes(1);
  });
});
