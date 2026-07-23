import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Hoisted spies shared by the module mock below -- mirrors
// error-reporting.test.ts's exact pattern for a dynamically-imported vendor
// SDK (posthog-js's default export IS the `posthog` singleton, same as
// `import posthog from 'posthog-js'` in real code).
const init = vi.hoisted(() => vi.fn());
const capture = vi.hoisted(() => vi.fn());
const captureExceptionSpy = vi.hoisted(() => vi.fn());
const startSessionRecording = vi.hoisted(() => vi.fn());

vi.mock("posthog-js", () => ({
  default: { init, capture, captureException: captureExceptionSpy, startSessionRecording },
}));

describe("analytics (PostHog web analytics)", () => {
  beforeEach(() => {
    vi.resetModules();
    init.mockClear();
    capture.mockClear();
    captureExceptionSpy.mockClear();
    startSessionRecording.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("unconfigured (no token)", () => {
    it("initAnalytics never loads posthog-js", async () => {
      vi.stubEnv("VITE_POSTHOG_PROJECT_TOKEN", "");
      const { initAnalytics } = await import("./analytics");
      initAnalytics();
      await Promise.resolve();
      expect(init).not.toHaveBeenCalled();
    });

    it("capturePageview never loads posthog-js or captures", async () => {
      vi.stubEnv("VITE_POSTHOG_PROJECT_TOKEN", "");
      const { capturePageview } = await import("./analytics");
      capturePageview("https://metagraph.sh/subnets");
      await Promise.resolve();
      expect(init).not.toHaveBeenCalled();
      expect(capture).not.toHaveBeenCalled();
    });

    it("captureEvent never loads posthog-js or captures", async () => {
      vi.stubEnv("VITE_POSTHOG_PROJECT_TOKEN", "");
      const { captureEvent } = await import("./analytics");
      captureEvent("web_vitals", { metric: "LCP", value: 1200 });
      await Promise.resolve();
      expect(init).not.toHaveBeenCalled();
      expect(capture).not.toHaveBeenCalled();
    });

    it("captureException never loads posthog-js, captures, or force-starts replay", async () => {
      vi.stubEnv("VITE_POSTHOG_PROJECT_TOKEN", "");
      const { captureException } = await import("./analytics");
      captureException(new Error("boom"), { boundary: "panel_shell" });
      await Promise.resolve();
      expect(init).not.toHaveBeenCalled();
      expect(captureExceptionSpy).not.toHaveBeenCalled();
      expect(startSessionRecording).not.toHaveBeenCalled();
    });
  });

  describe("configured", () => {
    it("initAnalytics loads and initializes posthog-js exactly once, even across repeated calls", async () => {
      vi.stubEnv("VITE_POSTHOG_PROJECT_TOKEN", "phc_test_token");
      const { initAnalytics } = await import("./analytics");
      initAnalytics();
      initAnalytics();
      await vi.waitFor(() => expect(init).toHaveBeenCalled());
      expect(init).toHaveBeenCalledTimes(1);
      expect(init.mock.calls[0][0]).toBe("phc_test_token");
    });

    it("initializes with the proxy api_host, capture_pageview disabled, and the SDK defaults date", async () => {
      vi.stubEnv("VITE_POSTHOG_PROJECT_TOKEN", "phc_test_token");
      vi.stubEnv("VITE_POSTHOG_HOST", "");
      vi.stubEnv("VITE_POSTHOG_UI_HOST", "");
      const { initAnalytics } = await import("./analytics");
      initAnalytics();
      await vi.waitFor(() => expect(init).toHaveBeenCalled());
      const options = init.mock.calls[0][1];
      expect(options.api_host).toBe("/ingest");
      expect(options.ui_host).toBe("https://us.posthog.com");
      expect(options.capture_pageview).toBe(false);
      expect(typeof options.defaults).toBe("string");
      expect(options.defaults.length).toBeGreaterThan(0);
    });

    it("respects DNT and uses memory-only (cookieless) persistence, matching Umami's no-cookie posture", async () => {
      vi.stubEnv("VITE_POSTHOG_PROJECT_TOKEN", "phc_test_token");
      const { initAnalytics } = await import("./analytics");
      initAnalytics();
      await vi.waitFor(() => expect(init).toHaveBeenCalled());
      const options = init.mock.calls[0][1];
      expect(options.respect_dnt).toBe(true);
      expect(options.persistence).toBe("memory");
    });

    it("enables pageleave and native web vitals capture despite capture_pageview being disabled", async () => {
      // Regression coverage: posthog-js's own capture_pageleave defaults to
      // 'if_capture_pageview', which piggybacks on (and is silently disabled
      // by) capture_pageview: false unless overridden explicitly.
      vi.stubEnv("VITE_POSTHOG_PROJECT_TOKEN", "phc_test_token");
      const { initAnalytics } = await import("./analytics");
      initAnalytics();
      await vi.waitFor(() => expect(init).toHaveBeenCalled());
      const options = init.mock.calls[0][1];
      expect(options.capture_pageleave).toBe(true);
      expect(options.capture_performance).toEqual({ web_vitals: true });
    });

    it("configures session replay with input/text masking and a conservative sample rate", async () => {
      vi.stubEnv("VITE_POSTHOG_PROJECT_TOKEN", "phc_test_token");
      const { initAnalytics } = await import("./analytics");
      initAnalytics();
      await vi.waitFor(() => expect(init).toHaveBeenCalled());
      const sessionRecording = init.mock.calls[0][1].session_recording;
      expect(sessionRecording.maskAllInputs).toBe(true);
      expect(sessionRecording.maskTextClass).toBe("ph-mask");
      expect(sessionRecording.blockClass).toBe("ph-no-capture");
      expect(sessionRecording.sampleRate).toBeGreaterThan(0);
      expect(sessionRecording.sampleRate).toBeLessThanOrEqual(0.2);
      // Explicit off, never left to a dashboard/remote-config default.
      expect(init.mock.calls[0][1].enable_recording_console_log).toBe(false);
    });

    it("honors VITE_POSTHOG_HOST / VITE_POSTHOG_UI_HOST overrides", async () => {
      vi.stubEnv("VITE_POSTHOG_PROJECT_TOKEN", "phc_test_token");
      vi.stubEnv("VITE_POSTHOG_HOST", "https://e.example.com");
      vi.stubEnv("VITE_POSTHOG_UI_HOST", "https://eu.posthog.com");
      const { initAnalytics } = await import("./analytics");
      initAnalytics();
      await vi.waitFor(() => expect(init).toHaveBeenCalled());
      expect(init.mock.calls[0][1].api_host).toBe("https://e.example.com");
      expect(init.mock.calls[0][1].ui_host).toBe("https://eu.posthog.com");
    });

    it("capturePageview captures $pageview with $current_url when a URL is given", async () => {
      vi.stubEnv("VITE_POSTHOG_PROJECT_TOKEN", "phc_test_token");
      const { capturePageview } = await import("./analytics");
      capturePageview("https://metagraph.sh/subnets/7");
      await vi.waitFor(() => expect(capture).toHaveBeenCalled());
      expect(capture).toHaveBeenCalledWith("$pageview", {
        $current_url: "https://metagraph.sh/subnets/7",
      });
    });

    it("capturePageview omits properties (posthog-js's own current-URL read) when no URL is given", async () => {
      vi.stubEnv("VITE_POSTHOG_PROJECT_TOKEN", "phc_test_token");
      const { capturePageview } = await import("./analytics");
      capturePageview();
      await vi.waitFor(() => expect(capture).toHaveBeenCalled());
      expect(capture).toHaveBeenCalledWith("$pageview", undefined);
    });

    it("captureEvent forwards the name and properties verbatim", async () => {
      vi.stubEnv("VITE_POSTHOG_PROJECT_TOKEN", "phc_test_token");
      const { captureEvent } = await import("./analytics");
      captureEvent("web_vitals", { metric: "CLS", value: 12 });
      await vi.waitFor(() => expect(capture).toHaveBeenCalled());
      expect(capture).toHaveBeenCalledWith("web_vitals", { metric: "CLS", value: 12 });
    });

    it("captureException calls posthog-js's dedicated captureException (never the generic .capture)", async () => {
      vi.stubEnv("VITE_POSTHOG_PROJECT_TOKEN", "phc_test_token");
      const { captureException } = await import("./analytics");
      const err = new Error("boom");
      captureException(err, { boundary: "panel_shell", componentStack: "<stack>" });
      await vi.waitFor(() => expect(captureExceptionSpy).toHaveBeenCalled());
      expect(captureExceptionSpy).toHaveBeenCalledWith(err, {
        boundary: "panel_shell",
        componentStack: "<stack>",
      });
      // Properties are merged FLAT (posthog-js's own signature), never
      // nested under an `extra` key the way the Sentry sink does it.
      expect(capture).not.toHaveBeenCalled();
    });

    it("captureException force-starts session replay past its sample-rate skip (issue 7761)", async () => {
      vi.stubEnv("VITE_POSTHOG_PROJECT_TOKEN", "phc_test_token");
      const { captureException } = await import("./analytics");
      const err = new Error("boom");
      captureException(err);
      await vi.waitFor(() => expect(captureExceptionSpy).toHaveBeenCalled());
      expect(startSessionRecording).toHaveBeenCalledWith(true);
      // Every exception-linked recording call must be paired with the
      // capture itself, never called standalone with nothing captured.
      expect(startSessionRecording).toHaveBeenCalledTimes(1);
    });

    it("captureException shares the same lazily-loaded instance as capturePageview/captureEvent (no second init)", async () => {
      vi.stubEnv("VITE_POSTHOG_PROJECT_TOKEN", "phc_test_token");
      const { capturePageview, captureException } = await import("./analytics");
      capturePageview("https://metagraph.sh/");
      captureException(new Error("boom"));
      await vi.waitFor(() => expect(captureExceptionSpy).toHaveBeenCalled());
      expect(init).toHaveBeenCalledTimes(1);
    });

    it("a posthog-js init failure never throws, and later captures are silently dropped", async () => {
      vi.stubEnv("VITE_POSTHOG_PROJECT_TOKEN", "phc_test_token");
      init.mockImplementation(() => {
        throw new Error("posthog init exploded");
      });
      const { initAnalytics, captureEvent } = await import("./analytics");
      expect(() => initAnalytics()).not.toThrow();
      expect(() => captureEvent("web_vitals", {})).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(capture).not.toHaveBeenCalled();
    });
  });
});
