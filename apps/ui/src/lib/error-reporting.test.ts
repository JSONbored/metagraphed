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
