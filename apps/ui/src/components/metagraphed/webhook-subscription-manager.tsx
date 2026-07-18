import { useState, type FormEvent, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiFetch, ApiError } from "@/lib/metagraphed/client";
import { classNames } from "@/lib/metagraphed/format";
import { CopyableCode, SectionHeading } from "@jsonbored/ui-kit";
import { EmptyState, Skeleton } from "@/components/metagraphed/states";
import type {
  WebhookDeliveryStatus,
  WebhookSubscriptionCreated,
  WebhookSubscriptionFilters,
  WebhookSubscriptionView,
} from "@/lib/metagraphed/types";

// Must match src/webhooks.mjs — WEBHOOK_SUBSCRIPTION_TOKEN_HEADER / WEBHOOK_SECRET_HEADER.
const SUBSCRIPTION_TOKEN_HEADER = "x-metagraph-webhook-subscription-token";
const SUBSCRIPTION_SECRET_HEADER = "x-metagraph-webhook-secret";

const CHANGE_KINDS = ["subnets", "artifacts"] as const;

const inputCls =
  "w-full rounded border border-border bg-card px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-muted focus:outline-none focus:border-ink/30";

/** Comma-separated netuids -> integers, or an error describing the offending token. Empty input is valid (no filter). */
export function parseNetuidsInput(
  raw: string,
): { ok: true; value: number[] } | { ok: false; error: string } {
  const netuids: number[] = [];
  for (const part of raw.split(",")) {
    const token = part.trim();
    if (!token) continue;
    if (!/^\d+$/.test(token)) {
      return { ok: false, error: `"${token}" is not a valid netuid` };
    }
    netuids.push(Number(token));
  }
  return { ok: true, value: netuids };
}

/**
 * Optional webhook secret (#6581): an empty value is valid — the server
 * auto-generates one — but a value the user actually types must be 16–256
 * characters, matching the field hint and the server-side bound. Validated on
 * the trimmed value, mirroring what `onSubmit` sends.
 */
export function validateSecretInput(raw: string): { ok: true } | { ok: false; error: string } {
  const secret = raw.trim();
  if (secret === "") return { ok: true };
  if (secret.length < 16 || secret.length > 256) {
    return {
      ok: false,
      error: `Secret must be 16–256 characters when set (currently ${secret.length}).`,
    };
  }
  return { ok: true };
}

/** Distinguishes a 401/503 create rejection, a 404 lookup, and a 403 secret-mismatch delete. */
function describeApiError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "Unauthorized — check your subscription token.";
    if (error.status === 503)
      return error.message || "Webhook subscriptions are disabled on this deployment.";
    if (error.status === 403) return "Secret mismatch — the subscription secret doesn't match.";
    if (error.status === 404) return "No subscription found with that id.";
    return error.message || "Request failed.";
  }
  return "Request failed.";
}

export function WebhookSubscriptionManager() {
  return (
    <div className="space-y-8">
      <CreateSubscriptionSection />
      <LookupSubscriptionSection />
      <DeleteSubscriptionSection />
    </div>
  );
}

interface CreateVariables {
  url: string;
  token: string;
  netuids: number[];
  kinds: string[];
  secret: string;
}

function CreateSubscriptionSection() {
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [netuidsRaw, setNetuidsRaw] = useState("");
  const [netuidsError, setNetuidsError] = useState<string | null>(null);
  const [kinds, setKinds] = useState<Set<string>>(new Set());
  const [secret, setSecret] = useState("");
  const [secretError, setSecretError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async (vars: CreateVariables): Promise<WebhookSubscriptionCreated> => {
      const filters: WebhookSubscriptionFilters = {};
      if (vars.netuids.length > 0) filters.netuids = vars.netuids;
      if (vars.kinds.length > 0) {
        filters.kinds = vars.kinds as WebhookSubscriptionFilters["kinds"];
      }
      const res = await apiFetch<WebhookSubscriptionCreated>("/api/v1/webhooks/subscriptions", {
        init: {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [SUBSCRIPTION_TOKEN_HEADER]: vars.token,
          },
          body: JSON.stringify({
            url: vars.url,
            filters,
            ...(vars.secret ? { secret: vars.secret } : {}),
          }),
        },
      });
      return res.data;
    },
  });

  function toggleKind(kind: string) {
    setKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const parsed = parseNetuidsInput(netuidsRaw);
    if (!parsed.ok) {
      setNetuidsError(parsed.error);
      return;
    }
    setNetuidsError(null);
    const secretCheck = validateSecretInput(secret);
    if (!secretCheck.ok) {
      setSecretError(secretCheck.error);
      return;
    }
    setSecretError(null);
    mutation.mutate({
      url: url.trim(),
      token: token.trim(),
      netuids: parsed.value,
      kinds: Array.from(kinds),
      secret: secret.trim(),
    });
  }

  const result = mutation.data;

  return (
    <section aria-labelledby="create-subscription-heading">
      <SectionHeading
        id="create-subscription-heading"
        title="Create subscription"
        intro="Register a URL to receive change-feed webhooks. Creation requires a subscription token issued by a metagraphed operator — this app never bundles one."
      />
      <form onSubmit={onSubmit} className="space-y-3 rounded border border-border bg-card p-4">
        <Field label="Webhook URL" required>
          <input
            type="url"
            required
            placeholder="https://hooks.example.com/mg"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className={inputCls}
          />
        </Field>
        <Field
          label="Subscription token"
          required
          hint="Provided out-of-band by a metagraphed operator."
        >
          <input
            type="password"
            required
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            className={inputCls}
          />
        </Field>
        <Field
          label="Netuids filter"
          hint="Comma-separated, optional — leave blank to receive all subnets."
        >
          <input
            type="text"
            inputMode="numeric"
            placeholder="7, 43"
            value={netuidsRaw}
            onChange={(e) => {
              setNetuidsRaw(e.target.value);
              setNetuidsError(null);
            }}
            className={inputCls}
          />
          {netuidsError ? (
            <p className="mt-1 text-[11px] text-health-down">{netuidsError}</p>
          ) : null}
        </Field>
        <Field label="Kinds filter" hint="Optional — leave unchecked to receive all change kinds.">
          <div className="flex gap-4">
            {CHANGE_KINDS.map((kind) => (
              <label key={kind} className="inline-flex items-center gap-1.5 text-[12px] text-ink">
                <input
                  type="checkbox"
                  checked={kinds.has(kind)}
                  onChange={() => toggleKind(kind)}
                />
                {kind}
              </label>
            ))}
          </div>
        </Field>
        <Field label="Secret" hint="Optional, 16–256 characters — auto-generated if left blank.">
          <input
            type="password"
            autoComplete="off"
            value={secret}
            onChange={(e) => {
              setSecret(e.target.value);
              setSecretError(null);
            }}
            className={inputCls}
          />
          {secretError ? <p className="mt-1 text-[11px] text-health-down">{secretError}</p> : null}
        </Field>
        <button
          type="submit"
          disabled={mutation.isPending}
          className="inline-flex items-center gap-1.5 rounded border border-accent/40 bg-primary-soft px-3 py-1.5 text-[12px] font-medium text-ink-strong hover:bg-primary-soft/80 disabled:opacity-50"
        >
          {mutation.isPending ? "Creating…" : "Create subscription"}
        </button>
      </form>

      {mutation.isPending ? <Skeleton className="mt-3 h-24 w-full" /> : null}

      {mutation.isError ? <ErrorPanel message={describeApiError(mutation.error)} /> : null}

      {result ? (
        <div className="mt-3 space-y-3 rounded border border-accent/40 bg-primary-soft/40 p-4">
          <p className="text-[12px] font-medium text-health-warn">
            The secret below is shown once and is never echoed back by GET — store it now.
          </p>
          <CopyableCode label="id" value={result.id} truncate={false} className="w-full" />
          <CopyableCode label="secret" value={result.secret} truncate={false} className="w-full" />
          <div className="space-y-1 text-[11px] text-ink-muted">
            <p>
              Deliveries are signed {result.delivery.signature_algorithm} over the raw request body,
              keyed by the secret above.
            </p>
            <p>
              Signature header <code className="text-ink">{result.delivery.signature_header}</code>{" "}
              · idempotency header{" "}
              <code className="text-ink">{result.delivery.idempotency_header}</code> (dedupe
              at-least-once retries)
            </p>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function LookupSubscriptionSection() {
  const [id, setId] = useState("");

  const mutation = useMutation({
    mutationFn: async (subscriptionId: string): Promise<WebhookSubscriptionView> => {
      const res = await apiFetch<WebhookSubscriptionView>(
        `/api/v1/webhooks/subscriptions/${encodeURIComponent(subscriptionId)}`,
      );
      return res.data;
    },
  });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = id.trim();
    if (!trimmed) return;
    mutation.mutate(trimmed);
  }

  const result = mutation.data;

  return (
    <section aria-labelledby="lookup-subscription-heading">
      <SectionHeading
        id="lookup-subscription-heading"
        title="Look up subscription"
        intro="Check a subscription's status and delivery health by id."
      />
      <form
        onSubmit={onSubmit}
        className="flex flex-wrap items-end gap-2 rounded border border-border bg-card p-4"
      >
        <Field label="Subscription id" required className="min-w-[280px] flex-1">
          <input
            type="text"
            required
            placeholder="00000000-0000-0000-0000-000000000000"
            value={id}
            onChange={(e) => setId(e.target.value)}
            className={inputCls}
          />
        </Field>
        <button
          type="submit"
          disabled={mutation.isPending}
          className="inline-flex items-center gap-1.5 rounded border border-border bg-card px-3 py-1.5 text-[12px] font-medium text-ink-muted hover:text-ink-strong hover:border-ink/30 disabled:opacity-50"
        >
          {mutation.isPending ? "Looking up…" : "Look up"}
        </button>
      </form>

      {mutation.isPending ? <Skeleton className="mt-3 h-24 w-full" /> : null}

      {mutation.isError ? <ErrorPanel message={describeApiError(mutation.error)} /> : null}

      {!mutation.isPending && !mutation.isError && !result ? (
        <EmptyState
          title="No subscription looked up yet"
          description="Enter a subscription id above to see its status and delivery health."
        />
      ) : null}

      {result ? (
        <div className="mt-3 space-y-3 rounded border border-border bg-card p-4">
          <div className="flex flex-wrap items-center gap-2">
            <DeliveryStatusPill status={result.delivery.status} />
            <span
              className={classNames(
                "font-mono text-[11px]",
                result.active ? "text-health-ok" : "text-ink-muted",
              )}
            >
              {result.active ? "active" : "inactive"}
            </span>
          </div>
          <dl className="grid gap-2 text-[12px]">
            <Row label="URL" value={result.url} />
            <Row label="Created" value={result.created_at ?? "—"} />
            <Row
              label="Netuids"
              value={result.filters.netuids?.length ? result.filters.netuids.join(", ") : "all"}
            />
            <Row
              label="Kinds"
              value={result.filters.kinds?.length ? result.filters.kinds.join(", ") : "all"}
            />
            <Row label="Pending deliveries" value={String(result.delivery.pending)} />
            <Row label="Dead-lettered" value={String(result.delivery.dead_letter)} />
          </dl>
          {result.delivery.last_failure ? (
            <div className="rounded border border-health-warn/30 bg-health-warn/5 p-2 text-[11px] text-ink-muted">
              Last failure: {result.delivery.last_failure.reason ?? "unknown"}
              {result.delivery.last_failure.status_code
                ? ` (HTTP ${result.delivery.last_failure.status_code})`
                : ""}{" "}
              after {result.delivery.last_failure.attempts ?? "?"} attempt(s).
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function DeleteSubscriptionSection() {
  const [id, setId] = useState("");
  const [secret, setSecret] = useState("");

  const mutation = useMutation({
    mutationFn: async (vars: {
      id: string;
      secret: string;
    }): Promise<{ id: string; deleted: boolean }> => {
      const res = await apiFetch<{ id: string; deleted: boolean }>(
        `/api/v1/webhooks/subscriptions/${encodeURIComponent(vars.id)}`,
        {
          init: {
            method: "DELETE",
            headers: { [SUBSCRIPTION_SECRET_HEADER]: vars.secret },
          },
        },
      );
      return res.data;
    },
  });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmedId = id.trim();
    const trimmedSecret = secret.trim();
    if (!trimmedId || !trimmedSecret) return;
    mutation.mutate({ id: trimmedId, secret: trimmedSecret });
  }

  return (
    <section aria-labelledby="delete-subscription-heading">
      <SectionHeading
        id="delete-subscription-heading"
        title="Delete subscription"
        intro="Requires the one-time secret returned when the subscription was created."
      />
      <form onSubmit={onSubmit} className="space-y-3 rounded border border-border bg-card p-4">
        <Field label="Subscription id" required>
          <input
            type="text"
            required
            value={id}
            onChange={(e) => setId(e.target.value)}
            className={inputCls}
          />
        </Field>
        <Field label="Secret" required>
          <input
            type="password"
            required
            autoComplete="off"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            className={inputCls}
          />
        </Field>
        <button
          type="submit"
          disabled={mutation.isPending}
          className="inline-flex items-center gap-1.5 rounded border border-health-down/40 bg-health-down/5 px-3 py-1.5 text-[12px] font-medium text-health-down hover:bg-health-down/10 disabled:opacity-50"
        >
          {mutation.isPending ? "Deleting…" : "Delete subscription"}
        </button>
      </form>

      {mutation.isPending ? <Skeleton className="mt-3 h-10 w-full" /> : null}

      {mutation.isError ? <ErrorPanel message={describeApiError(mutation.error)} /> : null}

      {mutation.data?.deleted ? (
        <div
          role="status"
          className="mt-3 rounded border border-health-ok/30 bg-health-ok/5 p-3 text-[12px] text-health-ok"
        >
          Subscription {mutation.data.id} deleted.
        </div>
      ) : null}
    </section>
  );
}

const DELIVERY_TONE: Record<WebhookDeliveryStatus["status"], string> = {
  ok: "text-health-ok border-health-ok/30 bg-health-ok/10",
  retrying: "text-health-warn border-health-warn/30 bg-health-warn/10",
  dead_letter: "text-health-down border-health-down/30 bg-health-down/10",
};

const DELIVERY_LABEL: Record<WebhookDeliveryStatus["status"], string> = {
  ok: "OK",
  retrying: "Retrying",
  dead_letter: "Dead-lettered",
};

function DeliveryStatusPill({ status }: { status: WebhookDeliveryStatus["status"] }) {
  return (
    <span
      className={classNames(
        "inline-flex items-center rounded border px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest",
        DELIVERY_TONE[status],
      )}
    >
      {DELIVERY_LABEL[status]}
    </span>
  );
}

function ErrorPanel({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="mt-3 rounded border border-health-down/30 bg-health-down/5 p-3 text-[12px] text-health-down"
    >
      {message}
    </div>
  );
}

function Field({
  label,
  hint,
  required,
  className,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={classNames("block", className)}>
      <span className="mb-1 block font-mono text-[10px] uppercase tracking-widest text-ink-muted">
        {label}
        {required ? <span className="text-health-down"> *</span> : null}
      </span>
      {children}
      {hint ? <span className="mt-1 block text-[11px] text-ink-muted">{hint}</span> : null}
    </label>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[auto_1fr] gap-3">
      <dt className="whitespace-nowrap font-mono text-[10px] uppercase tracking-widest text-ink-muted">
        {label}
      </dt>
      <dd className="min-w-0 truncate text-ink">{value}</dd>
    </div>
  );
}
