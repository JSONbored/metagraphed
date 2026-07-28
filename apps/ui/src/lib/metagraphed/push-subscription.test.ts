import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bufferToBase64Url,
  describeDevice,
  notificationPermission,
  pushUnavailableReason,
  toSubscriptionPayload,
  vapidKeyToBytes,
} from "./push-subscription";

// `navigator` is a getter-only global here, so restore ONLY via
// unstubAllGlobals — assigning the saved originals back directly throws.
afterEach(() => {
  vi.unstubAllGlobals();
});

/** Present a browser that fully supports push. */
function stubSupportedBrowser(permission: NotificationPermission = "default") {
  vi.stubGlobal("window", { PushManager: class {}, Notification: class {} });
  vi.stubGlobal("navigator", { serviceWorker: {}, userAgent: "test" });
  vi.stubGlobal("Notification", { permission });
}

describe("vapidKeyToBytes", () => {
  it("decodes unpadded base64url into the raw bytes subscribe() needs", () => {
    // "hello" -> aGVsbG8 (no padding, base64url alphabet).
    expect(Array.from(vapidKeyToBytes("aGVsbG8"))).toEqual([104, 101, 108, 108, 111]);
  });

  it("round-trips URL-unsafe bytes through the -_ alphabet", () => {
    const bytes = new Uint8Array([251, 255, 190, 62, 63]);
    const encoded = bufferToBase64Url(bytes.buffer);
    expect(encoded).not.toMatch(/[+/=]/);
    expect(Array.from(vapidKeyToBytes(encoded))).toEqual(Array.from(bytes));
  });
});

describe("bufferToBase64Url", () => {
  it("returns an empty string for a null key rather than throwing", () => {
    expect(bufferToBase64Url(null)).toBe("");
  });
});

describe("pushUnavailableReason", () => {
  it("returns null when the browser supports push", () => {
    stubSupportedBrowser();
    expect(pushUnavailableReason()).toBeNull();
  });

  it("reports unsupported when any required API is missing", () => {
    // No PushManager (e.g. iOS Safari in a normal tab).
    vi.stubGlobal("window", { Notification: class {} });
    vi.stubGlobal("navigator", { serviceWorker: {} });
    expect(pushUnavailableReason()).toBe("unsupported");

    // No service worker at all.
    vi.stubGlobal("window", { PushManager: class {}, Notification: class {} });
    vi.stubGlobal("navigator", {});
    expect(pushUnavailableReason()).toBe("unsupported");
  });
});

describe("notificationPermission", () => {
  it("reads the live permission when supported", () => {
    stubSupportedBrowser("granted");
    expect(notificationPermission()).toBe("granted");
  });

  it("reports unsupported instead of throwing during SSR", () => {
    vi.stubGlobal("window", undefined);
    expect(notificationPermission()).toBe("unsupported");
  });
});

describe("describeDevice", () => {
  it("names common device/browser pairs", () => {
    expect(
      describeDevice(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile Safari/604.1",
      ),
    ).toBe("Safari on iPhone");
    expect(
      describeDevice(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
      ),
    ).toBe("Chrome on Mac");
  });

  it("prefers the more specific browser token over the substring it contains", () => {
    // Edge and Opera UA strings both also contain "Chrome"; Chrome's own
    // contains "Safari". The specific token has to win or every device
    // would read as "Chrome"/"Safari".
    expect(describeDevice("Mozilla/5.0 Windows Chrome/120.0 Safari/537.36 Edg/120.0")).toBe(
      "Edge on Windows",
    );
    expect(describeDevice("Mozilla/5.0 Windows Chrome/120.0 Safari/537.36 OPR/106.0")).toBe(
      "Opera on Windows",
    );
  });

  it("degrades to whichever half it can identify, then to a safe default", () => {
    expect(describeDevice("Mozilla/5.0 (Android 14)")).toBe("Android");
    expect(describeDevice("Firefox/121.0")).toBe("Firefox");
    expect(describeDevice("some-unrecognised-agent")).toBe("Unknown device");
    expect(describeDevice(null)).toBe("Unknown device");
    expect(describeDevice("   ")).toBe("Unknown device");
  });
});

describe("toSubscriptionPayload", () => {
  const keys: Record<string, ArrayBuffer> = {
    p256dh: new Uint8Array([1, 2, 3]).buffer,
    auth: new Uint8Array([4, 5, 6]).buffer,
  };
  const subscription = {
    endpoint: "https://fcm.googleapis.com/fcm/send/abc",
    getKey: (name: string) => keys[name] ?? null,
  } as unknown as PushSubscription;

  it("shapes a live subscription into the API payload", () => {
    expect(toSubscriptionPayload(subscription, "UA/1.0")).toEqual({
      endpoint: "https://fcm.googleapis.com/fcm/send/abc",
      p256dh: bufferToBase64Url(keys.p256dh!),
      auth: bufferToBase64Url(keys.auth!),
      user_agent: "UA/1.0",
    });
  });

  it("omits user_agent when the caller has none, rather than sending empty", () => {
    expect(toSubscriptionPayload(subscription)).not.toHaveProperty("user_agent");
  });

  it("rejects a subscription missing either key — it could never be encrypted for", () => {
    const partial = {
      endpoint: "https://push.example/x",
      getKey: (name: string) => (name === "p256dh" ? keys.p256dh! : null),
    } as unknown as PushSubscription;
    expect(toSubscriptionPayload(partial)).toBeNull();
  });

  it("returns null for a missing/endpoint-less subscription instead of throwing", () => {
    expect(toSubscriptionPayload(null)).toBeNull();
    expect(toSubscriptionPayload({ endpoint: "" } as PushSubscription)).toBeNull();
  });
});
