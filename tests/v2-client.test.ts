import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";
import { V2_OPERATION_SCHEMAS } from "../schemas-src/v2/contracts.ts";
import {
  createV2ReadClient,
  V2ReadClientError,
  type V2ReadOperation,
  type V2ReadOutput,
} from "../src/v2/client.ts";
import { createModernApplication } from "../src/modern-application.ts";
import {
  canonicalSubnet,
  ecosystemFixture,
} from "../scripts/lib/modern-ecosystem-fixture.ts";
import {
  MODERN_FIXTURE,
  modernVerificationFixture,
} from "../scripts/lib/modern-verification-fixture.ts";

const origin = "https://example.test";
const hash = (digit: string) => `0x${digit.repeat(64)}`;
const publication = "2".repeat(64);
const ecosystemPublication = MODERN_FIXTURE.ecosystemPublication;
const envelope = {
  api_version: "2",
  network: { id: "finney", genesis_hash: hash("0") },
  snapshot: {
    block_number: "123",
    block_hash: hash("1"),
    parent_hash: hash("9"),
    metadata_digest: "5".repeat(64),
    spec_version: 488,
    transaction_version: 1,
    producer_revision: "6".repeat(40),
    publication_id: publication,
    observed_at: MODERN_FIXTURE.now,
    published_at: MODERN_FIXTURE.now,
  },
  freshness: {
    status: "current",
    age_seconds: 0,
    finalized_lag_blocks: "0",
    target_seconds: 30,
    target_blocks: 2,
  },
};
const head = {
  ...envelope,
  coverage: { from_block: "120", through_block: "123", contiguous: true },
  observed_finalized: {
    block_number: "123",
    block_hash: hash("1"),
    observed_at: MODERN_FIXTURE.now,
  },
};
const subnet = (netuid: number) =>
  canonicalSubnet({ netuid, counter: "0", registrationBlock: 0 });
const ecosystemEnvelope = {
  ...envelope,
  ...ecosystemFixture({
    snapshot: envelope.snapshot,
    publicationId: ecosystemPublication,
    operationalNetuids: [0, 7, 8],
  }),
};
const page = (ids: number[], count: number, next: number | null) => ({
  ...envelope,
  ...ecosystemFixture({
    snapshot: envelope.snapshot,
    publicationId: ecosystemPublication,
    operationalNetuids: Array.from({ length: count }, (_, index) => index),
  }),
  coverage: {
    registry_complete: true,
    reportable_subnets: count,
    operational_subnets: count,
  },
  subnets: ids.map(subnet),
  next_after: next,
});
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
const error = (code: string, status = 503) =>
  json(
    { api_version: "2", error: { code, message: "PRIVATE UPSTREAM DETAILS" } },
    status,
  );
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
};
const pinnedRegistryReads = [
  {
    name: "find_subnet_for_task",
    input: {
      network: "finney",
      publication_id: MODERN_FIXTURE.ecosystemPublication,
      task: "inference",
    },
    path: "/api/v2/networks/finney/services/search",
    query: {
      publication_id: MODERN_FIXTURE.ecosystemPublication,
      task: "inference",
      limit: "5",
    },
  },
  {
    name: "list_subnet_apis",
    input: {
      network: "finney",
      netuid: 200,
      publication_id: MODERN_FIXTURE.ecosystemPublication,
      catalog_id: MODERN_FIXTURE.catalog,
    },
    path: "/api/v2/networks/finney/subnets/200/services",
    query: {
      publication_id: MODERN_FIXTURE.ecosystemPublication,
      catalog_id: MODERN_FIXTURE.catalog,
    },
  },
  {
    name: "get_api_schema",
    input: {
      network: "finney",
      netuid: 200,
      publication_id: MODERN_FIXTURE.ecosystemPublication,
      catalog_id: MODERN_FIXTURE.catalog,
      service_id: "inference",
    },
    path: "/api/v2/networks/finney/subnets/200/services/inference/schema",
    query: {
      publication_id: MODERN_FIXTURE.ecosystemPublication,
      catalog_id: MODERN_FIXTURE.catalog,
    },
  },
  {
    name: "how_do_i_call",
    input: {
      network: "finney",
      netuid: 200,
      publication_id: MODERN_FIXTURE.ecosystemPublication,
      catalog_id: MODERN_FIXTURE.catalog,
    },
    path: "/api/v2/networks/finney/subnets/200/instructions",
    query: {
      publication_id: MODERN_FIXTURE.ecosystemPublication,
      catalog_id: MODERN_FIXTURE.catalog,
    },
  },
] as const;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("typed anonymous v2 reads", () => {
  test("canonical operations map to exact GETs with defaults, refinements and credential-free init", async () => {
    const database = modernVerificationFixture();
    const app = createModernApplication(database.executor, {
      origin,
      now: () => new Date(MODERN_FIXTURE.now),
    });
    const requests: { url: string; init: RequestInit | undefined }[] = [];
    const fetch: typeof globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), init });
      return app.fetch(new Request(url, init));
    };
    const client = createV2ReadClient({ origin, fetch });
    expectTypeOf(client.read).parameter(0).toEqualTypeOf<V2ReadOperation>();
    const block = client.read("get_block", {
      network: "finney",
      height: "123",
    });
    expectTypeOf(block).toEqualTypeOf<Promise<V2ReadOutput<"get_block">>>();
    const blockResult = await block;
    expect(blockResult.events[0].fields).toEqual({
      amount_rao: "9007199254740993",
    });
    await client.read(
      "get_chain_head",
      { network: "finney" },
      { expectedGenesisHash: hash("0") },
    );
    await client.read("list_subnets", {
      network: "finney",
      publication_id: undefined,
    });
    await client.read("get_subnet", { network: "finney", netuid: 200 });
    await client.read("find_subnet_for_task", {
      network: "finney",
      task: "  inference  ",
    });
    await client.read("list_subnet_apis", { network: "finney", netuid: 200 });
    const captured = await client.read("get_api_schema", {
      network: "finney",
      netuid: 200,
      service_id: "inference",
      catalog_id: MODERN_FIXTURE.catalog,
    });
    expect(captured.document_json).toBe(MODERN_FIXTURE.schema);
    await client.read("how_do_i_call", { network: "finney", netuid: 200 });
    expect(requests.map(({ url }) => url.replace(origin, ""))).toEqual([
      "/api/v2/networks/finney/blocks/123?limit=100&extrinsic_limit=25",
      "/api/v2/networks/finney/head",
      "/api/v2/networks/finney/subnets?limit=100",
      "/api/v2/networks/finney/subnets/200",
      "/api/v2/networks/finney/services/search?task=inference&limit=5",
      "/api/v2/networks/finney/subnets/200/services",
      `/api/v2/networks/finney/subnets/200/services/inference/schema?catalog_id=${MODERN_FIXTURE.catalog}`,
      "/api/v2/networks/finney/subnets/200/instructions",
    ]);
    for (const { init } of requests) {
      expect(init).toMatchObject({
        method: "GET",
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
      expect([...new Headers(init?.headers)]).toEqual([
        ["accept", "application/json"],
      ]);
      expect(init?.body).toBeUndefined();
    }
    expect(database.errors).toEqual([]);
    app.close();
  });

  test.each([
    { name: "list_subnets", input: { network: "finney" } },
    { name: "get_subnet", input: { network: "finney", netuid: 200 } },
    ...pinnedRegistryReads,
  ] as const)(
    "$name refuses a missing ecosystem at the canonical response boundary",
    async ({ name, input }) => {
      const database = modernVerificationFixture();
      const app = createModernApplication(database.executor, {
        origin,
        now: () => new Date(MODERN_FIXTURE.now),
      });
      const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
        const response = await app.fetch(new Request(url, init));
        const value = V2_OPERATION_SCHEMAS[name].output.parse(
          await response.json(),
        );
        expect(Reflect.deleteProperty(value, "ecosystem")).toBe(true);
        return json(value);
      });
      try {
        const client = createV2ReadClient({ origin, fetch });
        await expect(client.read(name, input)).rejects.toMatchObject({
          code: "response_rejected",
        });
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(database.errors).toEqual([]);
      } finally {
        await app.close();
      }
    },
  );

  test.each(pinnedRegistryReads)(
    "$name forwards exact registry pins to the controlled application",
    async ({ name, input, path, query }) => {
      const database = modernVerificationFixture();
      const app = createModernApplication(database.executor, {
        origin,
        now: () => new Date(MODERN_FIXTURE.now),
      });
      const fetch = vi.fn<typeof globalThis.fetch>((url, init) =>
        app.fetch(new Request(url, init)),
      );
      const client = createV2ReadClient({ origin, fetch });
      try {
        const result = await client.read(name, input);
        expect(fetch).toHaveBeenCalledTimes(1);
        const requested = new URL(String(fetch.mock.calls[0][0]));
        expect(requested.origin).toBe(origin);
        expect(requested.pathname).toBe(path);
        expect(Object.fromEntries(requested.searchParams)).toEqual(query);
        expect(result.ecosystem.publication_id).toBe(input.publication_id);
        expect(result.snapshot.publication_id).toBe(MODERN_FIXTURE.publication);
        expect(result).toMatchObject(
          name === "find_subnet_for_task"
            ? {
                results: [{ catalog: { catalog_id: MODERN_FIXTURE.catalog } }],
              }
            : { catalog: { catalog_id: MODERN_FIXTURE.catalog } },
        );
        expect(
          database.calls
            .filter(({ sql }) =>
              sql.includes("FROM registry.eligible_ecosystem_publications e"),
            )
            .map(({ values }) => values),
        ).toEqual([["finney", input.publication_id]]);
        expect(
          database.calls
            .filter(({ sql }) => sql.startsWith("WITH selected_catalog AS"))
            .map(({ values }) => values),
        ).toEqual([
          [
            "finney",
            200,
            MODERN_FIXTURE.registrationCounter,
            MODERN_FIXTURE.catalog,
            MODERN_FIXTURE.ecosystemPublication,
          ],
        ]);
        expect(database.errors).toEqual([]);
      } finally {
        app.close();
      }
    },
  );

  test.each(pinnedRegistryReads)(
    "$name rejects schema-valid substituted registry identities without retry",
    async ({ name, input }) => {
      const database = modernVerificationFixture();
      const app = createModernApplication(database.executor, {
        origin,
        now: () => new Date(MODERN_FIXTURE.now),
      });
      try {
        for (const selector of [
          "publication_id",
          ...("catalog_id" in input ? ["catalog_id"] : []),
        ]) {
          const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
            const response = await app.fetch(new Request(url, init));
            const value = V2_OPERATION_SCHEMAS[name].output.parse(
              await response.json(),
            );
            let changed: unknown;
            if (selector === "publication_id") {
              changed = {
                ...value,
                ecosystem: {
                  ...value.ecosystem,
                  publication_id: "f".repeat(64),
                },
              };
            } else {
              if (
                !("catalog" in value) ||
                value.catalog === null ||
                typeof value.catalog !== "object"
              )
                assert.fail("The selected operation must return its catalog");
              changed = {
                ...value,
                catalog: { ...value.catalog, catalog_id: "e".repeat(64) },
              };
            }
            return json(V2_OPERATION_SCHEMAS[name].output.parse(changed));
          });
          const client = createV2ReadClient({ origin, fetch });
          await expect(client.read(name, input)).rejects.toMatchObject({
            code: "identity_mismatch",
          });
          expect(fetch).toHaveBeenCalledTimes(1);
        }
        expect(database.errors).toEqual([]);
      } finally {
        app.close();
      }
    },
  );

  test.each(pinnedRegistryReads)(
    "$name preserves refusal for missing or unqualified selections without latest fallback",
    async ({ name, input }) => {
      for (const refusal of [
        "missing_publication",
        "unqualified_publication",
        ...("catalog_id" in input ? ["missing_catalog"] : []),
      ]) {
        const database = modernVerificationFixture(
          refusal === "unqualified_publication"
            ? "registry_coverage"
            : undefined,
        );
        const app = createModernApplication(database.executor, {
          origin,
          now: () => new Date(MODERN_FIXTURE.now),
        });
        const selected = {
          ...input,
          ...(refusal === "missing_publication"
            ? { publication_id: "f".repeat(64) }
            : {}),
          ...(refusal === "missing_catalog"
            ? { catalog_id: "e".repeat(64) }
            : {}),
        };
        const fetch = vi.fn<typeof globalThis.fetch>((url, init) =>
          app.fetch(new Request(url, init)),
        );
        const client = createV2ReadClient({ origin, fetch });
        try {
          await expect(client.read(name, selected)).rejects.toMatchObject({
            code: "http_error",
            status: refusal === "missing_catalog" ? 404 : 503,
            serverCode:
              refusal === "missing_catalog" ? "not_found" : "data_unavailable",
          });
          expect(fetch).toHaveBeenCalledTimes(1);
          const requested = new URL(String(fetch.mock.calls[0][0]));
          expect(requested.searchParams.get("publication_id")).toBe(
            selected.publication_id,
          );
          expect(
            database.calls
              .filter(({ sql }) =>
                sql.includes("FROM registry.eligible_ecosystem_publications e"),
              )
              .map(({ values }) => values),
          ).toEqual([["finney", selected.publication_id]]);
          expect(
            database.calls
              .filter(({ sql }) => sql.startsWith("WITH selected_catalog AS"))
              .map(({ values }) => values),
          ).toEqual(
            refusal === "missing_catalog"
              ? [
                  [
                    "finney",
                    200,
                    MODERN_FIXTURE.registrationCounter,
                    "e".repeat(64),
                    MODERN_FIXTURE.ecosystemPublication,
                  ],
                ]
              : [],
          );
          expect(database.errors).toEqual([]);
        } finally {
          app.close();
        }
      }
    },
  );

  test.each(pinnedRegistryReads)(
    "$name rejects malformed registry pins before fetching",
    async ({ name, input }) => {
      const fetch = vi.fn(async () => json(head));
      const client = createV2ReadClient({ origin, fetch });
      for (const selector of [
        "publication_id",
        ...("catalog_id" in input ? ["catalog_id"] : []),
      ])
        for (const invalid of ["bad", null, 42, "A".repeat(64)])
          await expect(
            Reflect.apply(client.read, client, [
              name,
              { ...input, [selector]: invalid },
            ]),
          ).rejects.toMatchObject({ code: "invalid_input" });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  test.each([
    "*",
    "null",
    "https://*.example.com",
    "https://user:secret@example.com",
    "https://example.com/path",
    "https://example.com/",
    "https://example.com?key=secret",
    "https://example.com#fragment",
    "http://example.com",
    "https://169.254.169.254",
    "https://10.0.0.1",
    "ftp://example.com",
  ])("rejects unsafe/noncanonical API origin %s", (origin) => {
    expect(() => createV2ReadClient({ origin })).toThrow(V2ReadClientError);
  });
  test.each([
    "http://127.0.0.1:8080",
    "http://localhost:8080",
    "http://[::1]:8080",
  ])("permits explicit loopback development %s", (origin) => {
    expect(() => createV2ReadClient({ origin })).not.toThrow();
  });
  test("refuses a platform without fetch before starting a request", () => {
    vi.stubGlobal("fetch", undefined);
    expect(() => createV2ReadClient({ origin })).toThrowError(
      expect.objectContaining({ code: "invalid_configuration" }),
    );
  });
  test("a failing cancellation subscription cannot consume an admission slot", async () => {
    const fetch = vi.fn(async () => json(head));
    const client = createV2ReadClient({ origin, fetch, maxConcurrent: 1 });
    const controller = new AbortController();
    vi.spyOn(controller.signal, "addEventListener").mockImplementationOnce(
      () => {
        throw new Error("PRIVATE EVENT TARGET DETAILS");
      },
    );
    await expect(
      client.read(
        "get_chain_head",
        { network: "finney" },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(fetch).not.toHaveBeenCalled();
    await expect(
      client.read("get_chain_head", { network: "finney" }),
    ).resolves.toEqual(head);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  test("requires native WebCrypto before accepting a captured schema", async () => {
    const database = modernVerificationFixture();
    const app = createModernApplication(database.executor, {
      origin,
      now: () => new Date(MODERN_FIXTURE.now),
    });
    const fetch = vi.fn(
      async (url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) =>
        app.fetch(new Request(url, init)),
    );
    vi.stubGlobal("crypto", undefined);
    const client = createV2ReadClient({ origin, fetch, maxConcurrent: 1 });
    try {
      await expect(
        client.read("get_api_schema", {
          network: "finney",
          netuid: 200,
          service_id: "inference",
          catalog_id: MODERN_FIXTURE.catalog,
        }),
      ).rejects.toMatchObject({ code: "response_rejected" });
      expect(fetch).toHaveBeenCalledTimes(1);
      await expect(
        client.read("get_chain_head", { network: "finney" }),
      ).resolves.toHaveProperty(
        "snapshot.publication_id",
        MODERN_FIXTURE.publication,
      );
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      app.close();
    }
  });
  test.each([
    { document_json: undefined },
    { document_json: 123 },
    { digest: undefined },
    { digest: 123 },
  ])(
    "refuses malformed captured-schema fields before hashing: %j",
    async (change) => {
      const database = modernVerificationFixture();
      const app = createModernApplication(database.executor, {
        origin,
        now: () => new Date(MODERN_FIXTURE.now),
      });
      try {
        const response = await app.fetch(
          new Request(
            origin +
              "/api/v2/networks/finney/subnets/200/services/inference/schema",
          ),
        );
        const captured = V2_OPERATION_SCHEMAS.get_api_schema.output.parse(
          await response.json(),
        );
        const hashing = vi.spyOn(webcrypto.subtle, "digest");
        vi.stubGlobal("crypto", webcrypto);
        const fetch = vi
          .fn<typeof globalThis.fetch>()
          .mockResolvedValueOnce(json({ ...captured, ...change }))
          .mockImplementation(async () => json(head));
        const client = createV2ReadClient({ origin, fetch, maxConcurrent: 1 });
        await expect(
          client.read("get_api_schema", {
            network: "finney",
            netuid: 200,
            service_id: "inference",
          }),
        ).rejects.toMatchObject({ code: "response_rejected" });
        expect(hashing).not.toHaveBeenCalled();
        expect(fetch).toHaveBeenCalledTimes(1);
        await expect(
          client.read("get_chain_head", { network: "finney" }),
        ).resolves.toEqual(head);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(database.errors).toEqual([]);
      } finally {
        await app.close();
      }
    },
  );
  test("an aborted schema digest keeps its slot until hashing settles and cannot deliver late", async () => {
    const database = modernVerificationFixture();
    const app = createModernApplication(database.executor, {
      origin,
      now: () => new Date(MODERN_FIXTURE.now),
    });
    const fetch = vi.fn(
      async (url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) =>
        app.fetch(new Request(url, init)),
    );
    const digest = await webcrypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(MODERN_FIXTURE.schema),
    );
    const pending = deferred<ArrayBuffer>();
    const hashing = vi
      .spyOn(webcrypto.subtle, "digest")
      .mockImplementation(() => pending.promise);
    vi.stubGlobal("crypto", webcrypto);
    const controller = new AbortController();
    const client = createV2ReadClient({ origin, fetch, maxConcurrent: 1 });
    try {
      const result = client.read(
        "get_api_schema",
        {
          network: "finney",
          netuid: 200,
          service_id: "inference",
          catalog_id: MODERN_FIXTURE.catalog,
        },
        { signal: controller.signal },
      );
      const rejected = expect(result).rejects.toMatchObject({
        code: "cancelled",
      });
      await vi.waitFor(() => expect(hashing).toHaveBeenCalledTimes(1));
      controller.abort();
      await rejected;
      await expect(
        client.read("get_chain_head", { network: "finney" }),
      ).rejects.toMatchObject({ code: "busy" });
      expect(fetch).toHaveBeenCalledTimes(1);
      pending.resolve(digest);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await expect(
        client.read("get_chain_head", { network: "finney" }),
      ).resolves.toHaveProperty(
        "snapshot.publication_id",
        MODERN_FIXTURE.publication,
      );
      expect(fetch).toHaveBeenCalledTimes(2);
      await expect(result).rejects.toMatchObject({ code: "cancelled" });
    } finally {
      pending.resolve(digest);
      app.close();
    }
  });
  test("invalid directory construction cannot issue a request", () => {
    const fetch = vi.fn(async () => json(head));
    const client = createV2ReadClient({ origin, fetch });
    for (const input of [{ network: "" }, { network: "finney", after: 0 }])
      expect(() =>
        Reflect.apply(client.directory, client, [input]),
      ).toThrowError(expect.objectContaining({ code: "invalid_input" }));
    expect(fetch).not.toHaveBeenCalled();
  });
  test.each([
    { maxResponseBytes: 0 },
    { maxResponseBytes: 1048577 },
    { deadlineMillis: 0 },
    { deadlineMillis: 30001 },
    { maxConcurrent: 0 },
    { maxConcurrent: 9 },
    { maxConcurrent: 1.5 },
  ])("rejects invalid client limits %j", (limits) => {
    expect(() => createV2ReadClient({ origin, ...limits })).toThrow(
      V2ReadClientError,
    );
  });

  test("rejects unsupported calls and invalid canonical inputs before fetch", async () => {
    const fetch = vi.fn(async () => json(head));
    const client = createV2ReadClient({ origin, fetch });
    for (const [name, input] of [
      ["invoke_service", {}],
      ["get_block", { network: "finney", height: 123 }],
      ["get_block", { network: "finney", height: "9223372036854775808" }],
      ["get_block", { network: "finney", height: "0123" }],
      ["list_subnets", { network: "finney", after: 0 }],
      ["get_subnet", { network: "finney", netuid: 65536 }],
      ["find_subnet_for_task", { network: "finney", task: "   " }],
      [
        "get_api_schema",
        { network: "finney", netuid: 1, service_id: "../secret" },
      ],
      ["get_chain_head", { network: "finney", authorization: "secret" }],
    ])
      await expect(
        Reflect.apply(client.read, client, [name, input]),
      ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      client.read(
        "get_chain_head",
        { network: "finney" },
        { expectedGenesisHash: "bad" },
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(fetch).not.toHaveBeenCalled();
  });

  test("checks requested identity independently of schema validity", async () => {
    for (const payload of [
      { ...head, network: { ...head.network, id: "testnet" } },
      { ...head, network: { ...head.network, genesis_hash: hash("f") } },
    ]) {
      const client = createV2ReadClient({
        origin,
        fetch: async () => json(payload),
      });
      await expect(
        client.read(
          "get_chain_head",
          { network: "finney" },
          { expectedGenesisHash: hash("0") },
        ),
      ).rejects.toMatchObject({ code: "identity_mismatch" });
    }
    const variants: [V2ReadOperation, unknown, unknown][] = [
      [
        "get_block",
        { network: "finney", height: "124" },
        {
          ...envelope,
          source_capture_digest: "7".repeat(64),
          event_count: 0,
          extrinsic_count: 0,
          events: [],
          extrinsics: [],
          next_event_index: null,
          next_extrinsic_index: null,
        },
      ],
      [
        "get_subnet",
        { network: "finney", netuid: 7 },
        { ...ecosystemEnvelope, subnet: subnet(8) },
      ],
      [
        "get_subnet",
        { network: "finney", netuid: 7, publication_id: "f".repeat(64) },
        { ...ecosystemEnvelope, subnet: subnet(7) },
      ],
    ];
    for (const [name, input, payload] of variants) {
      const client = createV2ReadClient({
        origin,
        fetch: async () => json(payload),
      });
      await expect(
        Reflect.apply(client.read, client, [name, input]),
      ).rejects.toMatchObject({ code: "identity_mismatch" });
    }
    const database = modernVerificationFixture();
    const app = createModernApplication(database.executor, {
      origin,
      now: () => new Date(MODERN_FIXTURE.now),
    });
    for (const change of [
      { service_id: "other" },
      { catalog: { catalog_id: "f".repeat(64) } },
      { document_json: "not-json" },
      { document_json: "[]" },
      { digest: "f".repeat(64) },
    ]) {
      const client = createV2ReadClient({
        origin,
        fetch: async (url, init) => {
          const response = await app.fetch(new Request(url, init));
          const value = V2_OPERATION_SCHEMAS.get_api_schema.output.parse(
            await response.json(),
          );
          return json({
            ...value,
            ...change,
            ...(change.catalog
              ? { catalog: { ...value.catalog, ...change.catalog } }
              : {}),
          });
        },
      });
      const mismatch = "service_id" in change || "catalog" in change;
      await expect(
        client.read("get_api_schema", {
          network: "finney",
          netuid: 200,
          service_id: "inference",
          catalog_id: MODERN_FIXTURE.catalog,
        }),
      ).rejects.toMatchObject({
        code: mismatch ? "identity_mismatch" : "response_rejected",
      });
    }
    const taskClient = createV2ReadClient({
      origin,
      fetch: async (url, init) => {
        const response = await app.fetch(new Request(url, init));
        const value = V2_OPERATION_SCHEMAS.find_subnet_for_task.output.parse(
          await response.json(),
        );
        return json({ ...value, task: "other" });
      },
    });
    await expect(
      taskClient.read("find_subnet_for_task", {
        network: "finney",
        task: "inference",
      }),
    ).rejects.toMatchObject({ code: "identity_mismatch" });
    app.close();
  });

  test("exact heights/amounts and untrusted field shapes never coerce or fabricate values", async () => {
    for (const payload of [
      { ...head, snapshot: { ...head.snapshot, block_number: 123 } },
      {
        ...head,
        snapshot: { ...head.snapshot, block_number: "9223372036854775808" },
      },
      { ...head, freshness: { ...head.freshness, status: "fresh_guess" } },
      { ...head, private_extra: "untrusted" },
    ]) {
      const client = createV2ReadClient({
        origin,
        fetch: async () => json(payload),
      });
      await expect(
        client.read("get_chain_head", { network: "finney" }),
      ).rejects.toMatchObject({ code: "response_rejected" });
    }
    const client = createV2ReadClient({
      origin,
      fetch: async () =>
        json({
          ...envelope,
          source_capture_digest: "7".repeat(64),
          event_count: 1,
          extrinsic_count: 0,
          events: [
            {
              event_index: 0,
              pallet: "Balances",
              variant: "Transfer",
              fields: { amount: Number.MAX_SAFE_INTEGER + 1 },
              phase: "Initialization",
              extrinsic_index: null,
              topics: [],
              participants: [],
            },
          ],
          extrinsics: [],
          next_event_index: null,
          next_extrinsic_index: null,
        }),
    });
    await expect(
      client.read("get_block", { network: "finney", height: "123" }),
    ).rejects.toMatchObject({ code: "response_rejected" });
  });
});

describe("bounded response protocol", () => {
  test("rejects a missing body and fetch implementations that return redirected identities", async () => {
    const invalid = [
      new Response(null, { headers: { "content-type": "application/json" } }),
      Response.error(),
    ];
    const redirected = json(head);
    Object.defineProperty(redirected, "redirected", { value: true });
    invalid.push(redirected);
    const elsewhere = json(head);
    Object.defineProperty(elsewhere, "url", {
      value: "https://attacker.test/private",
    });
    invalid.push(elsewhere);
    for (const response of invalid) {
      const client = createV2ReadClient({
        origin,
        fetch: async () => response,
      });
      await expect(
        client.read("get_chain_head", { network: "finney" }),
      ).rejects.toMatchObject({ code: "response_rejected" });
    }
  });
  test.each([
    "text/html",
    "application/json; charset=latin1",
    "application/problem+json",
    "",
  ])("rejects content type %s", async (contentType) => {
    const client = createV2ReadClient({
      origin,
      fetch: async () =>
        new Response(JSON.stringify(head), {
          headers: { "content-type": contentType },
        }),
    });
    await expect(
      client.read("get_chain_head", { network: "finney" }),
    ).rejects.toMatchObject({ code: "response_rejected" });
  });
  test.each([201, 204, 302])(
    "rejects unsupported HTTP status %s",
    async (status) => {
      const client = createV2ReadClient({
        origin,
        fetch: async () =>
          new Response(status === 204 ? null : JSON.stringify(head), {
            status,
            headers: { "content-type": "application/json" },
          }),
      });
      await expect(
        client.read("get_chain_head", { network: "finney" }),
      ).rejects.toMatchObject({ code: "response_rejected" });
    },
  );
  test.each([
    "busy",
    "unavailable",
    "data_unavailable",
    "forbidden",
    "internal_error",
  ])(
    "classifies bounded server error %s without leaking its message",
    async (serverCode) => {
      const client = createV2ReadClient({
        origin,
        fetch: async () => error(serverCode),
      });
      try {
        await client.read("get_chain_head", { network: "finney" });
        assert.fail("Expected refusal");
      } catch (failure) {
        expect(failure).toMatchObject({
          code: "http_error",
          status: 503,
          serverCode,
        });
        expect(String(failure)).not.toContain("PRIVATE");
      }
    },
  );
  test("rejects arbitrary error shapes/codes and source exceptions with safe diagnostics", async () => {
    for (const fetch of [
      async () => error("PRIVATE_ARBITRARY_CODE"),
      async () =>
        json(
          {
            api_version: "2",
            error: { code: "busy", message: "PRIVATE", extra: "PRIVATE" },
          },
          503,
        ),
      async () =>
        new Response("PRIVATE broken-json", {
          headers: { "content-type": "application/json" },
        }),
      async () => {
        throw new Error("PRIVATE transport internals");
      },
    ]) {
      const client = createV2ReadClient({ origin, fetch });
      await expect(
        client.read("get_chain_head", { network: "finney" }),
      ).rejects.toBeInstanceOf(V2ReadClientError);
      try {
        await client.read("get_chain_head", { network: "finney" });
      } catch (failure) {
        expect(String(failure)).not.toContain("PRIVATE");
      }
    }
  });
  test("streams bytes, handles split UTF-8 and rejects malformed encodings/oversized bodies independently of length headers", async () => {
    const data = modernVerificationFixture();
    const app = createModernApplication(data.executor, {
      origin,
      now: () => new Date(MODERN_FIXTURE.now),
    });
    let payload: V2ReadOutput<"list_subnet_apis">;
    try {
      payload = V2_OPERATION_SCHEMAS.list_subnet_apis.output.parse(
        await (
          await app.fetch(
            new Request(
              origin + "/api/v2/networks/finney/subnets/200/services",
            ),
          )
        ).json(),
      );
    } finally {
      await app.close();
    }
    payload.services[0].name = "雪";
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    const split = bytes.indexOf(0xe9) + 1;
    const good = createV2ReadClient({
      origin,
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(bytes.slice(0, split));
              controller.enqueue(bytes.slice(split));
              controller.close();
            },
          }),
          {
            headers: {
              "content-type": "application/json",
              "content-length": "0",
            },
          },
        ),
    });
    expect(
      (await good.read("list_subnet_apis", { network: "finney", netuid: 200 }))
        .services[0].name,
    ).toBe("雪");
    const bad = createV2ReadClient({
      origin,
      fetch: async () =>
        new Response(new Uint8Array([0xff]), {
          headers: { "content-type": "application/json" },
        }),
    });
    await expect(
      bad.read("get_chain_head", { network: "finney" }),
    ).rejects.toMatchObject({ code: "response_rejected" });
    let cancelled = false;
    const large = createV2ReadClient({
      origin,
      maxResponseBytes: 5,
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(6));
            },
            cancel() {
              cancelled = true;
            },
          }),
          {
            headers: {
              "content-type": "application/json",
              "content-length": "0",
            },
          },
        ),
    });
    await expect(
      large.read("get_chain_head", { network: "finney" }),
    ).rejects.toMatchObject({ code: "response_too_large" });
    expect(cancelled).toBe(true);
    const broken = createV2ReadClient({
      origin,
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("PRIVATE reader failure"));
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    });
    await expect(
      broken.read("get_chain_head", { network: "finney" }),
    ).rejects.toMatchObject({ code: "response_rejected" });
  });
});

describe("cancellation and admission custody", () => {
  test("an already aborted caller never dispatches", async () => {
    const fetch = vi.fn(async () => json(head));
    const controller = new AbortController();
    controller.abort(new Error("PRIVATE"));
    const client = createV2ReadClient({ origin, fetch });
    await expect(
      client.read(
        "get_chain_head",
        { network: "finney" },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(fetch).not.toHaveBeenCalled();
  });
  test.each(["cancelled", "deadline_exceeded"] as const)(
    "a later competing stop preserves the first %s result and cleanup admission",
    async (firstReason) => {
      vi.useFakeTimers();
      const pending = deferred<Response>();
      const cancelled = deferred<void>();
      const cancellation = vi.fn(() => {
        cancelled.resolve();
      });
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockImplementationOnce(async () => pending.promise)
        .mockImplementation(async () => json(head));
      const client = createV2ReadClient({
        origin,
        fetch,
        maxConcurrent: 1,
        deadlineMillis: 10,
      });
      const controller = new AbortController();
      const first = client.read(
        "get_chain_head",
        { network: "finney" },
        { signal: controller.signal },
      );
      const refused = expect(first).rejects.toMatchObject({
        code: firstReason,
      });
      if (firstReason === "cancelled") controller.abort();
      else await vi.advanceTimersByTimeAsync(10);
      await refused;
      if (firstReason === "cancelled") await vi.advanceTimersByTimeAsync(10);
      else controller.abort();
      await expect(
        client.read("get_chain_head", { network: "finney" }),
      ).rejects.toMatchObject({ code: "busy" });
      expect(fetch).toHaveBeenCalledTimes(1);
      pending.resolve(
        new Response(new ReadableStream<Uint8Array>({ cancel: cancellation }), {
          headers: { "content-type": "application/json" },
        }),
      );
      await cancelled.promise;
      await vi.waitFor(async () => {
        await expect(
          client.read("get_chain_head", { network: "finney" }),
        ).resolves.toEqual(head);
      });
      expect(cancellation).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );
  test("duplicate callbacks from an abort adapter cannot release active work or cancel its reader twice", async () => {
    const pending = deferred<Response>();
    const cancelled = deferred<void>();
    const cancellation = vi.fn(() => cancelled.resolve());
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementationOnce(async () => pending.promise)
      .mockImplementation(async () => json(head));
    let emitAbort!: () => void;
    const signal = {
      aborted: false,
      addEventListener: vi.fn((name: string, listener: () => void) => {
        expect(name).toBe("abort");
        emitAbort = listener;
      }),
      removeEventListener: vi.fn(),
    };
    const client = createV2ReadClient({ origin, fetch, maxConcurrent: 1 });
    const pendingRead = Reflect.apply(client.read, client, [
      "get_chain_head",
      { network: "finney" },
      { signal },
    ]);
    const refused = expect(pendingRead).rejects.toMatchObject({
      code: "cancelled",
    });
    signal.aborted = true;
    emitAbort();
    emitAbort();
    await refused;
    expect(signal.removeEventListener).toHaveBeenCalledExactlyOnceWith(
      "abort",
      emitAbort,
    );
    await expect(
      client.read("get_chain_head", { network: "finney" }),
    ).rejects.toMatchObject({ code: "busy" });
    expect(fetch).toHaveBeenCalledTimes(1);
    pending.resolve(
      new Response(new ReadableStream<Uint8Array>({ cancel: cancellation }), {
        headers: { "content-type": "application/json" },
      }),
    );
    await cancelled.promise;
    await vi.waitFor(async () => {
      await expect(
        client.read("get_chain_head", { network: "finney" }),
      ).resolves.toEqual(head);
    });
    expect(cancellation).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    await expect(pendingRead).rejects.toMatchObject({ code: "cancelled" });
  });
  test.each(["cancelled", "deadline_exceeded"] as const)(
    "%s does not free a fetch that ignores its abort",
    async (reason) => {
      vi.useFakeTimers();
      const pending = deferred<Response>();
      let aborted: AbortSignal | undefined;
      const fetch = vi.fn(
        async (
          _url: Parameters<typeof globalThis.fetch>[0],
          init?: RequestInit,
        ) => {
          aborted = init?.signal ?? undefined;
          return pending.promise;
        },
      );
      const client = createV2ReadClient({
        origin,
        fetch,
        maxConcurrent: 1,
        deadlineMillis: 10,
      });
      const controller = new AbortController();
      const first = client.read(
        "get_chain_head",
        { network: "finney" },
        { signal: controller.signal },
      );
      const refusal = expect(first).rejects.toMatchObject({ code: reason });
      if (reason === "cancelled") controller.abort();
      else await vi.advanceTimersByTimeAsync(10);
      await refusal;
      expect(aborted?.aborted).toBe(true);
      await expect(
        client.read("get_chain_head", { network: "finney" }),
      ).rejects.toMatchObject({ code: "busy" });
      expect(fetch).toHaveBeenCalledTimes(1);
      pending.resolve(json(head));
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      await Promise.resolve();
      await Promise.resolve();
      // The late response is cancelled before any value is delivered; then the
      // same bounded client can admit a new explicit request.
      fetch.mockImplementation(async () => json(head));
      await vi.waitFor(async () => {
        expect(
          (await client.read("get_chain_head", { network: "finney" })).snapshot
            .publication_id,
        ).toBe(publication);
      });
    },
  );
  test("oversize failure is prompt while a pending reader cancellation retains admission", async () => {
    const cancelled = deferred<void>();
    const cancellationStarted = deferred<void>();
    const fetch: typeof globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(10));
          },
          cancel() {
            cancellationStarted.resolve();
            return cancelled.promise;
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    const client = createV2ReadClient({
      origin,
      fetch,
      maxResponseBytes: 5,
      maxConcurrent: 1,
    });
    await expect(
      client.read("get_chain_head", { network: "finney" }),
    ).rejects.toMatchObject({ code: "response_too_large" });
    await cancellationStarted.promise;
    await expect(
      client.read("get_chain_head", { network: "finney" }),
    ).rejects.toMatchObject({ code: "busy" });
    cancelled.resolve();
  });
  test("caller cancellation of a pending reader is prompt but retains its cleanup slot", async () => {
    const reading = deferred<void>();
    const cancelled = deferred<void>();
    const fetch: typeof globalThis.fetch = async () =>
      new Response(
        new ReadableStream(
          {
            pull() {
              reading.resolve();
            },
            cancel() {
              return cancelled.promise;
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: { "content-type": "application/json" } },
      );
    const client = createV2ReadClient({ origin, fetch, maxConcurrent: 1 });
    const controller = new AbortController();
    const pending = client.read(
      "get_chain_head",
      { network: "finney" },
      { signal: controller.signal },
    );
    const refusal = expect(pending).rejects.toMatchObject({
      code: "cancelled",
    });
    await reading.promise;
    controller.abort();
    await refusal;
    await expect(
      client.read("get_chain_head", { network: "finney" }),
    ).rejects.toMatchObject({ code: "busy" });
    cancelled.resolve();
  });
});

describe("explicit coherent directory paging", () => {
  test("omitted limits use one hundred entries and preserve the publication through the final page", async () => {
    const responses = [
      page(
        Array.from({ length: 100 }, (_, index) => index),
        101,
        99,
      ),
      page([100], 101, null),
    ];
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      json(responses.shift()),
    );
    const directory = createV2ReadClient({ origin, fetch }).directory({
      network: "finney",
    });
    expect((await directory.next())?.subnets).toHaveLength(100);
    expect(
      (await directory.next())?.subnets.map((row) => row.generation.netuid),
    ).toEqual([100]);
    expect(await directory.next()).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(
      fetch.mock.calls.map(([url]) =>
        Object.fromEntries(new URL(String(url)).searchParams),
      ),
    ).toEqual([
      { limit: "100" },
      { publication_id: ecosystemPublication, after: "99", limit: "100" },
    ]);
  });
  test.each(["snapshot", "ecosystem"] as const)(
    "walks 406 registrations through one pinned request per next despite caller %s mutation",
    async (mutation) => {
      const responses = [
        page(
          Array.from({ length: 200 }, (_, i) => i),
          406,
          199,
        ),
        page(
          Array.from({ length: 200 }, (_, i) => i + 200),
          406,
          399,
        ),
        page([400, 401, 402, 403, 404, 405], 406, null),
      ];
      const urls: URL[] = [];
      const client = createV2ReadClient({
        origin,
        fetch: async (url) => {
          urls.push(new URL(String(url)));
          return json(responses.shift());
        },
      });
      const input = { network: "finney", limit: 200 };
      const directory = client.directory(input);
      expect(urls).toHaveLength(0);
      const first = await directory.next();
      expect(urls).toHaveLength(1);
      input.network = "testnet";
      if (mutation === "snapshot")
        first!.snapshot.publication_id = "f".repeat(64);
      else first!.ecosystem.publication_id = "f".repeat(64);
      const second = await directory.next();
      const third = await directory.next();
      expect(await directory.next()).toBeNull();
      expect(urls).toHaveLength(3);
      expect(
        urls
          .slice(1)
          .map((url) => [
            url.searchParams.get("publication_id"),
            url.searchParams.get("after"),
          ]),
      ).toEqual([
        [ecosystemPublication, "199"],
        [ecosystemPublication, "399"],
      ]);
      expect(
        urls.every((url) => url.pathname === "/api/v2/networks/finney/subnets"),
      ).toBe(true);
      expect(second!.subnets[0].generation.netuid).toBe(200);
      expect(third!.next_after).toBeNull();
    },
  );
  test.each([
    page([1], 2, null),
    page([0, 0], 2, null),
    page([1, 0], 2, null),
    page([0], 2, null),
    page([0], 2, 0),
  ])("rejects corrupt directory page invariants", async (payload) => {
    const client = createV2ReadClient({
      origin,
      fetch: async () => json(payload),
    });
    await expect(
      client.read("list_subnets", { network: "finney", limit: 2 }),
    ).rejects.toMatchObject({ code: "pagination_mismatch" });
  });
  test.each([
    {
      ...page([2], 3, null),
      ecosystem: {
        ...page([2], 3, null).ecosystem,
        publication_id: "f".repeat(64),
      },
    },
    {
      ...page([2], 3, null),
      snapshot: { ...envelope.snapshot, publication_id: "f".repeat(64) },
      ecosystem: {
        ...page([2], 3, null).ecosystem,
        block_publication_id: "f".repeat(64),
      },
    },
    {
      ...page([2], 3, null),
      network: { id: "finney", genesis_hash: hash("f") },
    },
    {
      ...page([2], 3, null),
      snapshot: { ...envelope.snapshot, block_hash: hash("f") },
      ecosystem: {
        ...page([2], 3, null).ecosystem,
        state: { ...page([2], 3, null).ecosystem.state, block_hash: hash("f") },
      },
    },
    page([1], 3, null),
    {
      ...page([2], 3, null),
      coverage: { ...page([2], 3, null).coverage, reportable_subnets: 4 },
    },
    page([], 3, null),
  ])(
    "poisons a walk on generation, snapshot, cursor or exact-count drift",
    async (next) => {
      const values = [page([0, 1], 3, 1), next];
      const fetch = vi.fn(async () => json(values.shift()));
      const directory = createV2ReadClient({ origin, fetch }).directory({
        network: "finney",
        limit: 2,
      });
      await directory.next();
      await expect(directory.next()).rejects.toBeInstanceOf(V2ReadClientError);
      await expect(directory.next()).rejects.toMatchObject({
        code: "pagination_mismatch",
      });
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );
  test("does not overlap a pager's requests or retry an unavailable publication", async () => {
    const pending = deferred<Response>();
    const fetch = vi.fn(async () => pending.promise);
    const directory = createV2ReadClient({ origin, fetch }).directory({
      network: "finney",
    });
    const first = directory.next();
    const failure = expect(first).rejects.toMatchObject({
      code: "http_error",
      serverCode: "data_unavailable",
    });
    await expect(directory.next()).rejects.toMatchObject({ code: "busy" });
    pending.resolve(error("data_unavailable"));
    await failure;
    await expect(directory.next()).rejects.toMatchObject({
      code: "pagination_mismatch",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

test("the complete client bundles and runs with Web APIs and no Node globals", async () => {
  const result = await build({
    absWorkingDir: fileURLToPath(new URL("..", import.meta.url)),
    entryPoints: ["src/v2/client.ts"],
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: "ModernClient",
    target: "es2022",
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  const inputs = Object.keys(result.metafile.inputs).filter(
    (name) => !name.split(/[\\/]/).includes("node_modules"),
  );
  expect(inputs.sort()).toEqual(
    [
      "src/v2/client.ts",
      "src/v2/account-event-cursor.ts",
      "src/v2/account-stake-cursor.ts",
      "schemas-src/v2/balance.ts",
      "schemas-src/v2/stake.ts",
      "schemas-src/v2/contracts.ts",
      "schemas-src/v2/invocation.ts",
      "schemas-src/v2/primitives.ts",
      "schemas-src/v2/registry.ts",
      "src/public-url-safety.ts",
      "src/ip-safety.ts",
    ].sort(),
  );
  expect(
    Object.values(result.metafile.outputs).every(
      (output) => output.imports.length === 0,
    ),
  ).toBe(true);
  const value = await runInNewContext(
    `(async () => { ${result.outputFiles[0].text}\n const client = ModernClient.createV2ReadClient({ origin: 'https://example.test', fetch: async () => new Response(HEAD, {headers:{'content-type':'application/json'}}) }); return (await client.read('get_chain_head', {network:'finney'})).snapshot.publication_id; })()`,
    {
      URL,
      Headers,
      Response,
      ReadableStream,
      TextEncoder,
      TextDecoder,
      AbortController,
      setTimeout,
      clearTimeout,
      crypto: webcrypto,
      HEAD: JSON.stringify(head),
      process: undefined,
      Buffer: undefined,
      require: undefined,
    },
  );
  expect(value).toBe(publication);
});

describe("published explorer response custody", () => {
  const block = (height: number) => ({
    snapshot: {
      ...envelope.snapshot,
      block_number: String(height),
      block_hash: height === 123 ? hash("1") : hash(String(height - 114)),
      parent_hash: hash(String(height - 115)),
      publication_id:
        height === 123 ? publication : String(height - 114).repeat(64),
    },
    source_capture_digest: "7".repeat(64),
    event_count: 0,
    extrinsic_count: 0,
  });
  const listing = () => ({
    ...envelope,
    coverage: { from_block: "121", through_block: "123", contiguous: true },
    blocks: [block(123), block(122)],
    next_before: "122",
  });
  const body = () => ({
    ...envelope,
    source_capture_digest: "7".repeat(64),
    event_count: 2,
    extrinsic_count: 2,
    events: [
      {
        event_index: 0,
        pallet: "Balances",
        variant: "Transfer",
        fields: { amount_rao: "18446744073709551615" },
        phase: "ApplyExtrinsic",
        extrinsic_index: 0,
        topics: [hash("a")],
        participants: [
          { participant_index: 0, account_id: hash("b"), role: "sender" },
        ],
      },
    ],
    extrinsics: [
      {
        extrinsic_index: 0,
        extrinsic_hash: hash("c"),
        pallet: "Balances",
        call: "transfer_keep_alive",
        fields: {},
        is_signed: false,
        signer: null,
      },
    ],
    next_event_index: 0,
    next_extrinsic_index: 0,
  });
  test("default block-list limits retain a complete anchored tail without a fabricated continuation", async () => {
    const blockHash = (height: number) =>
      height === 123
        ? hash("1")
        : height === 122
          ? hash("9")
          : `0x${height.toString(16).padStart(64, "0")}`;
    const rows = Array.from({ length: 26 }, (_, index) => {
      const height = 123 - index;
      return {
        ...block(123),
        snapshot: {
          ...envelope.snapshot,
          block_number: String(height),
          block_hash: blockHash(height),
          parent_hash: blockHash(height - 1),
          publication_id:
            height === 123
              ? publication
              : height.toString(16).padStart(64, "0"),
        },
      };
    });
    const firstPage = {
      ...envelope,
      coverage: { from_block: "98", through_block: "123", contiguous: true },
      blocks: rows.slice(0, 25),
      next_before: "99",
    };
    const lastPage = {
      ...firstPage,
      blocks: rows.slice(25),
      next_before: null,
    };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(firstPage))
      .mockResolvedValueOnce(json(lastPage));
    const client = createV2ReadClient({ origin, fetch });
    expect(await client.read("list_blocks", { network: "finney" })).toEqual(
      firstPage,
    );
    const continuation = {
      network: "finney",
      anchor_height: "123",
      anchor_hash: hash("1"),
      anchor_publication_id: publication,
      from_block: "98",
      before: "99",
    };
    expect(await client.read("list_blocks", continuation)).toEqual(lastPage);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(
      fetch.mock.calls.map(([url]) =>
        Object.fromEntries(new URL(String(url)).searchParams),
      ),
    ).toEqual([
      { limit: "25" },
      {
        anchor_height: "123",
        anchor_hash: hash("1"),
        anchor_publication_id: publication,
        from_block: "98",
        before: "99",
        limit: "25",
      },
    ]);
    for (const invalid of [
      { ...lastPage, next_before: "98" },
      { ...lastPage, blocks: [] },
    ]) {
      const refused = createV2ReadClient({
        origin,
        fetch: async () => json(invalid),
      });
      await expect(
        refused.read("list_blocks", continuation),
      ).rejects.toMatchObject({ code: "pagination_mismatch" });
    }
  });

  test("default body limits preserve independent exhausted event and extrinsic cursors", async () => {
    const original = body();
    const complete = {
      ...original,
      events: [
        original.events[0],
        { ...original.events[0], event_index: 1, extrinsic_index: 1 },
      ],
      extrinsics: [
        original.extrinsics[0],
        {
          ...original.extrinsics[0],
          extrinsic_index: 1,
          extrinsic_hash: hash("d"),
        },
      ],
      next_event_index: null,
      next_extrinsic_index: null,
    };
    const tail = {
      ...complete,
      events: complete.events.slice(1),
      extrinsics: [],
    };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(complete))
      .mockResolvedValueOnce(json(tail));
    const client = createV2ReadClient({ origin, fetch });
    expect(
      await client.read("get_block", { network: "finney", height: "123" }),
    ).toEqual(complete);
    const continuation = {
      network: "finney",
      height: "123",
      block_hash: hash("1"),
      publication_id: publication,
      after_event_index: 0,
      after_extrinsic_index: 1,
    };
    expect(await client.read("get_block", continuation)).toEqual(tail);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(
      fetch.mock.calls.map(([url]) =>
        Object.fromEntries(new URL(String(url)).searchParams),
      ),
    ).toEqual([
      { limit: "100", extrinsic_limit: "25" },
      {
        block_hash: hash("1"),
        publication_id: publication,
        after_event_index: "0",
        after_extrinsic_index: "1",
        limit: "100",
        extrinsic_limit: "25",
      },
    ]);
    const refused = createV2ReadClient({
      origin,
      fetch: async () => json({ ...tail, next_extrinsic_index: 0 }),
    });
    await expect(refused.read("get_block", continuation)).rejects.toMatchObject(
      {
        code: "pagination_mismatch",
      },
    );
  });

  test("rejects listing anchor, ordering, length, coverage and cursor mismatches", async () => {
    const original = listing();
    const wrongAnchor = {
      ...original,
      blocks: [
        {
          ...original.blocks[0],
          snapshot: {
            ...original.blocks[0].snapshot,
            publication_id: "f".repeat(64),
          },
        },
        original.blocks[1],
      ],
    };
    for (const value of [
      wrongAnchor,
      {
        ...original,
        blocks: [
          {
            ...original.blocks[0],
            snapshot: { ...original.blocks[0].snapshot, block_hash: hash("f") },
          },
          original.blocks[1],
        ],
      },
      { ...original, blocks: [original.blocks[1], original.blocks[0]] },
      { ...original, blocks: [original.blocks[0]] },
      {
        ...original,
        blocks: [
          original.blocks[0],
          {
            ...original.blocks[1],
            snapshot: { ...original.blocks[1].snapshot, block_hash: hash("f") },
          },
        ],
      },
      { ...original, next_before: "121" },
      { ...original, next_before: null },
      { ...original, coverage: { ...original.coverage, through_block: "124" } },
    ]) {
      const client = createV2ReadClient({
        origin,
        fetch: async () => json(value),
      });
      await expect(
        client.read("list_blocks", { network: "finney", limit: 2 }),
      ).rejects.toMatchObject({ code: "pagination_mismatch" });
    }
    const client = createV2ReadClient({
      origin,
      fetch: async () => json(original),
    });
    await expect(
      client.read("list_blocks", {
        network: "finney",
        anchor_height: "123",
        anchor_hash: hash("1"),
        anchor_publication_id: publication,
        from_block: "120",
        limit: 2,
      }),
    ).rejects.toMatchObject({ code: "pagination_mismatch" });
  });
  test("enforces independent body cursor shape, origin range and participant ordering", async () => {
    const original = body();
    const client = createV2ReadClient({
      origin,
      fetch: async () => json(original),
    });
    const read = {
      network: "finney",
      height: "123",
      limit: 1,
      extrinsic_limit: 1,
    };
    expect(await client.read("get_block", read)).toEqual(original);
    for (const value of [
      { ...original, events: [] },
      { ...original, extrinsics: [] },
      { ...original, next_event_index: null },
      { ...original, next_extrinsic_index: null },
      { ...original, events: [{ ...original.events[0], event_index: 1 }] },
      {
        ...original,
        extrinsics: [{ ...original.extrinsics[0], extrinsic_index: 1 }],
      },
      { ...original, events: [{ ...original.events[0], extrinsic_index: 2 }] },
      {
        ...original,
        events: [
          {
            ...original.events[0],
            participants: [
              { ...original.events[0].participants[0], participant_index: 1 },
            ],
          },
        ],
      },
    ]) {
      const changed = createV2ReadClient({
        origin,
        fetch: async () => json(value),
      });
      await expect(changed.read("get_block", read)).rejects.toMatchObject({
        code: "pagination_mismatch",
      });
    }
    for (const input of [
      { ...read, after_event_index: 0 },
      { ...read, after_extrinsic_index: 0 },
      { ...read, block_hash: hash("1") },
      { ...read, publication_id: publication },
    ]) {
      await expect(client.read("get_block", input)).rejects.toMatchObject({
        code: "invalid_input",
      });
    }
    await expect(
      client.read("get_block", {
        ...read,
        block_hash: hash("f"),
        publication_id: publication,
      }),
    ).rejects.toMatchObject({ code: "identity_mismatch" });
  });
  test("bounds decoded fields and signers before recursive output validation", async () => {
    let deep: unknown = null;
    for (let depth = 0; depth < 35; depth++) deep = { next: deep };
    const excessive = [
      deep,
      { text: "x".repeat(262145) },
      Array.from({ length: 16385 }, () => null),
      Object.fromEntries(
        Array.from({ length: 16385 }, (_value, index) => [`key${index}`, null]),
      ),
    ];
    for (const fields of excessive) {
      for (const collection of ["events", "extrinsics"] as const) {
        const original = body();
        const value = {
          ...original,
          [collection]: [{ ...original[collection][0], fields }],
        };
        expect(
          new TextEncoder().encode(JSON.stringify(value)).byteLength,
        ).toBeLessThan(1048576);
        const client = createV2ReadClient({
          origin,
          fetch: async () => json(value),
        });
        await expect(
          client.read("get_block", {
            network: "finney",
            height: "123",
            limit: 1,
            extrinsic_limit: 1,
          }),
        ).rejects.toMatchObject({ code: "response_rejected" });
      }
      const original = body();
      const client = createV2ReadClient({
        origin,
        fetch: async () =>
          json({
            ...original,
            extrinsics: [
              { ...original.extrinsics[0], is_signed: true, signer: fields },
            ],
          }),
      });
      await expect(
        client.read("get_block", {
          network: "finney",
          height: "123",
          limit: 1,
          extrinsic_limit: 1,
        }),
      ).rejects.toMatchObject({ code: "response_rejected" });
    }
  });
});
