// Notification payload shaping for the webpush alert channel (#8385).
//
// Split from web-push.ts (which is transport crypto) and from
// alert-delivery.ts (which builds HTTP requests for the text-ish channels):
// this is purely "what should the notification SAY and where should tapping
// it GO", so it stays testable without crypto or network.
//
// #8385 requirement 3, in order of preference for the title:
//   1. the action sentence (T5, #8371) when the payload carries one -- the
//      whole point of that epic was a human-readable line, so a notification
//      is exactly where it earns its keep;
//   2. otherwise the event kind ("StakeAdded"), which is at least specific;
//   3. otherwise a generic fallback, so a notification is never blank.
//
// The body is entity + relative time. Tapping deep-links to the entity page.
//
// SILENT PUSH IS PROHIBITED (#8385 requirement 3). Every push this app sends
// MUST result in a user-visible notification: browsers permit a `push`
// handler that shows nothing only briefly, then revoke the permission or
// surface a generic "site updated in background" notification on the user's
// behalf. The service worker therefore always calls showNotification(), and
// this builder always returns a renderable title/body -- there is no code
// path that produces an empty notification, by construction.

/** What the service worker receives, after decryption. Kept small and flat --
 * it must fit MAX_PAYLOAD_BYTES once JSON-encoded. */
export interface PushNotificationPayload {
  title: string;
  body: string;
  /** Same-origin path the notification opens on tap. */
  url: string;
  /** Correlates the notification with its delivery-history row. */
  tag: string;
}

const MAX_TITLE = 120;
const MAX_BODY = 180;

function clamp(value: string, max: number): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/**
 * Relative time, coarse on purpose. A notification arrives seconds after the
 * event, so minute precision is all that's meaningful, and a fixed vocabulary
 * keeps the body inside its byte budget regardless of age.
 */
export function relativeTime(
  observedAtMs: unknown,
  nowMs: number,
): string | null {
  const then = Number(observedAtMs);
  if (!Number.isFinite(then) || then <= 0) return null;
  const deltaSec = Math.round((nowMs - then) / 1000);
  if (deltaSec < 0) return "just now"; // clock skew: never say "in -3s"
  if (deltaSec < 60) return "just now";
  const min = Math.floor(deltaSec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

/**
 * The entity this event is about, as a display string + its deep link.
 *
 * Preference order mirrors how specific the link can be: a subnet is the
 * most navigable target we can always resolve from a firehose payload, then
 * an account, then the block. Falls back to the home page so a tap never
 * dead-ends on a 404.
 */
export function resolveEntityTarget(
  payload: Record<string, unknown> | null | undefined,
): {
  label: string;
  url: string;
} {
  const netuid = Number(payload?.netuid);
  if (Number.isFinite(netuid) && netuid >= 0) {
    return { label: `SN${netuid}`, url: `/subnets/${netuid}` };
  }
  const account =
    typeof payload?.hotkey === "string" && payload.hotkey
      ? payload.hotkey
      : typeof payload?.coldkey === "string" && payload.coldkey
        ? payload.coldkey
        : null;
  if (account) {
    const short =
      account.length > 12
        ? `${account.slice(0, 6)}…${account.slice(-6)}`
        : account;
    return { label: short, url: `/accounts/${account}` };
  }
  const block = Number(payload?.block_number);
  if (Number.isFinite(block) && block >= 0) {
    return { label: `block ${block}`, url: `/blocks/${block}` };
  }
  return { label: "Chain activity", url: "/" };
}

/**
 * Build the notification payload for one matched trigger.
 *
 * Always returns a renderable title and body — see the silent-push note in
 * this module's header for why that is a hard requirement rather than a
 * convenience.
 */
export function buildPushNotificationPayload(
  trigger: { id?: unknown; name?: unknown } | null | undefined,
  payload: Record<string, unknown> | null | undefined,
  nowMs: number,
): PushNotificationPayload {
  const sentence =
    typeof payload?.action_sentence === "string" &&
    payload.action_sentence.trim()
      ? payload.action_sentence
      : null;
  const kind =
    typeof payload?.event_kind === "string" && payload.event_kind.trim()
      ? payload.event_kind
      : null;
  const triggerName =
    typeof trigger?.name === "string" && trigger.name.trim()
      ? trigger.name
      : null;

  // Sentence first (T5), then the event kind, then a name that at least says
  // which of the user's own alerts fired, then a generic last resort.
  const title = clamp(
    sentence ?? kind ?? triggerName ?? "Chain alert",
    MAX_TITLE,
  );

  const entity = resolveEntityTarget(payload);
  const when = relativeTime(payload?.observed_at, nowMs);
  const bodyParts = [entity.label];
  if (when) bodyParts.push(when);
  // When the title came from the sentence, the alert's own name is useful
  // context in the body; when the title IS the name, repeating it is noise.
  if (triggerName && title !== triggerName)
    bodyParts.push(`alert: ${triggerName}`);

  return {
    title,
    body: clamp(bodyParts.join(" · "), MAX_BODY),
    url: entity.url,
    // Collapses repeat notifications for the same alert on the device rather
    // than stacking a wall of them.
    tag: `mg-alert-${trigger?.id ?? "unknown"}`,
  };
}
