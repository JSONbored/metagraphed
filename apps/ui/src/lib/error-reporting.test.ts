import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Hoisted spies shared by the module mocks below.
const captureException = vi.hoisted(() => vi.fn());
const init = vi.hoisted(() => vi.fn());
const reportLovableError = vi.hoisted(() => vi.fn());

vi.mock("@sentry/browser", () => ({ init, captureException }));
vi.mock("./lovable-error-reporting", () => ({ reportLovableError }));

describe("reportError", () => {
  beforeEach(() => {
    vi.resetModules();
    captureException.mockClear();
    init.mockClear();
    reportLovableError.mockClear();
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

  it("does NOT touch Sentry when no DSN is configured", async () => {
    vi.stubEnv("VITE_SENTRY_DSN", "");
    const { reportError } = await import("./error-reporting");
    reportError(new Error("boom"), {});
    // allow any (non-existent) microtasks to flush
    await Promise.resolve();
    expect(captureException).not.toHaveBeenCalled();
    expect(init).not.toHaveBeenCalled();
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
