const SOURCE =
  /^(?!(?:display|sharing)\/)(?:[a-z0-9][a-z0-9-]*\/)*[a-z0-9][a-z0-9-]*\.(?:png|jpe?g|gif|svg|webp|ico)$/;

/** Shared discovery policy without a dependency on generated output. */
export function isOgLogoSourcePath(value: string): boolean {
  return SOURCE.test(value);
}
