// Tests for scripts/validate-worker-types-parity.ts (#10188).
//
// The gate exists because #10186 found all three generated Worker Env files
// stale, and nothing went red. The failure that mattered most was not a missing
// binding but a WRONG LITERAL: `wrangler types` pins each var to a string
// literal, so a stale value SUPPRESSES type errors instead of causing them --
// `env.X === "postgres"` type-checked cleanly while being unreachable, and six
// dead branches accumulated behind that.
//
// So these drive the pure error builder with fixtures that reproduce each real
// failure, rather than only asserting the repo's own (currently correct) files
// pass. A gate whose sole evidence is "green on a clean tree" has not been
// shown to detect anything -- which is exactly how the first draft of this
// validator silently skipped every durable-object and rate-limiter binding
// (they key on `name`, not `binding`) until a deletion test caught it.

import { describe, expect, it } from "vitest";
import {
  declaredBindings,
  parseJsonc,
  workerTypesParityErrors,
  WORKERS,
} from "../scripts/validate-worker-types-parity.ts";

const worker = { config: "wrangler.jsonc", types: "types.d.ts" };

describe("var literal parity", () => {
  it("accepts a var whose literal matches", () => {
    expect(
      workerTypesParityErrors(
        worker,
        { vars: { METAGRAPH_NEURONS_SOURCE: "d1" } },
        '\tMETAGRAPH_NEURONS_SOURCE: "d1";\n',
      ),
    ).toEqual([]);
  });

  it("rejects a STALE literal, naming both sides", () => {
    // The #10186 shape: config moved to "d1", the generated file still says
    // "postgres". Reporting both values is the point -- "is stale" alone does
    // not tell you whether the code reading it is now dead.
    const errors = workerTypesParityErrors(
      worker,
      { vars: { METAGRAPH_NEURONS_SOURCE: "d1" } },
      '\tMETAGRAPH_NEURONS_SOURCE: "postgres";\n',
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('typed `"postgres"`');
    expect(errors[0]).toContain('sets "d1"');
  });

  it("rejects a var missing from the types entirely", () => {
    const errors = workerTypesParityErrors(
      worker,
      { vars: { NEON_READ_LANES: "neurons" } },
      "\tSOMETHING_ELSE: string;\n",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("NEON_READ_LANES is missing");
  });

  it("handles a var whose value embeds JSON, quotes and all", () => {
    // POSTHOG_USAGE_SAMPLE_RATES is `{"block-detail":0.01}`. Comparing against
    // a naively-quoted string would report false drift forever.
    const value = '{"block-detail":0.01}';
    expect(
      workerTypesParityErrors(
        worker,
        { vars: { POSTHOG_USAGE_SAMPLE_RATES: value } },
        `\tPOSTHOG_USAGE_SAMPLE_RATES: ${JSON.stringify(value)};\n`,
      ),
    ).toEqual([]);
  });

  it("ignores non-string vars, which wrangler widens rather than pins", () => {
    expect(
      workerTypesParityErrors(worker, { vars: { SOME_NUMBER: 5 } }, ""),
    ).toEqual([]);
  });
});

describe("binding parity", () => {
  it("finds a queue PRODUCER, nested under queues.producers", () => {
    // SYNC_BATCHES, the binding #10186 found untyped. `queues` is an object
    // with producers/consumers, not a flat array -- the case a first draft of
    // this gate missed.
    const config = {
      queues: { producers: [{ binding: "SYNC_BATCHES", queue: "sync" }] },
    };
    expect(declaredBindings(config)).toContain("SYNC_BATCHES");
    const errors = workerTypesParityErrors(worker, config, "\tOTHER: Queue;\n");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("binding SYNC_BATCHES is missing");
  });

  it("finds bindings keyed `name` rather than `binding`", () => {
    // durable_objects and ratelimits both use `name`. Reading only `binding`
    // skipped six DO namespaces and eleven rate limiters, silently.
    const config = {
      durable_objects: {
        bindings: [{ name: "CHAIN_FIREHOSE_HUB", class_name: "Hub" }],
      },
      ratelimits: [{ name: "RPC_RATE_LIMITER", namespace_id: "1" }],
    };
    expect(declaredBindings(config).sort()).toEqual([
      "CHAIN_FIREHOSE_HUB",
      "RPC_RATE_LIMITER",
    ]);
  });

  it("finds a single-object block", () => {
    expect(declaredBindings({ ai: { binding: "AI" } })).toEqual(["AI"]);
  });

  it("accepts a binding declared with a trailing comment, as wrangler emits", () => {
    // `DATA_API: Fetcher /* metagraphed-data-api */;` — matching on `NAME:`
    // rather than `NAME: Type;` is what keeps this from false-failing.
    expect(
      workerTypesParityErrors(
        worker,
        { services: [{ binding: "DATA_API", service: "data-api" }] },
        "\tDATA_API: Fetcher /* metagraphed-data-api */;\n",
      ),
    ).toEqual([]);
  });

  it("does not recurse into unrelated nested objects", () => {
    // One level only. A settings blob that happens to carry a `name` deeper
    // down must not be mistaken for a binding.
    expect(
      declaredBindings({
        queues: {
          consumers: [{ deep: { nested: { name: "NOT_A_BINDING" } } }],
        },
      }),
    ).toEqual([]);
  });
});

describe("parseJsonc", () => {
  it("strips comments and trailing commas", () => {
    expect(parseJsonc('{\n// c\n"a": 1,\n}')).toEqual({ a: 1 });
  });

  it("does not treat a // inside a string as a comment", () => {
    // CHAIN_HEAD_RPC_URL is an https:// URL; a naive comment stripper eats it
    // and the whole config fails to parse.
    expect(parseJsonc('{"url": "https://x.example/y"}')).toEqual({
      url: "https://x.example/y",
    });
  });

  it("keeps an escaped quote inside a string", () => {
    expect(parseJsonc('{"a": "he said \\"hi\\""}')).toEqual({
      a: 'he said "hi"',
    });
  });
});

describe("the worker list", () => {
  it("covers all three wrangler configs", () => {
    expect(WORKERS.map((w) => w.config).sort()).toEqual([
      "wrangler.data.jsonc",
      "wrangler.jsonc",
      "wrangler.registry.jsonc",
    ]);
  });
});
