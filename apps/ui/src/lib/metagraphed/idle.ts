/**
 * `requestIdleCallback` where the browser has it, a macrotask where it does
 * not.
 *
 * ## Why this is not a cast
 *
 * `lib.dom` declares `requestIdleCallback` as always present on `Window`.
 * Safari only shipped it in 16.4, so two route files were written not to
 * trust that declaration -- and expressed the doubt by asserting `window` into
 * `{ requestIdleCallback?: (cb: () => void) => number }`, which is a bigger
 * claim than it looks: it also restates the signature, so the day the callback
 * gains its `IdleDeadline` argument or the return type changes, the assertion
 * keeps compiling and the call is wrong.
 *
 * Taking the reference AS a maybe-shape says the same thing without claiming
 * anything. A real `Window` is assignable to `Partial<Pick<Window, ...>>`
 * because every property it has is one the target allows -- so no assertion is
 * needed, and the signatures stay lib.dom's rather than a copy of them.
 *
 * ## Why it is shared
 *
 * -providers-index-page.tsx and -subnets-index-page.tsx had the same eight
 * lines each, four assertions between them. Both prefetch brand icons for a
 * long list once the browser is idle, and neither wants to be the one that
 * gets fixed when the fallback is wrong.
 */
type MaybeIdle = Partial<Pick<Window, "requestIdleCallback" | "cancelIdleCallback">>;

/**
 * Run `callback` when the browser is idle. Returns a handle for `cancelIdle`.
 *
 * The fallback is `setTimeout(..., 1)` and not `0`: this exists to get work
 * OFF the critical path, and a 0ms timeout on a busy main thread still lands
 * in the same frame it was scheduled from.
 */
export function requestIdle(callback: () => void): number {
  const w: MaybeIdle = window;
  return w.requestIdleCallback ? w.requestIdleCallback(callback) : window.setTimeout(callback, 1);
}

/** Cancel a handle from `requestIdle`, whichever scheduler produced it. */
export function cancelIdle(handle: number): void {
  const w: MaybeIdle = window;
  if (w.cancelIdleCallback) {
    w.cancelIdleCallback(handle);
    return;
  }
  window.clearTimeout(handle);
}
