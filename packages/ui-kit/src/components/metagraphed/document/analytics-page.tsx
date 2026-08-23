import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { classNames } from "@/lib/format";
import { ActiveEntityProvider } from "../interaction/active-entity";
import {
  AnalyticsSection,
  type AnalyticsSectionProps,
} from "./analytics-section";
import { SectionNav, type SectionNavItem } from "./section-nav";

/**
 * A route is `EntityHero + ≤7 AnalyticsSection` and nothing else (#11607).
 * The wrapper mounts the active-entity store, renders the section nav from
 * its `AnalyticsSection` children, and refuses an eighth section in
 * development.
 */
export const MAX_SECTIONS = 7;

export interface AnalyticsPageProps {
  /** The `EntityHero` (or, mid-migration, the route's existing masthead). */
  hero?: ReactNode;
  /** `AnalyticsSection` elements. */
  children: ReactNode;
  /**
   * The nav, stated rather than inferred.
   *
   * `sectionItems` can only see an `AnalyticsSection` that is a DIRECT child.
   * A route whose sections are components -- each owning its own queries, as
   * every non-trivial one is -- has children of its own types, so inference
   * silently finds nothing and the page renders with no nav at all. Passing
   * the list is how such a page declares what it contains; the `MAX_SECTIONS`
   * ceiling applies to it exactly as it does to the inferred list.
   */
  sections?: readonly SectionNavItem[];
  className?: string;
}

export function sectionItems(children: ReactNode): SectionNavItem[] {
  const items: SectionNavItem[] = [];
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    if (child.type === AnalyticsSection) {
      const props = (child as ReactElement<AnalyticsSectionProps>).props;
      items.push({
        id: props.id,
        name: typeof props.name === "string" ? props.name : props.id,
      });
    }
  });
  return items;
}

export function AnalyticsPage({
  hero,
  children,
  sections,
  className,
}: AnalyticsPageProps) {
  const items = sections ? [...sections] : sectionItems(children);
  if (items.length > MAX_SECTIONS && process.env.NODE_ENV !== "production") {
    throw new Error(
      `AnalyticsPage: ${items.length} sections; a page answers at most ${MAX_SECTIONS} questions (#11607)`,
    );
  }
  return (
    <ActiveEntityProvider>
      <div className={classNames("mg-page", className)} data-mg-page="">
        {hero}
        <SectionNav items={items} />
        {children}
      </div>
    </ActiveEntityProvider>
  );
}
