import { definePlugin, serverFetch } from "nitro";
import { createNativeUiAssets, nativeOgElement } from "./lib/native-ui";

/** Loaded only by the explicit Node build; Worker assets keep their binding. */
export default definePlugin((app) => {
  const runtime = globalThis as typeof globalThis & { __env__?: unknown };
  if (runtime.__env__ !== undefined)
    throw new Error("Native UI asset environment is already owned");
  const environment = Object.freeze({
    ASSETS: createNativeUiAssets(serverFetch),
    NATIVE_OG_ELEMENT: nativeOgElement,
  });
  runtime.__env__ = environment;
  app.hooks.hook("close", () => {
    if (runtime.__env__ === environment) delete runtime.__env__;
  });
});
