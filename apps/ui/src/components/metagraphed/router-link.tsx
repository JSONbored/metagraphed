import { Link } from "@tanstack/react-router";
import type { SectionNavLink } from "@jsonbored/ui-kit";

/**
 * The app's router `Link` in the shape ui-kit's `link` slots expect
 * (`DataTable`, `SectionNav`). A table row that renders a bare `<a>` would
 * navigate with a full page load, losing the router's cache and scroll
 * restoration — every table passes this.
 */
export const RouterLink: SectionNavLink = ({ href, children, ...rest }) => (
  <Link to={href} {...rest}>
    {children}
  </Link>
);
