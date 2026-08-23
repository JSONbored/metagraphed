import {
  ActiveEntityProvider,
  DefinitionsProvider,
  EntityHero,
  Fact,
  FactSentence,
  Raw,
  SectionNav,
  type RawRow,
  type SectionNavItem,
} from "@jsonbored/ui-kit";
import { AppShell } from "@/components/metagraphed/app-shell";
import { RouterLink } from "@/components/metagraphed/router-link";
import { DESIGN_TOKENS } from "@/components/metagraphed/design/design-tokens.generated";
import {
  DocumentSection,
  FactsSection,
  HeroSection,
  LiveMetaSection,
  RangeSection,
  RawSection,
} from "@/components/metagraphed/design/document-specimens";
import { InteractionSection } from "@/components/metagraphed/design/interaction-specimens";
import {
  ChartsSection,
  CompareSection,
  CopySection,
  FiltersSection,
  RankSection,
  SheetSection,
  TableSection,
  TokensSection,
} from "@/components/metagraphed/design/data-specimens";
import { DEFINITIONS } from "@/lib/metagraphed/definitions";

/**
 * /design/primitives — the documentation of the design system (#11627).
 *
 * One `AnalyticsSection` per primitive, in the order of the epic
 * (#11606–#11611), each carrying its live specimen, its props as a
 * `DataTable`, and the measured anatomy of the thing it renders. Then the
 * tokens, GENERATED from `packages/ui-kit/src/styles.css` so the page cannot
 * document a colour the app has stopped shipping
 * (`design-tokens.generated.ts`, gated by `design-tokens.test.ts`).
 *
 * It is not an `AnalyticsPage`: that wrapper caps a route at seven sections
 * because a route answers at most seven questions, and this page is a
 * reference rather than a route with a subject. It mounts the same
 * `ActiveEntityProvider` and `SectionNav` by hand instead.
 *
 * The fifteen specimens live in three sibling modules rather than here
 * (#11678): the routes README caps a page module at 600 lines and this one had
 * reached 939, which made the page's actual shape — a hero, a nav, fifteen
 * sections and a source list — unreadable underneath its own contents.
 */
const SECTIONS: SectionNavItem[] = [
  { id: "document", name: "Document" },
  { id: "entity-hero", name: "Hero" },
  { id: "facts", name: "Facts" },
  { id: "live-meta", name: "Liveness" },
  { id: "range-control", name: "Range" },
  { id: "raw", name: "Raw" },
  { id: "interaction", name: "Interaction" },
  { id: "data-table", name: "Table" },
  { id: "charts", name: "Charts" },
  { id: "rank", name: "Ranking" },
  { id: "compare", name: "Compare" },
  { id: "filters", name: "Filters" },
  { id: "copyable-code", name: "Copy" },
  { id: "sheet", name: "Sheet" },
  { id: "tokens", name: "Tokens" },
];

const SOURCE_ROWS: readonly RawRow[] = [
  {
    label: "primitives",
    value: "packages/ui-kit/src/components/metagraphed/",
    copyLabel: "primitives path",
  },
  { label: "tokens", value: "packages/ui-kit/src/styles.css", copyLabel: "stylesheet path" },
  {
    label: "tokens table",
    value: "apps/ui/src/components/metagraphed/design/design-tokens.generated.ts",
    copyLabel: "generated tokens path",
  },
  {
    label: "generator",
    value: "apps/ui/scripts/generate-design-tokens.ts",
    copyLabel: "generator path",
  },
  {
    label: "specimens",
    value: "apps/ui/src/components/metagraphed/design/",
    copyLabel: "specimens path",
  },
];

export function PrimitivesPreview() {
  return (
    <AppShell>
      <DefinitionsProvider definitions={DEFINITIONS}>
        <ActiveEntityProvider>
          <EntityHero
            crumbs={[{ label: "Design", href: "/design/primitives" }, { label: "Primitives" }]}
            name="Design system"
            action={
              <RouterLink href="/docs" className="mg-hero-action">
                Read the docs
              </RouterLink>
            }
            sentence={
              <FactSentence>
                Every primitive the app is built from, with its live specimen, its props and its
                measured anatomy · <Fact>14 primitives</Fact> ·{" "}
                <Fact>{DESIGN_TOKENS.length} tokens</Fact> · <Fact>2 themes</Fact> ·{" "}
                <Fact>1 radius</Fact>
              </FactSentence>
            }
          />
          <SectionNav items={SECTIONS} />

          <DocumentSection />
          <HeroSection />
          <FactsSection />
          <LiveMetaSection />
          <RangeSection />
          <RawSection />
          <InteractionSection />
          <TableSection />
          <ChartsSection />
          <RankSection />
          <CompareSection />
          <FiltersSection />
          <CopySection />
          <SheetSection />
          <TokensSection />

          <Raw rows={SOURCE_ROWS} />
        </ActiveEntityProvider>
      </DefinitionsProvider>
    </AppShell>
  );
}
