export interface ApiTagIndexOperation {
  slug: string;
  title: string;
  method: string;
  route: string;
  description: string;
}

interface ApiTagIndexPageOptions {
  tag: string;
  title: string;
  operations: readonly ApiTagIndexOperation[];
}

/** Escape the two characters MDX treats as syntax in OpenAPI prose. */
function escapeMdx(text: string): string {
  return text.replace(/([<{])/g, "\\$1");
}

/**
 * Render the index page for one API tag.
 *
 * Each description sits on its own visual line in the same list item. A
 * trailing backslash is CommonMark's whitespace-clean hard-break form: it is
 * semantically equivalent to Markdown's two trailing spaces, but does not
 * make generated diffs fail `git diff --check`.
 */
export function renderApiTagIndexPage({ tag, title, operations }: ApiTagIndexPageOptions): string {
  const rows = [...operations]
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .map((op) => {
      // The method+path needs no escaping — it is inside a code span, where MDX
      // does not parse JSX. The description is bare prose and does.
      const line = `- [${escapeMdx(op.title)}](/docs/api-reference/${tag}/${op.slug}) — \`${op.method} ${op.route}\``;
      return op.description ? `${line}\\\n  ${escapeMdx(op.description)}` : line;
    })
    .join("\n");

  return (
    `---\n` +
    `title: ${title}\n` +
    `description: Every ${title} endpoint in the metagraphed API, with its method and path.\n` +
    `---\n\n` +
    `${operations.length} endpoint${operations.length === 1 ? "" : "s"}.\n\n` +
    `${rows}\n`
  );
}
