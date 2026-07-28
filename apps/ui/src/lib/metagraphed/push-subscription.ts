// Browser-side Push API helpers for web-push alerts (#8385).
//
// Split from the React component so the fiddly parts -- key conversion,
// capability detection, and turning a live PushSubscription into the JSON the
// API expects -- are unit-testable without a DOM, a service worker, or a real
// push service. The component keeps only state and markup.
//
// Nothing here asks for notification permission on its own: permission is
// requested exactly once, from an explicit user click in the component. A
// permission prompt on page load is the single fastest way to get a site
// permanently blocked by a browser's abuse heuristics.

/** The device-metadata shape the API returns for the "your devices" list. */
export interface PushDevice {
  id: string;
  endpoint: string;
  user_agent: string | null;
  created_at: number | null;
  last_used_at: number | null;
}

/** What POST /api/v1/watch/push-subscriptions accepts. */
export interface PushSubscriptionPayload {
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent?: string;
}

/**
 * VAPID public keys travel as base64url text but `pushManager.subscribe`
 * wants raw bytes. Standard-but-easy-to-get-wrong conversion, so it lives
 * here with its own test rather than inline in a component.
 */
export function vapidKeyToBytes(base64Url: string): Uint8Array {
  const padded = base64Url.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** Encode an ArrayBuffer key from the browser as the base64url the API wants. */
export function bufferToBase64Url(buffer: ArrayBuffer | null): string {
  if (!buffer) return "";
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Why push isn't available here, or null when it is.
 *
 * Returns a REASON rather than a boolean so the UI can say something true and
 * actionable ("open the installed app", "your browser doesn't support this")
 * instead of hiding the control with no explanation. iOS in particular only
 * grants push to a home-screen-installed PWA, which is a confusing dead end
 * unless it's named.
 */
export function pushUnavailableReason(): string | null {
  if (typeof window === "undefined") return "unsupported";
  if (!("serviceWorker" in navigator)) return "unsupported";
  if (!("PushManager" in window)) return "unsupported";
  if (!("Notification" in window)) return "unsupported";
  return null;
}

/** Current permission, normalized for SSR (where the API doesn't exist). */
export function notificationPermission(): NotificationPermission | "unsupported" {
  if (pushUnavailableReason()) return "unsupported";
  return Notification.permission;
}

/**
 * A short, human-recognisable device label derived from the UA string.
 *
 * Deliberately coarse: the point is only "which of my devices is this" when
 * revoking, and a full UA string is both unreadable and more fingerprinting
 * surface than the feature needs. Order matters -- Edge/Chrome both contain
 * "Chrome", iPadOS reports as Macintosh, so the more specific token wins.
 */
export function describeDevice(userAgent: string | null | undefined): string {
  const ua = (userAgent ?? "").trim();
  if (!ua) return "Unknown device";
  const os = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Macintosh|Mac OS X/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "Windows"
            : /Linux/.test(ua)
              ? "Linux"
              : null;
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\//.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : null;
  if (os && browser) return `${browser} on ${os}`;
  return os ?? browser ?? "Unknown device";
}

/** Turn a live PushSubscription into the API payload, or null if unusable. */
export function toSubscriptionPayload(
  subscription: PushSubscription | null | undefined,
  userAgent?: string,
): PushSubscriptionPayload | null {
  if (!subscription?.endpoint) return null;
  const p256dh = bufferToBase64Url(subscription.getKey?.("p256dh") ?? null);
  const auth = bufferToBase64Url(subscription.getKey?.("auth") ?? null);
  // A subscription missing either key can never be encrypted for, so it is
  // rejected here rather than stored and failing silently at every send.
  if (!p256dh || !auth) return null;
  return {
    endpoint: subscription.endpoint,
    p256dh,
    auth,
    ...(userAgent ? { user_agent: userAgent } : {}),
  };
}

/**
 * Subscribe this browser to push and return the API payload.
 *
 * `userVisibleOnly: true` is REQUIRED, not a preference -- Chrome rejects a
 * subscription without it outright, and it is the API-level expression of the
 * same silent-push prohibition documented in the service worker and
 * src/web-push-payload.ts.
 *
 * Throws with a human-readable message; the caller renders it.
 */
export async function subscribeToPush(vapidPublicKey: string): Promise<PushSubscriptionPayload> {
  if (pushUnavailableReason()) {
    throw new Error("Push notifications aren't supported in this browser.");
  }
  if (!vapidPublicKey) {
    throw new Error("Push notifications aren't configured on this deployment.");
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error(
      permission === "denied"
        ? "Notifications are blocked for this site — re-enable them in your browser settings."
        : "Notification permission wasn't granted.",
    );
  }

  const registration = await navigator.serviceWorker.ready;
  // Reuse an existing subscription when the browser already has one for this
  // service worker: re-subscribing would reissue the same endpoint anyway,
  // and calling subscribe() twice with a different key throws.
  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: vapidKeyToBytes(vapidPublicKey) as BufferSource,
    }));

  const payload = toSubscriptionPayload(
    subscription,
    typeof navigator !== "undefined" ? navigator.userAgent : undefined,
  );
  if (!payload) {
    throw new Error("The browser returned an incomplete push subscription.");
  }
  return payload;
}

/** Tear down this browser's local subscription (after the server row is gone). */
export async function unsubscribeLocally(endpoint: string): Promise<void> {
  if (pushUnavailableReason()) return;
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    // Only unsubscribe when this browser holds the SAME endpoint being
    // removed -- revoking a different device from this one must not kill
    // this browser's own subscription.
    if (subscription?.endpoint === endpoint) await subscription.unsubscribe();
  } catch {
    // Best effort: the server-side row is already deleted, which is what
    // actually stops delivery.
  }
}
