// The staged response audit for entity-handler routes (#10984).
//
// The generic seam's tripwire never sees the entity handlers' envelopes, and
// #10897 is what enforcement-without-staging looks like: 26 hours of 500s.
// These pin the staging contract itself -- warn logs and NEVER touches the
// served body, enforce substitutes the same refusal the generic seam serves,
// and promotion between them is a flag flip exercising code warn already ran.
import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import { auditResponse } from "../workers/api.ts";
import { createLocalArtifactEnv } from "../scripts/lib.ts";
import type { Row } from "./row-type.ts";

const ENTITY_URL = "https://api.metagraph.sh/api/v1/subnets/1/metagraph";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** A body the SubnetMetagraphArtifact component refuses: rows missing four
 * required properties. The store is empty locally, so a drift must be
 * crafted -- which is also why auditResponse is exported. */
const DRIFTED = {
  ok: true,
  schema_version: 1,
  data: {
    schema_version: 1,
    netuid: 1,
    neuron_count: 1,
    captured_at: "2026-08-13T00:00:00.000Z",
    block_number: 1,
    neurons: [{ uid: 0 }],
  },
  meta: {
    artifact_path: "/metagraph/subnets/1/metagraph.json",
    contract_version: "2026-08-13",
  },
};

function envWith(mode: string | undefined): Row {
  const env = createLocalArtifactEnv() as Row;
  if (mode === undefined) delete env.METAGRAPH_AUDIT_RESPONSES;
  else env.METAGRAPH_AUDIT_RESPONSES = mode;
  return env;
}

function ctxCapture(): { ctx: Row; settled: () => Promise<void> } {
  const tasks: Promise<unknown>[] = [];
  return {
    ctx: { waitUntil: (p: Promise<unknown>) => tasks.push(p) },
    settled: async () => {
      await Promise.all(tasks);
    },
  };
}

describe("auditResponse (#10984)", () => {
  test("unset flag: pass-through, zero cost beyond the check", async () => {
    const res = jsonResponse(DRIFTED);
    const out = await auditResponse(
      new Request(ENTITY_URL),
      envWith(undefined) as unknown as Env,
      { waitUntil: () => {} } as unknown as Parameters<typeof auditResponse>[2],
      res,
    );
    assert.equal(out, res);
  });

  test("warn: the drift is logged and the served body is untouched", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ctx, settled } = ctxCapture();
    const res = jsonResponse(DRIFTED);
    const out = await auditResponse(
      new Request(ENTITY_URL),
      envWith("warn") as unknown as Env,
      ctx as unknown as Parameters<typeof auditResponse>[2],
      res,
    );
    assert.equal(out, res, "warn must return the SAME response object");
    await settled();
    const drifts = warn.mock.calls
      .map((call) => String(call[0]))
      .filter((m) => m.includes("DRIFTED (warn)"));
    assert.equal(drifts.length, 1);
    assert.match(drifts[0], /subnet-metagraph/);
    warn.mockRestore();
  });

  test("enforce: the same drift becomes the generic seam's refusal", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await auditResponse(
      new Request(ENTITY_URL),
      envWith("enforce") as unknown as Env,
      { waitUntil: () => {} } as unknown as Parameters<typeof auditResponse>[2],
      jsonResponse(DRIFTED),
    );
    assert.equal(out.status, 500);
    const body = (await out.json()) as Row;
    assert.equal((body.error as Row)?.code, "response_schema_drift");
    error.mockRestore();
  });

  test("a clean body passes enforce untouched", async () => {
    // Locally the metagraph store is empty and empty rows VALIDATE -- the
    // property that made a crafted drift necessary above is itself asserted.
    const clean = structuredClone(DRIFTED) as Row;
    ((clean.data as Row).neurons as unknown[]).length = 0;
    (clean.data as Row).neuron_count = 0;
    const res = jsonResponse(clean);
    const out = await auditResponse(
      new Request(ENTITY_URL),
      envWith("enforce") as unknown as Env,
      { waitUntil: () => {} } as unknown as Parameters<typeof auditResponse>[2],
      res,
    );
    assert.equal(out, res);
  });

  test("a projected request is forgiven its absences, even in enforce", async () => {
    // The handler-level fields projection never sets meta.projection, so the
    // URL is the signal at this seam. A row narrowed to `uid` is exactly what
    // ?fields=uid serves.
    const out = await auditResponse(
      new Request(`${ENTITY_URL}?fields=uid`),
      envWith("enforce") as unknown as Env,
      { waitUntil: () => {} } as unknown as Parameters<typeof auditResponse>[2],
      jsonResponse(DRIFTED),
    );
    assert.equal(out.status, 200);
  });

  test("a body that claims JSON and is not never breaks the response", async () => {
    // json() throwing is not a drift, and the auditor's charter is the
    // tripwire's own: its failures must never take a route down. Both modes.
    const bad = () =>
      new Response("{not json", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const ctxWarn = ctxCapture();
    const resWarn = bad();
    const outWarn = await auditResponse(
      new Request(ENTITY_URL),
      envWith("warn") as unknown as Env,
      ctxWarn.ctx as unknown as Parameters<typeof auditResponse>[2],
      resWarn,
    );
    assert.equal(outWarn, resWarn);
    await ctxWarn.settled();
    const resEnforce = bad();
    const outEnforce = await auditResponse(
      new Request(ENTITY_URL),
      envWith("enforce") as unknown as Env,
      { waitUntil: () => {} } as unknown as Parameters<typeof auditResponse>[2],
      resEnforce,
    );
    assert.equal(outEnforce, resEnforce);
  });

  test("non-200, non-JSON and unrouted responses are skipped", async () => {
    const env = envWith("enforce") as unknown as Env;
    const ctx = { waitUntil: () => {} } as unknown as Parameters<
      typeof auditResponse
    >[2];
    const cases: Array<[Request, Response]> = [
      [
        new Request(ENTITY_URL),
        new Response("{}", {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
      ],
      [new Request(ENTITY_URL), new Response("hi", { status: 200 })],
      [
        new Request("https://api.metagraph.sh/not-a-route"),
        jsonResponse(DRIFTED),
      ],
    ];
    for (const [request, res] of cases) {
      assert.equal(await auditResponse(request, env, ctx, res), res);
    }
  });
});
