import type { ReactNode } from "react";
import { sectionId } from "./prose-doc-logic";

/**
 * One headed section of a prose document.
 *
 * The heading is a plain `<h2>` and takes its type from `.mg-prose`, which
 * sets the article measure and rhythm; the whole site is one face now
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
