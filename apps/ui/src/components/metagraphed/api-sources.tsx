import { useRegisterApiSource } from "@/lib/metagraphed/api-source-context";

/**
 * Declares the API paths a page reads. Renders nothing.
 *
 * This was `ApiSourceFooter`, which BOTH registered the paths and drew its own
 * "data sources" row at the bottom of the page. The shell footer draws them
 * now (#11628), from the same registry, on every route — so the component's
 * own row was the same list twice on the fourteen docs pages that used it, and
 * absent everywhere else. What is left is the declaration, which is the half
 * that was doing the work: the HAR-coverage gate reads these calls to know what
 * a route depends on.
 */
export function ApiSources({ paths, artifacts }: { paths: string[]; artifacts?: string[] }) {
  useRegisterApiSource(paths, artifacts ?? []);
  return null;
}
