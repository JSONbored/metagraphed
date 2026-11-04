import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterAll, expect, test } from "vitest";
import {
  createSqliteDocumentDecoder,
  storeSqliteValue,
} from "../src/sqlite-document-decoder.ts";
import {
  projectAccountDocument,
  projectNeuronDocument,
} from "../src/neuron-document-projection.ts";
import { prepareNeuronDocument } from "../src/neuron-document-preparation.ts";

const decoder = createSqliteDocumentDecoder({ maxAuditBytes: 1024 * 1024 });
const source = new DatabaseSync(":memory:");
const names = new Set([
  "_audit_neuron_docs_20260922",
  "_audit_neuron_members_20260922",
  "neurons_documents",
  "neurons_members",
  "neuron_daily_documents",
  "neuron_daily_members",
  "account_position_daily_documents",
  "account_position_daily_members",
]);
const objects = JSON.parse(
  readFileSync(
    new URL("../generated/db/d1-schema.json", import.meta.url),
    "utf8",
  ),
) as { type: string; name: string; sql: string }[];
for (const kind of ["table", "view"])
  for (const object of objects.filter(
    (item) => item.type === kind && (names.has(item.name) || kind === "view"),
  ))
    source.exec(object.sql);
const binary = (text: string) =>
  source.prepare("SELECT jsonb(?) AS value").get(text)!.value as Uint8Array;
afterAll(() => {
  decoder.close();
  source.close();
});

test("all four query-owner projections match actual source views", () => {
  const metric =
    '{"active":true,"validator_permit":false,"rank":0.1,"trust":null,"axon":{"a":1},"stake_tao":9007199254740993,"updated_at":17}';
  const payload = binary(`{"2":${metric},"2":{"rank":999},"02":{"rank":888}}`);
  const accountPayload = binary(`{"kC3A9":${metric},"kc3a9":{"rank":999}}`);
  source
    .prepare("INSERT INTO neurons_documents VALUES(1,'',0,1000000000000,?)")
    .run(payload);
  source
    .prepare("INSERT INTO neurons_members VALUES(1,2,'hot','cold',0)")
    .run();
  source
    .prepare(
      "INSERT INTO neuron_daily_documents VALUES(1,'2001-01-01',0,1000000000000,?)",
    )
    .run(payload);
  source
    .prepare(
      "INSERT INTO neuron_daily_members(netuid,uid,snapshot_date,hotkey,coldkey,shard) VALUES(1,2,'2001-01-01','hot','cold',0)",
    )
    .run();
  source
    .prepare("INSERT INTO _audit_neuron_docs_20260922 VALUES(1,?,0)")
    .run(payload);
  source
    .prepare(
      "INSERT INTO _audit_neuron_members_20260922 VALUES(1,2,'hot','cold')",
    )
    .run();
  source
    .prepare(
      "INSERT INTO account_position_daily_documents VALUES(1,'2001-01-01',0,1000000000000,?)",
    )
    .run(accountPayload);
  source
    .prepare(
      "INSERT INTO account_position_daily_members VALUES('é',1,'2001-01-01',0)",
    )
    .run();
  for (const [view, projected] of [
    [
      "neurons",
      projectNeuronDocument(
        decoder,
        { netuid: 1n, uid: 2n, hotkey: "hot", coldkey: "cold" },
        payload,
      ),
    ],
    [
      "neuron_daily",
      projectNeuronDocument(
        decoder,
        {
          netuid: 1n,
          uid: 2n,
          hotkey: "hot",
          coldkey: "cold",
          snapshot_date: "2001-01-01",
        },
        payload,
      ),
    ],
    [
      "_audit_neurons_20260922",
      projectNeuronDocument(
        decoder,
        { netuid: 1n, uid: 2n, hotkey: "hot", coldkey: "cold" },
        payload,
        "audit",
      ),
    ],
    [
      "account_position_daily",
      projectAccountDocument(
        decoder,
        { account: "é", netuid: 1n, snapshot_date: "2001-01-01" },
        accountPayload,
      ),
    ],
  ] as const) {
    const statement = source.prepare(`SELECT * FROM ${view}`);
    statement.setReadBigInts(true);
    expect(projected).toEqual({ ...statement.get() });
  }
});

test("receipts bind exact bytes, decoder identity and source first-entry axons", () => {
  const json =
    '{"1":{"axon":1},"1":{"axon":9},"2":{"axon":1.0},"3":{"axon":"a\\u0000b"},"4":42}';
  const payload = binary(json);
  const prepared = prepareNeuronDocument(
    decoder,
    "neuron_daily_documents",
    payload,
  );
  expect(prepared).toEqual({
    sourceTable: "neuron_daily_documents",
    payloadSha256: createHash("sha256").update(payload).digest(),
    json,
    axonValues: [
      ["1", storeSqliteValue(1n)],
      ["2", storeSqliteValue(1)],
      ["3", storeSqliteValue("a\0b")],
      ["4", null],
    ],
    decoderVersion: decoder.identity.version,
    decoderSourceId: decoder.identity.sourceId,
  });
  expect(
    prepareNeuronDocument(decoder, "neurons_documents", payload).axonValues,
  ).toEqual([]);
  const audit = Buffer.from("{x:1}");
  expect(
    prepareNeuronDocument(decoder, "_audit_neuron_docs_20260922", audit).json,
  ).toBe('{"x":1}');
  expect(() =>
    prepareNeuronDocument(decoder, "account_position_daily_documents", audit),
  ).toThrow("Malformed");
});
