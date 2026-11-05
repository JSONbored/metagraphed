export interface NativeStateExport {
  export(input: unknown): Promise<Response>;
}

/** A selected native exporter owns failure; it never revives an old database. */
export function selectedNativeStateExport(
  env: unknown,
): NativeStateExport | null {
  if (!env || typeof env !== "object" || !("NATIVE_STATE_EXPORT" in env))
    return null;
  const value = env.NATIVE_STATE_EXPORT;
  if (
    !value ||
    typeof value !== "object" ||
    !("export" in value) ||
    typeof value.export !== "function"
  )
    throw new TypeError("Native state export capability is incomplete");
  return value as NativeStateExport;
}
