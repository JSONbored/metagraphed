import { readFile } from "node:fs/promises";
import { stripJsonComments } from "../lib.ts";
import { d1AdminBatch, d1AdminCredentials } from "./d1-admin.ts";

export const CONTAINER_STATUS_PREFIX = "container-status/v1/";

export function parseContainerStatus(
  payload: unknown,
): Record<string, unknown> {
  if (typeof payload !== "string" || Buffer.byteLength(payload) > 65536)
    throw new Error("Container status is missing or exceeds 64 KiB");
  const body: unknown = JSON.parse(payload);
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new Error("Container status is not an object");
  return body as Record<string, unknown>;
}

/** Read the small status namespace once; failures never select legacy R2. */
export async function readContainerStatuses(transport: typeof fetch = fetch) {
  const config = JSON.parse(
    stripJsonComments(
      await readFile(new URL("../../wrangler.jsonc", import.meta.url), "utf8"),
    ),
  ) as { d1_databases: { binding: string; database_id: string }[] };
  const credentials = d1AdminCredentials({
    ...process.env,
    CLOUDFLARE_API_TOKEN:
      process.env.CLOUDFLARE_D1_API_TOKEN ?? process.env.CLOUDFLARE_API_TOKEN,
    CLOUDFLARE_D1_DATABASE_ID:
      process.env.CLOUDFLARE_D1_DATABASE_ID ??
      config.d1_databases.find((row) => row.binding === "D1_STATE")
        ?.database_id,
  });
  const [result] = await d1AdminBatch(
    [
      {
        sql:
          "SELECT key, CASE WHEN length(CAST(payload AS BLOB))<=65536 THEN payload ELSE NULL END AS payload " +
          "FROM generated_artifacts WHERE key>=? AND key<? LIMIT 65",
        params: [CONTAINER_STATUS_PREFIX, CONTAINER_STATUS_PREFIX + "\uffff"],
      },
    ],
    credentials,
    transport,
  );
  if (result.results.length > 64)
    throw new Error("Container status namespace exceeds its bound");
  const statuses = new Map<string, Record<string, unknown>>();
  for (const row of result.results) {
    if (
      typeof row.key !== "string" ||
      !row.key.startsWith(CONTAINER_STATUS_PREFIX)
    )
      throw new Error("Invalid container status identity");
    statuses.set(
      row.key.slice(CONTAINER_STATUS_PREFIX.length),
      parseContainerStatus(row.payload),
    );
  }
  return statuses;
}
