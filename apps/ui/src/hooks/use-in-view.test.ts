import { describe, expect, it, vi } from "vitest";

import { entriesIndicateInView, shouldFallbackInView } from "./use-in-view";

describe("shouldFallbackInView", () => {
  it("falls back when the element is missing (SSR / not mounted)", () => {
    expect(shouldFallbackInView(null, true)).toBe(true);
  });

  it("falls back when IntersectionObserver is unavailable", () => {
    const el = {} as Element;
    expect(shouldFallbackInView(el, false)).toBe(true);
  });

  it("observes when the element exists and IntersectionObserver is available", () => {
    const el = {} as Element;
    expect(shouldFallbackInView(el, true)).toBe(false);
  });
});

describe("entriesIndicateInView", () => {
  it("becomes visible when any entry is intersecting (one-shot trigger)", () => {
    expect(
      entriesIndicateInView([
        { isIntersecting: false },
        { isIntersecting: true },
      ]),
    ).toBe(true);
  });

  it("stays not-yet-visible when nothing intersects", () => {
    expect(
      entriesIndicateInView([{ isIntersecting: false }, { isIntersecting: false }]),
    ).toBe(false);
  });

  it("treats an empty entry list as not intersecting", () => {
    expect(entriesIndicateInView([])).toBe(false);
  });
});

describe("IntersectionObserver one-shot contract (minimal mock)", () => {
  it("disconnects after the first intersecting callback (stays visible forever)", () => {
    const disconnect = vi.fn();
    const observe = vi.fn();
    let callback: IntersectionObserverCallback | undefined;

    class MockIO {
      constructor(cb: IntersectionObserverCallback) {
        callback = cb;
      }
      observe = observe;
      disconnect = disconnect;
      unobserve = vi.fn();
      takeRecords = () => [];
      root = null;
      rootMargin = "";
      thresholds = [];
    }

    vi.stubGlobal("IntersectionObserver", MockIO);

    const io = new IntersectionObserver((entries) => {
      if (entriesIndicateInView(entries)) {
        // mirrors useInView: mark visible then disconnect
        disconnect();
      }
    });
    const el = {} as Element;
    io.observe(el);
    expect(observe).toHaveBeenCalledWith(el);

    // not intersecting yet
    callback?.(
      [{ isIntersecting: false } as IntersectionObserverEntry],
      io as unknown as IntersectionObserver,
    );
    expect(disconnect).not.toHaveBeenCalled();

    // first intersect → disconnect (one-shot); later leaves do not re-arm
    callback?.(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      io as unknown as IntersectionObserver,
    );
    expect(disconnect).toHaveBeenCalledTimes(1);

    callback?.(
      [{ isIntersecting: false } as IntersectionObserverEntry],
      io as unknown as IntersectionObserver,
    );
    expect(disconnect).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });
});
