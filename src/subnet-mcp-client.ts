import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import {
  CallToolResultSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  MAX_RESPONSE_BYTES,
  redactCredentialValue,
  type CallSubnetSurfaceCredential,
} from "./call-subnet-surface.ts";

const MAX_REQUESTS = 64;
const MAX_TOTAL_BYTES = 4 * MAX_RESPONSE_BYTES;
const MAX_TOOLS = 512;

export class SubnetMcpError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface SubnetMcpOptions {
  url: string;
  readTools: readonly string[];
  writeTools: readonly string[];
  credential?: CallSubnetSurfaceCredential;
  timeoutMs: number;
  fetchImpl: typeof fetch;
  isUnsafeUrl: (url: string) => Promise<boolean>;
}

export type SubnetMcpOperation =
  | { kind: "discover" }
  | {
      kind: "read" | "write";
      name: string;
      arguments: Record<string, unknown>;
    };

export type SubnetMcpResult =
  | { kind: "discover"; tools: (Tool & { access: "read" | "write" })[] }
  | { kind: "call"; result: CallToolResult };

/** A fresh SDK client per invocation: no caller credentials, validators or
 * provider session ids survive into another caller's operation. This module
 * is loaded only after the registry's explicit MCP admission succeeds. */
export async function runSubnetMcp(
  options: SubnetMcpOptions,
  operation: SubnetMcpOperation,
): Promise<SubnetMcpResult> {
  const { credential } = options;
  if (credential?.location === "body") {
    throw new SubnetMcpError(
      "credential_not_supported",
      "MCP transport credentials must use a declared header, query or cookie location.",
    );
  }
  const allowed = new Map<string, "read" | "write">();
  for (const name of options.readTools) allowed.set(name, "read");
  for (const name of options.writeTools) {
    if (allowed.has(name))
      throw new SubnetMcpError(
        "invalid_registry",
        "MCP read/write admissions overlap.",
      );
    allowed.set(name, "write");
  }
  if (
    operation.kind !== "discover" &&
    allowed.get(operation.name) !== operation.kind
  ) {
    throw new SubnetMcpError(
      "operation_not_allowed",
      "This MCP operation is not admitted for this tool.",
    );
  }
  const endpoint = new URL(options.url);
  const controller = new AbortController();
  const readers = new Set<ReadableStreamDefaultReader<Uint8Array>>();
  let phase: "operation" | "cleanup" | "closed" = "operation";
  let requests = 0;
  let totalBytes = 0;
  const validator = new CfWorkerJsonSchemaValidator();
  const client = new Client(
    { name: "metagraphed-subnet-bridge", version: "1" },
    { jsonSchemaValidator: validator },
  );
  const credentialEntries = credential?.values
    ? Object.entries(credential.values)
    : credential?.name && credential.value
      ? [[credential.name, credential.value]]
      : [];

  const checkedFetch: typeof fetch = async (input, init) => {
    if (
      phase === "closed" ||
      (phase === "cleanup" && init?.method !== "DELETE")
    )
      throw new SubnetMcpError(
        "request_closed",
        "The upstream MCP invocation has ended.",
      );
    if (phase === "operation" && ++requests > MAX_REQUESTS)
      throw new SubnetMcpError(
        "request_limit",
        "The upstream MCP request budget was exceeded.",
      );
    let url = new URL(input instanceof Request ? input.url : String(input));
    if (url.href !== endpoint.href)
      throw new SubnetMcpError(
        "unsafe_url",
        "The SDK requested an unregistered MCP endpoint.",
      );
    const headers = new Headers(init?.headers);
    for (const [name, value] of credentialEntries) {
      if (credential?.location === "query") url.searchParams.set(name, value);
      else if (credential?.location === "cookie")
        headers.append("cookie", `${name}=${value}`);
      else headers.set(name, value);
    }
    if (
      typeof init?.body === "string" &&
      new TextEncoder().encode(init.body).length > MAX_RESPONSE_BYTES
    )
      throw new SubnetMcpError(
        "request_too_large",
        "The upstream MCP request exceeds the byte limit.",
      );
    const signal =
      phase === "cleanup"
        ? AbortSignal.timeout(250)
        : init?.signal
          ? AbortSignal.any([controller.signal, init.signal])
          : controller.signal;
    for (let hop = 0; ; hop++) {
      if (await options.isUnsafeUrl(url.href))
        throw new SubnetMcpError(
          "unsafe_url",
          "The upstream MCP endpoint or redirect is unsafe.",
        );
      signal.throwIfAborted();
      const response = await options.fetchImpl(url.href, {
        ...init,
        headers,
        redirect: "manual",
        signal,
      });
      if (signal.aborted) {
        void response.body?.cancel().catch(() => {});
        signal.throwIfAborted();
      }
      const location = response.headers.get("location");
      if ([301, 302, 303, 307, 308].includes(response.status) && location) {
        void response.body?.cancel().catch(() => {});
        const target = new URL(location, url);
        if (hop === 5 || target.origin !== endpoint.origin)
          throw new SubnetMcpError(
            "redirect_blocked",
            "The upstream MCP redirect exceeds its admitted origin or hop limit.",
          );
        url = target;
        continue;
      }
      if (!response.body) return response;
      const reader = response.body.getReader();
      readers.add(reader);
      let bytes = 0;
      let emptyChunks = 0;
      // SDK error-body reads and JSON/SSE parsing use the same bounded stream.
      // Cancellation never waits on a provider's possibly stalled cancel hook.
      const body = new ReadableStream<Uint8Array>({
        async pull(output) {
          try {
            signal.throwIfAborted();
            const next = await reader.read();
            if (next.done) {
              readers.delete(reader);
              output.close();
              return;
            }
            bytes += next.value.byteLength;
            totalBytes += next.value.byteLength;
            if (bytes > MAX_RESPONSE_BYTES || totalBytes > MAX_TOTAL_BYTES)
              throw new SubnetMcpError(
                "response_too_large",
                "The upstream MCP response exceeds the byte budget.",
              );
            if (next.value.byteLength === 0 && ++emptyChunks % 128 === 0)
              await new Promise<void>((resolve) => setTimeout(resolve, 0));
            output.enqueue(next.value);
          } catch (error) {
            readers.delete(reader);
            void reader.cancel().catch(() => {});
            output.error(error);
          }
        },
        cancel() {
          readers.delete(reader);
          void reader.cancel().catch(() => {});
        },
      });
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }
  };
  const transport = new StreamableHTTPClientTransport(endpoint, {
    fetch: checkedFetch,
  });
  const timeout = new SubnetMcpError(
    "timeout",
    "The upstream MCP invocation exceeded its deadline.",
  );
  let timer: ReturnType<typeof setTimeout>;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort(timeout);
      reject(timeout);
    }, options.timeoutMs);
  });
  const requestOptions = {
    signal: controller.signal,
    timeout: options.timeoutMs + 1_000,
  };
  const execute = async (): Promise<SubnetMcpResult> => {
    await client.connect(transport, requestOptions);
    let cursor: string | undefined;
    const cursors = new Set<string>();
    const names = new Set<string>();
    const tools: (Tool & { access: "read" | "write" })[] = [];
    do {
      const page = await client.listTools(
        cursor ? { cursor } : undefined,
        requestOptions,
      );
      for (const tool of page.tools) {
        if (names.has(tool.name) || names.size === MAX_TOOLS)
          throw new SubnetMcpError(
            "invalid_catalog",
            "The upstream MCP catalog repeats a tool or exceeds its limit.",
          );
        names.add(tool.name);
        const access = allowed.get(tool.name);
        if (access) tools.push({ ...tool, access });
        if (operation.kind !== "discover" && tool.name === operation.name) {
          const checked = validator.getValidator(tool.inputSchema)(
            operation.arguments,
          );
          if (!checked.valid)
            throw new SubnetMcpError(
              "invalid_params",
              "Arguments do not match the upstream MCP tool schema.",
            );
          // listTools caches this page's output schemas inside the SDK. Call
          // before another page replaces that cache, retaining SDK validation.
          const result = await client.callTool(
            { name: tool.name, arguments: operation.arguments },
            CallToolResultSchema,
            requestOptions,
          );
          // The SDK's inferred type also includes its legacy toolResult schema;
          // the explicit modern schema above already validates native content.
          return { kind: "call", result: result as CallToolResult };
        }
      }
      cursor = page.nextCursor;
      if (cursor) {
        if (cursors.has(cursor))
          throw new SubnetMcpError(
            "invalid_catalog",
            "The upstream MCP catalog repeats a cursor.",
          );
        cursors.add(cursor);
      }
    } while (cursor);
    if (operation.kind !== "discover")
      throw new SubnetMcpError(
        "not_found",
        "The admitted tool is absent from the upstream MCP catalog.",
      );
    return { kind: "discover", tools };
  };
  try {
    return await Promise.race([execute(), expired]);
  } catch (error) {
    if (controller.signal.reason === timeout) throw timeout;
    if (error instanceof SubnetMcpError) throw error;
    throw new SubnetMcpError(
      "upstream_mcp_error",
      redactCredentialValue(String(error), credential),
    );
  } finally {
    clearTimeout(timer!);
    phase = "cleanup";
    controller.abort();
    for (const reader of readers) void reader.cancel().catch(() => {});
    // Session deletion is best effort and bounded even when fetch ignores its
    // signal. Closing the SDK clears any SSE reconnection timer afterwards.
    let cleanupTimer: ReturnType<typeof setTimeout>;
    await Promise.race([
      transport.terminateSession().catch(() => {}),
      new Promise<void>((resolve) => {
        cleanupTimer = setTimeout(resolve, 250);
      }),
    ]);
    clearTimeout(cleanupTimer!);
    phase = "closed";
    await client.close();
  }
}
