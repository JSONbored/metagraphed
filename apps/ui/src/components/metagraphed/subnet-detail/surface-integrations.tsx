import { useState } from "react";
import { CopyButton, DataTable, FilterSelect, type DataTableColumn } from "@jsonbored/ui-kit";
import { McpSurfaceAdmissionSchema } from "../../../../../../schemas-src/subnet-mcp-admission.ts";
import {
  HttpSurfaceAdmissionSchema,
  type HttpSurfaceAdmission,
} from "../../../../../../schemas-src/subnet-http-admission.ts";
import type { Surface } from "@/lib/metagraphed/types";

type Operation = {
  kind: string;
  identifier: string;
  tool: string;
  arguments: Record<string, unknown>;
  body_types?: string[];
  parameters?: HttpSurfaceAdmission["operations"][number]["parameters"];
  base_arguments?: Record<string, unknown>;
  body_options?: { media?: string; body: Record<string, unknown> }[];
};

function CallTemplate({ row }: { row: Operation }) {
  const [format, setFormat] = useState<string>();
  const selected =
    row.body_options?.find((option) => option.media === format) ?? row.body_options?.[0];
  const arguments_ = selected ? { ...row.base_arguments, ...selected.body } : row.arguments;
  return (
    <div className="flex min-w-0 items-center gap-1">
      {row.body_options && row.body_options.length > 1 ? (
        <FilterSelect
          aria-label={`Request format ${row.kind} ${row.identifier}`}
          className="h-11 min-w-0 flex-1"
          value={selected?.media ?? ""}
          onChange={(event) => setFormat(event.target.value)}
        >
          {row.body_options.map((option) => (
            <option key={option.media ?? ""} value={option.media ?? ""}>
              {option.media ?? "No body"}
            </option>
          ))}
        </FilterSelect>
      ) : null}
      <CopyButton
        key={selected?.media ?? ""}
        compact
        label={`${row.kind} ${row.identifier} call template`}
        value={JSON.stringify({ name: row.tool, arguments: arguments_ })}
      />
    </div>
  );
}

const COLUMNS: DataTableColumn<Operation>[] = [
  { key: "kind", label: "Operation", value: (row) => row.kind },
  { key: "identifier", label: "Name / path", value: (row) => row.identifier, wrap: true },
  { key: "tool", label: "MCP tool", value: (row) => row.tool, wrap: true },
  {
    key: "body",
    label: "HTTP body",
    value: (row) => row.body_types?.join(", ") ?? "—",
    wrap: true,
  },
  {
    key: "parameters",
    label: "Optional parameters",
    value: (row) => row.parameters?.map((parameter) => `${parameter.in}: ${parameter.name}`).join(", ") || "—",
    wrap: true,
  },
  {
    key: "copy",
    label: "Call template",
    value: (row) => JSON.stringify({ name: row.tool, arguments: row.arguments }),
    render: (row) => <CallTemplate row={row} />,
  },
];

/** Fill-in templates never infer provider fields or encode a multipart file. */
function bodyTemplate(content_type: string): Record<string, unknown> {
  const essence = content_type.split(";", 1)[0]!.trim().toLowerCase();
  if (essence.includes("*"))
    return {
      content_type: "<replace with a concrete declared content type>",
      body_base64: "<canonical base64 of the exact request bytes>",
    };
  if (essence === "application/json" || essence.endsWith("+json"))
    return {
      json_body: {},
      ...(content_type === "application/json" ? {} : { content_type }),
    };
  if (
    essence.startsWith("text/") ||
    essence === "application/xml" ||
    essence.endsWith("+xml") ||
    essence === "application/x-www-form-urlencoded"
  )
    return { content_type, body: "<replace with the provider's encoded request body>" };
  return {
    content_type:
      essence === "multipart/form-data" && !content_type.includes(";")
        ? `${content_type}; boundary=REPLACE_WITH_YOUR_BOUNDARY`
        : content_type,
    body_base64:
      essence === "multipart/form-data"
        ? "<canonical base64 of the complete multipart body with the matching boundary>"
        : "<canonical base64 of the exact request bytes>",
  };
}

function requestBodyOptions(operation: HttpSurfaceAdmission["operations"][number]) {
  if (!["POST", "PUT", "PATCH"].includes(operation.method) || !operation.request_content_types)
    return [];
  const declared = [...new Set(operation.request_content_types)];
  const preferred = declared.includes("application/json")
    ? "application/json"
    : (declared.find((type) => {
        const essence = type.split(";", 1)[0]!.trim().toLowerCase();
        return essence === "application/json" || essence.endsWith("+json");
      }) ?? declared[0]!);
  return [preferred, ...declared.filter((type) => type !== preferred)].map((media) => ({
    media,
    body: bodyTemplate(media),
  }));
}

/** Canonical admission validation runs only after this deferred view is opened. */
export function surfaceIntegrationOperations(surface: Surface): Operation[] {
  const mcp = McpSurfaceAdmissionSchema.safeParse(surface.mcp);
  const http = HttpSurfaceAdmissionSchema.safeParse(surface.http);
  const rows: Operation[] = [];
  const surface_id = surface.id;
  if (mcp.success) {
    for (const [kind, names, tool, argument] of [
      ["Read tool", mcp.data.read_tools, "read_subnet_mcp", "tool_name"],
      ["Write tool", mcp.data.write_tools, "write_subnet_mcp", "tool_name"],
      ["Prompt", mcp.data.read_prompts ?? [], "get_subnet_mcp_prompt", "prompt_name"],
      ["Resource", mcp.data.read_resources ?? [], "read_subnet_mcp_resource", "resource_uri"],
    ] as const) {
      for (const name of names)
        rows.push({ kind, identifier: name, tool, arguments: { surface_id, [argument]: name } });
    }
  }
  if (http.success) {
    for (const operation of http.data.operations) {
      const options = requestBodyOptions(operation);
      const defaultBody = operation.request_body_required ? (options[0]?.body ?? {}) : {};
      const baseArguments = { surface_id, path: operation.path, method: operation.method };
      rows.push({
        kind: operation.method,
        identifier: operation.path,
        tool:
          operation.method === "GET" || operation.method === "HEAD"
            ? "call_subnet_surface"
            : "write_subnet_surface",
        body_types: operation.request_content_types,
        parameters: operation.parameters,
        arguments: { ...baseArguments, ...defaultBody },
        base_arguments: baseArguments,
        body_options: options.length
          ? [...(operation.request_body_required ? [] : [{ body: {} }]), ...options]
          : undefined,
      });
      const artifactOptions = options
        .filter((option) => Object.hasOwn(option.body, "body_base64"))
        .map(({ media, body }) => ({
          media,
          body: {
            content_type: body.content_type,
            body_artifact: {
              url: "<public raw.githubusercontent.com URL with a full 40-character commit>",
              sha256: "<lowercase SHA-256 of the complete request bytes>",
              bytes: "<exact complete request byte count, at most 10000000>",
            },
          },
        }));
      if (artifactOptions.length)
        rows.push({
          kind: `${operation.method} from artifact`,
          identifier: operation.path,
          tool: "write_subnet_surface",
          body_types: operation.request_content_types,
          parameters: operation.parameters,
          arguments: { ...baseArguments, ...artifactOptions[0]!.body },
          base_arguments: baseArguments,
          body_options: artifactOptions,
        });
    }
  }
  return rows;
}

export default function SurfaceIntegrations({ surfaces }: { surfaces: Surface[] }) {
  const entries = surfaces
    .map((surface) => {
      const operations = surfaceIntegrationOperations(surface);
      const hasMcp = operations.some(
        (operation) =>
          operation.tool !== "call_subnet_surface" && operation.tool !== "write_subnet_surface",
      );
      // Native operations exist only after canonical admission validation.
      const publicDiscovery =
        hasMcp &&
        (surface.mcp as { public_discovery?: unknown } | undefined)?.public_discovery === true;
      return { surface, operations, hasMcp, publicDiscovery };
    })
    .filter((entry) => entry.operations.length > 0);
  return (
    <div id="surface-integrations" className="space-y-4">
      <p className="text-13 text-ink-muted">
        Reviewed operations · use your own provider credentials when required. Tool and prompt
        arguments come from live MCP discovery; fill HTTP body fields from the provider schema and
        replace path placeholders. Templates with angle-bracket values need those values replaced;
        byte bodies use canonical base64, and multipart boundaries must match the encoded body.
        Set optional parameters with header_values, query_values or cookie_values when needed.
        Health and call permission are separate.
      </p>
      {entries.length === 0 ? (
        <p className="text-13 text-ink-muted">
          No valid reviewed operation declarations were returned.
        </p>
      ) : null}
      {entries.map(({ surface, operations, hasMcp, publicDiscovery }) => (
        <section
          key={surface.id}
          className="space-y-3"
          aria-label={`${surface.name ?? surface.id} integration`}
        >
          <div className="flex flex-wrap items-center gap-2 text-13">
            <span className="font-medium text-ink-strong">{surface.name ?? surface.id}</span>
            <span className="text-ink-muted">
              {surface.auth_required
                ? publicDiscovery
                  ? "Public discovery; caller authentication required for execution"
                  : "Caller authentication required"
                : "No declared authentication"}
            </span>
            {hasMcp ? (
              <CopyButton
                label={`${surface.name ?? surface.id} MCP discovery`}
                value={JSON.stringify({
                  name: "discover_subnet_mcp",
                  arguments: { surface_id: surface.id },
                })}
              />
            ) : null}
          </div>
          <DataTable
            rows={operations}
            columns={COLUMNS}
            rowKey={(row) => `${row.kind}:${row.identifier}`}
            caption={`${surface.name ?? surface.id} reviewed operations`}
            source={`surface-${surface.id}-integration`}
            pageSize={10}
            mobile="cards"
          />
        </section>
      ))}
    </div>
  );
}
