import { SectionHeading } from "@jsonbored/ui-kit";
import { DataPageDisclosure } from "@/components/metagraphed/primitives";
import { HUB_COPY, type HubPath } from "@/lib/metagraphed/hub-copy";

/**
 * The prose that makes a hub eligible for the informational query (#11320).
 *
 * Measured before this: `/validators` rendered 1,650 words under **zero** H2s,
 * `/subnets` and `/apis` one each. A hub that is a bare table answers no
 * informational question, which is why eight sites rank for "bittensor subnets
 * list" and we appeared on none of them.
 *
 * **Nothing is added above the table.** #8248 records the masthead being
 * trimmed because nine meta-cards "pushed the table ~1,700px down on mobile",
 * and mobile-first indexing means the narrow layout is the one Google
 * evaluates — so re-spending that height on three paragraphs would trade one
 * ranking factor for another. The short answer goes in the masthead's existing
 * `description` slot (see `hubLede`, which also retires a second hand-written
 * copy of it), and the sections sit below the data, where a reader who scrolled
 * past the table is the one who wants them. A crawler reads the whole document
 * either way.
 *
 * Rendered through ui-kit's `SectionHeading` rather than hand-written markup:
 * it already emits a real `<h2>` with the canonical section styling and takes
 * an `intro` prose slot, so this adds copy without adding a second opinion
 * about what a section looks like.
 */

/**
 * The single-sentence answer, for the masthead's `description`.
 *
 * Every hub had a hand-written masthead description AND a separately written
 * `<meta name="description">` saying nearly the same thing in different words —
 * the same two-copies-of-one-fact shape that let `/apis` ship a `title` and an
 * `og:title` naming the page differently. One source now.
 */
export function hubLede(path: HubPath): string {
  return HUB_COPY[path].description;
}

/**
 * The explanatory sections, rendered below the table.
 *
 * With the headings each hub already has, this brings every one of them to the
 * three-plus a scannable page needs.
 */
export function HubSections({
  path,
  embedded = false,
}: {
  path: HubPath;
  /** Share a surrounding data module's rhythm instead of adding a second section gap. */
  embedded?: boolean;
}) {
  const { sections } = HUB_COPY[path].intro;
  return (
    <div className={embedded ? undefined : "mt-10"}>
      <DataPageDisclosure label="How this data is measured">
        <div className="space-y-section">
          {sections.map((section) => (
            <section key={section.heading}>
              <SectionHeading title={section.heading} intro={section.body} />
            </section>
          ))}
        </div>
      </DataPageDisclosure>
    </div>
  );
}
