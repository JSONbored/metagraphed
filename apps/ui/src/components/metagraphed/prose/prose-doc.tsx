import type { ReactNode } from "react";
import { sectionId } from "./prose-doc-logic";

/**
 * One headed section of a prose document.
 *
 * The heading is a plain `<h2>` and takes its type from `.mg-prose`, which
 * puts headings back into the mono face while the body runs in IBM Plex Sans
 * — the one place on the site where those two faces meet.
 */
export function ProseSection({ title, children }: { title: string; children: ReactNode }) {
  const id = sectionId(title);
  return (
    <section id={id} aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>{title}</h2>
      {children}
    </section>
  );
}
