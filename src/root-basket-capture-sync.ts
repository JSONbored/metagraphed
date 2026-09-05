import { RootBasketCaptureSchema } from "../schemas-src/root-basket-capture.ts";
import { createProducerStore, type ProducerStore } from "./producer-store.ts";
import { timingSafeEqual } from "./webhooks.ts";
import {
  rootBasketCaptureFits,
  writeRootBasketCapture,
} from "./root-basket-capture-write.ts";

// Matches adjacent protected sync request caps. This initial bounded receiver
// has not yet been sized against production captures; excess is rejected whole.
export const ROOT_BASKET_CAPTURE_MAX_BYTES = 8_000_000;
const TOKEN_HEADER = "x-root-basket-capture-sync-token";

interface SyncEnv {
  ROOT_BASKET_CAPTURE_SYNC_SECRET?: string;
  HYPERDRIVE?: { connectionString: string };
}

export async function handleRootBasketCaptureSync(
  request: Request,
  env: SyncEnv,
  deps: {
    store?: ProducerStore;
    now?: () => number;
    onError?: (error: unknown) => Promise<unknown>;
  } = {},
): Promise<Response> {
  const fail = (status: number, error: string) =>
    Response.json({ error }, { status });
  if (!env.ROOT_BASKET_CAPTURE_SYNC_SECRET)
    return fail(503, "root basket capture sync is not provisioned");
  if (
    !timingSafeEqual(
      request.headers.get(TOKEN_HEADER),
      env.ROOT_BASKET_CAPTURE_SYNC_SECRET,
    )
  ) {
    return fail(401, `provide a valid ${TOKEN_HEADER} header`);
  }
  const length = request.headers.get("content-length");
  if (
    length !== null &&
    (!/^\d+$/.test(length) || Number(length) > ROOT_BASKET_CAPTURE_MAX_BYTES)
  ) {
    return fail(413, "root basket capture body exceeds byte limit");
  }
  if (!request.body)
    return fail(400, "body must be a complete root basket capture");
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let text = "";
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > ROOT_BASKET_CAPTURE_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        return fail(413, "root basket capture body exceeds byte limit");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch {
    return fail(400, "root basket capture body could not be read");
  } finally {
    reader.releaseLock();
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return fail(400, "body must be JSON");
  }
  const parsed = RootBasketCaptureSchema.safeParse(body);
  if (!parsed.success)
    return fail(400, "body must be a complete root basket capture");
  if (!rootBasketCaptureFits(parsed.data))
    return fail(413, "root basket capture exceeds row limits");
  if (!deps.store && !env.HYPERDRIVE?.connectionString)
    return fail(503, "root basket capture store is unavailable");
  const store =
    deps.store ?? createProducerStore(env.HYPERDRIVE!.connectionString);
  try {
    const receipt = await writeRootBasketCapture(
      store,
      parsed.data,
      (deps.now ?? Date.now)(),
    );
    return Response.json({ ok: true, ...receipt });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("ROOT_BASKET_CAPTURE_CONFLICT:")
    ) {
      return fail(
        409,
        "root basket capture conflicts with an accepted observation",
      );
    }
    await deps.onError?.(error).catch(() => {});
    return fail(
      503,
      "root basket capture was not acknowledged; retry the same observation",
    );
  } finally {
    await store.close();
  }
}
