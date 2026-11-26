import assert from "node:assert/strict";
import { test } from "vitest";
import {
  NativeConfigError,
  nativeConfig,
  type NativeConfigSource,
} from "../src/native-config.ts";
import { NATIVE_REQUIRED_SECRETS } from "../src/native-runtime-settings.ts";

/** The generated OAuth provider is loaded by URL in production; injected here
 * so these cases exercise the configuration rather than the build output. */
const loadOAuth = async () => ({
  publicFetchProtection: true as const,
  OAuthProvider: class {
    async fetch() {
      return new Response("fixture");
    }
  },
  getOAuthApi() {
    throw new Error("unused OAuth fixture");
  },
});

/** Every scalar `nativeConfig` requires outright, apart from the secrets. */
const REQUIRED_TEXT = {
  METAGRAPHED_DATABASE_URL: "postgresql://fixture-only/metagraphed",
  METAGRAPHED_SCHEMA_OWNER: "metagraphed_owner",
  METAGRAPHED_EXPORT_IDENTITY: "urn:metagraphed:export:fixture",
  METAGRAPHED_INFERENCE_BASE_URL: "https://inference.example/v1/",
  METAGRAPHED_INFERENCE_TOKEN: "fixture-token",
  METAGRAPHED_COMPLETION_MODEL: "fixture-completion",
  METAGRAPHED_STATIC_DIRECTORY: "/srv/static",
  METAGRAPHED_ARCHIVE_DIRECTORY: "/srv/archive",
} as const;

/** A complete environment, built from the declaration of what each owner needs
 * rather than from a copied list, so a new required secret reaches these cases
 * without editing them. */
function completeEnvironment(): Record<string, string> {
  const env: Record<string, string> = { ...REQUIRED_TEXT };
  for (const keys of Object.values(NATIVE_REQUIRED_SECRETS))
    for (const key of keys) env[key] = `fixture-${key.toLowerCase()}`;
  return env;
}

const build = (env: NativeConfigSource) => nativeConfig(env, { loadOAuth });

test("a complete environment composes every required option", async () => {
  const options = await build(completeEnvironment());
  assert.equal(options.profile, "serving");
  assert.equal(
    options.postgres.connectionString,
    REQUIRED_TEXT.METAGRAPHED_DATABASE_URL,
  );
  // The default pool is the fleet serving login's own connection limit: above
  // the five the validator fan-out needs, never above what the role may hold.
  assert.equal(options.postgres.maxConnections, 8);
  // The schema OWNER, for all six schemas, and never the login the DSN names.
  assert.deepEqual(options.owners, {
    app: "metagraphed_owner",
    auth: "metagraphed_owner",
    jobs: "metagraphed_owner",
    realtime: "metagraphed_owner",
    retained: "metagraphed_owner",
    search: "metagraphed_owner",
  });
  assert.equal(typeof options.oauthModule.getOAuthApi, "function");
});

test("every missing secret is named, and all of them in one failure", async () => {
  type OwnerKey = keyof typeof NATIVE_REQUIRED_SECRETS;
  const owners = Object.keys(NATIVE_REQUIRED_SECRETS) as readonly OwnerKey[];
  assert.ok(owners.length >= 2, "the declaration should cover several owners");
  const firstKey = NATIVE_REQUIRED_SECRETS[owners[0]][0];
  const lastOwner = owners[owners.length - 1];
  const lastKeys = NATIVE_REQUIRED_SECRETS[lastOwner];
  const lastKey = lastKeys[lastKeys.length - 1];
  const env = completeEnvironment();
  delete env[firstKey];
  delete env[lastKey];

  const error = await build(env).then(
    () => undefined,
    (reason: unknown) => reason,
  );
  assert.ok(
    error instanceof NativeConfigError,
    "refuses as a configuration error",
  );
  // Both, not just the first: a deployment learns its whole gap from one failed
  // start instead of one name per restart.
  assert.match(error.message, new RegExp(firstKey));
  assert.match(error.message, new RegExp(lastKey));
});

test("a required scalar is refused by its own name", async () => {
  for (const key of Object.keys(REQUIRED_TEXT)) {
    const env = completeEnvironment();
    delete env[key];
    const error = await build(env).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    assert.ok(error instanceof Error, `${key} must be required`);
    assert.match(error.message, new RegExp(key), `${key} names itself`);
  }
});

test("a malformed budget refuses instead of silently keeping its default", async () => {
  for (const value of ["", " ", "12.5", "-4", "many", "0"]) {
    const env = completeEnvironment();
    env.METAGRAPHED_MAX_REQUESTS = value;
    const result = await build(env).then(
      (options) => options.maxRequests,
      (reason: unknown) => reason,
    );
    if (value.trim() === "") {
      // Absent and empty are the same thing: the reviewed default stands.
      assert.equal(result, 256, "an empty value keeps the default");
      continue;
    }
    assert.ok(
      result instanceof NativeConfigError,
      `${JSON.stringify(value)} must refuse rather than fall back`,
    );
    assert.match((result as Error).message, /METAGRAPHED_MAX_REQUESTS/);
  }
});

test("the embedding width has one source, so the identities cannot differ", async () => {
  const env = completeEnvironment();
  env.METAGRAPHED_EMBEDDING_DIMENSIONS = "1536";
  env.METAGRAPHED_EMBEDDING_MODEL = "fixture-large";
  const options = await build(env);
  // createNativeEnvironment refuses a disagreement between these two with
  // "identities differ"; reading one variable makes that unreachable here.
  assert.equal(options.semanticIndex.dimensions, 1536);
  assert.equal(options.inference.identity.embedding.dimensions, 1536);
  assert.equal(options.semanticIndex.model, "fixture-large");
  assert.equal(options.inference.identity.embedding.model, "fixture-large");
});

test("an unsupported profile refuses and names the supported set", async () => {
  const env = completeEnvironment();
  env.METAGRAPHED_PROFILE = "admin";
  const error = await build(env).then(
    () => undefined,
    (reason: unknown) => reason,
  );
  assert.ok(error instanceof NativeConfigError);
  for (const profile of ["trusted", "serving", "producer"])
    assert.match(error.message, new RegExp(profile));
});

test("each supported profile is carried through to the composition", async () => {
  for (const profile of ["trusted", "serving", "producer"] as const) {
    const env = completeEnvironment();
    env.METAGRAPHED_PROFILE = profile;
    assert.equal((await build(env)).profile, profile);
  }
});

test("one schema may name a different owner without moving the others", async () => {
  const env = completeEnvironment();
  env.METAGRAPHED_SCHEMA_OWNER_RETAINED = "metagraphed_ingest";
  const options = await build(env);
  assert.equal(options.owners.retained, "metagraphed_ingest");
  assert.equal(options.owners.app, "metagraphed_owner");
});

test("a pool outside what the process and its login can hold refuses", async () => {
  // Four cannot serve the validator fan-out; forty exceeds any login the
  // qualified package admitted. Both are declaration errors, named.
  for (const value of ["4", "40"]) {
    const env = completeEnvironment();
    env.METAGRAPHED_DATABASE_CONNECTIONS = value;
    const error = await build(env).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    assert.ok(error instanceof NativeConfigError, `${value} must refuse`);
    assert.match(error.message, /METAGRAPHED_DATABASE_CONNECTIONS/);
  }
  const env = completeEnvironment();
  env.METAGRAPHED_DATABASE_CONNECTIONS = "5";
  assert.equal((await build(env)).postgres.maxConnections, 5);
});
