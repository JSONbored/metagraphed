import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";
import {
  buildNativeOAuth,
  checkNativeOAuthSource,
} from "../scripts/build-native-oauth.ts";
import { loadNativeOAuthProvider } from "../src/native-oauth-provider.ts";

const source =
  'import { WorkerEntrypoint } from "cloudflare:workers"; const valid = handler.prototype instanceof WorkerEntrypoint; ' +
  'if (!(typeof Cloudflare !== "undefined" && Cloudflare.compatibilityFlags?.global_fetch_strictly_public === true)) {} ' +
  'function safety() { return !!(typeof Cloudflare !== "undefined" && Cloudflare.compatibilityFlags ? Cloudflare.compatibilityFlags : null)?.global_fetch_strictly_public; } ' +
  'fetch("one"); fetch("two");';

test("native bundle rejects expanded or executable platform dependencies", () => {
  checkNativeOAuthSource(source);
  for (const invalid of [
    "",
    source + source,
    source.replace("cloudflare:workers", "node:fs"),
    source.replace("{ WorkerEntrypoint }", "{ WorkerEntrypoint as Other }"),
    source.replace("{ WorkerEntrypoint }", "{ WorkerEntrypoint, Other }"),
    source.replace("{ WorkerEntrypoint }", "WorkerEntrypoint"),
    source.replace(
      "handler.prototype instanceof WorkerEntrypoint",
      "new WorkerEntrypoint()",
    ),
    source + ' import("other");',
    source + ' require("other");',
    source + ' export * from "other";',
    source + ' import other = require("other");',
    source + " WorkerEntrypoint.someMethod();",
    source + " globalThis.fetch('extra');",
    source + " const copy = fetch;",
    source + " const Cloudflare = {};",
    source + " fetch('extra');",
  ])
    assert.throws(
      () => checkNativeOAuthSource(invalid),
      /native OAuth|platform boundary/,
    );
});

test("native bundle is deterministic, attributed, and loads the real locked provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "oauth-build-"));
  try {
    const first = join(root, "first.mjs"),
      second = join(root, "second.mjs");
    await buildNativeOAuth(first);
    await buildNativeOAuth(second);
    const text = await readFile(first, "utf8");
    assert.equal(text, await readFile(second, "utf8"));
    assert.match(text, /Copyright \(c\) 2025 Cloudflare, Inc\./);
    assert.match(text, /Provider source SHA-256: [a-f0-9]{64}/);
    assert.doesNotMatch(text, /from ["']cloudflare:workers/);
    const loaded = await loadNativeOAuthProvider(pathToFileURL(first));
    assert.equal(typeof loaded.OAuthProvider, "function");
    assert.equal(typeof loaded.getOAuthApi, "function");
    await writeFile(
      join(root, "invalid.mjs"),
      "export const unrelated = true;",
    );
    await assert.rejects(
      loadNativeOAuthProvider(pathToFileURL(join(root, "invalid.mjs"))),
      /Invalid generated/,
    );
    await writeFile(
      join(root, "missing-helper.mjs"),
      "export class OAuthProvider {}",
    );
    await assert.rejects(
      loadNativeOAuthProvider(pathToFileURL(join(root, "missing-helper.mjs"))),
      /Invalid generated/,
    );
    for (const [name, text] of [
      [
        "missing-factory",
        "export class OAuthProvider {} export function getOAuthApi() {}",
      ],
      [
        "missing-protection",
        "export class OAuthProvider {} export function getOAuthApi() {} export function createNativeOAuthModule() {}",
      ],
    ]) {
      await writeFile(join(root, `${name}.mjs`), text);
      await assert.rejects(
        loadNativeOAuthProvider(pathToFileURL(join(root, `${name}.mjs`))),
        /Invalid generated/,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native bundle refuses an unreviewed version, license, lock or source", async () => {
  const root = await mkdtemp(join(tmpdir(), "oauth-pin-"));
  const packagePath = join(
    root,
    "node_modules/@cloudflare/workers-oauth-provider",
  );
  try {
    await mkdir(join(packagePath, "dist"), { recursive: true });
    for (const [version, license, lockVersion, integrity] of [
      ["0.8.4", "MIT", "0.8.4", "sha512-test"],
      ["0.8.3", "other", "0.8.3", "sha512-test"],
      ["0.8.3", "MIT", "0.8.2", "sha512-test"],
      ["0.8.3", "MIT", "0.8.3", "sha256-test"],
    ]) {
      await writeFile(
        join(packagePath, "package.json"),
        JSON.stringify({ version, license }),
      );
      await writeFile(
        join(root, "package-lock.json"),
        JSON.stringify({
          packages: {
            "node_modules/@cloudflare/workers-oauth-provider": {
              version: lockVersion,
              integrity,
            },
          },
        }),
      );
      await assert.rejects(
        buildNativeOAuth(join(root, "output.mjs"), root),
        /reviewed lock-pinned/,
      );
    }
    await writeFile(
      join(root, "package-lock.json"),
      JSON.stringify({
        packages: {
          "node_modules/@cloudflare/workers-oauth-provider": {
            version: "0.8.3",
            integrity: "sha512-test",
          },
        },
      }),
    );
    await writeFile(
      join(packagePath, "dist/oauth-provider.js"),
      "import other from 'other';",
    );
    await assert.rejects(
      buildNativeOAuth(join(root, "output.mjs"), root),
      /Unexpected native OAuth/,
    );
    await writeFile(join(packagePath, "dist/oauth-provider.js"), source);
    await assert.rejects(
      buildNativeOAuth(join(root, "output.mjs"), root),
      /source digest differs/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
