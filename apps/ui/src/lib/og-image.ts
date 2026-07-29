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
// DESIGN NOTE -- why this card is the app's LIGHT theme rather than the
// landing card's mint field or the app's dark one. src/og-image.ts
// (api.metagraph.sh) is a mint poster: one headline, no data. These per-page
// cards carry three to five lines of dense entity text, and a full-bleed mint
// field behind that much copy reads as a marketing banner rather than a data
// card. Light is also what a visitor actually lands on -- "Bone & Ink" is the
// DEFAULT theme (packages/ui-kit/src/styles.css: light in `:root`, dark under
// `.dark`), so a dark card promised a page the reader doesn't get.
//
// The ground is the app's OWN --paper, and -- just as importantly -- so is its
// STRUCTURE. Matching the background colour alone was not enough: the site
// reads the way it does because it is built from hairline-separated bands (a
// masthead rule, a ticker strip, panel borders) sitting almost on the ground
// colour, so a card with the correct background but no rules still felt like a
// flat void rather than a page from this product. The card is therefore banded
// the same way: lockup row, body, stat band, each separated by the app's own
// --border hairline, with the stat band on pure white --surface exactly as the
// site lifts a panel off the bone canvas.
//
// Mint is used the way the product uses it -- as an ACCENT only: the top rule,
// the eyebrow, the status dot and the stat values. Note the split between
// --accent (#00C899, for FILLS: rules, dots, borders) and --accent-text
// (#008156, for TEXT): the app makes exactly this distinction, because the
// vivid mint is 1.9:1 on paper and unreadable as small type. Getting that
// wrong is the single easiest way to make a light card look amateurish.
//
// workers-og is loaded lazily inside handleOgImage (see below), NOT statically:
// it pulls in a yoga `.wasm` that Node's ESM loader can't resolve, which would
// break `vite dev` SSR for every route. It only has to work on the Cloudflare
// Worker, which reaches the dynamic import only on an actual /og request.
type WorkersOg = typeof import("workers-og");

const OG_PATH = "/og";
const SUBTITLE = "The Bittensor subnet integration registry";
const WORDMARK = "Metagraphed";

// Palette -- the app's OWN light theme ("Bone & Ink"), not an approximation of
// it. satori has no oklch, no color-mix and no oklab interpolation, so every
// token below is the styles.css `:root` value converted to sRGB with the same
// maths a browser uses (see scripts/render-og-preview.ts's sibling note): the
// oklch -> linear-sRGB matrix for the plain tokens, and oklab interpolation
// against --paper for the alpha ones. Eyeballed hexes drift; these don't.

/** --accent. A FILL colour: rules, dots, borders, the mark. Never small text. */
const ACCENT = "#00C899";
/**
 * --accent-text. The AA-safe variant the app uses wherever the mint styles
 * type (4.58:1 on paper). Every accent-coloured STRING on this card uses it.
 */
const ACCENT_TEXT = "#008156";
/** --paper: the app's actual page background ("warm bone"). */
const GROUND = "#F8F7F2";
/** --surface: pure white, the card/panel lift used for the stat band. */
const SURFACE = "#FFFFFF";
/** --ink-strong: headline text. */
const TEXT_STRONG = "#101818";
/** --ink-muted: supporting copy. */
const TEXT_MUTED = "#616B6C";
/**
 * The app's hairline. `--border` is `--ink-strong` at 8% alpha; satori has no
 * reliable color-mix/oklab support, so this is that composite precomputed --
 * once over --paper (the card's own bands) and once over --surface (the logo
 * tile, which sits on white).
 *
 * This token matters more than it looks: the site's whole character comes from
 * hairline-separated bands and panels sitting almost ON the ground colour, not
 * from strong surface contrast. A card with the right background but no rules
 * reads as a flat void and looks nothing like the product.
 */
const HAIRLINE = "#E3E2DE";
const HAIRLINE_ON_SURFACE = "#E9EAEA";
/**
 * The site's background PATTERN, from packages/ui-kit/src/styles.css's
 * "Premium Blockmachine background: hairline grid + dot field + soft top
 * vignette" on `body`. Matching --paper alone still didn't look like the
 * product, because the product's ground is never a flat fill.
 *
 * Both are `--ink-strong` at low alpha (dot 6%, grid 3.5% in light) which
 * satori can't express, so they ship precomputed over --paper. Sizes are the
 * LIGHT-theme values: --mg-dot-size 24px (dark uses 26px), grid 96px in both.
 *
 * Verified satori actually renders this stack before relying on it -- the
 * local preview uses Chromium, which would happily render a pattern satori
 * silently dropped. A probe confirmed satori emits <pattern>,
 * <radialGradient> and <linearGradient> for exactly these declarations.
 */
const DOT_COLOR = "#E8E7E3";
const GRID_COLOR = "#EEEEEA";
const DOT_SIZE = 24;
const GRID_SIZE = 96;

/**
 * The card's INK band -- the foot, and the tile our own mark sits in.
 *
 * The body is bone; the foot is ink. That contrast is the app's own (its
 * masthead and footer sit on ink against the paper canvas), it gives the card
 * a real base instead of a white slab fading into a warm ground, and it gives
 * the brand mint somewhere it can be used at full strength: on ink the vivid
 * accent is a highlight, where on paper it had to be dialled all the way down
 * to #008156 to stay legible.
 *
 * These are the app's own `.dark` tokens, converted the same way the light
 * ones above were -- so this is the product's dark theme, not "a dark grey".
 */
const INK_GROUND = "#08090A";
/** --ink-muted (dark). Stat labels; --ink-subtle at #4B4D4F is too dim here. */
const INK_TEXT_MUTED = "#8A8C8F";
/** --ink-strong (dark). The footer lockup. */
const INK_TEXT_STRONG = "#EFF2F6";
/** --accent (dark). Stat values and our mark, at full strength on ink. */
const INK_ACCENT = "#5DEBBC";

/**
 * --health-ok / --health-warn / --health-down / --health-unknown.
 *
 * The DARK set, because the only thing this colours is the dot in the ink
 * foot. The light theme's AA text variants (#966800 amber, #DF2321 red) are
 * darkened to survive on paper and read as mud on ink -- the app switches
 * these per theme for exactly that reason, and so does the card.
 */
const HEALTH_COLORS: Record<string, string> = {
  ok: "#5DEBBC",
  warn: "#FCB442",
  down: "#FF6759",
  unknown: "#67696C",
};

/**
 * Whether a crawler-supplied `status` is one of the four states.
 *
 * `Object.hasOwn`, deliberately, not `key in HEALTH_COLORS`: `in` walks the
 * prototype chain, so `?status=constructor` (or `toString`, or `valueOf`)
 * would pass the check and then interpolate a stringified function into the
 * card's inline CSS. Own-property only.
 */
function isHealthState(value: string): boolean {
  return Object.hasOwn(HEALTH_COLORS, value);
}

// #8257/#8489: bumped whenever the rendered card changes, so already-unfurled
// links pick up the new design instead of serving last month's PNG from the
// edge cache for its full 7-day stale-while-revalidate window. Bumped to "3"
// for the #8489 rebuild -- every previously cached card is the old plain-text
// one and must be retired -- and to "4" for the light-theme pass, which
// changes every pixel of every card.
const CARD_VERSION = "4";

const MAX_SUBTITLE_LENGTH = 90;
const DEFAULT_TITLE = "Metagraphed";
const MAX_TITLE_LENGTH = 110;
// #8489: bounds for the new entity params, same posture as title/subtitle --
// this is an unauthenticated endpoint crawlers hit, so every interpolated
// value is both length-bounded AND escaped.
const MAX_EYEBROW_LENGTH = 32;
const MAX_STAT_LABEL_LENGTH = 24;
const MAX_STAT_VALUE_LENGTH = 28;
/** A bare DNS name, e.g. "chutes.ai". Never a URL — see readCardParams. */
const MAX_LOGO_HOST_LENGTH = 80;
const MAX_QUERY_LENGTH = 512;
const CACHE_CONTROL = "public, max-age=86400, stale-while-revalidate=604800";

/**
 * The brand "M" mark (the same brand-kit geometry src/og-image.ts uses),
 * emitted as an <img> data URI rather than inline <svg> for reliable satori
 * rasterization.
 *
 * Built from ONE path at two fills instead of two hand-pasted base64 blobs:
 * the card needs an ink mark for the light lockup and a mint one for the
 * accent tile, and a base64 constant cannot be recoloured -- which is how the
 * dark card ended up with a mint mark hardcoded and no way to follow the
 * theme. Coordinates are rounded to 2dp (the export carried float noise like
 * 1.1999999999999886); at a 0-750 user space scaled to 512px that is well
 * under a tenth of a pixel.
 */
const MARK_PATH =
  "M 315.5,1.2 C 313.4,1.7 281.7,32.8 206.5,107.9 C 146.5,167.9 99.3,214.4 97.7,215 C 95.9,215.6 79.4,216 52.3,216 C 11.4,216 9.6,216.1 6.5,218 C -0.4,222.3 0,215.8 0,328.7 C 0,428.5 0,430.6 2,433.8 C 6,440.3 12.9,442.5 19.5,439.4 C 21.3,438.6 70.9,389.4 130.6,329.3 C 223.9,235.5 239.2,220.4 243.8,218.4 C 249,216 249.5,216 281.8,216 C 312.4,216 314.7,216.1 317.7,218 C 319.4,219 321.5,220.9 322.2,222.2 C 323.2,224 323.6,245.1 324,328 L 324.5,431.5 L 326.8,434.8 C 331,440.6 338.1,442.6 343.8,439.6 C 345.3,438.8 395.8,388.8 456,328.5 C 516.2,268.2 566.7,218.2 568.2,217.4 C 570.4,216.3 577.3,216 605.2,216 C 637.4,216 639.7,216.1 642.7,218 C 644.4,219 646.5,220.9 647.2,222.2 C 648.2,224 648.6,245.7 649,331.7 C 649.5,438.1 649.5,438.9 651.6,441.7 C 654.8,446.1 659.7,448.2 665,447.5 C 669.4,447 670.6,445.9 707.3,409.2 C 728.1,388.5 745.8,370.3 746.6,368.8 C 747.8,366.5 748,354.9 748,295.8 C 748,228 747.9,225.4 746,222.3 C 742.5,216.5 742.6,216.5 703.3,216 C 668.7,215.5 667,215.4 664.3,213.4 C 662.8,212.3 660.7,209.8 659.8,207.9 C 658.1,204.7 658,197.9 658,107.8 C 658,-0.7 658.4,5.8 650.8,1.9 C 646.6,-0.2 643.4,-0.5 639.3,1.1 C 637.7,1.7 590.2,48.6 529.9,109.1 L 423.3,216.1 L 382.7,215.8 C 343.5,215.5 342.1,215.4 339.3,213.4 C 337.8,212.3 335.7,209.8 334.8,207.9 C 333.1,204.7 333,197.9 333,107.7 C 333,4.1 333.2,8.2 328.1,3.6 C 325.6,1.3 319.5,0.1 315.5,1.2";

/** `data:` URI for the mark at an arbitrary fill. */
export function markDataUri(fill: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512" fill="none">` +
    `<path transform="translate(81.920,151.738) scale(0.46545)" d="${MARK_PATH}" fill="${fill}"/></svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

/** Wordmark lockup mark: ink, matching the app masthead on the bone ground. */
const LOGO_DATA_URI = markDataUri(TEXT_STRONG);
/**
 * Avatar-slot mark for our own routes: full-strength mint, on an INK tile.
 *
 * It was mint on the white tile, and at that size the light accent on near-
 * white is genuinely hard to see -- the mark is a thin stroke, so it has far
 * less area to carry the contrast than a block of type does. Putting our own
 * mark on ink fixes it at the source rather than by darkening the brand
 * colour, and pairs the tile with the ink foot.
 *
 * This treatment is for OUR mark only. Entity tiles stay white: they hold a
 * third-party logo whose contrast we don't control, and white is the safe
 * canvas for an arbitrary one -- the same reason ui-kit's BrandIcon flips a
 * dark-on-transparent logo onto a white tile in dark mode.
 */
const BRAND_TILE_MARK = markDataUri(INK_ACCENT);

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

/**
 * Make a value safe to interpolate into the HTML string satori parses.
 *
 * This DELETES the two structural characters rather than escaping them, and
 * that is deliberate: workers-og's parser does NOT decode HTML entities in
 * text nodes. Verified against the deployed Worker, not assumed --
 * `/og?title=Agents %26 MCP` rendered the literal characters `& a m p ;`,
 * eight tofu boxes wide, because the subset had no glyph for most of them.
 * So the previous `&` -> `&amp;` escaping was not protecting the card; it was
 * the thing corrupting it, on every title with an ampersand in it.
 *
 * Only `<` and `>` can change how the markup parses, so only they have to go.
 * Removing them is strictly safer than escaping: the character cannot appear
 * in the output at all, so no tag can be formed no matter how the parser
 * behaves. Everything else -- `&`, quotes, apostrophes -- is ordinary text and
 * is passed through untouched, which is what makes it render correctly.
 *
 * This is safe only because no caller-supplied value reaches an ATTRIBUTE:
 * the one attribute carrying dynamic data is the icon's `src`, and that is a
 * data URI this module builds itself (see resolveIcon). Keep it that way.
 */
export function sanitizeText(value: string): string {
  return value.replace(/[<>]/g, "");
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
 * Stats are read as up to THREE `stat`/`statv` pairs. Three is the cap because
 * the rail is a single row and a fourth cell either wraps or shrinks the type
 * below legibility at unfurl size -- measured on a real render, at the 1200px
 * card width, against the "metagraph.sh" lockup that shares the band. Three
 * also matches what the product itself considers headline-worthy: the subnet
 * masthead's KPI band (#8247) leads with price, emission share and total
 * stake, and those are exactly the three a shared subnet link should carry.
 *
 * `entity` and `status` are the two non-text params:
 *   - `entity=1` marks a card for a NAMED THING (a subnet, a validator, an
 *     account) as opposed to one of our own routes. It decides the avatar
 *     slot's fallback -- see renderCardMarkup -- and is a flag rather than an
 *     inference because "has an eyebrow" stopped being a usable proxy once
 *     every route got one.
 *   - `status` is a health state from the same four-value vocabulary as the
 *     site's health pill, rendered as a coloured dot. Anything else is
 *     dropped rather than guessed at.
 */
export function readCardParams(params: URLSearchParams): {
  eyebrow: string | null;
  stats: OgStat[];
  logoHost: string | null;
  entity: boolean;
  status: string | null;
} {
  const eyebrow = normalizeParam(params.get("eyebrow"), MAX_EYEBROW_LENGTH);
  const logoHost = normalizeLogoHost(params.get("logo"));
  const entity = params.get("entity") === "1";
  const rawStatus = (params.get("status") || "").trim().toLowerCase();
  const status = isHealthState(rawStatus) ? rawStatus : null;
  const stats: OgStat[] = [];
  for (const [labelKey, valueKey] of [
    ["stat1", "stat1v"],
    ["stat2", "stat2v"],
    ["stat3", "stat3v"],
  ] as const) {
    const label = normalizeParam(params.get(labelKey), MAX_STAT_LABEL_LENGTH);
    const value = normalizeParam(params.get(valueKey), MAX_STAT_VALUE_LENGTH);
    // Both halves required: a value with no label is unreadable, and a label
    // with no value is an empty promise.
    if (label && value) stats.push({ label, value });
  }
  return { eyebrow, stats, logoHost, entity, status };
}

/**
 * The icon-proxy URL for a host.
 *
 * Kept next to normalizeLogoHost (which is what makes the host safe to put
 * here) and separate from the markup, because the markup must not know about
 * the network: handleOgImage resolves this to an inline data URI BEFORE
 * rendering so a 404 can fall back to a monogram. satori has no `onerror`, so
 * an unresolvable <img> paints an empty tile forever -- which is exactly what
 * a validator like tao.bot got, since no favicon aggregator has it.
 */
export function iconProxyUrl(host: string): string {
  return `https://api.metagraph.sh/api/v1/icon?host=${encodeURIComponent(host)}&size=128&theme=light`;
}

/**
 * Validate the `logo` param as a bare public DNS name.
 *
 * This is the security-critical one. /og is unauthenticated and crawler-
 * reachable, so accepting a URL here would let anyone make this Worker issue
 * an outbound request to a host of their choosing. Instead the param is a
 * HOSTNAME, and the card renders it through the existing SSRF-safe icon proxy
 * (src/icon-proxy.ts), which only ever fetches fixed favicon-aggregator
 * origins and passes the host as a query value — never as the request target.
 *
 * Rejects anything that isn't a plain dotted DNS label: schemes, slashes,
 * userinfo, ports, IP literals, and the localhost/.local/.internal family,
 * mirroring the proxy's own validation rather than trusting it blindly.
 */
export function normalizeLogoHost(value: string | null): string | null {
  const raw = (value || "").trim().toLowerCase();
  if (!raw || raw.length > MAX_LOGO_HOST_LENGTH) return null;
  // Plain DNS name only: labels of alphanumerics/hyphens, at least one dot,
  // and a non-numeric TLD (which also rules out bare IPv4 literals).
  if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(raw)) return null;
  if (/(^|\.)(localhost|local|internal|test|invalid|example)$/.test(raw)) return null;
  return raw;
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
 * Two-character monogram for an entity with no resolvable logo.
 *
 * Byte-for-byte the same rule as ui-kit's `monogramFor` (BrandIcon): two or
 * more words -> first letter of each; otherwise the first two characters;
 * uppercased. Copied rather than imported because this module is Worker-side
 * and must not pull the React component graph in.
 *
 * The point is that the site's BrandIcon ALWAYS renders something -- an image
 * when it has one, a monogram chip otherwise -- so a validator like "tao.bot"
 * shows "TA" rather than a blank space. The card previously rendered nothing
 * at all without a logo, which is why entity cards looked unfinished next to
 * the same entity on the site.
 */
export function monogramFor(title: string): string {
  const source = title.trim();
  if (!source) return "··";
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return source.slice(0, 2).toUpperCase();
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
  /**
   * Already-resolved image src for the avatar slot (a `data:` URI). Resolution
   * happens in handleOgImage, never here -- see iconProxyUrl.
   */
  icon?: string | null;
  /** Card is about a NAMED THING, so an unresolved icon falls back to a monogram. */
  entity?: boolean;
  /** Health state key into HEALTH_COLORS; colours the footer dot. */
  status?: string | null;
}): string {
  const title = sanitizeText(opts.title);
  const subtitle = sanitizeText(opts.subtitle);
  const eyebrow = opts.eyebrow ? sanitizeText(opts.eyebrow) : null;

  // Three cells have to share the band with the "metagraph.sh" lockup, so the
  // type steps down by one notch versus the old two-cell rail and the gutter
  // shrinks with it. Measured, not guessed: at the previous 21/42px with a
  // 64px gutter, three cells plus the lockup overran 1040px of usable width.
  const wide = opts.stats.length >= 3;
  const labelSize = wide ? 19 : 21;
  const valueSize = wide ? 36 : 42;
  const gutter = wide ? 44 : 64;
  const statCells = opts.stats
    .map(
      (stat) => `
        <div style="display:flex;flex-direction:column;margin-right:${gutter}px;">
          <div style="display:flex;font-size:${labelSize}px;font-weight:500;color:${INK_TEXT_MUTED};letter-spacing:2px;">${sanitizeText(
            stat.label.toUpperCase(),
          )}</div>
          <div style="display:flex;font-size:${valueSize}px;font-weight:700;color:${INK_ACCENT};margin-top:8px;">${sanitizeText(
            stat.value,
          )}</div>
        </div>`,
    )
    .join("");

  // The ink foot is unconditional -- unlike the old white slab, which had to be
  // suppressed on a statless card because a lifted panel with nothing in it
  // read as a mistake. An ink band with just the lockup in it is a base, so the
  // home and docs cards get one too and every card ends the same way. Only the
  // padding still varies: two lines of stats need less than a single lockup.
  const hasStats = opts.stats.length > 0;

  // The avatar slot, mirroring the site's BrandIcon ladder so the card shows
  // the same mark the page does -- it always renders SOMETHING, never a gap:
  //
  //   1. a resolved entity icon (verified fetchable before we got here),
  //   2. else, for an entity, a monogram chip -- "tao.bot" -> "TA", exactly
  //      what BrandIcon falls back to when no aggregator has a favicon,
  //   3. else OUR OWN MARK. Our routes (/agents, /docs, the home page) have no
  //      per-entity logo, and a monogram of a page title ("AG" for /agents) is
  //      meaningless -- the brand mark is the honest answer, and it is what
  //      the site puts in its own masthead. The previous bare mint rule left
  //      those cards looking unfinished.
  const tileBase = `display:flex;align-items:center;justify-content:center;width:96px;height:96px;border-radius:22px;margin-right:28px;margin-top:4px;`;
  // Entity tiles: white, with the app's on-surface hairline. Our own tile: ink,
  // which needs no border because it carries its own contrast against bone.
  const tileShell = `${tileBase}background:${SURFACE};border:1px solid ${HAIRLINE_ON_SURFACE};`;
  const brandTileShell = `${tileBase}background:${INK_GROUND};`;
  const logo = opts.icon
    ? `<div style="${tileShell}">
         <img src="${opts.icon}" style="width:64px;height:64px;border-radius:14px;" />
       </div>`
    : opts.entity
      ? `<div style="${tileShell}">
           <div style="display:flex;font-size:38px;font-weight:700;color:${ACCENT_TEXT};letter-spacing:-0.5px;">${sanitizeText(
             monogramFor(opts.title),
           )}</div>
         </div>`
      : `<div style="${brandTileShell}">
           <img src="${BRAND_TILE_MARK}" style="width:58px;height:58px;" />
         </div>`;

  // Footer dot. Mint by default (a brand bullet before the domain); the health
  // colour when a card carries a status, so a shared subnet link says
  // "degraded" at a glance the way the site's health pill does.
  const dotColor =
    (opts.status && isHealthState(opts.status) && HEALTH_COLORS[opts.status]) || INK_ACCENT;

  return `
    <div style="position:relative;display:flex;flex-direction:column;width:1200px;height:630px;background:${GROUND};background-image:radial-gradient(${DOT_COLOR} 1px, transparent 1px),linear-gradient(to right, ${GRID_COLOR} 1px, transparent 1px),linear-gradient(to bottom, ${GRID_COLOR} 1px, transparent 1px),radial-gradient(ellipse 110% 60% at 50% 0%, rgba(0,200,153,0.07) 0%, transparent 70%);background-size:${DOT_SIZE}px ${DOT_SIZE}px, ${GRID_SIZE}px ${GRID_SIZE}px, ${GRID_SIZE}px ${GRID_SIZE}px, 100% 100%;color:${TEXT_STRONG};font-family:'Space Grotesk','Inter';overflow:hidden;">
      <div style="display:flex;width:1200px;height:6px;background:${ACCENT};"></div>

      <div style="display:flex;align-items:center;padding:32px 80px;border-bottom:1px solid ${HAIRLINE};">
        <img src="${LOGO_DATA_URI}" style="width:50px;height:50px;" />
        <div style="display:flex;font-size:32px;font-weight:700;letter-spacing:-0.5px;margin-left:8px;">${WORDMARK}</div>
        ${
          eyebrow
            ? `<div style="display:flex;margin-left:22px;padding:6px 17px;border:2px solid ${ACCENT};border-radius:999px;font-size:20px;font-weight:500;color:${ACCENT_TEXT};letter-spacing:2px;">${sanitizeText(
                eyebrow.toUpperCase(),
              )}</div>`
            : ""
        }
      </div>

      <div style="display:flex;flex:1;align-items:center;padding:0 80px;">
        <div style="display:flex;align-items:flex-start;">
          ${logo}
          <div style="display:flex;flex-direction:column;">
            <div style="display:flex;font-size:${titleFontSize(
              opts.title.length,
            )}px;font-weight:700;line-height:1.08;letter-spacing:-1px;max-width:860px;">${title}</div>
            <div style="display:flex;font-size:29px;font-weight:400;line-height:1.35;color:${TEXT_MUTED};margin-top:18px;max-width:780px;">${subtitle}</div>
          </div>
        </div>
      </div>

      <div style="display:flex;align-items:center;justify-content:space-between;padding:${
        hasStats ? "26px" : "34px"
      } 80px;background:${INK_GROUND};">
        <div style="display:flex;">${statCells}</div>
        <div style="display:flex;align-items:center;">
          <div style="display:flex;width:9px;height:9px;border-radius:5px;background:${dotColor};margin-right:14px;"></div>
          <div style="display:flex;font-size:29px;font-weight:700;color:${INK_TEXT_STRONG};letter-spacing:-0.2px;">metagraph.sh</div>
        </div>
      </div>
    </div>`;
}

/**
 * The exact set of characters the card will paint, derived FROM the rendered
 * markup rather than re-listed by hand.
 *
 * Fonts are subset to `text=` for size, so any character that isn't in this
 * string rasterizes as a tofu box. Maintaining a parallel list of "everything
 * we render" is a bug generator: it silently drifts every time the markup
 * transforms a value. It already bit twice — stat labels are rendered
 * `.toUpperCase()`, and so is the eyebrow pill, but only the former was
 * mirrored into the hand-written list, so an eyebrow like "Validator" painted
 * "V" followed by eight tofu boxes wherever the title happened not to supply
 * the capitals.
 *
 * Deriving from the markup makes that impossible: whatever the template
 * renders is by construction what gets subset.
 *
 * Stripping tags is the whole job -- their attributes go with them, since they
 * live inside `<...>`, which is what keeps the inlined icon's base64 and every
 * style declaration out of the font request. There is deliberately no entity
 * decoding step: `sanitizeText` no longer emits entities (workers-og does not
 * decode them, so emitting them was the bug), and a decode here would have
 * quietly hidden that by subsetting the glyph the card was never going to
 * paint.
 */
export function glyphsForMarkup(markup: string): string {
  return markup.replace(/<[^>]*>/g, "");
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
  for (const key of [
    "eyebrow",
    "stat1",
    "stat1v",
    "stat2",
    "stat2v",
    "stat3",
    "stat3v",
    "logo",
    "entity",
    "status",
  ]) {
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

/**
 * How large an entity icon may be before we decline to inline it.
 *
 * The proxy serves 128px PNGs (~20KB is typical), so this is generous headroom
 * rather than a tuned limit -- its job is to stop a pathological response from
 * being base64'd into the markup, not to reject real icons.
 */
const MAX_ICON_BYTES = 256 * 1024;

/**
 * Fetch an entity icon through our proxy and inline it as a `data:` URI, or
 * return null so the card falls back to a monogram.
 *
 * This exists because satori has no `onerror`. The site can put a broken
 * <img> on the page and let BrandIcon's chain advance to a monogram; a card
 * cannot -- an unresolvable src rasterizes as an empty tile and stays that way
 * in every unfurl for the life of the cache entry. That is exactly what
 * happened to tao.bot: it publishes a favicon, but no aggregator the proxy
 * queries has one, so the proxy 404s and the tile came out blank while the
 * site showed "TA".
 *
 * Resolving here rather than letting satori fetch also means ONE request
 * instead of two, on a response that is edge-cached for a day.
 *
 * Every failure mode returns null rather than throwing: an OG card must render
 * something even when the icon service is down.
 */
export async function resolveIcon(
  host: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const response = await fetchImpl(iconProxyUrl(host));
    if (!response.ok) return null;
    const type = response.headers.get("content-type") || "";
    if (!type.startsWith("image/")) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_ICON_BYTES) return null;
    // btoa needs a binary string; chunked so a large icon can't blow the
    // argument limit with String.fromCharCode(...spread).
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    return `data:${type.split(";")[0]};base64,${btoa(binary)}`;
  } catch {
    return null;
  }
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
  const { eyebrow, stats, logoHost, entity, status } = readCardParams(url.searchParams);
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

  // Resolve the entity icon before rendering so an unresolvable one degrades
  // to a monogram instead of an empty tile -- see resolveIcon.
  const icon = logoHost ? await resolveIcon(logoHost) : null;

  // Build the markup FIRST so the font subset can be derived from it -- see
  // glyphsForMarkup for why a hand-maintained glyph list is a bug generator.
  const markup = renderCardMarkup({
    title: normalizedTitle,
    subtitle: normalizedSubtitle,
    eyebrow,
    stats,
    icon,
    entity,
    status,
  });
  // Subset each weight to only the glyphs actually painted (smaller + faster
  // fetch) plus the tau, which Space Grotesk lacks entirely and Inter supplies.
  const glyphs = glyphsForMarkup(markup);
  let bold: ArrayBuffer;
  let regular: ArrayBuffer;
  let medium: ArrayBuffer;
  let fallbackBold: ArrayBuffer;
  let fallbackRegular: ArrayBuffer;
  try {
    [bold, regular, medium, fallbackBold, fallbackRegular] = await Promise.all([
      loadGoogleFont({ family: "Space Grotesk", weight: 700, text: glyphs }),
      loadGoogleFont({ family: "Space Grotesk", weight: 400, text: glyphs }),
      loadGoogleFont({ family: "Space Grotesk", weight: 500, text: glyphs }),
      // #8489: Space Grotesk has NO Greek coverage, so the tau in every TAO
      // value ("0.0832 τ") rasterizes as a tofu box. Caught by rendering the
      // card through real satori -- the local Chromium preview substituted a
      // system font and showed a perfect tau, hiding it completely. Inter is
      // registered as a per-glyph fallback so the display face stays Space
      // Grotesk and only the glyphs it lacks come from Inter.
      loadGoogleFont({ family: "Inter", weight: 700, text: glyphs }),
      loadGoogleFont({ family: "Inter", weight: 400, text: glyphs }),
    ]);
  } catch (error) {
    console.error("Failed to load OG image fonts", error);
    return fallbackImageResponse();
  }

  try {
    const image = new ImageResponse(markup, {
      width: 1200,
      height: 630,
      fonts: [
        { name: "Space Grotesk", data: bold, weight: 700, style: "normal" },
        { name: "Space Grotesk", data: medium, weight: 500, style: "normal" },
        { name: "Space Grotesk", data: regular, weight: 400, style: "normal" },
        // Fallback only -- listed after the display face, so satori reaches
        // for it per-glyph rather than for whole runs.
        { name: "Inter", data: fallbackBold, weight: 700, style: "normal" },
        { name: "Inter", data: fallbackRegular, weight: 400, style: "normal" },
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
