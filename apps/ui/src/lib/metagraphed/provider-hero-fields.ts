/**
 * Whether the provider hero's slug subtitle is worth rendering — skipped
 * when it's just a case-folded repeat of the display name (e.g. name
 * "404-GEN" next to slug "404-gen" reads as the same string twice).
 */
export function shouldShowProviderSlugSubtitle(name: string | undefined, slug: string): boolean {
  if (!name) return false;
  return name.toLowerCase() !== slug.toLowerCase();
}
