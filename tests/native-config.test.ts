import assert from "node:assert/strict";
import test from "node:test";
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
  METAGRAPHED_DATABASE_ROLE: "metagraphed_serve",
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
  // The validator read fan-out needs five; createNativeEnvironment enforces it,
  // so the default must never be chosen below that floor.
  assert.ok(options.postgres.maxConnections >= 5);
  // One credential for every logical source this process presents (infra#882).
  assert.deepEqual(
    Object.values(options.owners),
    Array.from(Object.values(options.owners), () => "metagraphed_serve"),
  );
  assert.equal(typeof options.oauthModule.getOAuthApi, "function");
});

test("every missing secret is named, and all of them in one failure", async () => {
  const owners = Object.keys(NATIVE_REQUIRED_SECRETS);
  assert.ok(owners.length >= 2, "the declaration should cover several owners");
  const first = NATIVE_REQUIRED_SECRETS[owners[0] as never][0] as string;
  const last = NATIVE_REQUIRED_SECRETS[owners.at(-1) as never].at(-1) as string;
  const env = completeEnvironment();
  delete env[first];
  delete env[last];

  const error = await build(env).then(
    () => undefined,
    (reason: unknown) => reason,
  );
  assert.ok(error instanceof NativeConfigError, "refuses as a configuration error");
  // Both, not just the first: a deployment learns its whole gap from one failed
  // start instead of one name per restart.
  assert.match(error.message, new RegExp(first));
  assert.match(error.message, new RegExp(last));
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
