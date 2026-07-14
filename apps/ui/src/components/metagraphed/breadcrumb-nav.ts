export type Crumb = { label: string; to: string };

export function buildCrumbs(pathname: string): Crumb[] {
  const parts = pathname.split("/").filter(Boolean);
  const crumbs: Crumb[] = [{ label: "Registry", to: "/" }];
  let acc = "";
  for (const p of parts) {
    acc += "/" + p;
    crumbs.push({ label: decodeURIComponent(p), to: acc });
  }
  return crumbs;
}

// The level directly above the current page — what the mobile back affordance
// links to. Null on the root page, where there's nothing to go back to.
export function parentCrumb(crumbs: Crumb[]): Crumb | null {
  return crumbs.length > 1 ? crumbs[crumbs.length - 2] : null;
}
