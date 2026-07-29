// Edge-rendered Open Graph image (/og). Renders a BRANDED 1200x630 PNG card via
// workers-og (satori + resvg-wasm) so social/link unfurls have a real image.
// Infra module (imported by the Worker entry), so it survives Lovable regens.
//
// #8489: this card used to be three lines of plain text on flat black with no
// mark, no brand colour and no data -- the same generic card for the home page,
// every subnet, every validator and every doc. It is the card that actually
// travels (every share of metagraph.sh unfurls through here), so it now carries
// the brand lockup and, for entity pages, real information about that entity.
//
// DESIGN NOTE -- why this card is dark-ground rather than the landing card's
// mint field. src/og-image.ts (api.metagraph.sh) is a mint poster: one
// headline, no data. These per-page cards carry three to five lines of dense
// entity text, and a full-bleed mint field behind that much copy reads as a
// marketing banner rather than a data card.
//
// The ground is the app's OWN --paper, and -- just as importantly -- so is its
// STRUCTURE. Matching the background colour alone was not enough: the site
// reads the way it does because it is built from hairline-separated bands (a
// masthead rule, a ticker strip, panel borders) sitting almost on the ground
// colour, so a card with the correct background but no rules still felt like a
// flat void rather than a page from this product. The card is therefore banded
// the same way: lockup row, body, stat band, each separated by the app's own
// --border hairline.
//
// Mint is used the way the product uses it -- as an ACCENT only: the top rule,
// the mark, the eyebrow, the rule beside the headline, and the stat values.
// There is deliberately no large tinted shape behind the copy: a low-opacity
// green field over near-black still rasterizes a visible hard-edged arc rather
// than a soft wash, which read as a smudge rather than a design element.
// #8489 requirement 1 allows the dark variant when the reason is stated; this
// is that statement.
//
// workers-og is loaded lazily inside handleOgImage (see below), NOT statically:
// it pulls in a yoga `.wasm` that Node's ESM loader can't resolve, which would
// break `vite dev` SSR for every route. It only has to work on the Cloudflare
// Worker, which reaches the dynamic import only on an actual /og request.
type WorkersOg = typeof import("workers-og");

const OG_PATH = "/og";
const SUBTITLE = "The Bittensor subnet integration registry";
const WORDMARK = "Metagraphed";

// Palette. The ACCENT is the brand mint from src/og-image.ts (the brand-kit
// value, deliberately the vivid one rather than the app's slightly dialed-back
// UI token -- this is a marketing surface).
//
// Everything else is the app's OWN dark theme, converted from the oklch tokens
// in packages/ui-kit/src/styles.css's `.dark` block. Those are NEUTRAL (hue
// 250 at chroma 0.003-0.006 -- a cool near-black), not green: mint is an
// accent in this product, never a ground. An earlier pass used a green-tinted
// ink for the card background, which looked nothing like the app it links to.
const MINT = "#30FFC0";
/** --paper: the app's actual page background. */
const GROUND = "#08090A";
/** --surface: the card/panel lift used for the stat band. */
const SURFACE = "#0F1112";
/** --ink-strong: headline text. */
const TEXT_STRONG = "#EFF2F6";
/** --ink-muted: supporting copy. */
const TEXT_MUTED = "#8A8C8F";
/** --ink-subtle: stat labels. */
const TEXT_SUBTLE = "#4B4D4F";
/**
 * The app's hairline. `--border` is `--ink-strong` at 11% alpha; satori has no
 * reliable color-mix/oklab support, so this is that composite precomputed over
 * --paper. Sampled from the running app rather than guessed.
 *
 * This token matters more than it looks: the site's whole character comes from
 * hairline-separated bands and panels sitting almost ON the ground colour, not
 * from strong surface contrast. A card with the right background but no rules
 * reads as a flat void and looks nothing like the product.
 */
const HAIRLINE = "#212324";

// #8257/#8489: bumped whenever the rendered card changes, so already-unfurled
// links pick up the new design instead of serving last month's PNG from the
// edge cache for its full 7-day stale-while-revalidate window. Bumped to "3"
// for the #8489 rebuild -- every previously cached card is the old plain-text
// one and must be retired.
const CARD_VERSION = "3";

const MAX_SUBTITLE_LENGTH = 90;
const DEFAULT_TITLE = "Metagraphed";
const MAX_TITLE_LENGTH = 110;
// #8489: bounds for the new entity params, same posture as title/subtitle --
// this is an unauthenticated endpoint crawlers hit, so every interpolated
// value is both length-bounded AND escaped.
const MAX_EYEBROW_LENGTH = 32;
const MAX_STAT_LABEL_LENGTH = 24;
const MAX_STAT_VALUE_LENGTH = 28;
const MAX_QUERY_LENGTH = 512;
const CACHE_CONTROL = "public, max-age=86400, stale-while-revalidate=604800";

// The brand "M" mark, recoloured from src/og-image.ts's ink version to MINT so
// it reads on the ink ground (see the design note above). Same geometry, same
// brand kit source -- only the fill differs. Injected via <img> rather than
// inline <svg> for reliable satori rasterization, matching the landing card.
const LOGO_DATA_URI =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI1MTIiIGhlaWdodD0iNTEyIiB2aWV3Qm94PSIwIDAgNTEyIDUxMiIgZmlsbD0ibm9uZSI+CjxwYXRoIHRyYW5zZm9ybT0idHJhbnNsYXRlKDgxLjkyMCwxNTEuNzM4KSBzY2FsZSgwLjQ2NTQ1KSIgZD0iTSAzMTUuNSwxLjE5OTk5OTk5OTk5OTk4ODYgQyAzMTMuNDAwMDAwMDAwMDAwMDMsMS42OTk5OTk5OTk5OTk5ODg2IDI4MS43LDMyLjc5OTk5OTk5OTk5OTk1NSAyMDYuNSwxMDcuODk5OTk5OTk5OTk5OTggQyAxNDYuNSwxNjcuODk5OTk5OTk5OTk5OTggOTkuMzAwMDAwMDAwMDAwMDEsMjE0LjM5OTk5OTk5OTk5OTk4IDk3LjcsMjE1LjAgQyA5NS45LDIxNS42IDc5LjQsMjE2LjAgNTIuMzAwMDAwMDAwMDAwMDA0LDIxNi4wIEMgMTEuNCwyMTYuMCA5LjYwMDAwMDAwMDAwMDAwMSwyMTYuMSA2LjUsMjE4LjAgQyAtMC40LDIyMi4yOTk5OTk5OTk5OTk5OCAwLjAsMjE1Ljc5OTk5OTk5OTk5OTk4IDAuMCwzMjguNyBDIDAuMCw0MjguNSAwLjAsNDMwLjYgMi4wLDQzMy44IEMgNi4wLDQ0MC4zIDEyLjksNDQyLjUgMTkuNSw0MzkuNCBDIDIxLjMsNDM4LjYgNzAuOSwzODkuNCAxMzAuNiwzMjkuMyBDIDIyMy45LDIzNS41IDIzOS4yMDAwMDAwMDAwMDAwMiwyMjAuMzk5OTk5OTk5OTk5OTggMjQzLjgsMjE4LjM5OTk5OTk5OTk5OTk4IEMgMjQ5LjAsMjE2LjAgMjQ5LjUsMjE2LjAgMjgxLjgsMjE2LjAgQyAzMTIuNDAwMDAwMDAwMDAwMDMsMjE2LjAgMzE0LjcwMDAwMDAwMDAwMDA1LDIxNi4xIDMxNy43MDAwMDAwMDAwMDAwNSwyMTguMCBDIDMxOS40MDAwMDAwMDAwMDAwMywyMTkuMCAzMjEuNSwyMjAuODk5OTk5OTk5OTk5OTggMzIyLjIwMDAwMDAwMDAwMDA1LDIyMi4yIEMgMzIzLjIwMDAwMDAwMDAwMDA1LDIyNC4wIDMyMy42LDI0NS4xIDMyNC4wLDMyOC4wIEwgMzI0LjUsNDMxLjUgTCAzMjYuOCw0MzQuOCBDIDMzMS4wLDQ0MC42IDMzOC4xLDQ0Mi42IDM0My44LDQzOS42IEMgMzQ1LjMsNDM4LjggMzk1LjgsMzg4LjggNDU2LjAsMzI4LjUgQyA1MTYuMiwyNjguMiA1NjYuNywyMTguMiA1NjguMiwyMTcuMzk5OTk5OTk5OTk5OTggQyA1NzAuNCwyMTYuMjk5OTk5OTk5OTk5OTggNTc3LjMwMDAwMDAwMDAwMDEsMjE2LjAgNjA1LjIsMjE2LjAgQyA2MzcuNDAwMDAwMDAwMDAwMSwyMTYuMCA2MzkuNywyMTYuMSA2NDIuNywyMTguMCBDIDY0NC40MDAwMDAwMDAwMDAxLDIxOS4wIDY0Ni41LDIyMC44OTk5OTk5OTk5OTk5OCA2NDcuMiwyMjIuMiBDIDY0OC4yLDIyNC4wIDY0OC42LDI0NS43IDY0OS4wLDMzMS43IEMgNjQ5LjUsNDM4LjEgNjQ5LjUsNDM4LjkgNjUxLjYsNDQxLjcgQyA2NTQuODAwMDAwMDAwMDAwMSw0NDYuMSA2NTkuNyw0NDguMiA2NjUuMCw0NDcuNSBDIDY2OS40MDAwMDAwMDAwMDAxLDQ0Ny4wIDY3MC42LDQ0NS45IDcwNy4zMDAwMDAwMDAwMDAxLDQwOS4yIEMgNzI4LjEsMzg4LjUgNzQ1LjgwMDAwMDAwMDAwMDEsMzcwLjMgNzQ2LjYsMzY4LjggQyA3NDcuODAwMDAwMDAwMDAwMSwzNjYuNSA3NDguMCwzNTQuOSA3NDguMCwyOTUuNzk5OTk5OTk5OTk5OTUgQyA3NDguMCwyMjguMCA3NDcuOTAwMDAwMDAwMDAwMSwyMjUuMzk5OTk5OTk5OTk5OTggNzQ2LjAsMjIyLjI5OTk5OTk5OTk5OTk4IEMgNzQyLjUsMjE2LjUgNzQyLjYsMjE2LjUgNzAzLjMwMDAwMDAwMDAwMDEsMjE2LjAgQyA2NjguNywyMTUuNSA2NjcuMCwyMTUuMzk5OTk5OTk5OTk5OTggNjY0LjMwMDAwMDAwMDAwMDEsMjEzLjM5OTk5OTk5OTk5OTk4IEMgNjYyLjgwMDAwMDAwMDAwMDEsMjEyLjI5OTk5OTk5OTk5OTk4IDY2MC43LDIwOS43OTk5OTk5OTk5OTk5OCA2NTkuODAwMDAwMDAwMDAwMSwyMDcuODk5OTk5OTk5OTk5OTggQyA2NTguMSwyMDQuNyA2NTguMCwxOTcuODk5OTk5OTk5OTk5OTggNjU4LjAsMTA3Ljc5OTk5OTk5OTk5OTk1IEMgNjU4LjAsLTAuNzAwMDAwMDAwMDAwMDQ1NSA2NTguNDAwMDAwMDAwMDAwMSw1Ljc5OTk5OTk5OTk5OTk1NDUgNjUwLjgwMDAwMDAwMDAwMDEsMS44OTk5OTk5OTk5OTk5NzczIEMgNjQ2LjYsLTAuMjAwMDAwMDAwMDAwMDQ1NDcgNjQzLjQwMDAwMDAwMDAwMDEsLTAuNSA2MzkuMzAwMDAwMDAwMDAwMSwxLjA5OTk5OTk5OTk5OTk2NiBDIDYzNy43LDEuNjk5OTk5OTk5OTk5OTg4NiA1OTAuMiw0OC41OTk5OTk5OTk5OTk5NjYgNTI5LjksMTA5LjA5OTk5OTk5OTk5OTk3IEwgNDIzLjMsMjE2LjEgTCAzODIuNzAwMDAwMDAwMDAwMDUsMjE1Ljc5OTk5OTk5OTk5OTk4IEMgMzQzLjUsMjE1LjUgMzQyLjEsMjE1LjM5OTk5OTk5OTk5OTk4IDMzOS4zLDIxMy4zOTk5OTk5OTk5OTk5OCBDIDMzNy44LDIxMi4yOTk5OTk5OTk5OTk5OCAzMzUuNzAwMDAwMDAwMDAwMDUsMjA5Ljc5OTk5OTk5OTk5OTk4IDMzNC44LDIwNy44OTk5OTk5OTk5OTk5OCBDIDMzMy4xLDIwNC43IDMzMy4wLDE5Ny44OTk5OTk5OTk5OTk5OCAzMzMuMCwxMDcuNjk5OTk5OTk5OTk5OTkgQyAzMzMuMCw0LjA5OTk5OTk5OTk5OTk2NiAzMzMuMjAwMDAwMDAwMDAwMDUsOC4xOTk5OTk5OTk5OTk5ODg5IDMyOC4xLDMuNTk5OTk5OTk5OTk5OTY2IEMgMzI1LjYsMS4yOTk5OTk5OTk5OTk5NTQ1IDMxOS41LDAuMDk5OTk5OTk5OTk5OTk2NTkgMzE1LjUsMS4xOTk5OTk5OTk5OTk5ODg2IiBmaWxsPSIjMzBGRkMwIi8+Cjwvc3ZnPgo=";

// A tiny valid PNG returned when rendering dependencies fail. This keeps the
// public endpoint cheap and predictable instead of retrying expensive work.
const FALLBACK_PNG = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0,
  0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 248, 255, 255, 255, 127, 0, 9,
  251, 3, 253, 5, 67, 69, 202, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
]);

type EdgeCache = {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
};

const cacheStorage = (globalThis as { caches?: { default?: EdgeCache } }).caches?.default ?? null;

// Escape text for safe embedding in the HTML string satori parses.
export function escapeText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function normalizeTitle(value: string | null): string {
  const trimmed = (value || DEFAULT_TITLE).trim() || DEFAULT_TITLE;
  return trimmed.length > MAX_TITLE_LENGTH ? `${trimmed.slice(0, MAX_TITLE_LENGTH - 1)}…` : trimmed;
}

/**
 * The card's second line. Entity pages pass their own (#8257) -- "SN64 ·
 * 0.083 τ · healthy" says far more in a link unfurl than the same generic
 * tagline on every page did. Falls back to the tagline when absent, and is
 * bounded like the title so a long one can't overflow the card.
 */
export function normalizeSubtitle(value: string | null): string {
  const trimmed = (value || "").trim();
  if (!trimmed) return SUBTITLE;
  return trimmed.length > MAX_SUBTITLE_LENGTH
    ? `${trimmed.slice(0, MAX_SUBTITLE_LENGTH - 1)}…`
    : trimmed;
}

/**
 * Generic bounded-text normalizer for the #8489 entity params.
 *
 * Returns null (not "") for an absent/blank value so every call site can use a
 * plain truthiness check, and the card's own fallback path is a single
 * `?:` rather than scattered emptiness checks.
 */
export function normalizeParam(value: string | null, max: number): string | null {
  const trimmed = (value || "").trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** One "LABEL / value" cell in the card's stat rail. */
export interface OgStat {
  label: string;
  value: string;
}

/**
 * Read the entity params off the query string.
 *
 * Every value is bounded here and escaped at render, so a crawler-supplied
 * query can neither overflow the card nor inject markup into the string satori
 * parses -- the same treatment title/subtitle already had, extended to the new
 * fields rather than trusting them because they're "ours".
 *
 * Stats are read as up to two `stat`/`statv` pairs. Two is a deliberate cap:
 * the rail is one row, and a third cell either wraps or shrinks the type below
 * legibility at unfurl size.
 */
export function readCardParams(params: URLSearchParams): {
  eyebrow: string | null;
  stats: OgStat[];
} {
  const eyebrow = normalizeParam(params.get("eyebrow"), MAX_EYEBROW_LENGTH);
  const stats: OgStat[] = [];
  for (const [labelKey, valueKey] of [
    ["stat1", "stat1v"],
    ["stat2", "stat2v"],
  ] as const) {
    const label = normalizeParam(params.get(labelKey), MAX_STAT_LABEL_LENGTH);
    const value = normalizeParam(params.get(valueKey), MAX_STAT_VALUE_LENGTH);
    // Both halves required: a value with no label is unreadable, and a label
    // with no value is an empty promise.
    if (label && value) stats.push({ label, value });
  }
  return { eyebrow, stats };
}

/**
 * Title size, stepped down by length.
 *
 * A fixed 68px is right for the short names that dominate in practice
 * ("Chutes", "tao.bot", a truncated ss58), but `normalizeTitle` allows up to
 * 110 characters, and at 68px that wraps to four lines and shoves the stat
 * rail off the bottom of the card -- verified by rendering the pathological
 * case, not assumed. Satori has no reliable line-clamp, so the deterministic
 * fix is to scale the type to the content. Every returned size is chosen so
 * the worst case at that length still fits the 630px canvas.
 */
export function titleFontSize(length: number): number {
  if (length <= 24) return 68;
  if (length <= 48) return 54;
  return 42;
}

/**
 * The card markup.
 *
 * satori is strict: any element with more than one child needs an explicit
 * `display:flex`, and text must live in leaf nodes. Every container below sets
 * it deliberately -- a missing one renders as a blank card, not a warning.
 *
 * Two layout details, both found by rendering the real markup and MEASURING
 * it rather than eyeballing a thumbnail:
 *
 *  1. The root carries EXPLICIT 1200x630 pixel dimensions, not 100%/100%.
 *     Percentage sizing has to resolve against a parent, and when it doesn't
 *     the card lays out at its intrinsic content height instead of the canvas
 *     -- which silently pushed the stat rail past the bottom edge, cropped
 *     (measured 774px against a 630px canvas).
 *  2. The padded inner wrapper is `position:relative`. Absolutely-positioned
 *     elements paint above non-positioned in-flow content, so the decorative
 *     diagonal was washing out the subtitle behind it -- visible only by
 *     looking at a real render. Positioning the content wrapper lifts the copy
 *     back above the decoration, and the text columns are additionally capped
 *     short of the diagonal's footprint so legibility never depends on the
 *     stacking rule alone.
 *  3. Padding lives on an INNER wrapper, never on the sized root. With the CSS
 *     default `box-sizing: content-box`, width:1200px + 80px horizontal
 *     padding renders 1360px wide -- the card silently outgrows its own
 *     canvas. Separating "the box that is exactly the canvas" from "the box
 *     that has the padding" is unambiguous under either box model, and is the
 *     same structure src/og-image.ts (the landing card) already uses.
 *
 * Exported so a test can assert the structure without running the wasm
 * rasterizer.
 */
export function renderCardMarkup(opts: {
  title: string;
  subtitle: string;
  eyebrow: string | null;
  stats: OgStat[];
}): string {
  const title = escapeText(opts.title);
  const subtitle = escapeText(opts.subtitle);
  const eyebrow = opts.eyebrow ? escapeText(opts.eyebrow) : null;

  const statCells = opts.stats
    .map(
      (stat) => `
        <div style="display:flex;flex-direction:column;margin-right:64px;">
          <div style="display:flex;font-size:21px;font-weight:500;color:${TEXT_SUBTLE};letter-spacing:2px;">${escapeText(
            stat.label.toUpperCase(),
          )}</div>
          <div style="display:flex;font-size:42px;font-weight:700;color:${MINT};margin-top:8px;">${escapeText(
            stat.value,
          )}</div>
        </div>`,
    )
    .join("");

  // The stat band only takes its lifted surface when there are stats -- an
  // empty slab across the foot of the fallback card would be worse than none.
  const hasStats = opts.stats.length > 0;

  return `
    <div style="position:relative;display:flex;flex-direction:column;width:1200px;height:630px;background:${GROUND};color:${TEXT_STRONG};font-family:'Space Grotesk';overflow:hidden;">
      <div style="display:flex;width:1200px;height:6px;background:${MINT};"></div>

      <div style="display:flex;align-items:center;padding:34px 80px;border-bottom:1px solid ${HAIRLINE};">
        <img src="${LOGO_DATA_URI}" style="width:52px;height:52px;" />
        <div style="display:flex;font-size:33px;font-weight:700;letter-spacing:-0.5px;margin-left:8px;">${WORDMARK}</div>
        ${
          eyebrow
            ? `<div style="display:flex;margin-left:22px;padding:6px 17px;border:2px solid ${MINT};border-radius:999px;font-size:20px;font-weight:500;color:${MINT};letter-spacing:2px;">${escapeText(
                eyebrow.toUpperCase(),
              )}</div>`
            : ""
        }
      </div>

      <div style="display:flex;flex:1;align-items:center;padding:0 80px;">
        <div style="display:flex;align-items:stretch;">
          <div style="display:flex;width:5px;border-radius:3px;background:${MINT};margin-right:28px;"></div>
          <div style="display:flex;flex-direction:column;">
            <div style="display:flex;font-size:${titleFontSize(
              opts.title.length,
            )}px;font-weight:700;line-height:1.08;letter-spacing:-1px;max-width:880px;">${title}</div>
            <div style="display:flex;font-size:29px;font-weight:400;line-height:1.35;color:${TEXT_MUTED};margin-top:18px;max-width:800px;">${subtitle}</div>
          </div>
        </div>
      </div>

      <div style="display:flex;align-items:center;justify-content:space-between;padding:${
        hasStats ? "28px" : "34px"
      } 80px;border-top:1px solid ${HAIRLINE};background:${hasStats ? SURFACE : GROUND};">
        <div style="display:flex;">${statCells}</div>
        <div style="display:flex;font-size:23px;font-weight:500;color:${TEXT_MUTED};letter-spacing:1px;">metagraph.sh</div>
      </div>
    </div>`;
}

function makeCacheKey(url: URL, title: string, subtitle: string): Request {
  const cacheUrl = new URL(url);
  const original = cacheUrl.searchParams;
  const next = new URLSearchParams();
  next.set("title", title);
  next.set("subtitle", subtitle);
  // #8489: the entity params are part of the rendered output, so they MUST be
  // part of the cache key -- otherwise two subnets sharing a title would serve
  // each other's stats from the edge.
  for (const key of ["eyebrow", "stat1", "stat1v", "stat2", "stat2v"]) {
    const value = original.get(key);
    if (value) next.set(key, value);
  }
  // Part of the key, not just the markup: bumping it retires every cached
  // card at once rather than waiting each entry out.
  next.set("v", CARD_VERSION);
  cacheUrl.search = next.toString();
  return new Request(cacheUrl.toString(), { method: "GET" });
}

function withOgHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", CACHE_CONTROL);
  headers.set("content-type", "image/png");
  return new Response(response.body, { status: response.status, headers });
}

function fallbackImageResponse(status = 200): Response {
  return new Response(FALLBACK_PNG, {
    status,
    headers: {
      "cache-control": CACHE_CONTROL,
      "content-type": "image/png",
    },
  });
}

// Render the /og card, or return null when the path doesn't match.
export async function handleOgImage(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== OG_PATH) return null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  }
  if (url.search.length > MAX_QUERY_LENGTH) {
    return new Response("Query Too Large", { status: 414 });
  }

  const normalizedTitle = normalizeTitle(url.searchParams.get("title"));
  const normalizedSubtitle = normalizeSubtitle(url.searchParams.get("subtitle"));
  const { eyebrow, stats } = readCardParams(url.searchParams);
  const cacheKey = makeCacheKey(url, normalizedTitle, normalizedSubtitle);
  const cached = await cacheStorage?.match(cacheKey);
  if (cached) {
    const response = withOgHeaders(cached);
    return request.method === "HEAD" ? new Response(null, response) : response;
  }

  if (request.method === "HEAD") {
    return new Response(null, {
      headers: {
        "cache-control": CACHE_CONTROL,
        "content-type": "image/png",
      },
    });
  }

  // Lazily pull in workers-og (satori + yoga wasm) only now that we're actually
  // rendering — keeps the wasm out of the SSR module graph so `vite dev` works.
  // Failure here returns the fallback PNG rather than throwing, since this runs
  // outside server.ts's try/catch.
  let ImageResponse: WorkersOg["ImageResponse"];
  let loadGoogleFont: WorkersOg["loadGoogleFont"];
  try {
    ({ ImageResponse, loadGoogleFont } = await import("workers-og"));
  } catch (error) {
    console.error("Failed to load workers-og", error);
    return fallbackImageResponse();
  }

  // Subset each weight to only the bounded glyphs we render (smaller + faster
  // fetch). #8489: the subset must cover the entity params too, or a stat's
  // digits would render as tofu.
  const glyphs = `${normalizedTitle}${normalizedSubtitle}${WORDMARK}metagraph.sh${eyebrow ?? ""}${stats
    .map((s) => `${s.label}${s.label.toUpperCase()}${s.value}`)
    .join("")}`;
  let bold: ArrayBuffer;
  let regular: ArrayBuffer;
  let medium: ArrayBuffer;
  try {
    [bold, regular, medium] = await Promise.all([
      loadGoogleFont({ family: "Space Grotesk", weight: 700, text: glyphs }),
      loadGoogleFont({ family: "Space Grotesk", weight: 400, text: glyphs }),
      loadGoogleFont({ family: "Space Grotesk", weight: 500, text: glyphs }),
    ]);
  } catch (error) {
    console.error("Failed to load OG image fonts", error);
    return fallbackImageResponse();
  }

  const markup = renderCardMarkup({
    title: normalizedTitle,
    subtitle: normalizedSubtitle,
    eyebrow,
    stats,
  });

  try {
    const image = new ImageResponse(markup, {
      width: 1200,
      height: 630,
      fonts: [
        { name: "Space Grotesk", data: bold, weight: 700, style: "normal" },
        { name: "Space Grotesk", data: medium, weight: 500, style: "normal" },
        { name: "Space Grotesk", data: regular, weight: 400, style: "normal" },
      ],
    });
    const response = withOgHeaders(image);
    await cacheStorage?.put(cacheKey, response.clone());
    return response;
  } catch (error) {
    console.error("Failed to render OG image", error);
    return fallbackImageResponse();
  }
}
