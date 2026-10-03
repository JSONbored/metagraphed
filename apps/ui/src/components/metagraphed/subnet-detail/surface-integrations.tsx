import { CopyButton, DataTable, type DataTableColumn } from "@jsonbored/ui-kit";
import { McpSurfaceAdmissionSchema } from "../../../../../../schemas-src/subnet-mcp-admission.ts";
import { HttpSurfaceAdmissionSchema } from "../../../../../../schemas-src/subnet-http-admission.ts";
import type { Surface } from "@/lib/metagraphed/types";

type Operation = {
  kind: string;
  identifier: string;
  tool: string;
  arguments: Record<string, unknown>;
  body_types?: string[];
};

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
    key: "copy",
    label: "Call template",
    value: (row) => JSON.stringify({ name: row.tool, arguments: row.arguments }),
    render: (row) => (
      <CopyButton
        compact
        label={`${row.kind} ${row.identifier} call template`}
        value={JSON.stringify({ name: row.tool, arguments: row.arguments })}
      />
    ),
  },
];

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
      rows.push({
        kind: operation.method,
        identifier: operation.path,
        tool: operation.method === "GET" ? "call_subnet_surface" : "write_subnet_surface",
        body_types: operation.request_content_types,
        arguments: {
          surface_id,
          path: operation.path,
          method: operation.method,
          ...(operation.request_body_required &&
          operation.request_content_types?.includes("application/json")
            ? { json_body: {} }
            : {}),
        },
      });
    }
  }
  return rows;
}

export default function SurfaceIntegrations({ surfaces }: { surfaces: Surface[] }) {
  const entries = surfaces
    .map((surface) => ({ surface, operations: surfaceIntegrationOperations(surface) }))
    .filter((entry) => entry.operations.length > 0);
  return (
    <div id="surface-integrations" className="space-y-5">
      <p className="text-13 text-ink-muted">
        Reviewed operations · use your own provider credentials when required. Tool and prompt
        arguments come from live MCP discovery; fill HTTP body fields from the provider schema and
        replace path placeholders. Health and call permission are separate.
      </p>
      {entries.length === 0 ? (
        <p className="text-13 text-ink-muted">
          No valid reviewed operation declarations were returned.
        </p>
      ) : null}
      {entries.map(({ surface, operations }) => (
        <section
          key={surface.id}
          className="space-y-3"
          aria-label={`${surface.name ?? surface.id} integration`}
        >
          <div className="flex flex-wrap items-center gap-2 text-13">
            <span className="font-medium text-ink-strong">{surface.name ?? surface.id}</span>
            <span className="text-ink-muted">
              {surface.auth_required
                ? "Caller authentication required"
                : "No declared authentication"}
            </span>
            {operations.some(
              (operation) =>
                operation.tool !== "call_subnet_surface" &&
                operation.tool !== "write_subnet_surface",
            ) ? (
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
