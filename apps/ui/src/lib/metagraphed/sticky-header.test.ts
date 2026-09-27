import { afterEach, describe, expect, it, vi } from "vitest";
import { observeStickyHeader } from "./sticky-header";

afterEach(() => vi.unstubAllGlobals());

function fixture(initial = "") {
  let height = 48.4;
  let value = initial;
  let notify: () => void = () => {};
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  const setProperty = vi.fn((_key: string, next: string) => {
    value = next;
  });
  const observe = vi.fn();
  const disconnect = vi.fn();
  const target = {
    requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    }),
    cancelAnimationFrame: vi.fn((id: number) => frames.delete(id)),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  vi.stubGlobal("window", target);
  vi.stubGlobal("document", {
    documentElement: { style: { getPropertyValue: () => value, setProperty } },
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        notify = callback;
      }
      observe = observe;
      disconnect = disconnect;
    },
  );
  const measure = vi.fn(() => ({ height }));
  const header = { getBoundingClientRect: measure } as unknown as HTMLElement;
  return {
    header,
    target,
    observe,
    disconnect,
    setProperty,
    measure,
    frames,
    resize: () => notify(),
    height: (next: number) => {
      height = next;
    },
    paint: () => {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback(0));
    },
  };
}

describe("sticky header geometry", () => {
  it("publishes immediately, defers resize writes and coalesces notifications", () => {
    const f = fixture();
    const stop = observeStickyHeader(f.header);
    expect(f.setProperty).toHaveBeenLastCalledWith("--mg-sticky-offset", "48px");
    expect(f.observe).toHaveBeenCalledWith(f.header);
    f.height(64.6);
    f.resize();
    f.resize();
    const resize = f.target.addEventListener.mock.calls[0][1] as () => void;
    resize();
    expect(f.measure).toHaveBeenCalledTimes(1);
    expect(f.setProperty).toHaveBeenCalledTimes(1);
    expect(f.target.requestAnimationFrame).toHaveBeenCalledTimes(1);
    f.paint();
    expect(f.setProperty).toHaveBeenLastCalledWith("--mg-sticky-offset", "65px");
    f.height(80);
    f.resize();
    f.paint();
    expect(f.setProperty).toHaveBeenLastCalledWith("--mg-sticky-offset", "80px");
    stop();
    expect(f.disconnect).toHaveBeenCalledTimes(1);
    expect(f.target.removeEventListener).toHaveBeenCalledWith("resize", resize);
    expect(f.target.cancelAnimationFrame).not.toHaveBeenCalled();
  });

  it("skips writes for unchanged rounded geometry, including route remounts", () => {
    const f = fixture("48px");
    const stop = observeStickyHeader(f.header);
    f.height(48.49);
    f.resize();
    f.paint();
    expect(f.setProperty).not.toHaveBeenCalled();
    stop();
  });

  it("cancels a pending frame on unmount even when its identifier is zero", () => {
    const f = fixture();
    const stop = observeStickyHeader(f.header);
    f.height(100);
    f.resize();
    stop();
    expect(f.target.cancelAnimationFrame).toHaveBeenCalledWith(0);
    expect(f.frames.size).toBe(0);
    f.paint();
    expect(f.setProperty).toHaveBeenCalledTimes(1);
  });
});
