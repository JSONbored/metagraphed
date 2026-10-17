export interface ApiTagIndexOperation {
  slug: string;
  title: string;
  method: string;
  route: string;
  description?: string;
}

/** Escape prose that MDX would otherwise parse as JSX or an expression. */
function escapeMdx(text: string): string {
  return String(text).replace(/([<{])/g, "\\$1");
}

/** One operation in a generated API tag index. */
export function apiTagIndexRow(
  tag: string,
  operation: ApiTagIndexOperation,
): string {
  // Method and path are inside a code span; only the surrounding prose needs
  // MDX escaping. A backslash hard break preserves the description's line
  // break without the trailing spaces rejected by git diff --check (#11553).
  const line = `- [${escapeMdx(operation.title)}](/docs/api-reference/${tag}/${operation.slug}) — \`${operation.method} ${operation.route}\``;
  return operation.description
    ? `${line}\\\n  ${escapeMdx(operation.description)}`
    : line;
}
