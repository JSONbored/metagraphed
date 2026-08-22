import type { ReactNode } from "react";
import { classNames } from "@/lib/format";

/**
 * One entry in a directory listing.
 *
 * The alternative — a wide table — is what made these pages chaotic: every
 * column ended up speaking a different language (a bare count next to an
 * unlabelled bar next to a four-part price stack), and no cell had room to say
 * what it meant. A row gives each entry one coherent block: who it is on the
 * left, what it is in the middle, its one headline measure on the right, and
 * the supporting facts on a quieter line beneath.
 *
 * Every slot is optional except `title`, and an omitted slot collapses rather
 * than leaving a gap — a directory of sparse entries should not look like a
 * table full of holes.
 */
export function DirectoryRow({
  media,
  title,
  identifier,
  purpose,
  facts,
  value,
  valueMeta,
  className,
}: {
  /** Brand icon or avatar. Sized by the row, not by the caller. */
  media?: ReactNode;
  title: ReactNode;
  /** A stable handle — netuid, address, symbol. Quieter than the title. */
  identifier?: ReactNode;
  /** One plain-language line saying what this is. */
  purpose?: ReactNode;
  /**
   * Supporting facts, rendered on one separated line. Each should be
   * self-describing: "6/6 surfaces up" earns its place, "6" does not.
   */
  facts?: readonly ReactNode[];
  /** The single headline measure. */
  value?: ReactNode;
  /** Its change or unit, directly beneath. */
  valueMeta?: ReactNode;
  className?: string;
}) {
  const shownFacts = (facts ?? []).filter(
    (fact) => fact !== null && fact !== undefined,
  );

  return (
    <div className={classNames("mg-directory-row", className)}>
      {media ? (
        <div className="mg-directory-row-media" aria-hidden="true">
          {media}
        </div>
      ) : null}

      <div className="mg-directory-row-body">
        <div className="mg-directory-row-head">
          <span className="mg-directory-row-title">{title}</span>
          {identifier ? (
            <span className="mg-directory-row-id">{identifier}</span>
          ) : null}
        </div>

        {purpose ? <p className="mg-directory-row-purpose">{purpose}</p> : null}

        {shownFacts.length > 0 ? (
          <ul className="mg-directory-row-facts">
            {shownFacts.map((fact, index) => (
              // Facts are caller-ordered and often not otherwise keyable
              // (a health verdict, a count, a date); position is their identity.
              <li key={index}>{fact}</li>
            ))}
          </ul>
        ) : null}
      </div>

      {value !== undefined && value !== null ? (
        <div className="mg-directory-row-value">
          <span className="mg-directory-row-measure">{value}</span>
          {valueMeta ? (
            <span className="mg-directory-row-meta">{valueMeta}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
