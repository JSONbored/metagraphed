// Comments out of TypeScript source, for the gates that scan it.
//
// Three gates had byte-identical copies of this -- tests/no-sqlite-only-sql,
// tests/served-family-completeness and scripts/validate-route-query-parity,
// all of which learned the hard way that a comment naming a symbol reads as a
// reference and fails nothing when the symbol goes. The copies were added
// while fixing exactly that, which is a poor place to leave three of anything.
//
// NOT a parser, and the gates that use it do not need one: they scan for
// string literals or symbol names, so a comment left in would create a false
// match while a little over-stripping only loses a match the real code also
// lacks. A gate that needs to know what the code MEANS should resolve it
// instead (validate:unreferenced-exports uses knip for that reason).
//
// The other strippers in this tree are deliberately NOT this function:
//
//   - scripts/validate-declared-tables-exist.ts strips SQL `--`, a different
//     language;
//   - tests/served-family-completeness.ts also has withoutSqlComments, which
//     is string-literal aware because `--` can appear inside one;
//   - tests/read-store-*.ts strip only line-leading `//`, which is enough for
//     what they scan and cheaper than this;
//   - tests/neon-prune.ts, scripts/validate-lakehouse-readers.ts and
//     scripts/report-shape-duplicate-drift.ts replace with "" rather than " ",
//     which matters where the result is then matched for adjacent tokens, and
//     the last of those is a whitespace normaliser rather than a stripper.
//
// Consolidating those would change what they produce. Three identical copies
// is a shared definition; seven different ones are seven different questions.

/**
 * TypeScript comments replaced by a space.
 *
 * A SPACE, not "": the callers scan the result for tokens, and joining the
 * text either side of a comment can create a match that is not in the source.
 *
 * The `([^:])` guard on the inline pass is the non-obvious part and the reason
 * this deserves one home: without it, `https://example.com` loses everything
 * from its `//` onwards, so any gate scanning a file that mentions a URL
 * silently stops seeing the rest of that line.
 */
export function stripTsComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/([^:])\/\/.*$/gm, "$1 ");
}
