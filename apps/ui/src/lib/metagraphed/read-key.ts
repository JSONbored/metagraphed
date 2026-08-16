/**
 * Read a dynamic key off a typed object, as `unknown`.
 *
 * ## The problem this replaces
 *
 * Nine places in this workspace wrote `x as unknown as Record<string, unknown>`
 * so they could look up a key computed at runtime -- a sort column, a
 * parameter name, a "try these four fields in order" fallback. TypeScript
 * refuses the direct index because an INTERFACE has no implicit index
 * signature (a `type` alias for the same object shape does), which is a
 * soundness concession about interfaces being open to declaration merging,
 * not a statement that the read is dangerous.
 *
 * The workaround was worse than the problem. `as unknown as Record<string,
 * unknown>` erases the object's real type, so every OTHER read through the
 * same alias also stopped being checked -- and several call sites then read a
 * known field through it and got `unknown` back, which they cast again.
 *
 * ## Why `Reflect.get`
 *
 * It is the language's own answer and it needs no assertion: `Reflect.get`
 * takes `object` and returns `any`, which narrows to `unknown` on the way out.
 * No cast, no copy of the object, and the argument stays its real type, so
 * every static read at the call site keeps being checked.
 *
 * `Object.fromEntries(Object.entries(x))` would also type cleanly, but it
 * allocates a copy per call -- these run inside table-cell renders and sort
 * comparators.
 */
export function readKey(value: object, key: string): unknown {
  return Reflect.get(value, key);
}

/** A dynamic key read as a string, or `undefined` if it is anything else. */
export function readString(value: object, key: string): string | undefined {
  const found = readKey(value, key);
  return typeof found === "string" ? found : undefined;
}

/**
 * A dynamic key read as a finite number, or `undefined`.
 *
 * Finite and not merely `typeof === "number"`: these values come from JSON,
 * and a `NaN` reaching a `.toFixed()` renders the string "NaN" into a cell
 * rather than the em-dash the absent case is supposed to show.
 */
export function readNumber(value: object, key: string): number | undefined {
  const found = readKey(value, key);
  return typeof found === "number" && Number.isFinite(found) ? found : undefined;
}
