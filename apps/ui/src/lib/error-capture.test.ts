import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("consumeLastCapturedError", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function loadModule() {
    return import("./error-capture");
  }

  it("returns undefined when nothing was captured", async () => {
    const { consumeLastCapturedError } = await loadModule();
    expect(consumeLastCapturedError()).toBeUndefined();
  });

  it("returns the captured error once, then clears it (consume-once)", async () => {
    const { consumeLastCapturedError, recordCapturedError } = await loadModule();
    const err = new Error("ssr blew up");
    recordCapturedError(err);
    expect(consumeLastCapturedError()).toBe(err);
    expect(consumeLastCapturedError()).toBeUndefined();
  });

  it("returns undefined after the 5s TTL expires", async () => {
    const { consumeLastCapturedError, recordCapturedError } = await loadModule();
    recordCapturedError(new Error("stale"));
    vi.advanceTimersByTime(5_001);
    expect(consumeLastCapturedError()).toBeUndefined();
  });

  it("still returns the error just before the TTL boundary", async () => {
    const { consumeLastCapturedError, recordCapturedError } = await loadModule();
    const err = new Error("fresh");
    recordCapturedError(err);
    vi.advanceTimersByTime(5_000);
    expect(consumeLastCapturedError()).toBe(err);
  });
});
