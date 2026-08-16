import { afterEach, describe, expect, it, vi } from "vitest";
import { cancelIdle, requestIdle } from "./idle";

// Both branches matter and only one of them is the browser most people use.
// Safari shipped requestIdleCallback in 16.4; lib.dom declares it as always
// present, which is the mismatch the two route files were working around when
// they asserted `window` into a maybe-shape.
function withWindow(stub: Record<string, unknown>) {
  vi.stubGlobal("window", stub);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("requestIdle", () => {
  it("uses requestIdleCallback where the browser has it", () => {
    const requestIdleCallback = vi.fn(() => 7);
    withWindow({ requestIdleCallback, setTimeout: vi.fn(() => 99) });
    const callback = () => {};
    expect(requestIdle(callback)).toBe(7);
    expect(requestIdleCallback).toHaveBeenCalledWith(callback);
  });

  it("falls back to a macrotask where it does not", () => {
    const setTimeout = vi.fn(() => 99);
    withWindow({ setTimeout });
    const callback = () => {};
    expect(requestIdle(callback)).toBe(99);
    // 1ms and not 0: this exists to get work off the critical path, and a 0ms
    // timeout on a busy main thread lands in the frame that scheduled it.
    expect(setTimeout).toHaveBeenCalledWith(callback, 1);
  });
});

describe("cancelIdle", () => {
  it("cancels through cancelIdleCallback where the browser has it", () => {
    const cancelIdleCallback = vi.fn();
    const clearTimeout = vi.fn();
    withWindow({ cancelIdleCallback, clearTimeout });
    cancelIdle(7);
    expect(cancelIdleCallback).toHaveBeenCalledWith(7);
    expect(clearTimeout).not.toHaveBeenCalled();
  });

  it("clears the timeout where it does not", () => {
    const clearTimeout = vi.fn();
    withWindow({ clearTimeout });
    cancelIdle(99);
    expect(clearTimeout).toHaveBeenCalledWith(99);
  });

  it("pairs with requestIdle on the SAME branch", () => {
    // The bug this pins: cancelling a setTimeout handle with
    // cancelIdleCallback (or the reverse) is silent -- nothing throws, the
    // work just never gets cancelled. The two helpers must agree about which
    // scheduler produced the handle, and they agree by both asking `window`.
    const clearTimeout = vi.fn();
    withWindow({ setTimeout: vi.fn(() => 42), clearTimeout });
    cancelIdle(requestIdle(() => {}));
    expect(clearTimeout).toHaveBeenCalledWith(42);
  });
});
