/** Build each independent route schema only when a consumer asks for it. */
export function lazySchemaMap<T extends Record<string, () => unknown>>(
  factories: T,
): { [K in keyof T]: ReturnType<T[K]> } {
  const schemas = {} as { [K in keyof T]: ReturnType<T[K]> };
  for (const [key, build] of Object.entries(factories)) {
    Object.defineProperty(schemas, key, {
      enumerable: true,
      configurable: true,
      get() {
        const value = build();
        Object.defineProperty(schemas, key, { value, enumerable: true });
        return value;
      },
    });
  }
  return schemas;
}
