import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { repoRoot } from "./lib.ts";
import { sourceFiles } from "./validate-untyped-db-reads.ts";

/** Prevent a typed call, alias, credential binding or direct HTTP transport
 * from bringing the retired SQL service back into request or scheduled code. */
export function retiredStorageFindings(source: string): number[] {
  const ast = ts.createSourceFile(
    "source.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const lines = new Set<number>();
  function visit(node: ts.Node) {
    const text =
      ts.isIdentifier(node) ||
      ts.isStringLiteralLike(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
        ? node.text
        : "";
    if (
      text === "r2SqlQuery" ||
      text.startsWith("R2_SQL_") ||
      /(?:^|\/)r2-sql\.ts$/.test(text) ||
      text.includes("api.sql.cloudflarestorage.com") ||
      text.includes("/r2-sql/query/")
    ) {
      lines.add(ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return [...lines].sort((a, b) => a - b);
}

export function main(): number {
  const findings = sourceFiles(["src", "workers"], repoRoot).flatMap((file) =>
    retiredStorageFindings(readFileSync(file, "utf8")).map(
      (line) => `${path.relative(repoRoot, file)}:${line}`,
    ),
  );
  if (findings.length) {
    process.stderr.write(
      `Retired SQL dependencies remain:\n${findings.join("\n")}\n`,
    );
    return 1;
  }
  process.stdout.write(
    "retired-storage: no SQL client, credential or transport dependencies\n",
  );
  return 0;
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  process.exit(main());
