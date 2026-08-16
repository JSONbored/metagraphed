import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext } from "@tanstack/react-router";

import appCss from "../styles.css?url";
import { NotFoundComponent, ErrorComponent, RootShell, RootComponent } from "./-root-views";
import { registryFeedLinks } from "@/lib/metagraphed/feed-links";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => {
    const title = "Metagraphed — the Bittensor subnet integration registry";
    const description =
      "What every Bittensor subnet exposes (APIs, docs, schemas), whether it's healthy, and how to call it — machine-readable for AI agents and developers.";
    return {
      meta: [
        { charSet: "utf-8" },
        { name: "viewport", content: "width=device-width, initial-scale=1" },
        { title },
        { name: "description", content: description },
        { name: "author", content: "metagraphed" },
        { property: "og:title", content: title },
        { property: "og:description", content: description },
        { property: "og:type", content: "website" },
        { property: "og:site_name", content: "Metagraphed" },
        // og:url is injected per-route (canonical URL) in src/server.ts so deep
        // pages unfurl to themselves, not the homepage.
        { name: "twitter:card", content: "summary_large_image" },
        // Brand ink (mint-M favicon set). og:image stays the per-route /og card
        // injected in src/server.ts. theme-color is read directly by browser
        // chrome outside the CSS cascade, so it can't reference a custom
        // property -- a literal hex is unavoidable here, same as
        // health-tokens.ts/og-image.ts.
        // eslint-disable-next-line no-restricted-syntax -- see comment above
        { name: "theme-color", content: "#0B1F1A" },
        // talent.app domain-ownership verification for metagraph.sh (Metagraphed
        // listed there as a project). It lives in the root route rather than in
        // server.ts's SEO_DEFAULT_TAGS because that injection path is
        // HTMLRewriter-only -- absent under `vite dev` (Node) -- and a
        // verification token must be present wherever the site is served, not
        // only on workerd. Emitted site-wide; the homepage is what talent.app
        // fetches.
        {
          name: "talentapp:project_verification",
          content:
            "171a1b6c33acbfa216c340c922339cc6bf4f50f44d4c9300d03e4cb5339e1a1be7f961f957cf0499eb33ecbd05cebe77a94259cc187f77d140281791e649747a",
        },
      ],
      links: [
        { rel: "stylesheet", href: appCss },
        // Mint-M brand favicons (assets in public/, from the brand kit).
        { rel: "icon", href: "/favicon.ico", sizes: "any" },
        { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
        { rel: "apple-touch-icon", href: "/apple-touch-icon-180x180.png" },
        { rel: "manifest", href: "/site.webmanifest" },
        // #8703: feed autodiscovery. Without these, a reader handed
        // metagraph.sh finds nothing -- the feeds have existed since #741 and
        // no page ever pointed at them.
        ...registryFeedLinks(),
      ],
    };
  },
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});
