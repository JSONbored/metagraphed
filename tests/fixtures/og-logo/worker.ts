// Keep the production fetch, verification, font and workers-og/WASM renderer.
// The POST body supplies fixture facts, not a replacement rendering pipeline.
import { handleEntityOgImage } from "../../../src/og-entity-card.ts";

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/og/subnets/65535.png")
      return new Response("Unknown fixture request", { status: 404 });
    const { logoManifest, originalLogoUrl } = await request.json<{
      logoManifest: unknown;
      originalLogoUrl: string;
    }>();
    return (
      (await handleEntityOgImage(
        new Request(url, { method: "GET" }),
        {},
        url,
        {
          logoManifest,
          readArtifact: async (_env, artifactPath) => {
            if (artifactPath !== "/metagraph/subnets.json")
              throw new Error("Unexpected fixture artifact read");
            return {
              ok: true,
              data: {
                subnets: [
                  {
                    netuid: 65535,
                    name: "Format fixture",
                    logo_url: originalLogoUrl,
                  },
                ],
              },
            };
          },
        },
      )) ?? new Response("Entity route did not match", { status: 404 })
    );
  },
};
