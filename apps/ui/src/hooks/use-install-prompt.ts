import { useEffect, useState } from "react";

const DISMISSED_KEY = "metagraphed:install-prompt-dismissed";

/** The event type TypeScript's own lib.dom.d.ts still doesn't ship (#8384). */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export type InstallPromptKind = "native" | "ios" | null;

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    // iOS Safari's own non-standard flag -- `display-mode: standalone`
    // isn't reliably reported there.
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function isIosSafari(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  const isIos = /iphone|ipad|ipod/i.test(ua) && !("MSStream" in window);
  // Exclude Chrome/Firefox-on-iOS (they're still WebKit under the hood but
  // never get an install path there) and, best-effort, standalone-mode
  // in-app browsers that also match /safari/ in their UA.
  const isSafariBrowser = /safari/i.test(ua) && !/crios|fxios|edgios/i.test(ua);
  return isIos && isSafariBrowser;
}

function readDismissed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * #8384 requirement 4: a dismissible settings row, never a popup/nag bar.
 * `kind` is `"native"` once Chrome/Edge/Android has fired `beforeinstallprompt`
 * (call `promptInstall()` from a real user gesture to show the OS prompt),
 * `"ios"` on iOS Safari (which never fires that event -- the row instead
 * shows static share-sheet instructions), or `null` when there's nothing to
 * offer (already installed, previously dismissed, or an unsupported
 * browser).
 */
export function useInstallPrompt() {
  const [deferredEvent, setDeferredEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(true); // SSR-safe default: hidden
  const [standalone, setStandalone] = useState(false);
  const [iosSafari, setIosSafari] = useState(false);

  useEffect(() => {
    setDismissed(readDismissed());
    setStandalone(isStandalone());
    setIosSafari(isIosSafari());

    function onBeforeInstallPrompt(event: Event) {
      event.preventDefault();
      setDeferredEvent(event as BeforeInstallPromptEvent);
    }
    function onInstalled() {
      setDeferredEvent(null);
      setStandalone(true);
    }
    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const kind: InstallPromptKind =
    standalone || dismissed ? null : deferredEvent ? "native" : iosSafari ? "ios" : null;

  async function promptInstall() {
    if (!deferredEvent) return;
    await deferredEvent.prompt();
    const { outcome } = await deferredEvent.userChoice;
    setDeferredEvent(null);
    if (outcome === "accepted") setStandalone(true);
  }

  function dismiss() {
    setDismissed(true);
    try {
      window.localStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      /* ignore */
    }
  }

  return { kind, promptInstall, dismiss };
}
