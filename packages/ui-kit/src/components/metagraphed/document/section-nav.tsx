import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { classNames } from "@/lib/format";

/**
 * The in-page section nav (#11607): the sections' names as 11px links,
 * sticky under the header at 1280, the active one underlined by an
 * IntersectionObserver. Replaces page tabs and the section copy-link button.
 */
export interface SectionNavItem {
  id: string;
  name: string;
  /** A route instead of an in-page anchor (a hub's sub-routes). */
  href?: string;
  /** For `href` items: whether this is the current route. */
  current?: boolean;
}

export type SectionNavLink = ComponentType<{
  href: string;
  className?: string;
  "aria-current"?: "page";
  children: ReactNode;
}>;

export interface SectionNavProps {
  items: readonly SectionNavItem[];
  /** Renders `href` items (pass the app's router Link); defaults to `<a>`. */
  link?: SectionNavLink;
  className?: string;
}

/**
 * The active section is the first one, in document order, that is on screen
 * -- so scrolling down through a long visual keeps its heading lit until the
 * next heading arrives, and a short last section can still become active.
 */
export function pickActiveSection(
  ids: readonly string[],
  visible: ReadonlySet<string>,
  current: string | null,
): string | null {
  return ids.find((id) => visible.has(id)) ?? current;
}

export function useActiveSection(ids: readonly string[]): string | null {
  const [active, setActive] = useState<string | null>(ids[0] ?? null);
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const visible = new Map<string, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.set(e.target.id, e.intersectionRatio);
          else visible.delete(e.target.id);
        }
        setActive((current) =>
          pickActiveSection(ids, new Set(visible.keys()), current),
        );
      },
      { rootMargin: "-80px 0px -60% 0px", threshold: [0, 0.25, 0.5] },
    );
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [ids]);
  return active;
}

export function SectionNav({ items, link, className }: SectionNavProps) {
  const anchors = items.filter((i) => !i.href).map((i) => i.id);
  const active = useActiveSection(anchors);
  if (items.length === 0) return null;
  const LinkCmp = link ?? DefaultLink;
  return (
    <nav
      className={classNames("mg-section-nav", className)}
      aria-label="Sections"
      data-mg-section-nav=""
    >
      <ul>
        {items.map((item) =>
          item.href ? (
            <li key={item.id}>
              <LinkCmp
                href={item.href}
                aria-current={item.current ? "page" : undefined}
              >
                {item.name}
              </LinkCmp>
            </li>
          ) : (
            <li key={item.id}>
              <a
                href={`#${item.id}`}
                aria-current={active === item.id ? "location" : undefined}
              >
                {item.name}
              </a>
            </li>
          ),
        )}
      </ul>
    </nav>
  );
}

const DefaultLink: SectionNavLink = ({ href, children, ...rest }) => (
  <a href={href} {...rest}>
    {children}
  </a>
);
