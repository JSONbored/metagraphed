import { createHash } from "node:crypto";
import {
  storeSqliteValue,
  type createSqliteDocumentDecoder,
} from "./sqlite-document-decoder.ts";

type Decoder = ReturnType<typeof createSqliteDocumentDecoder>;
export type NeuronDocumentTable =
  | "neurons_documents"
  | "neuron_daily_documents"
  | "account_position_daily_documents"
  | "_audit_neuron_docs_20260922";

/** Derived inputs for the native write transaction. Insert/update this receipt
 * before its source document; deferred SQL checks reject a mismatched commit. */
export function prepareNeuronDocument(
  decoder: Decoder,
  sourceTable: NeuronDocumentTable,
  payload: Uint8Array,
) {
  const kind = sourceTable === "_audit_neuron_docs_20260922" ? "audit" : "live";
  const json = decoder.decode(payload, kind);
  const axonValues =
    sourceTable === "neuron_daily_documents"
      ? decoder
          .axons(payload)
          .map(({ key, value }) => [key, storeSqliteValue(value)])
      : [];
  return {
    sourceTable,
    payloadSha256: createHash("sha256").update(payload).digest(),
    json,
    axonValues,
    decoderVersion: decoder.identity.version,
    decoderSourceId: decoder.identity.sourceId,
  };
}
