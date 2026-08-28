import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HUB_COPY, type HubPath } from "@/lib/metagraphed/hub-copy";
import { HubSections } from "./hub-prose";

const PATHS = Object.keys(HUB_COPY) as HubPath[];

describe("HubSections", () => {
  it.each(PATHS)("%s keeps headings separate from explanatory body copy", (path) => {
    const html = renderToStaticMarkup(<HubSections path={path} />);
    const { sections } = HUB_COPY[path].intro;

    expect(html).toContain('class="mg-prose mg-hub-prose mt-10"');
    expect(html.match(/<h2>/g)).toHaveLength(sections.length);
    expect(html.match(/<p>/g)).toHaveLength(sections.length);

    for (const section of sections) {
      expect(html).toContain(renderToStaticMarkup(<h2>{section.heading}</h2>));
      expect(html).toContain(renderToStaticMarkup(<p>{section.body}</p>));
      expect(html).not.toContain(renderToStaticMarkup(<h2>{section.body}</h2>));
    }
  });
});
