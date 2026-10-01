// Temporary qualification handoff: the existing test runner uploads cov-out.
// Generated contracts are copied from the ordinary CI build, never generated
// on a contributor's Mac. Removed after the exact generated files are reviewed.
import { test } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";
import path from "node:path";
import { format } from "prettier";

test("retain remote generated contract artifacts for review", async () => {
  if (!process.env.CI) return;
  const changed = execFileSync("git", ["diff", "--name-only"], {
    encoding: "utf8",
  })
    .trim()
    .split("\n");
  const paths = changed.filter(
    (path) =>
      /^(public\/|generated\/|packages\/contract\/|packages\/client\/dist\/|docs\/reference\/)/.test(
        path,
      ) &&
      ![
        "public/metagraph/r2-manifest.json",
        "public/metagraph/schemas/index.json",
        "public/metagraph/operational-surfaces.json",
      ].includes(path),
  );
  const files = Object.fromEntries(
    paths.map((path) => [path, readFileSync(path, "utf8")]),
  );
  for (const source of ["src/chain-rpc.ts", "src/mcp-server.ts"]) {
    files[source] = await format(readFileSync(source, "utf8"), {
      filepath: source,
    });
  }
  mkdirSync("cov-out", { recursive: true });
  writeFileSync(
    "cov-out/root-basket-contract-artifacts.json.gz",
    gzipSync(JSON.stringify(files)),
  );
  console.log("ROOT_BASKET_GENERATED_ARTIFACTS", JSON.stringify(paths));
});

test("retain remote data-api bundle comparison against the verified base", async () => {
  if (!process.env.CI) return;
  const base = "fcec0582cf3b1e7a230782fab769b28a05912b01";
  const touched = new Set(
    execFileSync("git", ["diff", "--name-only", base, "HEAD"], {
      encoding: "utf8",
    })
      .trim()
      .split("\n"),
  );
  const measure = async (previous: boolean) => {
    const result = await build({
      entryPoints: ["workers/data-api.ts"],
      bundle: true,
      write: false,
      minify: true,
      format: "esm",
      platform: "node",
      metafile: true,
      external: ["node:*", "cloudflare:workers"],
      plugins: previous
        ? [
            {
              name: "verified-base-source",
              setup(builder) {
                builder.onLoad({ filter: /\.(ts|js|json)$/ }, (args) => {
                  const relative = path.relative(process.cwd(), args.path);
                  if (!touched.has(relative)) return;
                  return {
                    contents: execFileSync(
                      "git",
                      ["show", `${base}:${relative}`],
                      { encoding: "utf8" },
                    ),
                    loader: relative.endsWith(".json")
                      ? "json"
                      : relative.endsWith(".ts")
                        ? "ts"
                        : "js",
                  };
                });
              },
            },
          ]
        : [],
    });
    const bytes = result.outputFiles![0]!.contents;
    return {
      source_bytes: Object.entries(result.metafile!.inputs)
        .filter(([name]) => /^(src|workers|schemas-src|generated)\//.test(name))
        .reduce((sum, [, value]) => sum + value.bytes, 0),
      minified_bytes: bytes.length,
      gzip_bytes: gzipSync(bytes).length,
    };
  };
  console.log(
    "ROOT_BASKET_DATA_API_GRAPH",
    JSON.stringify({
      base,
      before: await measure(true),
      after: await measure(false),
      production: false,
    }),
  );
});
