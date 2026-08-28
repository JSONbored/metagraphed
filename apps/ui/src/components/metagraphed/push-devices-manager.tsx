import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellRing, Loader2, Trash2 } from "lucide-react";
import { DataTable, type DataTableColumn } from "@jsonbored/ui-kit";
import { ErrorState } from "@/components/metagraphed/states";
import { apiFetch, ApiError } from "@/lib/metagraphed/client";
import {
  describeDevice,
  notificationPermission,
  pushUnavailableReason,
  subscribeToPush,
  unsubscribeLocally,
  type PushDevice,
} from "@/lib/metagraphed/push-subscription";

/** Build-time public VAPID key. Public by design (it is the `k=` value every
 * push request advertises); the PRIVATE half lives only in Worker secrets. */
const VAPID_PUBLIC_KEY = (import.meta.env?.VITE_VAPID_PUBLIC_KEY as string | undefined) || "";

/** Epoch ms (how these columns are stored) -> the ISO string TimeAgo takes. */
function toIso(ms: number | null | undefined): string | null {
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0
    ? new Date(ms).toISOString()
    : null;
}

function watchHeaders(token: string): Record<string, string> {
  return { "x-watch-trigger-token": token, "content-type": "application/json" };
}

/**
 * "Enable push on this device" + the device list (#8385 requirement 1).
 *
 * Rendered inside the Alert Center's already-verified panel, so the T6 watch
 * token is passed in rather than re-issued here.
 *
 * Permission is requested ONLY from the explicit button click below — never
 * on mount. An unprompted permission request on page load is the fastest way
 * to get a site permanently blocked by browser abuse heuristics, and it would
 * also ask before the user has any idea what they'd be agreeing to.
 */
export function PushDevicesManager({ token }: { token: string }) {
  const queryClient = useQueryClient();
  const queryKey = ["watch-push-subscriptions", token];
  const [error, setError] = useState<string | null>(null);

  const devicesQuery = useQuery({
    queryKey,
    queryFn: async (): Promise<{ devices: PushDevice[]; max: number }> => {
      const res = await apiFetch<{
        subscriptions: PushDevice[];
        max_devices: number;
      }>("/api/v1/watch/push-subscriptions", { init: { headers: watchHeaders(token) } });
      return { devices: res.data.subscriptions, max: res.data.max_devices };
    },
    retry: 0,
  });

  const subscribeMutation = useMutation({
    mutationFn: async () => {
      const payload = await subscribeToPush(VAPID_PUBLIC_KEY);
      const res = await apiFetch<{ subscription: PushDevice }>("/api/v1/watch/push-subscriptions", {
        init: { method: "POST", headers: watchHeaders(token), body: JSON.stringify(payload) },
      });
      return res.data.subscription;
    },
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey });
    },
    onError: (e: unknown) => {
      // A 409 is the device cap, which is expected and worth phrasing well
      // rather than surfacing as a raw status.
      if (e instanceof ApiError && e.status === 409) {
        setError("Device limit reached — remove a device below first.");
        return;
      }
      setError(e instanceof Error ? e.message : "Couldn't enable push on this device.");
    },
  });

  const removeMutation = useMutation({
    mutationFn: async (device: PushDevice) => {
      await apiFetch(`/api/v1/watch/push-subscriptions/${device.id}`, {
        init: { method: "DELETE", headers: watchHeaders(token) },
      });
      // Only after the server row is gone — that is what actually stops
      // delivery; the local teardown is housekeeping.
      await unsubscribeLocally(device.endpoint);
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey }),
    onError: (e: unknown) =>
      setError(e instanceof Error ? e.message : "Couldn't remove that device."),
  });

  const devices = devicesQuery.data?.devices ?? [];
  const max = devicesQuery.data?.max;
  const unsupported = pushUnavailableReason() !== null;
  const permission = notificationPermission();
  const atLimit = devicesQuery.isSuccess && max != null && devices.length >= max;
  const deviceCount = devicesQuery.isSuccess ? devices.length : "—";
  const deviceLimit = devicesQuery.isSuccess ? max : "—";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span
          className="text-13 text-ink-muted"
          aria-live="polite"
          aria-busy={devicesQuery.isPending || undefined}
          title={
            devicesQuery.isError ? "Push-device records are temporarily unavailable" : undefined
          }
        >
          Push devices · {deviceCount}/{deviceLimit}
        </span>
        <button
          type="button"
          onClick={() => subscribeMutation.mutate()}
          disabled={unsupported || atLimit || subscribeMutation.isPending || !VAPID_PUBLIC_KEY}
          className="inline-flex min-h-9 items-center gap-1.5 rounded border border-border bg-card px-2.5 py-1 text-13 font-medium text-ink-strong transition-colors hover:border-accent/40 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {subscribeMutation.isPending ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : (
            <BellRing className="size-3.5" aria-hidden />
          )}
          Enable push on this device
        </button>
      </div>

      {/* Say WHY the control is unavailable rather than hiding it silently —
          each of these has a different, actionable remedy. */}
      {unsupported ? (
        <p className="text-13 text-ink-muted">
          This browser doesn&apos;t support web push. On iPhone or iPad, add Metagraphed to your
          home screen first — iOS only delivers push to an installed app.
        </p>
      ) : !VAPID_PUBLIC_KEY ? (
        <p className="text-13 text-ink-muted">
          Push alerts aren&apos;t configured on this deployment yet.
        </p>
      ) : permission === "denied" ? (
        <p className="text-13 text-ink-muted">
          Notifications are blocked for this site. Re-enable them in your browser&apos;s site
          settings, then try again.
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="text-13 text-health-down">
          {error}
        </p>
      ) : null}

      <DataTable
        caption="Push devices"
        captionHidden
        rows={devices}
        columns={deviceColumns(removeMutation)}
        rowKey={(device) => device.id}
        source="push-devices"
        paginate={false}
        loading={devicesQuery.isPending}
        error={
          devicesQuery.isError ? (
            <ErrorState
              error={devicesQuery.error}
              onRetry={() => void devicesQuery.refetch()}
              context="push devices"
            />
          ) : undefined
        }
        empty={
          !devicesQuery.isPending && !devicesQuery.isError ? (
            <p className="text-13 text-ink-muted">
              No devices yet. Enable push to get alerts without a page open.
            </p>
          ) : undefined
        }
      />
    </div>
  );
}

/**
 * Three rows at most (the server caps the fleet), but the same table the rest
 * of /settings uses -- a hand-rolled list here would be the one place on the
 * page where a row of records is drawn differently.
 */
function deviceColumns(remove: {
  mutate: (device: PushDevice) => void;
  isPending: boolean;
}): DataTableColumn<PushDevice>[] {
  return [
    { key: "device", label: "Device", value: (d) => describeDevice(d.user_agent) },
    { key: "added", label: "Added", kind: "time", value: (d) => toIso(d.created_at) },
    { key: "last_alert", label: "Last alert", kind: "time", value: (d) => toIso(d.last_used_at) },
    {
      key: "remove",
      label: "",
      align: "right",
      render: (d) => (
        <button
          type="button"
          aria-label={`Remove ${describeDevice(d.user_agent)}`}
          onClick={() => remove.mutate(d)}
          disabled={remove.isPending}
          className="inline-flex items-center justify-center rounded border border-border bg-card p-1.5 text-ink-muted transition-colors hover:border-health-down/40 hover:text-health-down disabled:opacity-50"
        >
          <Trash2 className="size-3.5" aria-hidden />
        </button>
      ),
    },
  ];
}
