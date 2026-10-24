// Pure exact-byte transform planner. No filesystem writes, bundler invocation,
// runtime launch, alias, Client replacement, or proof bypass is performed here.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const FAILURE_LIFECYCLE_SOURCE_PINS = {
  "src/pg-sql.ts": {
    fixed: "e28fdc0d23ddd9b0203d1e60d98075df54b5b1975aab9509cfc0018ff707b6f7",
    unfixed: "f7a6df95a4451c677aa44a73ee2a9392fc5424b8967d9097fe82cae2b6dd9888",
  },
  "src/read-store.ts": {
    fixed: "b24af5cc1c7fc452bd94867ea284c7612b9a6e7321956a5cbbe7f712b6e19ec5",
    unfixed: "7a6a4ccfdce1310994368067a7cee178ed3d82ef9bf4aea0358089912d951dc9",
  },
  "src/lane-health-store.ts": {
    fixed: "b215c77e24e553e46efa0d8e0c1473ce6be4415b94099fe78c7adc3c56e2cc28",
    unfixed: "c3e3ee21ff738f321bc7d9dead4a8d568f3b2eb362645077acc7bda51a95464b",
  },
  "src/strict-gzip-reader.ts": {
    fixed: "5b7e858b87ab29fef86dc374c48a5ee105bb7c4d3af3a5f1fa603f46a4fd6dec",
    unfixed: "5b7e858b87ab29fef86dc374c48a5ee105bb7c4d3af3a5f1fa603f46a4fd6dec",
  },
  "workers/data-api.ts": {
    fixed: "5672235a6874245cceb6df7b449c1f14b7f130f56c4de26fb100591fad98ffa0",
    unfixed: "5672235a6874245cceb6df7b449c1f14b7f130f56c4de26fb100591fad98ffa0",
  },
} as const;
export type FailureLifecycleSourcePath =
  keyof typeof FAILURE_LIFECYCLE_SOURCE_PINS;
// The queue invokes these helpers; read-store remains merged and untouched in
// every active root. Its transform is retained only as inert pure test coverage.
export const FAILURE_LIFECYCLE_ACTIVE_PATHS = Object.freeze([
  "src/pg-sql.ts",
  "src/lane-health-store.ts",
  "src/strict-gzip-reader.ts",
  "workers/data-api.ts",
] as const) satisfies readonly FailureLifecycleSourcePath[];
export const FAILURE_LIFECYCLE_UNFIXED_PATHS = Object.freeze([
  "src/pg-sql.ts",
  "src/lane-health-store.ts",
] as const) satisfies readonly FailureLifecycleSourcePath[];
export const FAILURE_LIFECYCLE_PURE_ONLY_PATHS = Object.freeze([
  "src/read-store.ts",
] as const);

const observerImport =
  "../tests/qualification/strict-gzip/failure-lifecycle-observer.ts";
export function instrumentFailureLifecycleSource(
  logical: FailureLifecycleSourcePath,
  source: string,
  variant: "fixed" | "unfixed" = "fixed",
) {
  assert.ok(Object.hasOwn(FAILURE_LIFECYCLE_SOURCE_PINS, logical));
  assert.ok(variant === "fixed" || variant === "unfixed");
  assert.equal(
    digest(source),
    FAILURE_LIFECYCLE_SOURCE_PINS[logical][variant],
    "Source changed; independent review required",
  );
  let output = source;
  const edits: { anchor: string; insertion: string }[] = [];
  const after = (anchor: string, insertion: string) => {
    assert.equal(
      output.split(anchor).length - 1,
      1,
      "Missing or ambiguous exact source anchor",
    );
    output = output.replace(anchor, anchor + insertion);
    edits.push({ anchor, insertion });
  };
  let names: string[];
  if (logical === "src/strict-gzip-reader.ts") {
    names = ["observeFailureInflater", "observeFailureReader"];
    after(
      "  const inflater = createInflateRaw(options);\n",
      "  observeFailureInflater(inflater, owned, start);\n",
    );
    // Insert before the existing final return without replacing that statement.
    const anchor = "  return reader;\n}\n";
    assert.equal(output.split(anchor).length - 1, 1);
    const insertion = "  observeFailureReader(reader, inflater);\n";
    output = output.replace(anchor, insertion + anchor);
    edits.push({ anchor, insertion });
  } else if (logical === "workers/data-api.ts") {
    names = [
      "observeFailureMessage",
      "observeFailureWriter",
      "beginFailureLifecycleFromEnv",
      "finishFailureLifecycle",
      "failureLifecycleResponse",
    ];
    after(
      "  async fetch(\n    request: Request,\n    env: DataApiEnv,\n    ctx: ExecutionContext,\n  ): Promise<Response> {\n",
      "    const lifecycleResponse = failureLifecycleResponse(request);\n    if (lifecycleResponse) return lifecycleResponse;\n",
    );
    after(
      "  async queue(\n    batch: MessageBatch<unknown>,\n    env: DataApiEnv,\n    ctx: ExecutionContext,\n  ): Promise<void> {\n",
      "    beginFailureLifecycleFromEnv(env);\n    try {\n",
    );
    const queueEnd = "  },\n};\n";
    assert.ok(output.endsWith(queueEnd));
    assert.equal(output.split(queueEnd).length - 1, 1);
    const finish = "    } finally {\n      finishFailureLifecycle();\n    }\n";
    output = output.slice(0, -queueEnd.length) + finish + queueEnd;
    edits.push({ anchor: queueEnd, insertion: finish });
    after(
      "    for (const message of batch.messages) {\n",
      "      observeFailureMessage(message.id, message.body);\n",
    );
    const anchor =
      "        await writeSyncBatch(body, writers, Date.now(), familyWriters);\n";
    assert.equal(output.split(anchor).length - 1, 1);
    const insertion = "        observeFailureWriter(message.id);\n";
    output = output.replace(anchor, insertion + anchor);
    edits.push({ anchor, insertion });
  } else {
    names = ["observeFailurePgClient"];
    const helper =
      logical === "src/pg-sql.ts"
        ? "createPgSql"
        : logical === "src/read-store.ts"
          ? "pgReadStore"
          : "pgLaneHealthDb";
    const anchor =
      logical === "src/pg-sql.ts"
        ? "    const client = clientFactory(hyperdrive.connectionString);\n"
        : "    const client =\n      deps.clientFactory?.(connectionString) ??\n      new Client({ connectionString });\n";
    after(
      anchor,
      `    observeFailurePgClient(client, Client, ${JSON.stringify(helper)});\n`,
    );
  }
  const importLine = `import { ${names.join(", ")} } from ${JSON.stringify(observerImport)};\n`;
  output = importLine + output;
  let recovered = output.slice(importLine.length);
  for (const { insertion } of edits) {
    assert.equal(recovered.split(insertion).length - 1, 1);
    recovered = recovered.replace(insertion, "");
  }
  assert.equal(
    recovered,
    source,
    "Instrumentation altered an original statement",
  );
  return {
    source: output,
    proof: {
      kind: "supplemental-source-bound-transform-v1" as const,
      logical,
      variant,
      originalSha256: digest(source),
      instrumentedSha256: digest(output),
      originalBytes: Buffer.byteLength(source),
      instrumentedBytes: Buffer.byteLength(output),
      importLine,
      edits: edits.map((edit) => ({
        ...edit,
        anchorSha256: digest(edit.anchor),
        insertionSha256: digest(edit.insertion),
      })),
    },
  };
}
export function verifyFailureLifecycleTransform(
  logical: FailureLifecycleSourcePath,
  original: string,
  transformed: string,
  variant: "fixed" | "unfixed" = "fixed",
) {
  const planned = instrumentFailureLifecycleSource(logical, original, variant);
  assert.equal(
    transformed,
    planned.source,
    "Instrumented output is not the exact reviewed transform",
  );
  return planned.proof;
}
