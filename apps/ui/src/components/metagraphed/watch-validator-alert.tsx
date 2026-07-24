import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiFetch } from "@/lib/metagraphed/client";
import { Skeleton } from "@/components/metagraphed/states";
import type { AlertTriggerCreated } from "@/lib/metagraphed/types";
import {
  ChannelAndDestinationFields,
  CreatedTokenPanel,
  CREATE_TOKEN_HEADER,
  describeApiError,
  ErrorPanel,
  Field,
  inputCls,
  type Channel,
} from "@/components/metagraphed/watch-alert-form";

// #4984's event_kind is a single value per trigger (not a filter list), so
// this is a single-select rather than the webhook manager's checkbox-set
// "kinds" pattern. Leaving it unset still matches every event for this
// hotkey (validateAlertTriggerInput requires only one of
// netuid/event_kind/account/min_amount_tao — `account` below always
// satisfies that on its own).
const EVENT_KINDS = [
  { value: "", label: "Any delegation or stake event" },
  { value: "DelegateAdded", label: "New delegation" },
  { value: "StakeAdded", label: "Stake added" },
] as const;

interface CreateVariables {
  token: string;
  eventKind: string;
  channel: Channel;
  destination: string;
}

/** "Watch this validator": a scoped alert trigger (account=hotkey) over the existing #4984 alerts API. */
export function WatchValidatorAlert({ hotkey }: { hotkey: string }) {
  const [token, setToken] = useState("");
  const [eventKind, setEventKind] = useState("");
  const [channel, setChannel] = useState<Channel>("webhook");
  const [destination, setDestination] = useState("");

  const mutation = useMutation({
    mutationFn: async (vars: CreateVariables): Promise<AlertTriggerCreated> => {
      const res = await apiFetch<AlertTriggerCreated>("/api/v1/alerts/triggers", {
        init: {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [CREATE_TOKEN_HEADER]: vars.token,
          },
          body: JSON.stringify({
            account: hotkey,
            ...(vars.eventKind ? { event_kind: vars.eventKind } : {}),
            channel: vars.channel,
            destination: vars.destination,
          }),
        },
      });
      return res.data;
    },
  });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    mutation.mutate({
      token: token.trim(),
      eventKind,
      channel,
      destination: destination.trim(),
    });
  }

  const result = mutation.data;

  return (
    <div className="space-y-3">
      <p className="max-w-2xl mg-type-caption-lg text-ink-muted">
        Get a webhook or Discord notification when this validator receives new delegations or stake.
        Creation requires a trigger token issued by a metagraphed operator — this app never bundles
        one.
      </p>
      <form onSubmit={onSubmit} className="space-y-3 rounded border border-border bg-card p-4">
        <Field
          label="Event"
          hint="Leave as 'any' to watch every delegation/stake event for this hotkey."
        >
          <select
            value={eventKind}
            onChange={(e) => setEventKind(e.target.value)}
            className={inputCls}
          >
            {EVENT_KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </Field>
        <ChannelAndDestinationFields
          channel={channel}
          onChannelChange={setChannel}
          destination={destination}
          onDestinationChange={setDestination}
        />
        <Field
          label="Creation token"
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
        <button
          type="submit"
          disabled={mutation.isPending}
          className="inline-flex items-center gap-1.5 rounded border border-accent/40 bg-primary-soft px-3 py-1.5 mg-type-caption font-medium text-ink-strong hover:bg-primary-soft/80 disabled:opacity-50"
        >
          {mutation.isPending ? "Creating…" : "Watch this validator"}
        </button>
      </form>

      {mutation.isPending ? <Skeleton className="h-20 w-full" /> : null}

      {mutation.isError ? <ErrorPanel message={describeApiError(mutation.error)} /> : null}

      {result ? <CreatedTokenPanel id={result.id} ownerToken={result.owner_token} /> : null}
    </div>
  );
}
