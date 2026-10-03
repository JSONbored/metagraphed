import { createHash } from "node:crypto";
import type { z } from "zod";
import type {
  NativeCodeArtifactSchema,
  NativeRuntimeRequestSchema,
} from "../schemas-src/routes/native-runtime.ts";
import {
  NATIVE_RUNTIME_LIMITS,
  type NativeMetadata,
  type NativeField,
} from "./native-runtime-metadata.ts";
import {
  decodeNativeValue,
  encodeNativeValue,
  nativeHex,
  type NativeValue,
} from "./native-runtime-values.ts";
import { nativeContractSimulationWork } from "./native-contract-simulation.ts";
import { nativeEvmSimulationGas } from "./native-evm-simulation.ts";
import { publicCommitArtifactUrl } from "./public-commit-artifact.ts";

type Operation = z.infer<
  typeof NativeRuntimeRequestSchema
>["operations"][number];
type Artifact = z.infer<typeof NativeCodeArtifactSchema>;

function artifactUrl(value: string) {
  return publicCommitArtifactUrl(
    value,
    "Native code requires a public commit-pinned artifact URL",
  );
}
function byteVector(metadata: NativeMetadata, id: number) {
  const type = metadata.types.get(id)?.definition;
  const item =
    type?.kind === "sequence"
      ? metadata.types.get(type.type)?.definition
      : undefined;
  return item?.kind === "primitive" && item.primitive === 3;
}
function codeArgument(
  metadata: NativeMetadata,
  operation: Extract<Operation, { kind: "runtime" | "prepare" }>,
) {
  let fields: NativeField[];
  const evm =
    operation.kind === "runtime"
      ? operation.api === "EthereumRuntimeRPCApi" &&
        operation.member === "create"
      : operation.pallet === "EVM" &&
        ["create", "create2"].includes(operation.member);
  const palletName = evm ? "EVM" : "Contracts";
  const pallet = metadata.pallets.find((row) => row.name === palletName);
  if (!pallet)
    throw new Error(
      `Native code requires the ${palletName} pallet at this source`,
    );
  if (operation.evm_call)
    throw new Error(
      "Native deployment code cannot use precompile call arguments",
    );
  let limit = BigInt(NATIVE_RUNTIME_LIMITS.valueBytes);
  if (!evm) {
    const constant = pallet.constants.find((row) => row.name === "MaxCodeLen");
    if (!constant)
      throw new Error("Native code requires the source MaxCodeLen");
    const value = decodeNativeValue(metadata, constant.type, constant.value);
    if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value))
      throw new Error("Invalid native source code byte limit");
    limit = BigInt(value);
  }
  if (
    operation.kind === "runtime" &&
    (evm ||
      (operation.api === "ContractsApi" &&
        ["upload_code", "instantiate"].includes(operation.member)))
  ) {
    const api = metadata.apis.find((row) => row.name === operation.api);
    const method = api?.methods.find((row) => row.name === operation.member);
    if (!method)
      throw new Error("Native code runtime method is absent at this source");
    fields = method.inputs;
    // Reject missing/excessive Weight before fetching any public artifact.
    if (evm) nativeEvmSimulationGas(fields, operation.args);
    else nativeContractSimulationWork(operation.member, fields, operation.args);
  } else if (
    operation.kind === "prepare" &&
    (evm ||
      (operation.pallet === "Contracts" &&
        ["upload_code", "instantiate_with_code"].includes(operation.member)))
  ) {
    const calls =
      pallet.calls === null
        ? undefined
        : metadata.types.get(pallet.calls)?.definition;
    const call =
      calls?.kind === "variant"
        ? calls.variants.find((row) => row.name === operation.member)
        : undefined;
    if (!call) throw new Error("Native code call is absent at this source");
    fields = call.fields;
  } else
    throw new Error(
      "Native code artifacts require a declared contract code operation",
    );
  if (operation.args.length !== fields.length)
    throw new Error("Native code argument arity mismatch");
  const indexes = fields.flatMap((field, index) =>
    field.name ===
    (evm ? (operation.kind === "runtime" ? "data" : "init") : "code")
      ? [index]
      : [],
  );
  if (indexes.length !== 1)
    throw new Error("Native code requires one declared code argument");
  const index = indexes[0]!;
  const id = fields[index]!.type;
  const value = operation.args[index];
  let upload = false;
  if (!byteVector(metadata, id)) {
    if (evm)
      throw new Error("Native EVM code argument is not a declared byte vector");
    const type = metadata.types.get(id)?.definition;
    const variant =
      type?.kind === "variant"
        ? type.variants.find((row) => row.name === "Upload")
        : undefined;
    if (
      !variant ||
      variant.fields.length !== 1 ||
      variant.fields[0]!.name !== null ||
      !byteVector(metadata, variant.fields[0]!.type)
    )
      throw new Error("Native code argument is not a declared byte vector");
    upload = true;
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      value.variant !== "Upload" ||
      value.fields !== "0x" ||
      Object.keys(value).length !== 2
    )
      throw new Error("Native code artifact requires an empty Upload argument");
  } else if (value !== "0x")
    throw new Error("Native code artifact requires an empty code argument");
  fields.forEach((field, i) =>
    encodeNativeValue(metadata, field.type, operation.args[i]!),
  );
  return { argumentIndex: index, upload, limit };
}

async function fetchArtifact(artifact: Artifact, fetchImpl: typeof fetch) {
  const signal = AbortSignal.timeout(5000);
  const response = await fetchImpl(artifact.url, {
    signal,
    redirect: "manual",
    headers: { accept: "application/octet-stream" },
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Native code artifact response failed: ${response.status}`);
  }
  const declared = response.headers.get("content-length");
  const encoding = response.headers.get("content-encoding");
  const compressed = encoding !== null && encoding !== "identity";
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) ||
      Number(declared) >
        (compressed ? NATIVE_RUNTIME_LIMITS.valueBytes : artifact.bytes) ||
      (!compressed && Number(declared) !== artifact.bytes))
  ) {
    await response.body?.cancel();
    throw new Error("Native code artifact declared length mismatch");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Native code artifact body is absent");
  const parts: Uint8Array[] = [];
  let bytes = 0,
    chunks = 0;
  let onAbort: () => void;
  const expired = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("Native code artifact timed out"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    for (;;) {
      const part = await Promise.race([reader.read(), expired]);
      if (part.done) break;
      bytes += part.value.byteLength;
      if (++chunks > 4096 || bytes > artifact.bytes)
        throw new Error("Native code artifact exceeds its stream budget");
      parts.push(part.value);
    }
  } finally {
    signal.removeEventListener("abort", onAbort!);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (bytes !== artifact.bytes)
    throw new Error("Native code artifact length mismatch");
  const body = Buffer.concat(parts, bytes);
  if (createHash("sha256").update(body).digest("hex") !== artifact.sha256)
    throw new Error("Native code artifact checksum mismatch");
  return nativeHex(body);
}

/** Resolve only explicitly supplied public code references. Ordinary requests
 * keep the original operations and incur no artifact fetch or argument copy. */
export async function resolveNativeCodeArtifacts(
  metadata: NativeMetadata,
  operations: Operation[],
  fetchImpl: typeof fetch,
) {
  const rows: {
    operation: Extract<Operation, { kind: "runtime" | "prepare" }>;
    index: number;
    artifact: Artifact;
  }[] = [];
  operations.forEach((operation, index) => {
    if (
      (operation.kind === "runtime" || operation.kind === "prepare") &&
      operation.code_artifact
    )
      rows.push({
        operation,
        index,
        artifact: operation.code_artifact,
      });
  });
  if (rows.length === 0) return operations;
  const refs = new Map<string, Artifact>();
  const bindings = rows.map((row) => {
    const binding = codeArgument(metadata, row.operation);
    if (BigInt(row.artifact.bytes) > binding.limit)
      throw new Error("Native code artifact exceeds the source MaxCodeLen");
    const artifact = { ...row.artifact, url: artifactUrl(row.artifact.url) };
    const key = JSON.stringify(artifact);
    refs.set(key, artifact);
    return { ...row, ...binding };
  });
  if (refs.size > 1)
    throw new Error("Native request permits one distinct code artifact");
  const artifact = [...refs.values()][0]!;
  const value = await fetchArtifact(artifact, fetchImpl);
  const bound = new Map(bindings.map((row) => [row.index, row]));
  return operations.map((operation, index) => {
    const binding = bound.get(index);
    if (!binding) return operation;
    const args: NativeValue[] = [...binding.operation.args];
    args[binding.argumentIndex] = binding.upload
      ? { variant: "Upload", fields: value }
      : value;
    return { ...binding.operation, args };
  });
}
