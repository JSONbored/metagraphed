import { afterEach, describe, expect, it, vi } from "vitest";
import { dayLabel } from "./what-changed-feed";

describe("dayLabel (#8356)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("labels the current day 'Today' and the prior day 'Yesterday'", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 27, 12, 0, 0));
    expect(dayLabel("2026-07-27")).toBe("Today");
    expect(dayLabel("2026-07-26")).toBe("Yesterday");
  });

  it("formats any other day with an EXPLICIT locale, never the runtime default", () => {
    // The exact bug: toLocaleDateString(undefined, ...) resolves to whatever
    // locale the calling environment defaults to -- SSR (Cloudflare Workers)
    // and a visitor's own browser routinely disagree, and React's hydration
    // diff throws on the resulting text mismatch. Spying on the real
    // Date.prototype method (rather than only asserting the returned string)
    // proves the FIX's actual mechanism -- an explicit locale argument -- not
    // just that today's test happens to run under an en-US environment.
    const spy = vi.spyOn(Date.prototype, "toLocaleDateString");
    dayLabel("2026-07-20");
    expect(spy).toHaveBeenCalledTimes(1);
    const [locale] = spy.mock.calls[0]!;
    expect(locale).toBe("en-US");
    expect(locale).not.toBeUndefined();
  });

  it("still returns the correct, readable date text", () => {
    expect(dayLabel("2026-07-20")).toBe("Mon, Jul 20");
  });

  it("Today/Yesterday never call toLocaleDateString at all -- pure day-key comparison", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 27, 12, 0, 0));
    const spy = vi.spyOn(Date.prototype, "toLocaleDateString");
    dayLabel("2026-07-27");
    dayLabel("2026-07-26");
    expect(spy).not.toHaveBeenCalled();
  });
});
