// The registry sync against Neon (#10060).
//
// This family is the one that moves WITHOUT a mirror, so the tests carry the
// weight the mirror-then-prove sequence carries elsewhere. Two things matter:
// the transaction really wraps the reads as well as the writes (the whole
// reason for not reusing createPgSql), and every dialect difference from the
// D1 statement is actually present rather than assumed.
import assert from "node:assert/strict";
import { describe, test } from "vitest";

import {
  applyRegistrySyncToNeon,
  type RegistryPgClient,
} from "../src/registry-sync-neon.ts";

/** Records the statement text in order, and can be told to fail on the Nth. */
function fakeClient(
  opts: { failOn?: RegExp; rows?: Record<string, unknown[]> } = {},
) {
  const log: { text: string; values: unknown[] }[] = [];
  const client: RegistryPgClient = {
    connect: async () => undefined,
    end: async () => undefined,
    query: async (text: string, values: unknown[] = []) => {
      log.push({ text, values });
      if (opts.failOn?.test(text)) throw new Error("boom");
      for (const [pattern, rows] of Object.entries(opts.rows ?? {})) {
        if (text.includes(pattern)) return { rows };
      }
      return { rows: [] };
    },
  };
  return { log, client, texts: () => log.map((l) => l.text) };
}

const COMMIT = "COMMIT";
const provider = {
  id: "p1",
  overlay: { a: 1 },
  source_commit: "c1",
};

describe("the transaction is real", () => {
  test("BEGIN wraps everything and COMMIT closes it", async () => {
    const { client, texts } = fakeClient();
    await applyRegistrySyncToNeon(
      "postgres://x",
      {
        providers: [provider],
        subnets: [],
        surfaces: [],
        pruneSurfaces: [],
        deleteSubnets: [],
      },
      { clientFactory: () => client },
    );
    const t = texts();
    assert.equal(t[0], "BEGIN");
    assert.equal(t[t.length - 1], COMMIT);
  });

  test("the READS are inside the transaction, not before it", async () => {
    // The entire reason this module does not reuse createPgSql: that runner
    // opens a fresh connection per statement, and the D1 version had to move
    // its reads out of the transaction entirely -- which is the TOCTOU window
    // its own header documents. A read landing before BEGIN would mean the
    // window is still open and the rewrite bought nothing.
    const { client, texts } = fakeClient();
    await applyRegistrySyncToNeon(
      "postgres://x",
      {
        providers: [],
        subnets: [],
        surfaces: [],
        pruneSurfaces: [
          {
            subnet_netuid: 1,
            current_surfaces: [{ kind: "website", url: "https://a.invalid" }],
            source_commit: "c1",
          },
        ],
        deleteSubnets: [],
      },
      { clientFactory: () => client },
    );
    const t = texts();
    const selectAt = t.findIndex((x) => x.includes("SELECT id, subnet_netuid"));
    assert.ok(selectAt > 0, "no read was issued");
    assert.equal(t[0], "BEGIN");
    assert.ok(selectAt > t.indexOf("BEGIN"), "a read ran before BEGIN");
  });

  test("a failure ROLLS BACK and never COMMITs", async () => {
    const { client, texts } = fakeClient({ failOn: /INSERT INTO providers/ });
    await assert.rejects(() =>
      applyRegistrySyncToNeon(
        "postgres://x",
        {
          providers: [provider],
          subnets: [],
          surfaces: [],
          pruneSurfaces: [],
          deleteSubnets: [],
        },
        { clientFactory: () => client },
      ),
    );
    const t = texts();
    assert.ok(t.includes("ROLLBACK"), "no rollback was issued");
    assert.equal(t.includes(COMMIT), false, "a failed sync still committed");
  });
});

describe("the dialect differences are actually applied", () => {
  test("IS DISTINCT FROM, never SQLite's IS NOT", async () => {
    const { client, texts } = fakeClient();
    await applyRegistrySyncToNeon(
      "postgres://x",
      {
        providers: [provider],
        subnets: [],
        surfaces: [],
        pruneSurfaces: [],
        deleteSubnets: [],
      },
      { clientFactory: () => client },
    );
    const sql = texts().join("\n");
    assert.ok(sql.includes("IS DISTINCT FROM excluded.overlay"));
    assert.equal(/IS NOT excluded/.test(sql), false);
  });

  test("jsonb functions, never json_each/json_extract", async () => {
    const { client, texts } = fakeClient({
      rows: { "SELECT id, subnet_netuid": [{ id: "s1", subnet_netuid: 1 }] },
    });
    await applyRegistrySyncToNeon(
      "postgres://x",
      {
        providers: [],
        subnets: [],
        surfaces: [],
        pruneSurfaces: [
          {
            subnet_netuid: 1,
            current_surfaces: [{ kind: "website", url: "https://a.invalid" }],
            source_commit: "c1",
          },
        ],
        deleteSubnets: [],
      },
      { clientFactory: () => client },
    );
    const sql = texts().join("\n");
    assert.ok(sql.includes("jsonb_array_elements("));
    assert.ok(sql.includes("jsonb_array_elements_text("));
    assert.ok(sql.includes("keep.value->>'k'"));
    assert.equal(/json_each|json_extract/.test(sql), false);
  });

  test("no `?` placeholder and no unixepoch survived the port", async () => {
    const { client, texts } = fakeClient();
    await applyRegistrySyncToNeon(
      "postgres://x",
      {
        providers: [provider],
        subnets: [
          {
            netuid: 1,
            slug: "a",
            name: "A",
            overlay: {},
            source_commit: "c1",
          },
        ],
        surfaces: [],
        pruneSurfaces: [],
        deleteSubnets: [],
      },
      { clientFactory: () => client },
    );
    const sql = texts().join("\n");
    assert.equal(sql.includes("unixepoch"), false);
    assert.ok(sql.includes("EXTRACT(EPOCH FROM now())"));
    // A bare `?` would bind nothing in Postgres and match no row -- the #9821
    // failure shape.
    assert.equal(/VALUES \(\?|= \?/.test(sql), false);
  });

  test("probe_eligible and public_safe bind as BOOLEANS, not 0/1", async () => {
    // They are 0/1 with a CHECK in D1 and real BOOLEAN in Neon. Binding a
    // number here is the class of bug that killed the hotkey-alpha mirror.
    const { client, log } = fakeClient();
    await applyRegistrySyncToNeon(
      "postgres://x",
      {
        providers: [],
        subnets: [],
        surfaces: [
          {
            subnet_netuid: 1,
            surface_key: "k",
            kind: "website",
            url: "https://a.invalid",
            overlay: { v: 1 },
            source_commit: "c1",
            probe_eligible: true,
            public_safe: false,
          },
        ],
        pruneSurfaces: [],
        deleteSubnets: [],
      },
      { clientFactory: () => client, newId: () => "fixed-id" },
    );
    const insert = log.find((l) => l.text.includes("INSERT INTO surfaces"))!;
    // By TYPE, not by value: `0 == false` and `1 == true` under loose
    // comparison, so asserting the value alone would pass on the exact bug
    // this exists to catch. (A blanket "no 0 or 1 anywhere in the bindings"
    // check is wrong for the opposite reason -- subnet_netuid is legitimately
    // the number 1.)
    assert.equal(
      typeof insert.values[8],
      "boolean",
      "probe_eligible was not a boolean",
    );
    assert.equal(
      typeof insert.values[9],
      "boolean",
      "public_safe was not a boolean",
    );
    assert.equal(insert.values[8], true);
    assert.equal(insert.values[9], false);
  });
});

describe("surface identity", () => {
  test("an existing surface keeps its id, so history names the same row", async () => {
    const { client, log } = fakeClient({
      rows: {
        "SELECT id, overlay FROM surfaces": [
          { id: "existing-id", overlay: "{}" },
        ],
      },
    });
    await applyRegistrySyncToNeon(
      "postgres://x",
      {
        providers: [],
        subnets: [],
        surfaces: [
          {
            subnet_netuid: 1,
            surface_key: "k",
            kind: "website",
            url: "https://a.invalid",
            overlay: { changed: true },
            source_commit: "c1",
          },
        ],
        pruneSurfaces: [],
        deleteSubnets: [],
      },
      { clientFactory: () => client, newId: () => "SHOULD-NOT-BE-USED" },
    );
    const history = log.find((l) =>
      l.text.includes("INSERT INTO surface_history"),
    )!;
    assert.equal(history.values[0], "existing-id");
    assert.equal(history.values[2], "update");
  });

  test("an unchanged overlay is skipped entirely", async () => {
    const overlay = JSON.stringify({ v: 1 });
    const { client, texts } = fakeClient({
      rows: { "SELECT id, overlay FROM surfaces": [{ id: "e", overlay }] },
    });
    const out = await applyRegistrySyncToNeon(
      "postgres://x",
      {
        providers: [],
        subnets: [],
        surfaces: [
          {
            subnet_netuid: 1,
            surface_key: "k",
            kind: "website",
            url: "https://a.invalid",
            overlay: { v: 1 },
            source_commit: "c1",
          },
        ],
        pruneSurfaces: [],
        deleteSubnets: [],
      },
      { clientFactory: () => client },
    );
    assert.equal(out.surfaces_written, 0);
    assert.equal(
      texts().some((t) => t.includes("INSERT INTO surfaces")),
      false,
    );
  });
});
