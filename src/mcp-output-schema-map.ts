/** Emit each output schema once, when a listing or validation first needs it.
 * Keeping the emitted object retains its non-enumerable Zod source reference. */
export function lazyOutputSchemas<T>(
  factories: Readonly<Record<string, () => T>>,
): Record<string, T> {
  const schemas: Record<string, T> = {};
  for (const [name, create] of Object.entries(factories)) {
    let ready = false;
    let schema!: T;
    Object.defineProperty(schemas, name, {
      enumerable: true,
      get() {
        if (!ready) {
          schema = create();
          ready = true;
        }
        return schema;
      },
    });
  }
  return schemas;
}
