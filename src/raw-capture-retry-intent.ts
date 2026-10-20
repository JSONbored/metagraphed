import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

export const RAW_CAPTURE_CHUNK_BYTES = 65_536;
export const RAW_CAPTURE_MAX_BYTES = 32 * 1024 * 1024;
export const RAW_CAPTURE_INTENT_MAX_BYTES = 96 * 1024;
const FORMAT = "raw-capture-0028-0029-v1";
const KEY =
  /^chain\/raw\/(testnet\/)?blocks\/(\d{12})-(\d{12})\.ndjson(?![\s\S])/;
const HASH = /^[a-f0-9]{64}(?![\s\S])/;
const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?(?![\s\S])/;
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

export interface RawCaptureDescriptor {
  key: string;
  sha256: string;
  network: "mainnet" | "testnet";
  first_block: number;
  last_block: number;
  raw_bytes: number;
  compressed_bytes: number;
  compressed_sha256: string;
  parts: number;
  captured_at: number;
}
export interface RawCaptureIntent {
  version: 1;
  schema: typeof FORMAT;
  descriptor: RawCaptureDescriptor;
  provenance: string[];
}
export interface RawCapturePrepared {
  descriptor: RawCaptureDescriptor;
  provenance: string[];
  compressed: Buffer;
}
interface Span {
  start: number;
  end: number;
  token: string;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
function range(key: string) {
  const match = KEY.exec(key);
  if (!match) throw new Error("Invalid raw capture object");
  const first = Number(match[2]),
    last = Number(match[3]);
  if (last < first || last - first >= 4096)
    throw new Error("Raw capture exceeds its storage budget");
  return {
    first,
    last,
    network: match[1] ? ("testnet" as const) : ("mainnet" as const),
  };
}

/** Locate one validated top-level numeric token without reserializing payloads. */
function provenance(value: string, first: number, last: number): Span[] {
  const lines = value.trimEnd().split("\n");
  if (lines.length !== last - first + 1)
    throw new Error("Raw capture range differs from its records");
  const spans: Span[] = [];
  let offset = 0;
  for (const [index, line] of lines.entries()) {
    const row: unknown = JSON.parse(line);
    if (
      !row ||
      typeof row !== "object" ||
      !("block_number" in row) ||
      row.block_number !== first + index ||
      !("captured_at" in row) ||
      !positiveInteger(row.captured_at)
    )
      throw new Error("Raw capture identity differs");
    let depth = 0;
    let found: Span | undefined;
    let blockNumberSeen = false;
    for (let cursor = 0; cursor < line.length; cursor++) {
      const char = line[cursor];
      if (char === "{" || char === "[") depth++;
      else if (char === "}" || char === "]") depth--;
      else if (char === '"') {
        const start = cursor;
        for (;;) {
          cursor = line.indexOf('"', cursor + 1);
          let escapes = 0;
          for (let before = cursor - 1; line[before] === "\\"; before--)
            escapes++;
          if (escapes % 2 === 0) break;
        }
        if (depth !== 1) continue;
        const name: unknown = JSON.parse(line.slice(start, cursor + 1));
        if (name !== "captured_at" && name !== "block_number") continue;
        const colon = /^\s*:\s*/.exec(line.slice(cursor + 1));
        if (!colon) continue;
        if (name === "block_number") {
          if (blockNumberSeen)
            throw new Error("Raw capture identity is ambiguous");
          blockNumberSeen = true;
          continue;
        }
        const tokenStart = cursor + 1 + colon[0].length;
        const token = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
          line.slice(tokenStart),
        )!;
        if (found) throw new Error("Raw capture provenance is ambiguous");
        found = {
          start: offset + tokenStart,
          end: offset + tokenStart + token[0].length,
          token: token[0],
        };
      }
    }
    // JSON validation and the own numeric field above guarantee one token.
    spans.push(found!);
    offset += line.length + 1;
  }
  return spans;
}

function validatedInput(key: string, value: string) {
  if (typeof value !== "string" || !value.endsWith("\n"))
    throw new Error("Invalid raw capture object");
  const identity = range(key);
  const bytes = Buffer.byteLength(value);
  if (bytes > RAW_CAPTURE_MAX_BYTES)
    throw new Error("Raw capture exceeds its storage budget");
  const spans = provenance(value, identity.first, identity.last);
  return { ...identity, bytes, spans };
}

export function rawCaptureIdentity(key: string, value: string) {
  const input = validatedInput(key, value);
  return {
    key,
    network: input.network,
    first: input.first,
    last: input.last,
    sha256: createHash("sha256").update(value).digest("hex"),
  };
}

function prepareBytes(
  key: string,
  input: ReturnType<typeof range>,
  raw: Buffer,
  tokens: string[],
  sha256 = digest(raw),
): RawCapturePrepared {
  const compressed = gzipSync(raw, { level: 6 });
  const descriptor: RawCaptureDescriptor = {
    key,
    sha256,
    network: input.network,
    first_block: input.first,
    last_block: input.last,
    raw_bytes: raw.length,
    compressed_bytes: compressed.length,
    compressed_sha256: digest(compressed),
    parts: Math.ceil(compressed.length / RAW_CAPTURE_CHUNK_BYTES),
    captured_at: Math.max(...tokens.map((token) => JSON.parse(token) as number)),
  };
  return {
    descriptor,
    compressed,
    provenance: tokens,
  };
}

export function prepareRawCapture(
  key: string,
  value: string,
): RawCapturePrepared {
  const input = validatedInput(key, value);
  return prepareBytes(
    key,
    input,
    Buffer.from(value),
    input.spans.map((span) => span.token),
  );
}

export function encodeRawCaptureIntent(prepared: RawCapturePrepared): string {
  const payload = JSON.stringify({
    version: 1,
    schema: FORMAT,
    descriptor: prepared.descriptor,
    provenance: prepared.provenance,
  } satisfies RawCaptureIntent);
  if (Buffer.byteLength(payload) > RAW_CAPTURE_INTENT_MAX_BYTES)
    throw new Error("Raw capture retry intent exceeds its metadata budget");
  return payload;
}

export function decodeRawCaptureIntent(payload: string): RawCaptureIntent {
  if (
    typeof payload !== "string" ||
    Buffer.byteLength(payload) > RAW_CAPTURE_INTENT_MAX_BYTES
  )
    throw new Error("Raw capture retry intent exceeds its metadata budget");
  const candidate: unknown = JSON.parse(payload);
  if (JSON.stringify(candidate) !== payload)
    throw new Error("Raw capture retry intent is not canonical");
  if (!candidate || typeof candidate !== "object")
    throw new Error("Raw capture retry intent identity differs");
  const control = candidate as Record<string, unknown>;
  if (
    Object.keys(control).sort().join(",") !==
      "descriptor,provenance,schema,version" ||
    control.version !== 1 ||
    control.schema !== FORMAT ||
    !control.descriptor ||
    typeof control.descriptor !== "object" ||
    !Array.isArray(control.provenance)
  )
    throw new Error("Raw capture retry intent identity differs");
  const d = control.descriptor as RawCaptureDescriptor;
  if (
    Object.keys(d).sort().join(",") !==
      "captured_at,compressed_bytes,compressed_sha256,first_block,key,last_block,network,parts,raw_bytes,sha256" ||
    typeof d.key !== "string"
  )
    throw new Error("Raw capture retry descriptor differs");
  const identity = range(d.key);
  if (
    d.network !== identity.network ||
    d.first_block !== identity.first ||
    d.last_block !== identity.last ||
    typeof d.sha256 !== "string" ||
    !HASH.test(d.sha256) ||
    typeof d.compressed_sha256 !== "string" ||
    !HASH.test(d.compressed_sha256) ||
    !positiveInteger(d.raw_bytes) ||
    d.raw_bytes > RAW_CAPTURE_MAX_BYTES ||
    !positiveInteger(d.compressed_bytes) ||
    d.compressed_bytes > 33_619_968 ||
    !positiveInteger(d.parts) ||
    d.parts > 513 ||
    d.parts !== Math.ceil(d.compressed_bytes / RAW_CAPTURE_CHUNK_BYTES) ||
    !positiveInteger(d.captured_at) ||
    control.provenance.length !== d.last_block - d.first_block + 1 ||
    control.provenance.some(
      (token) =>
        typeof token !== "string" ||
        !NUMBER.test(token) ||
        !positiveInteger(JSON.parse(token)),
    ) ||
    Math.max(
      ...control.provenance.map((token) => JSON.parse(token) as number),
    ) !== d.captured_at
  )
    throw new Error("Raw capture retry descriptor differs");
  return candidate as RawCaptureIntent;
}

export function resumeRawCapture(
  intent: RawCaptureIntent,
  key: string,
  value: string,
): RawCapturePrepared {
  // Revalidate metadata before trusting its allocation size or replacement tokens.
  const pinned = decodeRawCaptureIntent(JSON.stringify(intent));
  if (key !== pinned.descriptor.key)
    throw new Error("Raw capture retry range differs");
  const input = validatedInput(key, value);
  const expectedBytes = input.spans.reduce(
    (bytes, span, index) =>
      bytes + pinned.provenance[index]!.length - span.token.length,
    input.bytes,
  );
  if (expectedBytes !== pinned.descriptor.raw_bytes)
    throw new Error("Raw capture retry original bytes differ");
  const raw = Buffer.alloc(pinned.descriptor.raw_bytes);
  const encoder = new TextEncoder();
  let offset = 0;
  const append = (part: string) => {
    const target = raw.subarray(offset);
    const { read, written } = encoder.encodeInto(part, target);
    if (read !== part.length || written > target.byteLength)
      throw new Error("Raw capture retry original bytes differ");
    offset += written;
  };
  let through = 0;
  for (const [index, span] of input.spans.entries()) {
    // Numeric token boundaries cannot divide a UTF-16 surrogate pair.
    append(value.slice(through, span.start));
    append(pinned.provenance[index]!);
    through = span.end;
  }
  append(value.slice(through));
  if (offset !== raw.length)
    throw new Error("Raw capture retry original bytes differ");
  const sha256 = digest(raw);
  if (sha256 !== pinned.descriptor.sha256)
    throw new Error("Raw capture retry original bytes differ");
  const original = prepareBytes(key, input, raw, [...pinned.provenance], sha256);
  if (
    Object.entries(pinned.descriptor).some(
      ([name, expected]) =>
        original.descriptor[name as keyof RawCaptureDescriptor] !== expected,
    )
  )
    throw new Error("Raw capture retry original bytes differ");
  return original;
}

export function rawCaptureIntentKey(network: "mainnet" | "testnet"): string {
  return "raw-capture-retry/v1/" + network;
}
