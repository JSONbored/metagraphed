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

// The backend (src/alert-triggers.mjs) validates `netuid` (0-65535) as an
// independently-sufficient match condition, so a netuid-only trigger fires on
// every matching chain event for that subnet. This mirrors WatchValidatorAlert
// (account-scoped) — same #4984 endpoint, create-token gate, and one-time
// owner-token result — but sends `netuid` instead of `account` (#6558).
// Mirror WatchValidatorAlert's proven kinds (the backend accepts any string but
// only these are known to occur); the netuid scope is what makes it subnet-wide.
const EVENT_KINDS = [
  { value: "", label: "Any event on this subnet" },
  { value: "DelegateAdded", label: "New delegation" },
  { value: "StakeAdded", label: "Stake added" },
] as const;

interface CreateVariables {
  token: string;
  eventKind: string;
  channel: Channel;
  destination: string;
}

/** "Watch this subnet": a netuid-scoped alert trigger over the existing #4984 alerts API. */
export function WatchSubnetAlert({ netuid }: { netuid: number }) {
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
            netuid,
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
      <p className="max-w-2xl text-[13px] text-ink-muted">
        Get a webhook or Discord notification for on-chain activity on SN{netuid}. Creation requires
        a trigger token issued by a metagraphed operator — this app never bundles one.
      </p>
      <form onSubmit={onSubmit} className="space-y-3 rounded border border-border bg-card p-4">
        <Field label="Event" hint="Leave as 'any' to watch every indexed event on this subnet.">
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
          className="inline-flex items-center gap-1.5 rounded border border-accent/40 bg-primary-soft px-3 py-1.5 text-[12px] font-medium text-ink-strong hover:bg-primary-soft/80 disabled:opacity-50"
        >
          {mutation.isPending ? "Creating…" : "Watch this subnet"}
        </button>
      </form>

      {mutation.isPending ? <Skeleton className="h-20 w-full" /> : null}

      {mutation.isError ? <ErrorPanel message={describeApiError(mutation.error)} /> : null}

      {result ? <CreatedTokenPanel id={result.id} ownerToken={result.owner_token} /> : null}
    </div>
  );
}
