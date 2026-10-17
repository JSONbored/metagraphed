import type { ConsoleMessage, Frame, Page, Request, Response, TestInfo } from "@playwright/test";
import { createHash } from "node:crypto";
import { fromJSON } from "seroval";

const MAX_EVENTS = 200;
const HTML_CAP_BYTES = 600 * 1024;
const BINDING = "__mgNativeRuntimeDiagnostic";
const TOKEN = "__MG_NATIVE_DIAGNOSTIC_DOCUMENT__";
type Observation = Record<string, unknown>;

function loopbackOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

function publicSlugData(value: string | null): Observation {
  if (value === null) return { payload_present: false };
  if (value.length > 64 * 1024) return { payload_present: true, decode: "over-cap" };
  try {
    const input: unknown = fromJSON(JSON.parse(value));
    const data = input && typeof input === "object" ? Reflect.get(input, "data") : undefined;
    if (!Array.isArray(data))
      return {
        payload_present: true,
        decode: "ok",
        data_type: data === null ? "null" : typeof data,
      };
    return {
      payload_present: true,
      decode: "ok",
      data_type: "array",
      data_length: data.length,
      public_slugs:
        data.length <= 8 &&
        data.every((slug) => typeof slug === "string" && /^[A-Za-z0-9_.-]{0,100}$/.test(slug))
          ? data
          : undefined,
    };
  } catch (error) {
    return {
      payload_present: true,
      decode: "failed",
      error_type: error instanceof Error ? error.name.slice(0, 60) : typeof error,
    };
  }
}

function errorKind(message: string): string {
  if (/hydration|server rendered|Minified React error #(418|419|423|425)/i.test(message))
    return "hydration";
  if (/chunk|module script|dynamically imported|loading.*script/i.test(message))
    return "chunk-load";
  return "other";
}

/** Observation only: no routing, request interception, readiness wait or app-state changes. */
export async function startRuntimeDiagnostics(page: Page, baseURL: string | undefined) {
  const origin = loopbackOrigin(baseURL ?? "");
  if (!origin) throw new Error("Native runtime diagnostics require a loopback baseURL");
  const events: Observation[] = [];
  const pending = new Set<Promise<void>>();
  const started = Date.now();
  let dropped = 0;
  let closed = false;
  const add = (event: string, detail: Observation): Observation | undefined => {
    if (closed) return;
    if (events.length >= MAX_EVENTS) {
      dropped += 1;
      return;
    }
    const observation = { elapsed_ms: Date.now() - started, event, ...detail };
    events.push(observation);
    return observation;
  };
  const localURL = (value: string): URL | null => {
    try {
      const url = new URL(value);
      return url.origin === origin ? url : null;
    } catch {
      return null;
    }
  };
  const track = (operation: Promise<void>) => {
    const observed = operation.catch(() => {}).finally(() => pending.delete(observed));
    pending.add(observed);
  };
  const onRequest = (request: Request) => {
    const url = localURL(request.url());
    if (!url || (!request.isNavigationRequest() && !url.pathname.startsWith("/_serverFn/"))) return;
    const observation = add("request", {
      path: url.pathname.slice(0, 200),
      method: request.method(),
      resource_type: request.resourceType(),
      navigation: request.isNavigationRequest(),
      ...(url.pathname.startsWith("/_serverFn/") && request.method() === "GET"
        ? publicSlugData(url.searchParams.get("payload"))
        : {}),
    });
    if (observation)
      track(
        request.headerValue("x-tsr-serverfn").then(
          (value) => {
            observation.internal_header_present = value !== null;
            observation.internal_header_true = value === "true";
          },
          () => {
            observation.internal_header_read = "failed";
          },
        ),
      );
  };
  const onResponse = (response: Response) => {
    const url = localURL(response.url());
    if (
      !url ||
      (!response.request().isNavigationRequest() && !url.pathname.startsWith("/_serverFn/"))
    )
      return;
    const observation = add("response", {
      path: url.pathname.slice(0, 200),
      method: response.request().method(),
      navigation: response.request().isNavigationRequest(),
      status: response.status(),
    });
    if (observation)
      track(
        response.headerValue("content-type").then(
          (value) => {
            observation.content_type = value?.slice(0, 120) ?? null;
          },
          () => {
            observation.content_type_read = "failed";
          },
        ),
      );
  };
  const onRequestFailed = (request: Request) => {
    const url = localURL(request.url());
    if (!url) return;
    const reason = request.failure()?.errorText ?? "";
    add("request-failed", {
      path: url.pathname.slice(0, 200),
      resource_type: request.resourceType(),
      reason: /^net::ERR_[A-Z_]+$/.test(reason) ? reason : "request-failed",
    });
  };
  const onNavigation = (frame: Frame) => {
    if (frame !== page.mainFrame()) return;
    const url = localURL(frame.url());
    if (url) add("main-frame-navigation", { path: url.pathname.slice(0, 200) });
  };
  const onPageError = (error: Error) => {
    if (localURL(page.url()))
      add("page-error", { error_type: error.name.slice(0, 60), kind: errorKind(error.message) });
  };
  const onConsole = (message: ConsoleMessage) => {
    if (localURL(page.url()) && message.type() === "error")
      add("console-error", { kind: errorKind(message.text()) });
  };
  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("requestfailed", onRequestFailed);
  page.on("framenavigated", onNavigation);
  page.on("pageerror", onPageError);
  page.on("console", onConsole);
  await page.exposeBinding(BINDING, (source, value: unknown) => {
    if (source.frame !== page.mainFrame() || !localURL(source.frame.url())) return;
    if (!value || typeof value !== "object") return;
    const input = value as Observation;
    if (
      typeof input.kind !== "string" ||
      !/^(document-start|docs-pointerdown|docs-click|menu-pointerdown|menu-click|dialog-change|pagehide|pageshow)$/.test(
        input.kind,
      )
    )
      return;
    add("browser", {
      kind: input.kind,
      document_token: typeof input.token === "string" ? input.token.slice(0, 40) : null,
      path: typeof input.path === "string" ? input.path.slice(0, 200) : null,
      hydrated: input.hydrated === true,
      browser_count:
        typeof input.browser_count === "number" ? Math.min(input.browser_count, 60) : null,
      browser_cap_reached: input.browser_cap_reached === true,
      dialogs: typeof input.dialogs === "number" ? Math.min(input.dialogs, 100) : null,
      site_navigation: input.site_navigation === true,
      light_button: input.light_button === true,
    });
  });
  await page.addInitScript(
    ({ origin, binding, tokenKey }) => {
      if (location.origin !== origin || window !== window.top) return;
      const token = crypto.randomUUID();
      Reflect.set(window, tokenKey, token);
      let count = 0;
      let lastState = "";
      const snapshot = () => {
        const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')];
        const navigation = dialogs.find((dialog) => {
          const name =
            dialog.getAttribute("aria-label") ??
            (dialog.getAttribute("aria-labelledby") ?? "")
              .split(/\s+/)
              .map((id) => document.getElementById(id)?.textContent ?? "")
              .join(" ");
          return name.trim() === "Site navigation";
        });
        return {
          dialogs: dialogs.length,
          site_navigation: Boolean(navigation),
          light_button: [...(navigation?.querySelectorAll("button") ?? [])]
            .slice(0, 100)
            .some(
              (button) =>
                (button.getAttribute("aria-label") ?? button.textContent ?? "").trim() === "Light",
            ),
        };
      };
      const emit = (kind: string, state = snapshot()) => {
        if (count >= 60) return;
        count += 1;
        const send = Reflect.get(window, binding) as
          ((value: unknown) => Promise<void>) | undefined;
        if (typeof send !== "function") return;
        void send({
          kind,
          token,
          path: location.pathname,
          hydrated: Reflect.get(window, "__MG_HYDRATED__") === true,
          browser_count: count,
          browser_cap_reached: count === 60,
          ...state,
        }).catch(() => {});
      };
      emit("document-start");
      for (const type of ["pointerdown", "click"] as const) {
        document.addEventListener(
          type,
          (event) => {
            const target = event.target instanceof Element ? event.target : null;
            const anchor = target?.closest("footer a");
            if (
              anchor instanceof HTMLAnchorElement &&
              anchor.origin === origin &&
              anchor.pathname === "/docs"
            )
              emit(`docs-${type}`);
            if (target?.closest('button[aria-label="Open menu"]')) emit(`menu-${type}`);
          },
          true,
        );
      }
      new MutationObserver(() => {
        if (count >= 60) return;
        const state = snapshot();
        const serialized = JSON.stringify(state);
        if (serialized === lastState) return;
        lastState = serialized;
        emit("dialog-change", state);
      }).observe(document, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["role", "aria-label", "aria-labelledby", "aria-hidden", "data-state"],
      });
      window.addEventListener("pagehide", () => emit("pagehide"));
      window.addEventListener("pageshow", () => emit("pageshow"));
    },
    { origin, binding: BINDING, tokenKey: TOKEN },
  );
  return {
    async attach(testInfo: TestInfo) {
      page.off("request", onRequest);
      page.off("response", onResponse);
      page.off("requestfailed", onRequestFailed);
      page.off("framenavigated", onNavigation);
      page.off("pageerror", onPageError);
      page.off("console", onConsole);
      let timer: ReturnType<typeof setTimeout> | undefined;
      // afterEach has its own Playwright teardown budget, even after a test timeout.
      // Bound diagnostics independently; this changes no test/action timeout.
      await Promise.race([
        Promise.allSettled([...pending]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 1500);
        }),
      ]);
      clearTimeout(timer);
      const pendingAtAttach = pending.size;
      closed = true;
      await testInfo.attach("native-runtime-observations", {
        contentType: "application/json",
        body: JSON.stringify({
          version: 1,
          status: testInfo.status,
          retry: testInfo.retry,
          loopback_origin: origin,
          event_cap: MAX_EVENTS,
          browser_event_cap_per_document: 60,
          dropped_events: dropped,
          pending_header_reads: pendingAtAttach,
          events,
        }),
      });
    },
  };
}

/** Reuses exactly the response fetched by the unchanged HTML-ratchet test. */
export async function attachHtmlDiagnostics(
  testInfo: TestInfo,
  url: string,
  path: string,
  html: string,
) {
  const origin = loopbackOrigin(url);
  const expectedOrigin = loopbackOrigin(testInfo.project.use.baseURL ?? "");
  if ((path !== "/" && path !== "/subnets") || !origin || origin !== expectedOrigin) return;
  if (new URL(url).pathname !== path) return;
  const bytes = Buffer.from(html, "utf8");
  const captured = bytes.subarray(0, HTML_CAP_BYTES);
  const prefix = captured.toString("utf8");
  const scripts = [...prefix.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
  const scriptBytes = scripts.reduce((sum, match) => sum + Buffer.byteLength(match[0]), 0);
  const scriptSummary = scripts.slice(0, 40).map((match) => ({
    tag_bytes: Buffer.byteLength(match[0]),
    body_bytes: Buffer.byteLength(match[2]),
    external: /\bsrc\s*=/i.test(match[1]),
    // Hints identify candidate hydration scripts; they are not exact data ownership attribution.
    hydration_hint: /__TSR|__TSS|dehydrat|queryKey|queryHash/.test(match[2]),
  }));
  const name = path === "/" ? "home" : "subnets";
  await testInfo.attach(`native-${name}-html`, { contentType: "text/plain", body: captured });
  await testInfo.attach(`native-${name}-html-summary`, {
    contentType: "application/json",
    body: JSON.stringify({
      path,
      utf8_bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      captured_bytes: captured.length,
      capture_cap_bytes: HTML_CAP_BYTES,
      truncated: bytes.length > captured.length,
      script_count_in_capture: scripts.length,
      script_bytes_in_capture: scriptBytes,
      non_script_bytes_in_capture: captured.length - scriptBytes,
      script_summaries: scriptSummary,
      script_summaries_truncated: scripts.length > scriptSummary.length,
    }),
  });
}

// Scoped observations for two ordinary fixture cases. No waits, routing or app state changes.
const ordinaryFixtureDiagnostics = new WeakMap<
  Page,
  {
    runtime: Awaited<ReturnType<typeof startRuntimeDiagnostics>>;
    events: Observation[];
    record: (phase: string, detail?: Record<string, string | number | boolean>) => void;
    cleanup: () => void;
    dropped: () => number;
  }
>();

export async function startOrdinaryFixtureDiagnostics(page: Page, baseURL: string | undefined) {
  const runtime = await startRuntimeDiagnostics(page, baseURL);
  const origin = loopbackOrigin(baseURL ?? "");
  const events: Observation[] = [];
  const started = Date.now();
  let dropped = 0;
  let nextRequest = 0;
  const ids = new WeakMap<Request, number>();
  const add = (event: string, detail: Observation) => {
    if (events.length >= 200) {
      dropped += 1;
      return;
    }
    events.push({ elapsed_ms: Date.now() - started, event, ...detail });
  };
  add("observation-start", { started_at_utc: new Date(started).toISOString() });
  const selected = (request: Request, failed = false) => {
    const url = new URL(request.url());
    if (
      url.origin === origin &&
      url.pathname.startsWith("/assets/") &&
      url.pathname.endsWith(".js")
    )
      return failed || /\/settings-panel-[^/]+\.js$/.test(url.pathname) ? url : null;
    if (
      url.origin === "http://127.0.0.1:8081" &&
      ["/api/v1/providers/lium", "/api/v1/providers/lium/endpoints", "/api/v1/surfaces"].includes(
        url.pathname,
      )
    )
      return url;
    return null;
  };
  const observe = (event: string, request: Request, status?: number) => {
    const url = selected(request, event === "request-failed");
    if (!url) return;
    let id = ids.get(request);
    if (id === undefined) {
      id = ++nextRequest;
      ids.set(request, id);
    }
    const reason = request.failure()?.errorText ?? "";
    add(event, {
      request_id: id,
      path: url.pathname.slice(0, 200),
      method: request.method(),
      resource_type: request.resourceType(),
      navigation: request.isNavigationRequest(),
      status,
      ...(event === "request-failed"
        ? {
            reason: /^net::ERR_[A-Z_]+$/.test(reason) ? reason : "request-failed",
          }
        : {}),
    });
  };
  const onRequest = (request: Request) => observe("request", request);
  const onResponse = (response: Response) =>
    observe("response", response.request(), response.status());
  const onFinished = (request: Request) => observe("request-finished", request);
  const onFailed = (request: Request) => observe("request-failed", request);
  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("requestfinished", onFinished);
  page.on("requestfailed", onFailed);
  ordinaryFixtureDiagnostics.set(page, {
    runtime,
    events,
    record: (phase, detail = {}) => add("phase", { phase: phase.slice(0, 80), ...detail }),
    cleanup: () => {
      page.off("request", onRequest);
      page.off("response", onResponse);
      page.off("requestfinished", onFinished);
      page.off("requestfailed", onFailed);
    },
    dropped: () => dropped,
  });
}

export function recordOrdinaryFixturePhase(
  page: Page,
  phase: string,
  detail?: Record<string, string | number | boolean>,
) {
  ordinaryFixtureDiagnostics.get(page)?.record(phase, detail);
}

export async function attachOrdinaryFixtureDiagnostics(page: Page, testInfo: TestInfo) {
  const observations = ordinaryFixtureDiagnostics.get(page);
  if (!observations) return;
  observations.cleanup();
  try {
    await observations.runtime.attach(testInfo);
  } finally {
    await testInfo.attach("ordinary-fixture-observations", {
      contentType: "application/json",
      body: JSON.stringify({
        version: 1,
        status: testInfo.status,
        retry: testInfo.retry,
        event_cap: 200,
        dropped_events: observations.dropped(),
        events: observations.events,
      }),
    });
    ordinaryFixtureDiagnostics.delete(page);
  }
}
