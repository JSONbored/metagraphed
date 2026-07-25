import { createFileRoute } from "@tanstack/react-router";
import { Ss58ToolPage } from "./-tools-ss58-page";

export const Route = createFileRoute("/tools/ss58")({
  head: () => ({
    meta: [
      { title: "SS58 address inspector — Metagraphed" },
      {
        name: "description",
        content:
          "Decode and validate any SS58-formatted Substrate address — network prefix, public key, checksum. Runs entirely in your browser; nothing is sent anywhere. No API key.",
      },
    ],
  }),
  component: Ss58ToolPage,
});
