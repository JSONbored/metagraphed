import { createHash } from "node:crypto";
import { z } from "zod";
import { boundedInternalJson, internalJson as reply } from "./internal-json.ts";
import { timingSafeEqual } from "./webhooks.ts";

const asset = z
  .object({
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z
      .number()
      .int()
      .min(1)
      .max(512 * 1024),
  })
  .strict();
const base = z.object({
  kind: z.literal("native-store"),
  partition: z.string().regex(/^[a-f0-9]$/),
});
const schema = z.discriminatedUnion("operation", [
  base
    .extend({
      operation: z.enum(["verify", "read-many"]),
      assets: z.array(asset).min(1).max(32),
    })
    .strict(),
  base
    .extend({
      operation: z.literal("read"),
      sha256: asset.shape.sha256,
      bytes: z
        .number()
        .int()
        .min(1)
        .max(24 * 1024 * 1024),
      manifest: z.literal(true).optional(),
    })
    .strict(),
]);

/** Publication control stays outside the data API's serving import graph. */
export async function handleNativeStoreExportRequest(
  request: Request,
  env: unknown,
): Promise<Response> {
  const secret = (env as { STATE_EXPORT_SECRET?: string } | null)
    ?.STATE_EXPORT_SECRET;
  if (!secret)
    return reply({ error: "native store export is not provisioned" }, 503);
  if (!timingSafeEqual(request.headers.get("x-state-export-token"), secret))
    return reply({ error: "invalid state export credential" }, 401);
  if (request.method !== "POST")
    return reply({ error: "native store export requires POST" }, 405);
  return handleNativeStoreExport(
    await boundedInternalJson(request, 8192).catch(() => null),
    env,
  );
}

/** Called only behind the export credential; all paths are content addresses. */
export async function handleNativeStoreExport(
  input: unknown,
  env: unknown,
): Promise<Response> {
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    return reply({ error: "invalid native store request" }, 400);
  const value = parsed.data;
  if (
    value.operation !== "read" &&
    (new Set(value.assets.map((a) => a.sha256)).size !== value.assets.length ||
      value.assets.reduce((n, a) => n + a.bytes, 0) > 8 * 1024 * 1024)
  )
    return reply({ error: "native store verification exceeds budget" }, 400);
  if (value.operation === "read" && !value.manifest && value.bytes > 512 * 1024)
    return reply({ error: "native store payload exceeds budget" }, 400);
  const binding = (env as Record<string, unknown> | null)?.[
    `NATIVE_HISTORY_ASSETS_${value.partition}`
  ] as Pick<Fetcher, "fetch"> | undefined;
  if (!binding || typeof binding.fetch !== "function")
    return reply({ error: "native store is not provisioned" }, 503);
  const signal = AbortSignal.timeout(30_000);

  async function read(
    sha256: string,
    bytes: number,
    manifest = false,
  ): Promise<ArrayBuffer> {
    const path = manifest
      ? `/__native_publisher__/${sha256}.json.gz`
      : `/${sha256}.mgpack`;
    const response = await binding!.fetch(
      new Request(`https://history-assets.invalid${path}`, {
        headers: { "accept-encoding": "identity" },
        // workerd supports manual/follow; status 200 below rejects redirects.
        redirect: "manual",
        signal,
      }),
    );
    const length = response.headers.get("content-length");
    if (
      response.status !== 200 ||
      !response.body ||
      (length !== null &&
        (!/^\d+$/.test(length) || Number(length) !== bytes)) ||
      (response.headers.get("content-encoding") ?? "identity") !== "identity"
    ) {
      await response.body?.cancel();
      throw new Error("Native store response differs");
    }
    const output = new Uint8Array(bytes),
      reader = response.body.getReader();
    let offset = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        if (offset + next.value.length > bytes)
          throw new Error("Native store response is oversized");
        output.set(next.value, offset);
        offset += next.value.length;
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    if (
      offset !== bytes ||
      createHash("sha256").update(output).digest("hex") !== sha256
    )
      throw new Error("Native store content identity differs");
    return output.buffer;
  }
  try {
    if (value.operation === "read") {
      const bytes = await read(value.sha256, value.bytes, value.manifest);
      return new Response(bytes, {
        headers: {
          "cache-control": "no-store",
          "content-type": "application/octet-stream",
          "content-length": String(bytes.byteLength),
          "x-content-sha256": value.sha256,
        },
      });
    }
    if (value.operation === "read-many") {
      const output = new Uint8Array(
        value.assets.reduce((n, entry) => n + entry.bytes, 0),
      );
      let offset = 0;
      for (let start = 0; start < value.assets.length; start += 4) {
        const batch = value.assets.slice(start, start + 4);
        const bytes = await Promise.all(
          batch.map((entry) => read(entry.sha256, entry.bytes)),
        );
        for (const part of bytes) {
          output.set(new Uint8Array(part), offset);
          offset += part.byteLength;
        }
      }
      return new Response(output, {
        headers: {
          "cache-control": "no-store",
          "content-type": "application/octet-stream",
          "content-length": String(output.length),
          "x-content-sha256": createHash("sha256").update(output).digest("hex"),
        },
      });
    }
    // Sequential reads keep memory to one bounded asset. Return small receipts,
    // avoiding a second transfer of the complete publication through the API.
    for (const entry of value.assets) await read(entry.sha256, entry.bytes);
    return reply({
      version: 1,
      partition: value.partition,
      verified: true,
      assets: value.assets,
    });
  } catch {
    return reply(
      { error: "native store content is unavailable or changed" },
      502,
    );
  }
}
