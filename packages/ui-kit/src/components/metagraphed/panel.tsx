import type { ReactNode, ElementType, ComponentPropsWithoutRef } from "react";
import { classNames } from "@/lib/format";
import { SectionLabel } from "./section-label";

interface PanelOwnProps {
  /** Optional uppercase-mono title, rendered via <SectionLabel>. */
  title?: ReactNode;
  /** Right-aligned header slot (buttons, toggles, freshness pill). */
  action?: ReactNode;
  /** Secondary caption under the title. */
  caption?: ReactNode;
  /** Dense padding variant (uses --mg-panel-pad-dense). */
  dense?: boolean;
  /** Zero padding — use when children own their spacing (e.g. tables). */
  flush?: boolean;
  /**
   * The whole block is a target — a link or a button.
   *
   * This is the ONE case that still gets a container, because an interactive
   * block has to look like something you can hit. It takes the site's card
   * treatment: a raised surface, a half-pixel ring, and a one-pixel lift on
   * hover. A Panel that is merely grouping does not get that, and does not
   * need it.
   */
  interactive?: boolean;
  /**
   * This is the one currently emphasised among its siblings.
   *
   * Selection used to be expressed by passing `tone="accent"`, which tinted
   * the whole card — so a selected panel looked like a semantic warning and a
   * warning looked like a selection. They are different states and now have
   * different names: this draws the brand accent as a hairline and the
   * faintest wash, which is the one emphasis the accent is reserved for.
   */
  selected?: boolean;
  as?: ElementType;
  className?: string;
  bodyClassName?: string;
  children?: ReactNode;
}

export type PanelProps = PanelOwnProps &
  Omit<ComponentPropsWithoutRef<"section">, keyof PanelOwnProps>;

/**
 * A group of related content. Not a card.
 *
 * This drew `rounded-sm border` plus a filled background on all **284** of its
 * uses, which is where most of the site's card-wall impression came from. Of
 * those, ten passed a semantic tone and one a glow: the other ~273 were boxes
 * around content that needed no box, only separation — and a rule and some
 * space separate better than a border, because a border also implies the thing
 * inside is a distinct object.
 *
 * What moved, rather than being hidden behind a flag:
 *
 * - semantic state (`tone`, `tintBorderOnly`) is a `<Callout>`, which is a
 *   different component because it does a different job: it says "read this,
 *   something is wrong" rather than "these things belong together".
 * - `glow` is gone. Soft elevation on a flat system was decoration.
 * - `interactive` stays and now means the card treatment, since a block you
 *   can click is the one kind of panel that genuinely is an object.
 */
export function Panel({
  title,
  action,
  caption,
  dense,
  flush,
  interactive,
  selected,
  as,
  className,
  bodyClassName,
  children,
  ...rest
}: PanelProps) {
  const Cmp: ElementType = as ?? "section";
  const hasHeader = title != null || action != null || caption != null;
  const padClass = flush
    ? "mg-panel-pad-flush"
    : dense
      ? "mg-panel-pad-dense"
      : "mg-panel-pad";
  return (
    <Cmp
      {...rest}
      data-selected={selected ? "true" : undefined}
      className={classNames(
        "mg-panel",
        interactive && "mg-panel--interactive",
        className,
      )}
    >
      {hasHeader ? (
        <header
          className={classNames(
            "mg-panel-header",
            dense ? "mg-panel-pad-dense" : "mg-panel-pad",
          )}
        >
          <div className="min-w-0">
            {title != null ? <SectionLabel>{title}</SectionLabel> : null}
            {caption != null ? (
              <p className="mt-1 mg-type-caption text-ink-muted">{caption}</p>
            ) : null}
          </div>
          {action != null ? (
            <div className="shrink-0 flex items-center gap-2">{action}</div>
          ) : null}
        </header>
      ) : null}
      <div className={classNames(padClass, bodyClassName)}>{children}</div>
    </Cmp>
  );
}
