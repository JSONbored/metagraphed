import type { webcrypto } from "node:crypto";
import { z } from "zod";
import {
  V2_OPERATION_SCHEMAS,
  isBoundedV2DecodedValue,
  V2ErrorSchema,
  V2HashSchema,
  isV2AccountStakeEntryAtState,
} from "../../schemas-src/v2/contracts.ts";
import { isUnsafeUrl } from "../public-url-safety.ts";
import {
  decodeAccountEventCursor,
  encodeAccountEventCursor,
} from "./account-event-cursor.ts";
import {
  accountStakeKey,
  compareAccountStakeKeys,
  decodeAccountStakeCursor,
} from "./account-stake-cursor.ts";

export const V2_READ_OPERATIONS = [
  "get_chain_head",
  "list_blocks",
  "get_block",
  "list_account_events",
  "list_account_stake",
  "list_subnets",
  "get_subnet",
  "find_subnet_for_task",
  "list_subnet_apis",
  "get_api_schema",
  "how_do_i_call",
] as const;
export type V2ReadOperation = (typeof V2_READ_OPERATIONS)[number];
export type V2ReadInput<Name extends V2ReadOperation> = z.input<
  (typeof V2_OPERATION_SCHEMAS)[Name]["input"]
>;
export type V2ReadOutput<Name extends V2ReadOperation> = z.output<
  (typeof V2_OPERATION_SCHEMAS)[Name]["output"]
>;
type ParsedInput = z.output<
  (typeof V2_OPERATION_SCHEMAS)[V2ReadOperation]["input"]
>;
type ReadOutput = V2ReadOutput<V2ReadOperation>;

const messages = {
  invalid_configuration: "Invalid public API client configuration",
  invalid_input: "Invalid public API read input",
  busy: "Public API client request limit reached",
  cancelled: "Public API read cancelled",
  deadline_exceeded: "Public API read deadline exceeded",
  transport_failed: "Public API transport failed",
  response_rejected: "Public API response failed validation",
  response_too_large: "Public API response exceeds the byte limit",
  http_error: "Public API request was refused",
  identity_mismatch: "Public API response identity does not match the request",
  pagination_mismatch: "Public API directory publication is inconsistent",
} as const;
export type V2ReadClientErrorCode = keyof typeof messages;
export class V2ReadClientError extends Error {
  readonly code: V2ReadClientErrorCode;
  readonly status?: number;
  readonly serverCode?: string;

  constructor(
    code: V2ReadClientErrorCode,
    status?: number,
    serverCode?: string,
  ) {
    super(messages[code]);
    this.name = "V2ReadClientError";
    this.code = code;
    this.status = status;
    this.serverCode = serverCode;
  }
}

// The outer application also emits these bounded codes before the REST
// operation. Its error messages remain untrusted and never become diagnostics.
const HttpErrorSchema = V2ErrorSchema.extend({
  error: V2ErrorSchema.shape.error.extend({
    code: z.union([
      V2ErrorSchema.shape.error.shape.code,
      z.enum(["busy", "unavailable", "forbidden"]),
    ]),
  }),
});

export interface V2ReadRequestOptions {
  signal?: AbortSignal;
  expectedGenesisHash?: string;
}
export interface V2ReadClientOptions {
  origin: string;
  fetch?: typeof globalThis.fetch;
  maxResponseBytes?: number;
  deadlineMillis?: number;
  maxConcurrent?: number;
}

const pathFields = {
  get_chain_head: ["network"],
  list_blocks: ["network"],
  get_block: ["network", "height"],
  list_account_events: ["network", "account_id"],
  list_account_stake: ["network", "account_id"],
  list_subnets: ["network"],
  get_subnet: ["network", "netuid"],
  find_subnet_for_task: ["network"],
  list_subnet_apis: ["network", "netuid"],
  get_api_schema: ["network", "netuid", "service_id"],
  how_do_i_call: ["network", "netuid"],
} satisfies Record<V2ReadOperation, string[]>;

function requestUrl(
  origin: string,
  name: V2ReadOperation,
  input: ParsedInput,
): URL {
  const fields: Record<string, unknown> = input;
  const segment = (key: string) => encodeURIComponent(String(fields[key]));
  const paths: Record<V2ReadOperation, string> = {
    get_chain_head: "head",
    list_blocks: "blocks",
    get_block: `blocks/${segment("height")}`,
    list_account_events: `accounts/${segment("account_id")}/events`,
    list_account_stake: `accounts/${segment("account_id")}/stake`,
    list_subnets: "subnets",
    get_subnet: `subnets/${segment("netuid")}`,
    find_subnet_for_task: "services/search",
    list_subnet_apis: `subnets/${segment("netuid")}/services`,
    get_api_schema: `subnets/${segment("netuid")}/services/${segment("service_id")}/schema`,
    how_do_i_call: `subnets/${segment("netuid")}/instructions`,
  };
  const url = new URL(
    `/api/v2/networks/${segment("network")}/${paths[name]}`,
    origin,
  );
  for (const [key, value] of Object.entries(fields)) {
    if (pathFields[name].includes(key) || value === undefined) continue;
    // Only canonical parsed selectors are forwarded; no user headers, paths,
    // request init, or provider URL can enter this transport.
    if (typeof value !== "string" && typeof value !== "number")
      throw new V2ReadClientError("invalid_input");
    url.searchParams.set(key, String(value));
  }
  return url;
}

function identity(
  name: V2ReadOperation,
  input: ParsedInput,
  output: ReadOutput,
  expectedGenesis?: string,
) {
  const ecosystemRead = [
    "list_subnets",
    "get_subnet",
    "find_subnet_for_task",
    "list_subnet_apis",
    "get_api_schema",
    "how_do_i_call",
  ].includes(name);
  if (ecosystemRead && !("ecosystem" in output))
    throw new V2ReadClientError("response_rejected");
  if (name === "list_account_stake" && !("stake" in output))
    throw new V2ReadClientError("response_rejected");
  const publication =
    ecosystemRead && "ecosystem" in output
      ? output.ecosystem.publication_id
      : name === "list_account_stake" && "stake" in output
        ? output.stake.publication_id
        : output.snapshot.publication_id;
  if (
    output.network.id !== input.network ||
    (expectedGenesis !== undefined &&
      output.network.genesis_hash !== expectedGenesis) ||
    ("publication_id" in input &&
      input.publication_id !== undefined &&
      publication !== input.publication_id) ||
    ("height" in input && output.snapshot.block_number !== input.height) ||
    ("block_hash" in input &&
      input.block_hash !== undefined &&
      output.snapshot.block_hash !== input.block_hash) ||
    ("anchor_height" in input &&
      input.anchor_height !== undefined &&
      output.snapshot.block_number !== input.anchor_height) ||
    ("anchor_hash" in input &&
      input.anchor_hash !== undefined &&
      output.snapshot.block_hash !== input.anchor_hash) ||
    ("anchor_publication_id" in input &&
      input.anchor_publication_id !== undefined &&
      output.snapshot.publication_id !== input.anchor_publication_id) ||
    ("netuid" in input &&
      "subnet" in output &&
      output.subnet.generation.netuid !== input.netuid) ||
    ("service_id" in input &&
      "service_id" in output &&
      output.service_id !== input.service_id) ||
    ("task" in input && "task" in output && output.task !== input.task) ||
    ("catalog_id" in input &&
      input.catalog_id !== undefined &&
      "catalog" in output &&
      output.catalog.catalog_id !== input.catalog_id)
  )
    throw new V2ReadClientError("identity_mismatch");
}

function accountStakePage(
  input: V2ReadInput<"list_account_stake">,
  page: V2ReadOutput<"list_account_stake">,
) {
  const cursor =
    input.cursor === undefined
      ? undefined
      : decodeAccountStakeCursor(input.cursor);
  if (
    page.account_id !== input.account_id ||
    page.entries.length > (input.limit ?? 10) ||
    (cursor !== undefined &&
      (cursor.genesis_hash !== page.network.genesis_hash ||
        cursor.publication_id !== page.stake.publication_id))
  )
    throw new V2ReadClientError("identity_mismatch");
  let previous =
    cursor === undefined
      ? undefined
      : { kind: cursor.kind, hotkey: cursor.hotkey, netuid: cursor.netuid };
  for (const entry of page.entries) {
    const key = accountStakeKey(entry);
    if (
      (previous !== undefined && compareAccountStakeKeys(previous, key) >= 0) ||
      !isV2AccountStakeEntryAtState(
        entry,
        input.account_id,
        page.network.genesis_hash,
        page.stake.state,
      )
    )
      throw new V2ReadClientError("pagination_mismatch");
    previous = key;
  }
  if (page.next_cursor !== null) {
    let next;
    try {
      next = decodeAccountStakeCursor(page.next_cursor);
    } catch {
      throw new V2ReadClientError("pagination_mismatch");
    }
    const last = page.entries.at(-1);
    if (
      last === undefined ||
      page.entries.length !== (input.limit ?? 10) ||
      next.network !== page.network.id ||
      next.genesis_hash !== page.network.genesis_hash ||
      next.account_id !== input.account_id ||
      next.publication_id !== page.stake.publication_id ||
      compareAccountStakeKeys(next, accountStakeKey(last)) !== 0
    )
      throw new V2ReadClientError("pagination_mismatch");
  }
}

function accountEventPage(
  input: V2ReadInput<"list_account_events">,
  page: V2ReadOutput<"list_account_events">,
) {
  const cursor =
    input.cursor === undefined
      ? undefined
      : decodeAccountEventCursor(input.cursor);
  const from = cursor?.from_block ?? input.from_block;
  if (
    page.account_id !== input.account_id ||
    page.coverage.through_block !== page.snapshot.block_number ||
    BigInt(page.coverage.from_block) > BigInt(page.coverage.through_block) ||
    (from !== undefined && page.coverage.from_block !== from) ||
    page.events.length > (input.limit ?? 25) ||
    (cursor &&
      (cursor.genesis_hash !== page.network.genesis_hash ||
        cursor.anchor_height !== page.snapshot.block_number ||
        cursor.anchor_hash !== page.snapshot.block_hash ||
        cursor.anchor_publication_id !== page.snapshot.publication_id ||
        cursor.revision_generation !== page.revision.generation ||
        cursor.revision_publication_id !== page.revision.publication_id))
  )
    throw new V2ReadClientError("pagination_mismatch");
  let previous = cursor
    ? { height: BigInt(cursor.before_block), index: cursor.before_event_index }
    : undefined;
  let priorSource: string | undefined;
  for (const row of page.events) {
    const height = BigInt(row.snapshot.block_number);
    const { event } = row;
    const matches = event.participants.filter(
      (participant) => participant.account_id === input.account_id,
    );
    const source = JSON.stringify({
      snapshot: row.snapshot,
      source_capture_digest: row.source_capture_digest,
      event_count: row.event_count,
      extrinsic_count: row.extrinsic_count,
    });
    if (
      height < BigInt(page.coverage.from_block) ||
      height > BigInt(page.snapshot.block_number) ||
      event.event_index >= row.event_count ||
      (event.phase === "ApplyExtrinsic") !== (event.extrinsic_index !== null) ||
      (event.extrinsic_index !== null &&
        event.extrinsic_index >= row.extrinsic_count) ||
      event.participants.some(
        (participant, index) => participant.participant_index !== index,
      ) ||
      JSON.stringify(matches) !== JSON.stringify(row.matching_participants) ||
      (height === BigInt(page.snapshot.block_number) &&
        JSON.stringify(row.snapshot) !== JSON.stringify(page.snapshot)) ||
      (previous &&
        (height > previous.height ||
          (height === previous.height &&
            event.event_index >= previous.index))) ||
      (previous &&
        height === previous.height &&
        priorSource !== undefined &&
        source !== priorSource)
    )
      throw new V2ReadClientError("pagination_mismatch");
    previous = { height, index: event.event_index };
    priorSource = source;
  }
  if (page.next_cursor !== null) {
    const last = page.events.at(-1);
    if (
      !last ||
      page.events.length !== (input.limit ?? 25) ||
      page.next_cursor !==
        encodeAccountEventCursor({
          version: 1,
          network: input.network,
          genesis_hash: page.network.genesis_hash,
          account_id: input.account_id,
          from_block: page.coverage.from_block,
          anchor_height: page.snapshot.block_number,
          anchor_hash: page.snapshot.block_hash,
          anchor_publication_id: page.snapshot.publication_id,
          revision_generation: page.revision.generation,
          revision_publication_id: page.revision.publication_id,
          before_block: last.snapshot.block_number,
          before_event_index: last.event.event_index,
        })
    )
      throw new V2ReadClientError("pagination_mismatch");
  }
}

function directoryPage(
  input: V2ReadInput<"list_subnets">,
  page: V2ReadOutput<"list_subnets">,
) {
  const limit = input.limit ?? 100;
  const rows = page.subnets;
  if (
    page.coverage.reportable_subnets > 4096 ||
    rows.length > limit ||
    page.coverage.reportable_subnets < rows.length ||
    (input.after === undefined && rows[0]?.generation.netuid !== 0) ||
    rows.some(
      (row, index) =>
        row.generation.netuid <=
        (index ? rows[index - 1].generation.netuid : (input.after ?? -1)),
    ) ||
    (page.next_after !== null &&
      (rows.length !== limit ||
        page.next_after !== rows.at(-1)?.generation.netuid)) ||
    (input.after === undefined &&
      (page.next_after === null) !==
        (rows.length === page.coverage.reportable_subnets))
  )
    throw new V2ReadClientError("pagination_mismatch");
}

export function createV2ReadClient(options: V2ReadClientOptions) {
  let origin: string;
  try {
    const url = new URL(options.origin);
    const loopback =
      url.hostname === "localhost" ||
      url.hostname === "[::1]" ||
      /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
    if (
      url.origin !== options.origin ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      url.hostname.includes("*") ||
      (!loopback && (url.protocol !== "https:" || isUnsafeUrl(url.href))) ||
      !["http:", "https:"].includes(url.protocol)
    )
      throw new Error();
    origin = url.origin;
  } catch {
    throw new V2ReadClientError("invalid_configuration");
  }
  const maxResponseBytes = options.maxResponseBytes ?? 1048576;
  const deadlineMillis = options.deadlineMillis ?? 10000;
  const maxConcurrent = options.maxConcurrent ?? 4;
  for (const [value, maximum] of [
    [maxResponseBytes, 1048576],
    [deadlineMillis, 30000],
    [maxConcurrent, 8],
  ])
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
      throw new V2ReadClientError("invalid_configuration");
  const fetch = options.fetch ?? globalThis.fetch;
  if (typeof fetch !== "function")
    throw new V2ReadClientError("invalid_configuration");
  let active = 0;

  async function read<Name extends V2ReadOperation>(
    name: Name,
    input: V2ReadInput<Name>,
    request: V2ReadRequestOptions = {},
  ): Promise<V2ReadOutput<Name>> {
    if (!(V2_READ_OPERATIONS as readonly string[]).includes(name))
      throw new V2ReadClientError("invalid_input");
    const parsed = V2_OPERATION_SCHEMAS[name].input.safeParse(input);
    const expectedGenesisHash = request.expectedGenesisHash;
    const signal = request.signal;
    if (
      !parsed.success ||
      (signal !== undefined &&
        (typeof signal.aborted !== "boolean" ||
          typeof signal.addEventListener !== "function" ||
          typeof signal.removeEventListener !== "function")) ||
      (expectedGenesisHash !== undefined &&
        !V2HashSchema.safeParse(expectedGenesisHash).success)
    )
      throw new V2ReadClientError("invalid_input");
    if (name === "list_account_stake") {
      const query = parsed.data as V2ReadInput<"list_account_stake">;
      if (query.cursor !== undefined) {
        try {
          const cursor = decodeAccountStakeCursor(query.cursor);
          if (
            cursor.network !== query.network ||
            cursor.account_id !== query.account_id ||
            (query.publication_id !== undefined &&
              query.publication_id !== cursor.publication_id) ||
            (expectedGenesisHash !== undefined &&
              expectedGenesisHash !== cursor.genesis_hash)
          )
            throw new Error();
        } catch {
          throw new V2ReadClientError("invalid_input");
        }
      }
    }
    if (name === "list_account_events") {
      const query = parsed.data as V2ReadInput<"list_account_events">;
      if (query.cursor !== undefined) {
        try {
          const cursor = decodeAccountEventCursor(query.cursor);
          if (
            cursor.network !== query.network ||
            cursor.account_id !== query.account_id ||
            (expectedGenesisHash !== undefined &&
              cursor.genesis_hash !== expectedGenesisHash)
          )
            throw new Error();
        } catch {
          throw new V2ReadClientError("invalid_input");
        }
      }
    }
    const url = requestUrl(origin, name, parsed.data);
    if (signal?.aborted) throw new V2ReadClientError("cancelled");
    if (active >= maxConcurrent) throw new V2ReadClientError("busy");
    active++;
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let cancellation: Promise<void> | undefined;
    let consumed = false;
    let stopped: V2ReadClientError | undefined;
    let deliver!: (value: V2ReadOutput<Name>) => void;
    let reject!: (error: V2ReadClientError) => void;
    const result = new Promise<V2ReadOutput<Name>>((resolve, refuse) => {
      deliver = resolve;
      reject = refuse;
    });
    const cancelReader = () => {
      if (reader && !consumed && !cancellation) cancellation = reader.cancel();
    };
    const stop = (code: "cancelled" | "deadline_exceeded") => {
      if (stopped) return;
      stopped = new V2ReadClientError(code);
      reject(stopped);
      controller.abort();
      cancelReader();
    };
    const abort = () => stop("cancelled");
    try {
      signal?.addEventListener("abort", abort, { once: true });
    } catch {
      active--;
      throw new V2ReadClientError("invalid_input");
    }
    const timer = setTimeout(() => stop("deadline_exceeded"), deadlineMillis);

    // A caller can stop waiting promptly while an ignored abort/cancel is still
    // outstanding. The admission slot belongs to this work, not that caller.
    const work = async () => {
      let received = false;
      try {
        const init = {
          method: "GET",
          headers: { Accept: "application/json" },
          credentials: "omit",
          redirect: "error",
          cache: "no-store",
          referrerPolicy: "no-referrer",
          signal: controller.signal,
        } as const;
        const response = await fetch(url.href, init);
        received = true;
        reader = response.body?.getReader();
        if (stopped) throw stopped;
        if (
          !reader ||
          response.redirected ||
          (response.url !== "" && response.url !== url.href) ||
          !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
            (response.headers.get("content-type") ?? "").trim(),
          ) ||
          (response.status !== 200 &&
            (response.status < 400 || response.status > 599))
        )
          throw new V2ReadClientError("response_rejected");
        const decoder = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: false,
        });
        let bytes = 0;
        let text = "";
        for (;;) {
          const part = await reader.read();
          if (stopped) throw stopped;
          if (part.done) {
            consumed = true;
            break;
          }
          bytes += part.value.byteLength;
          if (bytes > maxResponseBytes)
            throw new V2ReadClientError("response_too_large");
          text += decoder.decode(part.value, { stream: true });
        }
        text += decoder.decode();
        const value: unknown = JSON.parse(text);
        if (response.status !== 200) {
          const error = HttpErrorSchema.safeParse(value);
          if (!error.success) throw new V2ReadClientError("response_rejected");
          throw new V2ReadClientError(
            "http_error",
            response.status,
            error.data.error.code,
          );
        }
        if (name === "get_block") {
          if (
            value === null ||
            typeof value !== "object" ||
            !("events" in value) ||
            !("extrinsics" in value) ||
            !Array.isArray(value.events) ||
            value.events.length > 200 ||
            !Array.isArray(value.extrinsics) ||
            value.extrinsics.length > 100 ||
            [...value.events, ...value.extrinsics].some(
              (row) =>
                row === null ||
                typeof row !== "object" ||
                !isBoundedV2DecodedValue(row.fields) ||
                ("signer" in row && !isBoundedV2DecodedValue(row.signer)),
            )
          )
            throw new V2ReadClientError("response_rejected");
        }
        if (name === "list_account_stake") {
          if (
            value === null ||
            typeof value !== "object" ||
            !("entries" in value) ||
            !Array.isArray(value.entries) ||
            value.entries.length > 10 ||
            value.entries.some((entry) => !isBoundedV2DecodedValue(entry))
          )
            throw new V2ReadClientError("response_rejected");
        }
        if (name === "list_account_events") {
          if (
            value === null ||
            typeof value !== "object" ||
            !("events" in value) ||
            !Array.isArray(value.events) ||
            value.events.length > 100 ||
            value.events.some(
              (row) =>
                row === null ||
                typeof row !== "object" ||
                !("event" in row) ||
                row.event === null ||
                typeof row.event !== "object" ||
                !("fields" in row.event) ||
                !("participants" in row.event) ||
                !Array.isArray(row.event.participants) ||
                row.event.participants.length > 256 ||
                !("topics" in row.event) ||
                !Array.isArray(row.event.topics) ||
                row.event.topics.length > 256 ||
                !("matching_participants" in row) ||
                !Array.isArray(row.matching_participants) ||
                row.matching_participants.length > 256 ||
                !isBoundedV2DecodedValue(row.event.fields),
            )
          )
            throw new V2ReadClientError("response_rejected");
        }
        const output = V2_OPERATION_SCHEMAS[name].output.safeParse(value);
        if (!output.success) throw new V2ReadClientError("response_rejected");
        const data: ReadOutput = output.data;
        identity(name, parsed.data, data, expectedGenesisHash);
        if (name === "list_account_stake")
          accountStakePage(
            parsed.data as V2ReadInput<"list_account_stake">,
            data as V2ReadOutput<"list_account_stake">,
          );
        if (name === "list_account_events")
          accountEventPage(
            parsed.data as V2ReadInput<"list_account_events">,
            data as V2ReadOutput<"list_account_events">,
          );
        if (name === "list_subnets")
          directoryPage(
            parsed.data as V2ReadInput<"list_subnets">,
            data as V2ReadOutput<"list_subnets">,
          );
        if (name === "list_blocks") {
          const query = parsed.data as V2ReadInput<"list_blocks">;
          const page = data as V2ReadOutput<"list_blocks">;
          const top =
            query.before === undefined
              ? BigInt(page.snapshot.block_number)
              : BigInt(query.before) - 1n;
          const available = top - BigInt(page.coverage.from_block) + 1n;
          const expected = Number(
            available < BigInt(query.limit ?? 25)
              ? available
              : BigInt(query.limit ?? 25),
          );
          if (
            (query.before === undefined &&
              (page.blocks[0]?.snapshot.block_hash !==
                page.snapshot.block_hash ||
                page.blocks[0]?.snapshot.publication_id !==
                  page.snapshot.publication_id)) ||
            page.coverage.through_block !== page.snapshot.block_number ||
            (query.from_block !== undefined &&
              page.coverage.from_block !== query.from_block) ||
            page.blocks.length !== expected ||
            page.blocks.some(
              (row, index) =>
                BigInt(row.snapshot.block_number) !== top - BigInt(index) ||
                (index > 0 &&
                  page.blocks[index - 1].snapshot.parent_hash !==
                    row.snapshot.block_hash),
            ) ||
            page.next_before !==
              (available > BigInt(page.blocks.length)
                ? page.blocks.at(-1)?.snapshot.block_number
                : null)
          )
            throw new V2ReadClientError("pagination_mismatch");
        }
        if (name === "get_block") {
          const query = parsed.data as V2ReadInput<"get_block">;
          const page = data as V2ReadOutput<"get_block">;
          for (const [rows, count, after, limit, next] of [
            [
              page.events.map((row) => row.event_index),
              page.event_count,
              query.after_event_index,
              query.limit ?? 100,
              page.next_event_index,
            ],
            [
              page.extrinsics.map((row) => row.extrinsic_index),
              page.extrinsic_count,
              query.after_extrinsic_index,
              query.extrinsic_limit ?? 25,
              page.next_extrinsic_index,
            ],
          ] as const) {
            const start = (after ?? -1) + 1;
            if (
              rows.length !== Math.min(Math.max(0, count - start), limit) ||
              rows.some((index, offset) => index !== start + offset) ||
              next !== (start + rows.length < count ? rows.at(-1) : null)
            )
              throw new V2ReadClientError("pagination_mismatch");
          }
          if (
            page.events.some(
              (event) =>
                (event.extrinsic_index !== null &&
                  event.extrinsic_index >= page.extrinsic_count) ||
                event.participants.some(
                  (row, index) => row.participant_index !== index,
                ),
            )
          )
            throw new V2ReadClientError("pagination_mismatch");
        }
        if (name === "get_api_schema") {
          if (
            !("document_json" in data) ||
            typeof data.document_json !== "string" ||
            !("digest" in data) ||
            typeof data.digest !== "string"
          )
            throw new V2ReadClientError("response_rejected");
          const documentJson = data.document_json;
          const expectedDigest = data.digest;
          const document: unknown = JSON.parse(documentJson);
          if (
            document === null ||
            typeof document !== "object" ||
            Array.isArray(document)
          )
            throw new V2ReadClientError("response_rejected");
          // This project's Worker ambient types omit the browser's native
          // WebCrypto global. Keep that platform seam local and type-only.
          const crypto = (
            globalThis as typeof globalThis & { crypto?: webcrypto.Crypto }
          ).crypto;
          if (typeof crypto?.subtle?.digest !== "function")
            throw new V2ReadClientError("response_rejected");
          const digest = await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(documentJson),
          );
          const hex = Array.from(new Uint8Array(digest), (byte) =>
            byte.toString(16).padStart(2, "0"),
          ).join("");
          if (hex !== expectedDigest)
            throw new V2ReadClientError("response_rejected");
        }
        if (stopped) throw stopped;
        // The selected name indexes the same canonical input/output pair.
        deliver(output.data as V2ReadOutput<Name>);
      } catch (error) {
        reject(
          stopped ??
            (error instanceof V2ReadClientError
              ? error
              : new V2ReadClientError(
                  received ? "response_rejected" : "transport_failed",
                )),
        );
        controller.abort();
      } finally {
        try {
          cancelReader();
          if (cancellation) await Promise.allSettled([cancellation]);
        } finally {
          try {
            reader?.releaseLock();
          } finally {
            active--;
          }
        }
      }
    };
    // Cleanup failures are observable if the caller is still waiting; they
    // cannot strand a slot or expose a source exception after cancellation.
    void work().catch(() => reject(new V2ReadClientError("response_rejected")));
    try {
      return await result;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  function directory(
    input: Omit<V2ReadInput<"list_subnets">, "after">,
    options: Omit<V2ReadRequestOptions, "signal"> = {},
  ) {
    const parsed = V2_OPERATION_SCHEMAS.list_subnets.input.safeParse(input);
    if (!parsed.success || Object.hasOwn(input, "after"))
      throw new V2ReadClientError("invalid_input");
    const start = parsed.data;
    const expectedGenesisHash = options.expectedGenesisHash;
    let anchor:
      | {
          publication: string;
          genesis: string;
          snapshot: string;
          ecosystem: string;
          count: number;
        }
      | undefined;
    let after: number | undefined;
    let seen = 0;
    let done = false;
    let pending = false;
    let failed = false;
    return {
      async next(
        request: Pick<V2ReadRequestOptions, "signal"> = {},
      ): Promise<V2ReadOutput<"list_subnets"> | null> {
        if (failed) throw new V2ReadClientError("pagination_mismatch");
        if (pending) throw new V2ReadClientError("busy");
        if (done) return null;
        pending = true;
        try {
          const page = await read(
            "list_subnets",
            {
              ...start,
              ...(anchor ? { publication_id: anchor.publication, after } : {}),
            },
            {
              signal: request.signal,
              expectedGenesisHash: anchor?.genesis ?? expectedGenesisHash,
            },
          );
          if (
            anchor &&
            (anchor.snapshot !== JSON.stringify(page.snapshot) ||
              anchor.ecosystem !== JSON.stringify(page.ecosystem) ||
              anchor.count !== page.coverage.reportable_subnets)
          )
            throw new V2ReadClientError("pagination_mismatch");
          seen += page.subnets.length;
          if (
            seen > page.coverage.reportable_subnets ||
            (page.next_after === null) !==
              (seen === page.coverage.reportable_subnets)
          )
            throw new V2ReadClientError("pagination_mismatch");
          anchor ??= {
            publication: page.ecosystem.publication_id,
            genesis: page.network.genesis_hash,
            snapshot: JSON.stringify(page.snapshot),
            ecosystem: JSON.stringify(page.ecosystem),
            count: page.coverage.reportable_subnets,
          };
          after = page.next_after ?? undefined;
          done = page.next_after === null;
          return page;
        } catch (error) {
          failed = true;
          throw error;
        } finally {
          pending = false;
        }
      },
    };
  }
  return { read, directory };
}
