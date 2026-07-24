import { describe, expect, it, vi } from "vitest";

import { canObserveInView, entriesIndicateInView } from "./use-in-view";

// useInView needs a React + DOM runtime, but this suite is plain-node (no DOM,
// no renderHook — see apps/ui/vitest.config.ts), so we cover the hook's real
// decision logic through its two extracted, exported pure pieces plus a minimal
// IntersectionObserver mock that replays the observer's one-shot lifecycle.

describe("canObserveInView", () => {
  it("cannot observe without an element (SSR / not-yet-mounted fallback)", () => {
    expect(canObserveInView(null, true)).toBe(false);
  });

  it("cannot observe without IntersectionObserver (no-IntersectionObserver fallback)", () => {
    expect(canObserveInView({} as Element, false)).toBe(false);
  });

  it("observes when the element is mounted and IntersectionObserver exists", () => {
    expect(canObserveInView({} as Element, true)).toBe(true);
  });
});

describe("entriesIndicateInView", () => {
  it("is visible once any entry intersects (one-shot trigger)", () => {
    expect(entriesIndicateInView([{ isIntersecting: false }, { isIntersecting: true }])).toBe(true);
  });

  it("stays not-yet-visible while nothing intersects", () => {
    expect(entriesIndicateInView([{ isIntersecting: false }, { isIntersecting: false }])).toBe(
      false,
    );
  });

  it("treats an empty entry list as not intersecting", () => {
    expect(entriesIndicateInView([])).toBe(false);
  });
});

describe("IntersectionObserver one-shot lifecycle (minimal mock)", () => {
  it("becomes visible on first intersect and stays visible after leaving the viewport", () => {
    const observe = vi.fn();
    const unobserve = vi.fn();
    const disconnect = vi.fn();
    let notify: IntersectionObserverCallback | undefined;

    class MockIntersectionObserver {
      constructor(cb: IntersectionObserverCallback) {
        notify = cb;
      }
      observe = observe;
      unobserve = unobserve;
      disconnect = disconnect;
      takeRecords = () => [];
      root = null;
      rootMargin = "";
      thresholds = [];
    }

    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);

    // Mirror the useInView effect body: observe, then flip-once-and-disconnect.
    let inView = false;
    const observer = new IntersectionObserver((entries) => {
      if (entriesIndicateInView(entries)) {
        inView = true;
        observer.disconnect();
      }
    });
    const el = {} as Element;
    observer.observe(el);
    expect(observe).toHaveBeenCalledWith(el);

    // present but not intersecting yet -> no change, observer still armed
    notify?.(
      [{ isIntersecting: false } as IntersectionObserverEntry],
      observer as unknown as IntersectionObserver,
    );
    expect(inView).toBe(false);
    expect(disconnect).not.toHaveBeenCalled();

    // first real intersection -> visible + disconnect (one-shot)
    notify?.(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      observer as unknown as IntersectionObserver,
    );
    expect(inView).toBe(true);
    expect(disconnect).toHaveBeenCalledTimes(1);

    // element leaves the viewport again -> still visible, never re-armed
    notify?.(
      [{ isIntersecting: false } as IntersectionObserverEntry],
      observer as unknown as IntersectionObserver,
    );
    expect(inView).toBe(true);
    expect(disconnect).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });
});
