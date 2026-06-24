// Bulk CSV exports of the registry (subnets, surfaces, providers) + a manifest,
// for analysts and "state of the subnets" data drops who want the whole dataset
// in a spreadsheet-friendly format instead of paginating the JSON API. CSV is
// the format the API doesn't already offer; JSON/NDJSON consumers use the
// existing artifacts/API.
//
// Pure transformation (rows -> CSV strings): no I/O, so the caller writes the
// files and it stays unit-testable in isolation. Inputs are the already
// public-safe, already-redacted projections built upstream, so nothing
// credentialed leaks into the exports.

// RFC-4180: quote any field containing a comma, quote, or newline and double
// embedded quotes; coerce null/undefined to empty; join arrays. Prefix text
// cells that spreadsheet apps may interpret as formulas when opened from CSV.
const SPREADSHEET_FORMULA_PREFIX = /^[=+\-@\t\r\n]/;

export function csvValue(value) {
  if (value === null || value === undefined) {
    return "";
  }
  const text = Array.isArray(value)
    ? value.join("; ")
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);
  const safeText = SPREADSHEET_FORMULA_PREFIX.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safeText)
    ? `"${safeText.replace(/"/g, '""')}"`
    : safeText;
}

export function toCsv(columns, rows) {
  const header = columns.join(",");
  const body = rows.map((row) =>
    columns.map((column) => csvValue(row[column])).join(","),
  );
  return [header, ...body].join("\n") + "\n";
}

const SUBNET_COLUMNS = [
  "netuid",
  "slug",
  "name",
  "native_name",
  "status",
  "subnet_type",
  "lifecycle",
  "coverage_level",
  "curation_level",
  "surface_count",
  "probed_surface_count",
  "candidate_count",
  "gap_count",
  "participant_count",
  "mechanism_count",
  "tempo",
  "block",
  "registered_at_block",
  "source_repo",
  "website_url",
  "docs_url",
  "dashboard_url",
  "logo_url",
  "contact_present",
  "discord",
  "discord_url",
  "categories",
  "description",
];

const SURFACE_COLUMNS = [
  "id",
  "netuid",
  "subnet_slug",
  "subnet_name",
  "kind",
  "name",
  "provider",
  "authority",
  "url",
  "auth_required",
  "public_safe",
  "probe_status",
];

const PROVIDER_COLUMNS = [
  "id",
  "name",
  "kind",
  "authority",
  "github_url",
  "website_url",
];

function pick(row, columns) {
  const out = {};
  for (const column of columns) {
    out[column] = row[column] ?? null;
  }
  return out;
}

function surfaceRow(surface) {
  return {
    ...pick(
      surface,
      SURFACE_COLUMNS.filter((column) => column !== "probe_status"),
    ),
    probe_status: surface.probe?.status ?? null,
  };
}

const TABLES = [
  {
    id: "subnets",
    title: "Subnets",
    description:
      "Registry index: one row per subnet (identity + counts + links).",
    columns: SUBNET_COLUMNS,
    project: (data) => data.subnets.map((row) => pick(row, SUBNET_COLUMNS)),
  },
  {
    id: "surfaces",
    title: "Surfaces",
    description:
      "One row per public surface (API/docs/dashboard) across all subnets.",
    columns: SURFACE_COLUMNS,
    project: (data) => data.surfaces.map(surfaceRow),
  },
  {
    id: "providers",
    title: "Providers",
    description: "One row per provider/authority backing subnet surfaces.",
    columns: PROVIDER_COLUMNS,
    project: (data) => data.providers.map((row) => pick(row, PROVIDER_COLUMNS)),
  },
];

// Returns { files: [{ relativePath, contentType, body }], manifest }.
// relativePath is under "datasets/" (e.g. "datasets/subnets.csv").
export function buildDatasetExports({
  subnets,
  surfaces,
  providers,
  generatedAt,
  publishedAt = null,
  contractVersion,
  hashJson = null,
}) {
  const data = { subnets, surfaces, providers };
  const files = [];
  const datasets = [];

  for (const table of TABLES) {
    const rows = table.project(data);
    files.push({
      relativePath: `datasets/${table.id}.csv`,
      contentType: "text/csv; charset=utf-8",
      body: toCsv(table.columns, rows),
    });
    datasets.push({
      id: table.id,
      title: table.title,
      description: table.description,
      rows: rows.length,
      columns: table.columns,
      format: "csv",
      path: `/datasets/${table.id}.csv`,
    });
  }

  const contentFingerprint = {
    datasets,
    files: files.map(({ relativePath, contentType, body }) => ({
      relativePath,
      contentType,
      body,
    })),
  };

  return {
    files,
    manifest: {
      schema_version: 1,
      contract_version: contractVersion,
      // Real publish time + deterministic content fingerprint (issue #349);
      // generated_at stays the deterministic build stamp.
      generated_at: generatedAt,
      published_at: publishedAt,
      content_hash: hashJson ? hashJson(contentFingerprint) : null,
      dataset_count: datasets.length,
      datasets,
    },
  };
}
