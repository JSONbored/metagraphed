import { Link, useRouterState } from "@tanstack/react-router";
import { SectionNav, type SectionNavLink } from "@jsonbored/ui-kit";
import { apisNav } from "./apis-logic";

// API sections are sibling destinations. Prefix matching would also select
// Catalog on every child route, overriding the explicit current-page flag.
const ApiSectionLink: SectionNavLink = ({ href, children, ...rest }) => (
  <Link to={href} activeOptions={{ exact: true }} {...rest}>
    {children}
  </Link>
);

export function ApiNavigation() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  return <SectionNav items={apisNav(pathname)} link={ApiSectionLink} />;
}
