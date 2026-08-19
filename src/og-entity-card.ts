// Per-entity Open Graph cards (#11075): GET /og/subnets/{netuid}.png and
// GET /og/accounts/{ss58}.png, rendered from live registry data.
//
// WHY THIS CAN LIVE IN THE WORKER NOW. The render left the Worker in #6502 on a
// bundle-budget argument: workers-og's wasm is ~545 KiB gzipped and the bundler
// ships every reachable import. Measured 2026-08-11, this Worker is 944.8 KiB
// against a 10 MB paid limit, so ~545 KiB more is ~14.5% of it -- the budget
// argument is measurably not binding.
//
// The argument that IS live is startup CPU. This Worker has failed to deploy
// four separate times with `code: 10021 Script startup exceeded CPU time
// limit`, always from work at module scope, and wasm instantiation is exactly
// that shape. So `workers-og` is imported INSIDE the handler and never at
// module scope, and the cost was measured rather than assumed -- eight
// `wrangler versions upload` samples each, which reports startup time without
// routing traffic:
//
//   without the import   319 315 321 283 314 301 307 326   median 313 ms
//   with the import      362 549 315 313 281 312 297 321   median 313 ms
//
// Identical medians: the module is not evaluated until the handler runs. Both
// sets carry outliers because the platform validates on a shared host and the
// limit is load-dependent -- which is the same reason those four deploys failed
// non-deterministically, and is a property of this Worker's 313 ms baseline
// rather than of this import.
//
// CACHED PER ENTITY IN R2, not rendered per request. The key carries a digest
// of the exact facts drawn on the card, so a data change is a NEW key rather
// than an invalidation -- there is no moment where a stale card and a fresh one
// share a name. That is the difference from the landing card, which re-rendered
// an unchanged image on every cache miss because its key was constant.
//
// A RENDER FAILURE IS NEVER A 5xx. Social crawlers do not retry, and a 5xx to
// one is a link that unfurls blank for as long as the crawler caches it. Every
// failure path falls back to the same branded static card the landing route
// uses, which lives in ASSETS -- a different subsystem, so it survives the
// failure modes that take the render down.
import type { ArtifactEnv } from "../workers/storage.ts";
import {
  type AssetFetcher,
  fallbackResponse,
  imageHeaders,
  INK,
  INK_TEXT,
  LOGO_DATA_URI,
  MINT,
  WORDMARK,
} from "./og-image.ts";

/** 1200x630 is the size every major unfurler crops to; anything else is cropped
 * for us and usually badly. */
const WIDTH = 1200;
const HEIGHT = 630;

/** Cards are immutable under their digest, so they may be cached hard. A new
 * digest is a new URL; nothing has to expire for a card to change. */
const CACHE_CONTROL = "public, max-age=86400, stale-while-revalidate=604800";

const SUBNET_PATH = /^\/og\/subnets\/(\d{1,5})\.png$/;
const ACCOUNT_PATH = /^\/og\/accounts\/([1-9A-HJ-NP-Za-km-z]{47,48})\.png$/;

export interface EntityCardFacts {
  /** The line a reader identifies the entity by. */
  title: string;
  /** What kind of thing this is, shown small above the title. */
  kind: string;
  /** Up to three `label -> value` pairs. Fewer is fine; a card with one real
   * fact reads better than one padded with nulls. */
  stats: { label: string; value: string }[];
}

/**
 * The card markup. Kept separate from the render so it can be asserted on in a
 * test without instantiating wasm, the same split `renderMarkup` uses for the
 * landing card.
 *
 * ESCAPED, because every value here is registry data and one of them is a
 * subnet name a third party controls. satori parses this as markup, so an
 * unescaped `<` is a rendering bug at best.
 */
export function renderEntityMarkup(facts: EntityCardFacts): string {
  const stats = facts.stats
    .slice(0, 3)
    .map(
      (stat) =>
        `<div style="display:flex;flex-direction:column;margin-right:64px;">
           <div style="display:flex;font-size:26px;font-weight:500;color:${INK};opacity:0.66;">${escapeMarkup(stat.label)}</div>
           <div style="display:flex;font-size:52px;font-weight:700;color:${INK_TEXT};">${escapeMarkup(stat.value)}</div>
         </div>`,
    )
    .join("");
  return `
    <div style="position:relative;display:flex;flex-direction:column;justify-content:space-between;width:100%;height:100%;background:${MINT};color:${INK_TEXT};font-family:'Space Grotesk';padding:74px 90px;overflow:hidden;">
      <div style="position:absolute;top:-250px;right:-210px;width:740px;height:740px;background:#5BFFD2;opacity:0.5;transform:rotate(34deg);display:flex;"></div>
      <div style="display:flex;flex-direction:column;">
        <div style="display:flex;font-size:30px;font-weight:500;color:${INK};opacity:0.72;">${escapeMarkup(facts.kind)}</div>
        <div style="display:flex;font-size:78px;font-weight:700;letter-spacing:-2px;margin-top:10px;">${escapeMarkup(facts.title)}</div>
      </div>
      <div style="display:flex;align-items:flex-end;justify-content:space-between;width:100%;">
        <div style="display:flex;">${stats}</div>
        <div style="display:flex;align-items:center;">
          <img src="${LOGO_DATA_URI}" style="width:64px;height:64px;" />
          <div style="display:flex;font-size:34px;font-weight:700;margin-left:14px;">${WORDMARK}</div>
        </div>
      </div>
    </div>`;
}

/** satori reads this as markup, and subnet names are third-party strings. */
function escapeMarkup(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * A stable digest of exactly what the card draws.
 *
 * FNV-1a over the facts, not over the entity id: two publishes that change
 * nothing visible produce the same key and re-use the cached PNG, and any
 * change to a drawn value produces a different one. Non-cryptographic on
 * purpose -- this names a cache entry, it does not authenticate anything.
 */
export function factsDigest(facts: EntityCardFacts): string {
  const canonical = JSON.stringify([
    facts.kind,
    facts.title,
    facts.stats.map((s) => [s.label, s.value]),
  ]);
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i += 1) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * `cache/og/subnets/64-a1b2c3d4.png` -- the digest is IN the key, so a
 * regenerate writes a new object rather than overwriting a live one.
 *
 * UNDER `cache/`, deliberately outside `metagraph/`. Objects under the
 * artifact prefix are owned by the publish, which reconciles what it finds
 * against what it built -- a render this Worker wrote would look like drift to
 * it. This is a cache: nothing downstream reads it by name, and losing all of
 * it costs one re-render per card.
 */
export function cardKey(kind: string, subject: string, digest: string): string {
  return `cache/og/${kind}/${subject}-${digest}.png`;
}

/**
 * The R2-backed half of the cache, as a pair of functions the handler can be
 * given or not.
 *
 * HERE RATHER THAN INLINE AT THE DISPATCH SITE, because it is logic: a missing
 * binding, a miss, and a body that has to be read to completion are three
 * different outcomes and each has a right answer. Inline in the router they
 * would be untestable without standing up the whole request path and
 * instantiating the wasm to reach them.
 */
export function r2CardCache(env: {
  METAGRAPH_ARCHIVE?: {
    get?: (
      key: string,
    ) => Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
    put?: (
      key: string,
      body: ArrayBuffer,
      options?: { httpMetadata?: { contentType?: string } },
    ) => Promise<unknown>;
  };
}): Pick<EntityCardDeps, "readCard" | "writeCard"> {
  return {
    readCard: async (key) => {
      // No binding is a MISS, not an error: the card renders and the run
      // simply does not get cached. A throw here would take an unfurl down
      // over a cache that was never configured.
      const archive = env.METAGRAPH_ARCHIVE;
      if (!archive?.get) return null;
      const object = await archive.get(key);
      return object ? await object.arrayBuffer() : null;
    },
    writeCard: async (key, body) => {
      await env.METAGRAPH_ARCHIVE?.put?.(key, body, {
        httpMetadata: { contentType: "image/png" },
      });
    },
  };
}

export interface EntityCardTarget {
  kind: "subnets" | "accounts";
  subject: string;
}

/** Which entity a path names, or null when it names none. */
export function matchEntityCard(pathname: string): EntityCardTarget | null {
  const subnet = SUBNET_PATH.exec(pathname);
  if (subnet) {
    const netuid = Number(subnet[1]);
    // The u16 range the rest of this API enforces. A path outside it is not a
    // subnet card with no data, it is not a subnet.
    if (!Number.isInteger(netuid) || netuid > 65535) return null;
    return { kind: "subnets", subject: String(netuid) };
  }
  const account = ACCOUNT_PATH.exec(pathname);
  if (account) return { kind: "accounts", subject: account[1] };
  return null;
}

/** The reader `workers/storage.ts` exports, named by its own contract rather
 * than loosened to `unknown` -- a loose bag here is what forces a cast at the
 * call site, and the boundary-cast ratchet in this repo is at zero. */
type ArtifactReader = (
  env: ArtifactEnv,
  path: string,
) => Promise<{ ok: boolean; data?: unknown }>;

type R2Writer = (key: string, body: ArrayBuffer) => Promise<void>;

export interface EntityCardDeps {
  readArtifact?: ArtifactReader;
  readCard?: (key: string) => Promise<ArrayBuffer | null>;
  writeCard?: R2Writer;
  render?: (markup: string) => Promise<ArrayBuffer>;
  assets?: AssetFetcher | null;
}

/**
 * The facts a subnet card draws, from the published registry index.
 *
 * ONE ARTIFACT READ, not a live query. Everything here is already in
 * `/metagraph/subnets.json`, which the badge routes read for the same reason:
 * a card is a picture of published state, and giving it its own query path
 * would make an unfurl more expensive than the page it advertises.
 *
 * Returns null when the subnet is not in the index. A card for a subnet we
 * have nothing to say about should be the branded fallback, not a card with
 * three dashes on it.
 */
export function subnetFacts(
  index: unknown,
  netuid: number,
): EntityCardFacts | null {
  const list = (index as { subnets?: Array<Record<string, unknown>> })?.subnets;
  if (!Array.isArray(list)) return null;
  const row = list.find((entry) => Number(entry?.netuid) === netuid);
  if (!row) return null;
  const name = typeof row.name === "string" && row.name ? row.name : null;
  const stats: { label: string; value: string }[] = [];
  // Only facts that are actually present. `absent is null, never zero` is the
  // contract everywhere else in this API, and a card is not exempt: a subnet
  // with no measured readiness must not show "0/100".
  if (typeof row.integration_readiness === "number") {
    stats.push({
      label: "Readiness",
      value: `${row.integration_readiness}/100`,
    });
  }
  if (typeof row.surface_count === "number") {
    stats.push({ label: "Surfaces", value: String(row.surface_count) });
  }
  if (typeof row.coverage_level === "string" && row.coverage_level) {
    stats.push({ label: "Coverage", value: row.coverage_level });
  }
  return {
    kind: `Bittensor subnet ${netuid}`,
    title: name ?? `Subnet ${netuid}`,
    stats,
  };
}

/** An account card names the address and nothing it cannot stand behind. The
 * ss58 is truncated because 48 characters at card size is unreadable, and the
 * full value is in the URL the card is attached to. */
export function accountFacts(ss58: string): EntityCardFacts {
  return {
    kind: "Bittensor account",
    title: `${ss58.slice(0, 6)}…${ss58.slice(-6)}`,
    stats: [{ label: "Address", value: `${ss58.slice(0, 12)}…` }],
  };
}

/**
 * GET /og/subnets/{netuid}.png and /og/accounts/{ss58}.png.
 *
 * Returns null when the path is not an entity card, so the caller's dispatch
 * continues. Never throws and never 5xxes: every failure lands on the branded
 * fallback, because the caller is a social crawler that will cache whatever it
 * gets and will not come back to check.
 */
export async function handleEntityOgImage(
  request: Request,
  env: ArtifactEnv,
  url: URL,
  deps: EntityCardDeps = {},
): Promise<Response | null> {
  const target = matchEntityCard(url.pathname);
  if (!target) return null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { allow: "GET, HEAD" },
    });
  }
  const assets =
    deps.assets !== undefined ? deps.assets : (env?.ASSETS ?? null);

  let facts: EntityCardFacts | null = null;
  try {
    if (target.kind === "accounts") {
      facts = accountFacts(target.subject);
    } else if (typeof deps.readArtifact === "function") {
      const index = await deps.readArtifact(env, "/metagraph/subnets.json");
      facts = index?.ok
        ? subnetFacts(index.data, Number(target.subject))
        : null;
    }
  } catch (error) {
    console.error("og-entity: facts unavailable", error);
    facts = null;
  }
  if (!facts) return fallbackResponse(assets, url);

  const key = cardKey(target.kind, target.subject, factsDigest(facts));

  // The cached render, if this exact card has been drawn before.
  try {
    const cached = await deps.readCard?.(key);
    if (cached) {
      return request.method === "HEAD"
        ? new Response(null, {
            headers: imageHeaders(undefined, CACHE_CONTROL),
          })
        : new Response(cached, {
            headers: imageHeaders(undefined, CACHE_CONTROL),
          });
    }
  } catch (error) {
    console.error("og-entity: cache read failed", error);
  }

  if (request.method === "HEAD") {
    return new Response(null, {
      headers: imageHeaders(undefined, CACHE_CONTROL),
    });
  }

  let png: ArrayBuffer;
  try {
    png = deps.render
      ? await deps.render(renderEntityMarkup(facts))
      : await renderPng(renderEntityMarkup(facts));
  } catch (error) {
    console.error("og-entity: render failed", error);
    return fallbackResponse(assets, url);
  }

  // Written AFTER the response is known good, and a write failure is not the
  // caller's problem -- they already have the image.
  try {
    await deps.writeCard?.(key, png);
  } catch (error) {
    console.error("og-entity: cache write failed", error);
  }
  return new Response(png, { headers: imageHeaders(undefined, CACHE_CONTROL) });
}

/**
 * The render itself.
 *
 * IMPORTED HERE, INSIDE THE FUNCTION, and never at module scope -- see this
 * file's header for the measurement. A static import would instantiate the
 * wasm during startup, which is the failure mode that has broken this Worker's
 * deploys four times.
 */
async function renderPng(markup: string): Promise<ArrayBuffer> {
  const { ImageResponse } = await import("workers-og");
  const response = new ImageResponse(markup, {
    width: WIDTH,
    height: HEIGHT,
  });
  return await response.arrayBuffer();
}
