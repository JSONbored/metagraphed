import { useRouter, useRouterState } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import {
  AnalyticsSection,
  DataTable,
  EntityHero,
  Fact,
  FactSentence,
  FilterField,
  FilterInput,
  Raw,
  type DataTableColumn,
} from "@jsonbored/ui-kit";
import { AppShell } from "@/components/metagraphed/app-shell";
import { RouterLink } from "@/components/metagraphed/router-link";

/**
 * The five destinations a reader who missed is most likely to have wanted.
 * Paths, not prose: the URL is the thing they typed wrong.
 */
const NOT_FOUND_DESTINATIONS: readonly { path: string; holds: string }[] = [
  { path: "/subnets", holds: "Every subnet, ranked by emission." },
  { path: "/validators", holds: "Every validator, ranked by stake." },
  { path: "/chain", holds: "Blocks, extrinsics and events as they land." },
  { path: "/apis/providers", holds: "Who operates the endpoints." },
  { path: "/apis/schemas", holds: "OpenAPI coverage and schema drift." },
  { path: "/health", holds: "What is up, and what is not." },
];

const NOT_FOUND_COLUMNS: DataTableColumn<(typeof NOT_FOUND_DESTINATIONS)[number]>[] = [
  { key: "path", label: "Path", value: (d) => d.path },
  { key: "holds", label: "What is there", value: (d) => d.holds },
];

/**
 * 404 (#11627) — the site's shell, an EntityHero, one table.
 *
 * It used to be a standalone page with its own 40px display heading, a
 * bordered "Attempted URL" panel, a search field with an absolutely-positioned
 * icon, a six-card grid of example links, and a fourth row of four pill
 * buttons — five separate visual vocabularies for "you are lost". It renders
 * inside `AppShell` now, so the header the reader needs is simply there, and
 * everything below it is the hero, the jump box, and a table of where to go.
 */
export function NotFoundComponent() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const router = useRouter();
  const [query, setQuery] = useState("");
  const attempted =
    typeof window !== "undefined" ? window.location.href : `https://metagraph.sh${pathname}`;

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const raw = query.trim();
    if (!raw) return;
    const n = Number(raw.replace(/[^\d]/g, ""));
    if (Number.isFinite(n) && n >= 0 && n <= 1024) {
      router.navigate({ to: "/subnets/$netuid", params: { netuid: n } });
    } else {
      router.navigate({ to: "/subnets", search: { q: raw } });
    }
  };

  return (
    <AppShell>
      <EntityHero
        name="Nothing at this URL"
        sentence={
          <FactSentence>
            The path you followed is not a registry view. <Fact>404</Fact>
            <Fact>{pathname}</Fact>
          </FactSentence>
        }
      />

      <AnalyticsSection
        id="jump"
        name="Jump to a subnet"
        question="A netuid deep-links to its profile; anything else searches the registry."
        visual={
          <form onSubmit={onSubmit} role="search" aria-label="Find a subnet">
            <FilterField label="Subnet" htmlFor="nf-search">
              <FilterInput
                id="nf-search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="e.g. 7, 74, or a keyword"
              />
            </FilterField>
          </form>
        }
        footnote="netuid 0–1024, or any keyword"
      />

      <AnalyticsSection
        id="destinations"
        name="Where to go instead"
        question="The six indexes the rest of the site hangs off."
        visual={
          <DataTable
            caption="Registry indexes"
            captionHidden
            rows={NOT_FOUND_DESTINATIONS}
            columns={NOT_FOUND_COLUMNS}
            rowKey={(d) => d.path}
            source="not-found"
            paginate={false}
            rowHref={(d) => d.path}
            link={RouterLink}
          />
        }
      />

      {/* The attempted URL, copyable, for a bug report -- the one thing the
          reader might need to send someone else. */}
      <Raw rows={[{ label: "attempted", value: attempted }]} />
    </AppShell>
  );
}
