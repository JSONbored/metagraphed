import { describe, it, expect, vi } from "vitest";
import { focusHashTarget, type FocusableEl } from "./use-hash-scroll";

/** A fake element recording its tabindex attribute + focus calls, so the
 * focus-follows-hash logic (#6421) is exercised without a DOM — the suite runs
 * in a plain node environment. */
function fakeEl(initialTabIndex?: string) {
  const attrs = new Map<string, string>();
  if (initialTabIndex !== undefined) attrs.set("tabindex", initialTabIndex);
  const classes = new Set<string>();
  const focus = vi.fn<(options?: { preventScroll?: boolean }) => void>();
  const el: FocusableEl = {
    hasAttribute: (n) => attrs.has(n),
    setAttribute: (n, v) => void attrs.set(n, v),
    classList: { add: (t) => void classes.add(t) },
    focus,
  };
  return { el, attrs, classes, focus };
}

describe("focusHashTarget", () => {
  it("moves focus with preventScroll so it doesn't fight the smooth scroll", () => {
    const { el, focus } = fakeEl();
    focusHashTarget(el);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("makes an unfocusable section focusable and LEAVES the tabindex in place", () => {
    // Persisting tabindex="-1" is deliberate: removing it (as back-to-top does
    // for <main>) blurs the section back to <body>, reverting a keyboard user's
    // focus. tabindex="-1" is not a tab stop, so leaving it costs nothing.
    const { el, attrs } = fakeEl(); // a <section>/<h2> has no tabindex
    focusHashTarget(el);
    expect(attrs.get("tabindex")).toBe("-1");
  });

  it("marks the target so it gets the app's focus ring instead of the UA outline", () => {
    const { el, classes } = fakeEl();
    focusHashTarget(el);
    expect(classes.has("mg-hash-focus")).toBe(true);
  });

  it("leaves an element's own tabindex untouched", () => {
    const { el, attrs, focus } = fakeEl("0"); // already focusable, e.g. tabindex="0"
    focusHashTarget(el);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    // Its real tabindex must survive — we neither overwrite nor strip it.
    expect(attrs.get("tabindex")).toBe("0");
  });
});
