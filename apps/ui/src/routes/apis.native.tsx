import { createFileRoute } from "@tanstack/react-router";
import { NativeRuntimePage } from "./-native-runtime-page";

const title = "Bittensor native state and calls · Metagraphed";
const description = "Read finalized Bittensor protocol state, inspect runtime types and prepare unsigned native calls from the chain’s current metadata.";

export const Route = createFileRoute("/apis/native")({
  head: () => ({ meta: [{ title }, { name: "description", content: description }, { property: "og:title", content: title }, { property: "og:description", content: description }] }),
  component: NativeRuntimePage,
});
