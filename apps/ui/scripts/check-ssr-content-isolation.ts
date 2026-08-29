import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { init, parse } from "es-module-lexer";

interface ModuleImport {
  dynamic: boolean;
  specifier: string;
}

const uiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverRoot = resolve(uiRoot, "dist/server");
const ssrEntry = resolve(serverRoot, "_ssr/index.mjs");

function fail(message: string): never {
  console.error(`::error::${message}`);
  process.exit(1);
}

function moduleImports(file: string): ModuleImport[] {
  if (!existsSync(file)) fail(`SSR isolation gate could not find ${relative(uiRoot, file)}.`);
  const source = readFileSync(file, "utf8");
  const [imports] = parse(source);
  return imports.flatMap((entry) =>
    entry.n
      ? [
          {
            dynamic: entry.d !== -1,
            specifier: entry.n,
          },
        ]
      : [],
  );
}

function dynamicImport(file: string, pattern: RegExp, label: string): string {
  const found = moduleImports(file).find(
    ({ dynamic, specifier }) => dynamic && pattern.test(specifier),
  );
  if (!found) fail(`SSR isolation gate could not locate the active ${label} import.`);
  return resolve(dirname(file), found.specifier);
}

function staticGraph(entry: string): Set<string> {
  const visited = new Set<string>();
  const pending = [entry];

  while (pending.length > 0) {
    const file = pending.pop();
    if (!file || visited.has(file)) continue;
    if (!existsSync(file))
      fail(`SSR static import resolves to missing file ${relative(uiRoot, file)}.`);
    visited.add(file);

    for (const { dynamic, specifier } of moduleImports(file)) {
      if (!dynamic && specifier.startsWith(".")) {
        pending.push(resolve(dirname(file), specifier));
      }
    }
  }

  return visited;
}

function contentModules(graph: Set<string>): string[] {
  return [...graph]
    .filter((file) => file.includes("/_content/"))
    .map((file) => relative(serverRoot, file))
    .sort();
}

function gzipKilobytes(file: string): number {
  return Math.ceil(gzipSync(readFileSync(file)).length / 1024);
}

await init;

const serverEntry = dynamicImport(ssrEntry, /^\.\/server-.*\.mjs$/, "server entry");
const router = dynamicImport(serverEntry, /^\.\/router-.*\.mjs$/, "router");
const routerGraph = staticGraph(router);
const routerContent = contentModules(routerGraph);
if (routerContent.length > 0) {
  fail(
    `The shared SSR router statically reaches compiled MDX content: ${routerContent.join(", ")}. ` +
      "Move content sources behind route/request-time dynamic imports.",
  );
}
if (routerGraph.size < 10) {
  fail(`The active router graph contains only ${routerGraph.size} modules; refusing a false pass.`);
}

const docsSource = dynamicImport(ssrEntry, /^\.\/docs-source-.*\.mjs$/, "docs source");
const newsSource = dynamicImport(ssrEntry, /^\.\/news-source-.*\.mjs$/, "news source");
const docsContent = contentModules(staticGraph(docsSource));
const newsContent = contentModules(staticGraph(newsSource));

if (docsContent.length !== 1 || docsContent[0] !== "_content/docs.mjs") {
  fail(
    `The docs source must reach only _content/docs.mjs; found: ${docsContent.join(", ") || "none"}.`,
  );
}
if (newsContent.length !== 1 || newsContent[0] !== "_content/news.mjs") {
  fail(
    `The news source must reach only _content/news.mjs; found: ${newsContent.join(", ") || "none"}.`,
  );
}

const docsChunk = resolve(serverRoot, docsContent[0]);
const newsChunk = resolve(serverRoot, newsContent[0]);
console.log(
  `SSR content isolation: router entry ${gzipKilobytes(router)} KB gzip; its ${routerGraph.size}-module static graph contains no compiled MDX; ` +
    `docs ${gzipKilobytes(docsChunk)} KB and news ${gzipKilobytes(newsChunk)} KB remain request-loaded and separate.`,
);
