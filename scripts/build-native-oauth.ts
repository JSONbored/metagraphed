import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import ts from "typescript";

// Exact upstream license at v0.8.3, commit be19d92ceaeff7c844cf52dec666bbf0f0243a30.
const license = `MIT License

Copyright (c) 2025 Cloudflare, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

/** The reviewed import uses WorkerEntrypoint only for class validation. CIMD's
 * guarded Cloudflare global is not emulated. Added imports or executable class
 * use require a new native review. */
export function checkNativeOAuthSource(source: string): void {
  const ast = ts.createSourceFile(
    "oauth-provider.js",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  let imports = 0,
    classChecks = 0;
  const visit = (node: ts.Node): void => {
    if (
      (ts.isExportDeclaration(node) && node.moduleSpecifier) ||
      ts.isImportEqualsDeclaration(node)
    ) {
      throw new Error("Unexpected native OAuth module dependency");
    }
    if (ts.isImportDeclaration(node)) {
      const bindings = node.importClause?.namedBindings;
      if (
        !ts.isStringLiteral(node.moduleSpecifier) ||
        node.moduleSpecifier.text !== "cloudflare:workers" ||
        !bindings ||
        !ts.isNamedImports(bindings) ||
        bindings.elements.length !== 1 ||
        bindings.elements[0].name.text !== "WorkerEntrypoint" ||
        bindings.elements[0].propertyName
      ) {
        throw new Error("Unexpected native OAuth import");
      }
      imports += 1;
    }
    if (
      ts.isIdentifier(node) &&
      node.text === "WorkerEntrypoint" &&
      !ts.isImportSpecifier(node.parent)
    ) {
      if (
        !ts.isBinaryExpression(node.parent) ||
        node.parent.right !== node ||
        node.parent.operatorToken.kind !== ts.SyntaxKind.InstanceOfKeyword
      ) {
        throw new Error("Unexpected native OAuth WorkerEntrypoint use");
      }
      classChecks += 1;
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      throw new Error("Unexpected native OAuth dynamic import");
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require"
    ) {
      throw new Error("Unexpected native OAuth require");
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (imports !== 1 || classChecks !== 1)
    throw new Error("Native OAuth platform boundary changed");
}

export async function buildNativeOAuth(
  output = resolve("dist/native/oauth-provider.mjs"),
  root = resolve("."),
): Promise<void> {
  const packagePath = resolve(
    root,
    "node_modules/@cloudflare/workers-oauth-provider",
  );
  const manifest = JSON.parse(
    await readFile(resolve(packagePath, "package.json"), "utf8"),
  );
  const lock = JSON.parse(
    await readFile(resolve(root, "package-lock.json"), "utf8"),
  );
  const pin = lock.packages["node_modules/@cloudflare/workers-oauth-provider"];
  if (
    manifest.version !== "0.8.3" ||
    pin.version !== manifest.version ||
    manifest.license !== "MIT" ||
    !/^sha512-/.test(pin.integrity)
  )
    throw new Error(
      "Native OAuth requires the reviewed lock-pinned MIT provider",
    );
  const source = await readFile(
    resolve(packagePath, "dist/oauth-provider.js"),
    "utf8",
  );
  checkNativeOAuthSource(source);
  const digest = createHash("sha256").update(source).digest("hex");
  const result = await build({
    stdin: {
      contents: source,
      sourcefile: "workers-oauth-provider-0.8.3.js",
      resolveDir: packagePath,
    },
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    write: false,
    legalComments: "inline",
    banner: { js: `/*\n${license}\n\nProvider source SHA-256: ${digest}\n*/` },
    plugins: [
      {
        name: "native-oauth-object-handlers",
        setup(builder) {
          builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: "object-handlers",
            namespace: "native-oauth",
          }));
          builder.onLoad({ filter: /.*/, namespace: "native-oauth" }, () => ({
            contents:
              'export class WorkerEntrypoint { constructor() { throw new TypeError("Native OAuth only supports object handlers"); } }',
            loader: "js",
          }));
        },
      },
    ],
  });
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, result.outputFiles[0].contents);
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await buildNativeOAuth(process.argv[2]);
}
