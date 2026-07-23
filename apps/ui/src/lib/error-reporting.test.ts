import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Hoisted spies shared by the module mocks below.
const captureException = vi.hoisted(() => vi.fn());
const init = vi.hoisted(() => vi.fn());
const reportLovableError = vi.hoisted(() => vi.fn());
const posthogCaptureException = vi.hoisted(() => vi.fn());

vi.mock("@sentry/browser", () => ({ init, captureException }));
vi.mock("./lovable-error-reporting", () => ({ reportLovableError }));
// analytics.ts is a real, independently-tested module (analytics.test.ts) --
// mocked here purely to isolate reportError's own fan-out logic from
// analytics.ts's own token-gating / lazy-load behavior.
vi.mock("./analytics", () => ({ captureException: posthogCaptureException }));

describe("reportError", () => {
  beforeEach(() => {
    vi.resetModules();
    captureException.mockClear();
    init.mockClear();
    reportLovableError.mockClear();
    posthogCaptureException.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("forwards to the Lovable channel regardless of DSN", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", "");
    const { reportError } = await import("./error-reporting");
    const err = new Error("boom");
    reportError(err, { boundary: "panel_shell" });
    expect(reportLovableError).toHaveBeenCalledWith(err, { boundary: "panel_shell" });
  });

  it("forwards to PostHog (analytics.ts) regardless of Sentry DSN -- a parallel sink, not a replacement", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", "");
    const { reportError } = await import("./error-reporting");
    const err = new Error("boom");
    const ctx = { boundary: "panel_shell", componentStack: "<stack>" };
    reportError(err, ctx);
    // analytics.ts's own captureException does its own token-gating/no-op
    // internally (verified in analytics.test.ts) -- reportError must call it
    // unconditionally and let that module decide whether it's a no-op.
    expect(posthogCaptureException).toHaveBeenCalledWith(err, ctx);
  });

  it("passes properties FLAT to PostHog, never nested under `extra` the way the Sentry call site is", async () => {
    // DSN intentionally unset: this test only cares about the PostHog call
    // shape, and leaving Sentry unconfigured avoids its own async dynamic
    // import resolving after this test has already finished (which would
    // otherwise bleed a captureException call into a later test).
    vi.stubEnv("VITE_SENTRY_DSN", "");
    const { reportError } = await import("./error-reporting");
    const err = new Error("boom");
    const ctx = { boundary: "panel_shell" };
    reportError(err, ctx);
    expect(posthogCaptureException).toHaveBeenCalledWith(err, ctx);
    expect(posthogCaptureException).not.toHaveBeenCalledWith(err, { extra: ctx });
  });

  it("does NOT touch Sentry when no DSN is configured and it's not a production build", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", "");
    vi.stubEnv("PROD", false);
    const { reportError } = await import("./error-reporting");
    reportError(new Error("boom"), {});
    // allow any (non-existent) microtasks to flush
    await Promise.resolve();
    expect(captureException).not.toHaveBeenCalled();
    expect(init).not.toHaveBeenCalled();
  });

  it("falls back to the real project DSN on a production build with no explicit override", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", "");
    vi.stubEnv("PROD", true);
    const { reportError } = await import("./error-reporting");
    reportError(new Error("boom"), {});
    await vi.waitFor(() => expect(init).toHaveBeenCalled());
    expect(init.mock.calls[0][0].dsn).toMatch(/^https:\/\/.+@.+\.ingest\..+\.sentry\.io\/\d+$/);
    expect(captureException).toHaveBeenCalled();
  });

  it("captures the exception via Sentry when a DSN is configured", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", "https://abc@o0.ingest.sentry.io/0");
    vi.stubEnv("VITE_SENTRY_RELEASE", "");
    const { reportError } = await import("./error-reporting");
    const err = new Error("boom");
    const ctx = { boundary: "panel_shell", componentStack: "<stack>" };
    reportError(err, ctx);
    // dynamic import + .then() chain resolves on the microtask queue
    await vi.waitFor(() => expect(captureException).toHaveBeenCalled());
    expect(init).toHaveBeenCalledWith({
      dsn: "https://abc@o0.ingest.sentry.io/0",
      release: undefined,
      environment: expect.any(String),
    });
    expect(captureException).toHaveBeenCalledWith(err, { extra: ctx });
  });

  it("passes VITE_SENTRY_RELEASE through as the Sentry release when set", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", "https://abc@o0.ingest.sentry.io/0");
    vi.stubEnv("VITE_SENTRY_RELEASE", "deadbeef1234");
    const { reportError } = await import("./error-reporting");
    reportError(new Error("boom"), {});
    await vi.waitFor(() => expect(init).toHaveBeenCalled());
    expect(init.mock.calls[0][0].release).toBe("deadbeef1234");
  });

  it("treats an empty VITE_SENTRY_RELEASE (unset in the build) as undefined, not an empty string", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", "https://abc@o0.ingest.sentry.io/0");
    vi.stubEnv("VITE_SENTRY_RELEASE", "");
    const { reportError } = await import("./error-reporting");
    reportError(new Error("boom"), {});
    await vi.waitFor(() => expect(init).toHaveBeenCalled());
    expect(init.mock.calls[0][0].release).toBeUndefined();
  });
});
