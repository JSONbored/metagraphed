import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { providersQuery } from "@/lib/metagraphed/queries";
import { EntityIndexDirectory } from "./entity-index-directory";

/**
 * A complete, crawlable index of every provider (#11204).
 *
 * The same defect the subnet index fixes, on the other hub: /apis/providers
 * server-rendered 25 links for 138 providers, so 113 provider pages had no
 * internal link anywhere on the site. See EntityIndexDirectory for the full
 * reasoning.
 */
export function ProviderIndexDirectory() {
  const { data } = useSuspenseQuery(providersQuery());
  // Sorted by display name: unlike subnets, a provider has no numeric identity
  // to order by, and a name is what a reader scans a directory for. The slug is
  // the route key, so an entry without one cannot be linked and is dropped.
  // `name` is optional on the type even though the list normalizer falls back
  // to the slug — resolved here rather than asserted, so a future shape change
  // surfaces as a type error instead of an empty anchor.
  const providers = [...data.data]
    .flatMap((provider) =>
      provider.slug ? [{ slug: provider.slug, label: provider.name ?? provider.slug }] : [],
    )
    .sort((a, b) => a.label.localeCompare(b.label));

  return (
    <EntityIndexDirectory label="providers" count={providers.length}>
      {providers.map((provider) => (
        <li key={provider.slug} className="break-inside-avoid py-0.5">
          <Link
            to="/providers/$slug"
            params={{ slug: provider.slug }}
            className="text-13 text-ink-muted hover:text-accent"
          >
            {provider.label}
          </Link>
        </li>
      ))}
    </EntityIndexDirectory>
  );
}
