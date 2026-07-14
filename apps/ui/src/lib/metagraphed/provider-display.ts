/**
 * Decide what the provider hero should show as its slug subtitle.
 *
 * The hero title falls back to the slug when a provider has no display name
 * (`name ?? slug`), so echoing the slug in the subtitle is redundant whenever
 * the displayed title already is the slug — e.g. a provider named "404-GEN"
 * with slug "404-gen" would otherwise render "404-GEN · 404-gen".
 *
 * Returns the slug to render as the subtitle, or `null` when it would only
 * repeat the displayed title (matched case-insensitively).
 */
export function providerSlugSubtitle(
  name: string | null | undefined,
  slug: string,
): string | null {
  const displayTitle = name?.trim() ? name.trim() : slug;
  return displayTitle.toLowerCase() === slug.trim().toLowerCase() ? null : slug;
}
