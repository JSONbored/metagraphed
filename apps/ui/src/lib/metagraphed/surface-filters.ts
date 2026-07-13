import { z } from "zod";
import { fallback } from "@tanstack/zod-adapter";

import { tableSearchSchema, matchesQuery } from "@/lib/metagraphed/url-state";
import type { Surface } from "@/lib/metagraphed/types";

/**
 * /surfaces extends the shared table-state schema with three public-interface
 * filter shortcuts that the nav mega-menu links to (`?public_safe=1`,
 * `?auth=required`, `?rate_limited=1`). They live here — not on the shared
 * `tableSearchSchema` — so the sibling /subnets route's schema stays lean.
 */
export const surfacesSearchSchema = tableSearchSchema.extend({
  public_safe: fallback(z.string(), "").default(""),
  auth: fallback(z.string(), "").default(""),
  rate_limited: fallback(z.string(), "").default(""),
});

export type SurfacesSearch = z.infer<typeof surfacesSearchSchema>;

/**
 * Whether a surface row passes the active /surfaces filters. Kept pure so every
 * branch — including the `public_safe` / `auth` / `rate_limited` shortcuts wired
 * for #3975, which previously rendered the unfiltered list — is unit-tested
 * without rendering. Rate-limited surfaces are those that document a limit via
 * the per-row `rate_limit_notes` field.
 */
export function matchesSurfaceFilters(s: Surface, search: SurfacesSearch): boolean {
  if (!matchesQuery([s.name, s.url, s.provider, s.provider_slug, s.netuid], search.q)) return false;
  if (search.kind && s.kind !== search.kind) return false;
  if (search.provider && (s.provider_slug ?? s.provider) !== search.provider) return false;
  if (search.netuid && String(s.netuid) !== search.netuid) return false;
  if (search.public_safe && !s.public_safe) return false;
  if (search.auth === "required" && !s.auth_required) return false;
  if (search.auth === "none" && s.auth_required) return false;
  if (search.rate_limited && !s.rate_limit_notes) return false;
  return true;
}
