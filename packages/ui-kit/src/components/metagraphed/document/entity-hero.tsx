import type { ReactNode } from "react";
import { classNames } from "@/lib/format";
import { FactStrip, type FactCells } from "./fact-strip";
import { LiveMeta, type LiveMetaProps } from "./live-meta";

/**
 * The hero every entity route opens with (#11607): breadcrumb chips → name
 * (40px) with an optional 40px avatar and ONE primary action → the fact
 * sentence → the fact strip → the liveness line. No badge row, no icon rail,
 * no "show more stats", no status pill -- states are words in fact chips.
 */
export interface Crumb {
  label: string;
  href?: string;
}

/** Up to six facts in the sentence, enforced by the tuple type. */
export type FactNodes =
  | readonly []
  | readonly [ReactNode]
  | readonly [ReactNode, ReactNode]
  | readonly [ReactNode, ReactNode, ReactNode]
  | readonly [ReactNode, ReactNode, ReactNode, ReactNode]
  | readonly [ReactNode, ReactNode, ReactNode, ReactNode, ReactNode]
  | readonly [ReactNode, ReactNode, ReactNode, ReactNode, ReactNode, ReactNode];

export interface EntityHeroProps {
  crumbs?: readonly Crumb[];
  name: ReactNode;
  /** A 40px, 4px-radius avatar (e.g. `BrandIcon`). */
  avatar?: ReactNode;
  /** The one primary action (a `<Link>` or `<button>` styled by `.mg-hero-action`). */
  action?: ReactNode;
  /** Secondary icon actions (watch, share). */
  secondary?: ReactNode;
  /** The `FactSentence` (build it with `<Fact>` chips). */
  sentence?: ReactNode;
  cells?: FactCells;
  /** A composed `<FactStrip>` (routes mid-migration that map legacy KPI arrays). */
  facts?: ReactNode;
  live?: LiveMetaProps;
  /**
   * The heading level for `name`. 1 on a route, which is every real use.
   *
   * 3 on /design/primitives, where a hero is a SPECIMEN inside a documented
   * section rather than the page's own subject: emitting `<h1>` there gave that
   * page two of them (#11691), which is a document with two titles as far as a
   * screen reader is concerned.
   */
  headingLevel?: 1 | 2 | 3;
  className?: string;
}

export function EntityHero({
  crumbs,
  name,
  avatar,
  action,
  secondary,
  sentence,
  cells,
  facts,
  live,
  headingLevel = 1,
  className,
}: EntityHeroProps) {
  return (
    <header className={classNames("mg-hero", className)} data-mg-hero="">
      {crumbs && crumbs.length > 0 ? (
        <nav className="mg-hero-crumbs" aria-label="Breadcrumb">
          {crumbs.map((c, i) => (
            <span key={`${c.label}-${i}`} className="mg-hero-crumb">
              {c.href ? <a href={c.href}>{c.label}</a> : c.label}
            </span>
          ))}
        </nav>
      ) : null}
      <div className="mg-hero-title">
        {avatar ? <span className="mg-hero-avatar">{avatar}</span> : null}
        {headingLevel === 1 ? (
          <h1>{name}</h1>
        ) : headingLevel === 2 ? (
          <h2>{name}</h2>
        ) : (
          <h3>{name}</h3>
        )}
        {action || secondary ? (
          <div className="mg-hero-actions">
            {secondary}
            {action}
          </div>
        ) : null}
      </div>
      {sentence}
      {cells ? <FactStrip cells={cells} /> : null}
      {facts}
      {live ? <LiveMeta {...live} /> : null}
    </header>
  );
}
