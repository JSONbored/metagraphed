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

const reviewedSourceSha256 =
  "6f44fc0e229515d98e23ca75ccf4da17df40eefbe8d84ece4964b03bf977278f";

/** Review both platform and fetch use before binding the source to native
 * public-only fetch. The exact source digest is checked independently. */
export function checkNativeOAuthSource(source: string): void {
  const ast = ts.createSourceFile(
    "oauth-provider.js",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  let imports = 0,
    classChecks = 0,
    fetchCalls = 0,
    cloudflareReferences = 0;
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
    if (ts.isIdentifier(node) && node.text === "Cloudflare") {
      if (
        !ts.isTypeOfExpression(node.parent) &&
        !(
          ts.isPropertyAccessExpression(node.parent) &&
          node.parent.expression === node
        )
      ) {
        throw new Error("Unexpected native OAuth Cloudflare use");
      }
      cloudflareReferences += 1;
    }
    if (ts.isIdentifier(node) && node.text === "fetch") {
      if (ts.isCallExpression(node.parent) && node.parent.expression === node)
        fetchCalls += 1;
      else if (!(
        (ts.isMethodDeclaration(node.parent) && node.parent.name === node) ||
        (ts.isPropertyAccessExpression(node.parent) &&
          node.parent.name === node &&
          !["globalThis", "self", "window"].includes(
            node.parent.expression.getText(ast),
          ))
      )) {
        throw new Error("Unexpected native OAuth fetch use");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (
    imports !== 1 ||
    classChecks !== 1 ||
    fetchCalls !== 2 ||
    cloudflareReferences !== 5
  )
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
  if (digest !== reviewedSourceSha256)
    throw new Error(
      "Native OAuth source digest differs from the reviewed provider",
    );
  const provider = await build({
    stdin: {
      contents: source,
      sourcefile: "workers-oauth-provider-0.8.3.js",
      resolveDir: packagePath,
    },
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node22",
    write: false,
    legalComments: "inline",
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
  // Scope the capability flag and fetch to this generated provider only. Each
  // factory call still wraps its transport in the qualified safety owner.
  const entry = `import { createNativePublicFetch } from ${JSON.stringify(resolve(root, "src/native-public-fetch.ts"))};
export function createNativeOAuthModule(options) {
  const fetch = createNativePublicFetch(options);
  const Cloudflare = { compatibilityFlags: { global_fetch_strictly_public: true } };
  const module = { exports: {} };
  ${provider.outputFiles[0].text}
  return { ...module.exports, publicFetchProtection: true };
}
const native = createNativeOAuthModule();
export const OAuthProvider = native.OAuthProvider;
export const getOAuthApi = native.getOAuthApi;
export const publicFetchProtection = native.publicFetchProtection;`;
  const result = await build({
    stdin: {
      contents: entry,
      sourcefile: "native-oauth-provider.js",
      resolveDir: root,
    },
    absWorkingDir: root,
    bundle: true,
    packages: "external",
    format: "esm",
    platform: "node",
    target: "node22",
    write: false,
    legalComments: "inline",
    banner: {
      js: `/*\nUpstream @cloudflare/workers-oauth-provider 0.8.3:\n${license}\n\nProvider source SHA-256: ${digest}\nNative adapter: metagraphed, AGPL-3.0-or-later.\n*/`,
    },
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
