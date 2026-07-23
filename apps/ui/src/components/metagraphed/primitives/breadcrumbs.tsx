import { Fragment } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronRight, Home } from "lucide-react";
import { buildCrumbs, type Crumb } from "@/components/metagraphed/breadcrumb-nav";
import { classNames } from "@/lib/metagraphed/format";

export interface BreadcrumbsProps {
  /** Override the auto-derived pathname; useful for tests. */
  pathname?: string;
  /** Or pass fully-formed crumbs directly. */
  crumbs?: Crumb[];
  className?: string;
}

/**
 * Registry-wide breadcrumb strip. Rendered above PageHero on child list and
 * detail routes so users always know where they sit in the /subnets/…,
 * /providers/…, /blocks/… hierarchies.
 */
export function Breadcrumbs({ pathname, crumbs, className }: BreadcrumbsProps) {
  const resolved =
    crumbs ??
    (typeof pathname === "string"
      ? buildCrumbs(pathname)
      : typeof window !== "undefined"
        ? buildCrumbs(window.location.pathname)
        : []);
  if (resolved.length <= 1) return null;
  return (
    <nav
      aria-label="Breadcrumb"
      className={classNames(
        "flex flex-wrap items-center gap-1 font-mono text-[10px] uppercase tracking-widest text-ink-muted",
        className,
      )}
    >
      {resolved.map((c, i) => {
        const isLast = i === resolved.length - 1;
        return (
          <Fragment key={`${i}-${c.to}`}>
            {i === 0 ? (
              <Home className="size-3 mr-0.5" aria-hidden />
            ) : (
              <ChevronRight className="size-3 opacity-60" aria-hidden />
            )}
            {isLast ? (
              <span aria-current="page" className="text-ink-strong">
                {c.label}
              </span>
            ) : (
              <Link
                to={c.to}
                className="hover:text-ink-strong transition-colors mg-focus-ring rounded"
              >
                {c.label}
              </Link>
            )}
          </Fragment>
        );
      })}
    </nav>
  );
}
