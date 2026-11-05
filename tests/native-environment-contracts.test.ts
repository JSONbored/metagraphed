import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "vitest";
import { stripJsonComments } from "../scripts/lib/jsonc.ts";
import {
  NATIVE_ROLE_DEFAULTS,
  NATIVE_REQUIRED_SECRETS,
  NATIVE_SETTING_KEYS,
  nativeRuntimeSettings,
  nativeSettingsByOwner,
} from "../src/native-runtime-settings.ts";
import {
  NATIVE_SOURCE_RELATIONS,
  nativeSourceDefinitions,
  nativeSource,
  assertNativeSequencePrivileges,
} from "../src/native-source-manifest.ts";
import type { NativeSource } from "../src/native-api-process.ts";
import type { NativeCronOwner } from "../src/pg-cron.ts";
import { NATIVE_RATE_POLICIES } from "../src/native-rate-policies.ts";

const owners = {
  app: "owner",
  auth: "owner",
  jobs: "owner",
  realtime: "owner",
  retained: "owner",
  search: "owner",
};
const credentials = (owner: NativeCronOwner) =>
  Object.fromEntries(
    NATIVE_REQUIRED_SECRETS[owner].map((key) => [key, "fixture-value"]),
  );

test("native settings retain reviewed feature defaults without legacy selectors", () => {
  const retired = new Set([
    "D1_STATE_TABLES",
    "D1_EXPORT_REVISIONS",
    "METAGRAPH_AI_GATEWAY",
    "ANALYTICS_ENGINE_SQL_TOKEN",
    "ACCOUNT_HISTORY_ASSET_RELEASE",
    "HISTORY_ASSET_RELEASE",
    "NATIVE_HISTORY_ASSET_RELEASE",
  ]);
  for (const [owner, filename] of [
    ["api", "wrangler.jsonc"],
    ["data", "wrangler.data.jsonc"],
    ["registry", "wrangler.registry.jsonc"],
  ] as const) {
    const config = JSON.parse(
      stripJsonComments(
        readFileSync(new URL("../" + filename, import.meta.url), "utf8"),
      ),
    ) as { vars: Record<string, string> };
    assert.deepEqual(
      NATIVE_ROLE_DEFAULTS[owner],
      Object.fromEntries(
        Object.entries(config.vars).filter(([key]) => !retired.has(key)),
      ),
    );
    assert(Object.isFrozen(NATIVE_ROLE_DEFAULTS[owner]));
    assert(Object.isFrozen(NATIVE_REQUIRED_SECRETS[owner]));
    const input = credentials(owner);
    const value = nativeRuntimeSettings(owner, input);
    assert(Object.isFrozen(value));
    input[NATIVE_REQUIRED_SECRETS[owner][0]] = "mutated";
    assert.equal(value[NATIVE_REQUIRED_SECRETS[owner][0]], "fixture-value");
  }
  assert(Object.isFrozen(NATIVE_SETTING_KEYS));
  const supplemental = readFileSync(
    new URL("../workers/env-extra.d.ts", import.meta.url),
    "utf8",
  );
  const constructedOrRetired = new Set([
    "METAGRAPH_AI_GATEWAY",
    "RAW_CAPTURE_STORAGE",
    "ANALYTICS_ENGINE_SQL_TOKEN",
    "ANALYTICS_ENGINE_SQL_ACCOUNT_ID",
  ]);
  for (const name of [
    "RuntimeSecretEnv",
    "ChainHeadPollEnv",
    "RawCaptureLaneEnv",
    "RpcUsageAnalyticsEnv",
  ]) {
    const body = supplemental
      .split(`interface ${name} {`, 2)[1]!
      .split("\n}", 1)[0]!;
    for (const [, key] of body.matchAll(/^ {2}([A-Z][A-Z0-9_]+)\?: string;/gm))
      assert(
        constructedOrRetired.has(key!) ||
          (NATIVE_SETTING_KEYS as readonly string[]).includes(key!),
        `Native scalar setting is unreviewed: ${key}`,
      );
  }
});

test("settings reject missing credentials, unknown objects and disabled active features", () => {
  assert.throws(
    () => nativeRuntimeSettings("other" as NativeCronOwner, {}),
    /Unknown/,
  );
  for (const input of [null, undefined, [], 1, "settings"])
    assert.throws(
      () => nativeRuntimeSettings("api", input),
      /settings are required/,
    );
  assert.throws(
    () => nativeRuntimeSettings("registry", {}),
    /REGISTRY_SYNC_SECRET/,
  );
  const registry = credentials("registry");
  for (const value of [null, 1, {}, "\0", "x".repeat(65537)])
    assert.throws(
      () =>
        nativeRuntimeSettings("registry", {
          ...registry,
          REGISTRY_SYNC_SECRET: value,
        }),
      /Invalid native setting/,
    );
  for (const key of [
    "D1_STATE",
    "D1_STATE_TABLES",
    "AI",
    "HYPERDRIVE",
    "UNKNOWN",
  ])
    assert.throws(
      () => nativeRuntimeSettings("registry", { ...registry, [key]: "value" }),
      /Unsupported/,
    );
  assert.throws(
    () =>
      nativeRuntimeSettings(
        "registry",
        Object.fromEntries(
          Array.from({ length: 257 }, (_, index) => [String(index), "value"]),
        ),
      ),
    /count budget/,
  );
  assert.throws(
    () =>
      nativeRuntimeSettings("api", {
        ...credentials("api"),
        METAGRAPH_ENABLE_AI: "false",
      }),
    /preserve active setting/,
  );
  assert.throws(
    () =>
      nativeRuntimeSettings("data", {
        ...credentials("data"),
        SYNC_QUEUE_LANES: "",
      }),
    /preserve active setting/,
  );
});

test("native owners require credentials used by active entrypoint gates", () => {
  for (const [owner, filename] of [
    ["api", "api.ts"],
    ["data", "data-api.ts"],
  ] as const) {
    const entry = readFileSync(
      new URL("../workers/" + filename, import.meta.url),
      "utf8",
    );
    for (const [, key] of entry.matchAll(
      /if \(!env\.([A-Z_]*(?:SECRET|TOKEN|KEY))\)/g,
    ))
      assert(
        (NATIVE_REQUIRED_SECRETS[owner] as readonly string[]).includes(key!),
        `Native ${owner} credential gate is unreviewed: ${key}`,
      );
  }
});

test("native authentication preserves every declared rate-limit policy", () => {
  const policies = [
    "wrangler.jsonc",
    "wrangler.data.jsonc",
    "wrangler.registry.jsonc",
  ].flatMap((filename) => {
    const config = JSON.parse(
      stripJsonComments(
        readFileSync(new URL("../" + filename, import.meta.url), "utf8"),
      ),
    ) as {
      ratelimits: { name: string; simple: { limit: number; period: number } }[];
    };
    return config.ratelimits.map((item) => ({
      binding: item.name,
      limit: item.simple.limit,
      period: item.simple.period,
    }));
  });
  assert.deepEqual(NATIVE_RATE_POLICIES, policies);
  assert(NATIVE_RATE_POLICIES.every(Object.isFrozen));
});

test("owner settings refuse mismatched internal credentials", () => {
  const input = {
    api: credentials("api"),
    data: credentials("data"),
    registry: credentials("registry"),
  };
  assert(Object.isFrozen(nativeSettingsByOwner(input)));
  for (const value of [null, 1, [], { ...input, other: {} }])
    assert.throws(
      () => nativeSettingsByOwner(value),
      /three application owners/,
    );
  assert.throws(() => nativeSettingsByOwner({}), /settings are required/);
  assert.throws(
    () =>
      nativeSettingsByOwner({
        ...input,
        data: { ...input.data, API_KEY_LOOKUP_INTERNAL_TOKEN: "different" },
      }),
    /credential differs/,
  );
  assert.throws(
    () =>
      nativeSettingsByOwner({
        ...input,
        registry: { REGISTRY_SYNC_SECRET: "different" },
      }),
    /REGISTRY_SYNC_SECRET/,
  );
});

test("source ownership covers runtime DDL with separate read-only retained view", () => {
  const declarations = new Map<string, Set<string>>();
  const directory = new URL("../migrations/postgres/", import.meta.url);
  for (const file of readdirSync(directory).filter((name) =>
    name.endsWith(".sql"),
  )) {
    const text = readFileSync(new URL(file, directory), "utf8");
    for (const match of text.matchAll(
      /CREATE\s+(TABLE|VIEW)\s+(?:IF NOT EXISTS\s+)?([a-z_]+)\.([a-z_0-9]+)/g,
    )) {
      const [, kind, schema, table] = match;
      if (
        schema === "source_meta" ||
        (schema === "app" && table!.startsWith("_"))
      )
        continue;
      const name = schema + (kind === "VIEW" ? "_views" : "");
      if (!declarations.has(name)) declarations.set(name, new Set());
      declarations.get(name)!.add(table!);
    }
  }
  const definitions = nativeSourceDefinitions(owners);
  assert.equal(definitions.length, declarations.size);
  for (const definition of definitions) {
    assert(Object.isFrozen(definition));
    assert(Object.isFrozen(definition.relations));
    assert.deepEqual(
      definition.relations,
      [...declarations.get(definition.name)!].sort(),
    );
    assert.equal(definition.owner, "owner");
    assert.equal(
      definition.schema,
      definition.name === "retained_views" ? "retained" : definition.name,
    );
    assert.equal(
      definition.access,
      definition.name === "retained_views" ? "read" : "read-write",
    );
  }
  for (const input of [
    null,
    [],
    { ...owners, extra: "owner" },
    { ...owners, app: "" },
    { ...owners, jobs: "unsafe-name" },
  ])
    assert.throws(
      () => nativeSourceDefinitions(input as typeof owners),
      /source owner|declared schemas/,
    );
  assert.throws(() => nativeSource(new Map(), "app"), /unavailable/);
});

test("sequence readiness observes every writable source without allocating identifiers", async () => {
  let writable: unknown = true;
  let rows = true;
  const calls: { text: string; values?: unknown[] }[] = [];
  const read = {
    async query<Row>(text: string, values?: unknown[]) {
      calls.push({ text, values });
      return (
        rows ? [{ relation: "items", sequence: "items_id_seq", writable }] : []
      ) as Row[];
    },
    async first<Row>() {
      return null as Row | null;
    },
  };
  const forbidden = async () => {
    throw new Error("readiness must not write");
  };
  const sql = Object.assign(forbidden, { unsafe: forbidden });
  const sources = new Map(
    nativeSourceDefinitions(owners).map((definition) => [
      definition.name,
      {
        ...definition,
        read,
        sql,
        producer: { ...read, run: forbidden, transaction: forbidden },
        transaction: forbidden,
      } as NativeSource,
    ]),
  );
  assert.equal(nativeSource(sources, "app"), sources.get("app"));
  await assertNativeSequencePrivileges(sources);
  assert.equal(calls.length, Object.keys(NATIVE_SOURCE_RELATIONS).length - 1);
  assert(
    calls.every(
      (call) =>
        call.text.includes("'USAGE'") &&
        call.text.includes("'UPDATE'") &&
        !/nextval\s*\(/i.test(call.text),
    ),
  );
  for (const value of [false, null, 0]) {
    writable = value;
    await assert.rejects(
      assertNativeSequencePrivileges(sources),
      /sequence privilege/,
    );
  }
  rows = false;
  await assertNativeSequencePrivileges(sources);
});
