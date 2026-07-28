import { useEffect } from "react";
import { toast } from "sonner";

/**
 * #8384 requirement 6: new deploys must not strand users, but must also
 * never yank content out from under someone mid-session. The worker itself
 * never calls skipWaiting() on install (see public/sw.js) -- it sits in the
 * "waiting" state until this hook, on the visitor's explicit say-so via the
 * toast action, posts SKIP_WAITING and reloads once the new worker takes
 * control. `sonner`'s own `duration: Infinity` + `action` API is used
 * directly (no shared "persistent toast" wrapper exists in this codebase --
 * see the four existing `toast(...)` call sites in use-copy.ts/command-
 * palette-body.tsx/download-openapi-button.tsx, all one-shot transient
 * toasts; this is deliberately the first persistent one).
 */
export function useServiceWorker() {
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;

    // `controllerchange` also fires the very FIRST time a worker claims this
    // page (registration.active's initial `clients.claim()` in public/sw.js)
    // -- there is no "previous" controller to swap out for in that case, so
    // reloading then would be a pointless, surprising reload on every first
    // visit. Only reload when THIS hook itself requested the swap by posting
    // SKIP_WAITING, tracked explicitly rather than inferred from the event.
    let userRequestedUpdate = false;

    function promptUpdate(waiting: ServiceWorker) {
      toast("Update available", {
        description: "A new version of Metagraphed is ready.",
        duration: Infinity,
        action: {
          label: "Refresh",
          onClick: () => {
            userRequestedUpdate = true;
            waiting.postMessage("SKIP_WAITING");
          },
        },
      });
    }

    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!userRequestedUpdate) return;
      window.location.reload();
    });

    navigator.serviceWorker
      .register("/sw.js")
      .then((registration) => {
        if (registration.waiting && registration.active) {
          promptUpdate(registration.waiting);
        }
        registration.addEventListener("updatefound", () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.addEventListener("statechange", () => {
            if (installing.state === "installed" && registration.active) {
              promptUpdate(installing);
            }
          });
        });
      })
      .catch(() => {
        // Best-effort: a registration failure (unsupported browser, a
        // blocked script, an unrelated deploy hiccup) must never break the
        // app itself -- the site works identically without a service
        // worker, just without offline support.
      });
  }, []);
}
