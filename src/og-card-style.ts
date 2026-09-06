// Renderer-only literals mirror the site's canonical dark tokens. Tests compare
// them with ui-kit CSS; this module has no browser or rendering dependencies.
export const OG_THEME = {
  canvas: "#161616",
  layer: "#1f1f1f",
  raised: "#2a2a2a",
  ink: "#f2f2f2",
  muted: "#a3a3a3",
  rule: "rgba(255, 255, 255, 0.11)",
  brand: "#30ffc0",
  accent: "#3ddc97",
} as const;

export { CARD_VERSION } from "./og-card-version.ts";
export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;
export const WORDMARK = "Metagraphed";
export const CARD_LIMITS = {
  title: 110,
  eyebrow: 32,
  statLabel: 24,
  statValue: 28,
  mark: 5,
} as const;

// Owned brand mark, kept as geometry rather than a fetched asset.
const MARK_PATH =
  "M 315.5,1.2 C 313.4,1.7 281.7,32.8 206.5,107.9 C 146.5,167.9 99.3,214.4 97.7,215 C 95.9,215.6 79.4,216 52.3,216 C 11.4,216 9.6,216.1 6.5,218 C -0.4,222.3 0,215.8 0,328.7 C 0,428.5 0,430.6 2,433.8 C 6,440.3 12.9,442.5 19.5,439.4 C 21.3,438.6 70.9,389.4 130.6,329.3 C 223.9,235.5 239.2,220.4 243.8,218.4 C 249,216 249.5,216 281.8,216 C 312.4,216 314.7,216.1 317.7,218 C 319.4,219 321.5,220.9 322.2,222.2 C 323.2,224 323.6,245.1 324,328 L 324.5,431.5 L 326.8,434.8 C 331,440.6 338.1,442.6 343.8,439.6 C 345.3,438.8 395.8,388.8 456,328.5 C 516.2,268.2 566.7,218.2 568.2,217.4 C 570.4,216.3 577.3,216 605.2,216 C 637.4,216 639.7,216.1 642.7,218 C 644.4,219 646.5,220.9 647.2,222.2 C 648.2,224 648.6,245.7 649,331.7 C 649.5,438.1 649.5,438.9 651.6,441.7 C 654.8,446.1 659.7,448.2 665,447.5 C 669.4,447 670.6,445.9 707.3,409.2 C 728.1,388.5 745.8,370.3 746.6,368.8 C 747.8,366.5 748,354.9 748,295.8 C 748,228 747.9,225.4 746,222.3 C 742.5,216.5 742.6,216.5 703.3,216 C 668.7,215.5 667,215.4 664.3,213.4 C 662.8,212.3 660.7,209.8 659.8,207.9 C 658.1,204.7 658,197.9 658,107.8 C 658,-0.7 658.4,5.8 650.8,1.9 C 646.6,-0.2 643.4,-0.5 639.3,1.1 C 637.7,1.7 590.2,48.6 529.9,109.1 L 423.3,216.1 L 382.7,215.8 C 343.5,215.5 342.1,215.4 339.3,213.4 C 337.8,212.3 335.7,209.8 334.8,207.9 C 333.1,204.7 333,197.9 333,107.7 C 333,4.1 333.2,8.2 328.1,3.6 C 325.6,1.3 319.5,0.1 315.5,1.2";
export const LOGO_DATA_URI =
  "data:image/svg+xml;base64," +
  btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><path transform="translate(81.920,151.738) scale(0.46545)" d="' +
      MARK_PATH +
      '" fill="' +
      OG_THEME.brand +
      '"/></svg>',
  );

// Geometry mirrors ui-kit Wordmark; a parity test prevents silent brand drift.
export const WORDMARK_DATA_URI =
  "data:image/svg+xml;base64," +
  btoa(
    '<svg width="1190.44" height="164.29" xmlns="http://www.w3.org/2000/svg" viewBox="-5.00 -5.00 1190.44 164.29" fill="none" role="img" aria-label="Metagraphed" > <path transform="translate(0,0.000) scale(0.26813)" d="M 315.5,1.1999999999999886 C 313.40000000000003,1.6999999999999886 281.7,32.799999999999955 206.5,107.89999999999998 C 146.5,167.89999999999998 99.30000000000001,214.39999999999998 97.7,215.0 C 95.9,215.6 79.4,216.0 52.300000000000004,216.0 C 11.4,216.0 9.600000000000001,216.1 6.5,218.0 C -0.4,222.29999999999998 0.0,215.79999999999998 0.0,328.7 C 0.0,428.5 0.0,430.6 2.0,433.8 C 6.0,440.3 12.9,442.5 19.5,439.4 C 21.3,438.6 70.9,389.4 130.6,329.3 C 223.9,235.5 239.20000000000002,220.39999999999998 243.8,218.39999999999998 C 249.0,216.0 249.5,216.0 281.8,216.0 C 312.40000000000003,216.0 314.70000000000005,216.1 317.70000000000005,218.0 C 319.40000000000003,219.0 321.5,220.89999999999998 322.20000000000005,222.2 C 323.20000000000005,224.0 323.6,245.1 324.0,328.0 L 324.5,431.5 L 326.8,434.8 C 331.0,440.6 338.1,442.6 343.8,439.6 C 345.3,438.8 395.8,388.8 456.0,328.5 C 516.2,268.2 566.7,218.2 568.2,217.39999999999998 C 570.4,216.29999999999998 577.3000000000001,216.0 605.2,216.0 C 637.4000000000001,216.0 639.7,216.1 642.7,218.0 C 644.4000000000001,219.0 646.5,220.89999999999998 647.2,222.2 C 648.2,224.0 648.6,245.7 649.0,331.7 C 649.5,438.1 649.5,438.9 651.6,441.7 C 654.8000000000001,446.1 659.7,448.2 665.0,447.5 C 669.4000000000001,447.0 670.6,445.9 707.3000000000001,409.2 C 728.1,388.5 745.8000000000001,370.3 746.6,368.8 C 747.8000000000001,366.5 748.0,354.9 748.0,295.79999999999995 C 748.0,228.0 747.9000000000001,225.39999999999998 746.0,222.29999999999998 C 742.5,216.5 742.6,216.5 703.3000000000001,216.0 C 668.7,215.5 667.0,215.39999999999998 664.3000000000001,213.39999999999998 C 662.8000000000001,212.29999999999998 660.7,209.79999999999998 659.8000000000001,207.89999999999998 C 658.1,204.7 658.0,197.89999999999998 658.0,107.79999999999995 C 658.0,-0.7000000000000455 658.4000000000001,5.7999999999999545 650.8000000000001,1.8999999999999773 C 646.6,-0.20000000000004547 643.4000000000001,-0.5 639.3000000000001,1.099999999999966 C 637.7,1.6999999999999886 590.2,48.599999999999966 529.9,109.09999999999997 L 423.3,216.1 L 382.70000000000005,215.79999999999998 C 343.5,215.5 342.1,215.39999999999998 339.3,213.39999999999998 C 337.8,212.29999999999998 335.70000000000005,209.79999999999998 334.8,207.89999999999998 C 333.1,204.7 333.0,197.89999999999998 333.0,107.69999999999999 C 333.0,4.099999999999966 333.20000000000005,8.199999999999989 328.1,3.599999999999966 C 325.6,1.2999999999999545 319.5,0.0999999999999659 315.5,1.1999999999999886" fill="#30FFC0" /> <g transform="translate(216.673,120.000) scale(0.171429,-0.171429)" fill="#f2f2f2" > <path transform="translate(0,0)" d="M296 -14Q222 -14 165.5 17.5Q109 49 77.5 106.5Q46 164 46 242V254Q46 332 77.0 389.5Q108 447 164.0 478.5Q220 510 294 510Q367 510 421.0 477.5Q475 445 505.0 387.5Q535 330 535 254V211H174Q176 160 212.0 128.0Q248 96 300 96Q353 96 378.0 119.0Q403 142 416 170L519 116Q505 90 478.5 59.5Q452 29 408.0 7.5Q364 -14 296 -14ZM175 305H407Q403 348 372.5 374.0Q342 400 293 400Q242 400 212.0 374.0Q182 348 175 305Z" /> <path transform="translate(577,0)" d="M260 0Q211 0 180.5 30.5Q150 61 150 112V392H26V496H150V650H276V496H412V392H276V134Q276 104 304 104H400V0Z" /> <path transform="translate(1033,0)" d="M224 -14Q171 -14 129.0 4.5Q87 23 62.5 58.5Q38 94 38 145Q38 196 62.5 230.5Q87 265 130.5 282.5Q174 300 230 300H366V328Q366 363 344.0 385.5Q322 408 274 408Q227 408 204.0 386.5Q181 365 174 331L58 370Q70 408 96.5 439.5Q123 471 167.5 490.5Q212 510 276 510Q374 510 431.0 461.0Q488 412 488 319V134Q488 104 516 104H556V0H472Q435 0 411.0 18.0Q387 36 387 66V67H368Q364 55 350.0 35.5Q336 16 306.0 1.0Q276 -14 224 -14ZM246 88Q299 88 332.5 117.5Q366 147 366 196V206H239Q204 206 184.0 191.0Q164 176 164 149Q164 122 185.0 105.0Q206 88 246 88Z" /> <path transform="translate(1611,0)" d="M46 246V262Q46 340 77.0 395.5Q108 451 159.5 480.5Q211 510 272 510Q340 510 375.0 486.0Q410 462 426 436H444V496H568V-88Q568 -139 538.0 -169.5Q508 -200 458 -200H126V-90H414Q442 -90 442 -60V69H424Q414 53 396.0 36.5Q378 20 348.0 9.0Q318 -2 272 -2Q211 -2 159.5 27.5Q108 57 77.0 112.5Q46 168 46 246ZM308 108Q366 108 405.0 145.0Q444 182 444 249V259Q444 327 405.5 363.5Q367 400 308 400Q250 400 211.0 363.5Q172 327 172 259V249Q172 182 211.0 145.0Q250 108 308 108Z" /> <path transform="translate(2249,0)" d="M70 0V496H194V440H212Q223 470 248.5 484.0Q274 498 308 498H368V386H306Q258 386 227.0 360.5Q196 335 196 282V0Z" /> <path transform="translate(2645,0)" d="M224 -14Q171 -14 129.0 4.5Q87 23 62.5 58.5Q38 94 38 145Q38 196 62.5 230.5Q87 265 130.5 282.5Q174 300 230 300H366V328Q366 363 344.0 385.5Q322 408 274 408Q227 408 204.0 386.5Q181 365 174 331L58 370Q70 408 96.5 439.5Q123 471 167.5 490.5Q212 510 276 510Q374 510 431.0 461.0Q488 412 488 319V134Q488 104 516 104H556V0H472Q435 0 411.0 18.0Q387 36 387 66V67H368Q364 55 350.0 35.5Q336 16 306.0 1.0Q276 -14 224 -14ZM246 88Q299 88 332.5 117.5Q366 147 366 196V206H239Q204 206 184.0 191.0Q164 176 164 149Q164 122 185.0 105.0Q206 88 246 88Z" /> <path transform="translate(3223,0)" d="M70 -200V496H194V436H212Q229 465 265.0 487.5Q301 510 368 510Q428 510 479.0 480.5Q530 451 561.0 394.0Q592 337 592 256V240Q592 159 561.0 102.0Q530 45 479.0 15.5Q428 -14 368 -14Q323 -14 292.5 -3.5Q262 7 243.5 23.5Q225 40 214 57H196V-200ZM330 96Q389 96 427.5 133.5Q466 171 466 243V253Q466 325 427.0 362.5Q388 400 330 400Q272 400 233.0 362.5Q194 325 194 253V243Q194 171 233.0 133.5Q272 96 330 96Z" /> <path transform="translate(3861,0)" d="M70 0V700H196V435H214Q222 451 239.0 467.0Q256 483 284.5 493.5Q313 504 357 504Q415 504 458.5 477.5Q502 451 526.0 404.5Q550 358 550 296V0H424V286Q424 342 396.5 370.0Q369 398 318 398Q260 398 228.0 359.5Q196 321 196 252V0Z" /> <path transform="translate(4477,0)" d="M296 -14Q222 -14 165.5 17.5Q109 49 77.5 106.5Q46 164 46 242V254Q46 332 77.0 389.5Q108 447 164.0 478.5Q220 510 294 510Q367 510 421.0 477.5Q475 445 505.0 387.5Q535 330 535 254V211H174Q176 160 212.0 128.0Q248 96 300 96Q353 96 378.0 119.0Q403 142 416 170L519 116Q505 90 478.5 59.5Q452 29 408.0 7.5Q364 -14 296 -14ZM175 305H407Q403 348 372.5 374.0Q342 400 293 400Q242 400 212.0 374.0Q182 348 175 305Z" /> <path transform="translate(5054,0)" d="M270 -14Q211 -14 159.5 15.5Q108 45 77.0 102.0Q46 159 46 240V256Q46 337 77.0 394.0Q108 451 159.0 480.5Q210 510 270 510Q315 510 345.5 499.5Q376 489 395.0 473.0Q414 457 424 439H442V700H568V0H444V60H426Q409 32 373.5 9.0Q338 -14 270 -14ZM308 96Q366 96 405.0 133.5Q444 171 444 243V253Q444 325 405.5 362.5Q367 400 308 400Q250 400 211.0 362.5Q172 327 172 253V243Q172 171 211.0 133.5Q250 96 308 96Z" /> </g> </svg>',
  );
export const BRAND_GRAPHIC_DATA_URI =
  "data:image/svg+xml;base64," +
  btoa(
    `<svg xmlns="http://www.w3.org/2000/svg" width="754" height="454" viewBox="-2 -2 754 454"><path d="${MARK_PATH}" fill="${OG_THEME.brand}"/></svg>`,
  );

/** Text nodes only: remove tag delimiters; neither renderer decodes entities. */
export function cardLabel(value: string, limit: number): string {
  const text = value.replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
  const chars = Array.from(text);
  return chars.length > limit ? chars.slice(0, limit - 1).join("") + "…" : text;
}

export interface CardLayout {
  title: string;
  /** Essential record identity, separate from optional measured facts. */
  identifier?: string;
  subtitle?: string;
  stats: { label: string; value: string }[];
  logo?: string | null;
  mark?: string | null;
  entity?: boolean;
}

/** Monospaced headline lines retain a readable size, even for unbroken names. */
export function cardTitleLines(
  title: string,
  width: number,
  size: number,
  maxLines = 3,
): string[] {
  const budget = Math.floor(width / (size * 0.62 - 3));
  let remaining = Array.from(title);
  const lines: string[] = [];
  while (remaining.length) {
    if (remaining.length <= budget || lines.length === maxLines - 1) {
      lines.push(cardLabel(remaining.join(""), budget));
      break;
    }
    const boundary = remaining.slice(0, budget).lastIndexOf(" ");
    const end = boundary > budget / 2 ? boundary : budget;
    lines.push(remaining.slice(0, end).join(""));
    remaining = Array.from(remaining.slice(end).join("").trim());
  }
  return lines;
}

/** The landing and entity cards share artwork, without sharing their data reads. */
export function renderCardLayout(card: CardLayout): string {
  const title = cardLabel(card.title, CARD_LIMITS.title);
  // Only the handler's inlined PNG bytes reach this attribute. No remote URL is
  // ever resolved by the layout, even if a caller supplies one accidentally.
  const logo =
    card.logo && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(card.logo)
      ? card.logo
      : null;
  const mark = card.mark ? cardLabel(card.mark, CARD_LIMITS.mark) : null;
  const markSize = mark && mark.length > 3 ? 58 : 108;
  const graphic = logo
    ? `<div style="display:flex;position:absolute;left:910px;top:224px;width:192px;height:192px;padding:16px;align-items:center;justify-content:center;background:#ffffff;border:1px solid ${OG_THEME.rule};border-radius:4px;"><img src="${logo}" width="158" height="158" style="width:158px;height:158px;object-fit:contain;" /></div>`
    : mark
      ? `<div style="display:flex;position:absolute;left:874px;top:224px;width:258px;height:192px;align-items:center;justify-content:center;font-family:'Geist Mono','Inter';font-size:${markSize}px;font-weight:500;color:${OG_THEME.accent};">${mark}</div>`
      : card.entity
        ? ""
        : `<img src="${BRAND_GRAPHIC_DATA_URI}" width="258" height="155" style="position:absolute;left:874px;top:246px;width:258px;height:155px;" />`;
  const width = graphic ? 750 : 1072;
  const identifier = card.identifier
    ? cardLabel(card.identifier, CARD_LIMITS.eyebrow)
    : null;
  const stats = card.stats.slice(0, 4);
  // Bound all populated combinations, not just today's short landing copy.
  // At most two subtitle/fact lines leave room above the domain at y=562.
  const dense = Boolean(card.subtitle && stats.length);
  const titleSize =
    dense && title.length > 17
      ? 48
      : title.length <= 17
        ? 84
        : title.length <= 32
          ? 72
          : title.length <= 52
            ? 60
            : 48;
  const contentTop = dense && identifier ? 128 : 176;
  const statWidth = Math.min(250, width / Math.max(stats.length, 1));
  const statCells = stats
    .map((stat, index) => {
      const rawLabel = cardLabel(stat.label, CARD_LIMITS.statLabel);
      const label = rawLabel.slice(0, 1).toUpperCase() + rawLabel.slice(1);
      const value = cardLabel(stat.value, CARD_LIMITS.statValue);
      const valueSize = Math.max(
        22,
        Math.min(
          32,
          Math.floor((statWidth - 24) / (Math.max(value.length, 1) * 0.62)),
        ),
      );
      return `<div style="display:flex;flex-direction:column;width:${statWidth}px;padding-right:18px;${index ? `border-left:1px solid ${OG_THEME.rule};padding-left:22px;` : ""}"><p style="display:block;margin:0;font-size:18px;line-height:1.2;color:${OG_THEME.muted};word-break:break-word;line-clamp:2;">${label}</p><p style="display:block;margin:0;font-family:'Geist Mono','Inter';font-size:${valueSize}px;font-weight:500;color:${OG_THEME.accent};line-height:1.2;margin-top:12px;word-break:break-all;line-clamp:2;">${value}</p></div>`;
    })
    .join("");
  return `<div style="display:flex;position:relative;width:1200px;height:630px;background:${OG_THEME.canvas};color:${OG_THEME.ink};font-family:'Geist','Inter';overflow:hidden;">
    <img src="${WORDMARK_DATA_URI}" alt="${WORDMARK}" width="244" height="34" style="position:absolute;left:64px;top:52px;width:244px;height:34px;" />
    <div style="display:flex;position:absolute;left:64px;top:${contentTop}px;width:${width}px;flex-direction:column;">
      ${identifier && identifier !== title ? `<div style="display:flex;font-family:'Geist Mono','Inter';font-size:23px;color:${OG_THEME.accent};margin-bottom:20px;">${identifier}</div>` : ""}
      ${cardTitleLines(title, width, titleSize, dense ? 2 : 3)
        .map(
          (line) =>
            `<div style="display:flex;font-family:'Geist Mono','Inter';font-size:${titleSize}px;font-weight:500;line-height:1.14;letter-spacing:-3px;">${line}</div>`,
        )
        .join("")}
      ${card.subtitle ? `<p style="display:block;margin:0;max-width:${width}px;font-size:29px;font-weight:500;line-height:1.4;color:${OG_THEME.muted};margin-top:28px;word-break:break-word;line-clamp:2;">${cardLabel(card.subtitle, 90)}</p>` : ""}
      ${stats.length ? `<div style="display:flex;align-items:flex-start;margin-top:38px;">${statCells}</div>` : ""}
    </div>
    ${graphic}
    <div style="display:flex;position:absolute;left:64px;bottom:46px;font-family:'Geist Mono','Inter';font-size:21px;font-weight:500;color:${OG_THEME.muted};">api.metagraph.sh</div>
  </div>`.replace(/>\s+</g, "><");
}

/** Derive glyphs after normalization so brand text and ellipses cannot drift. */
export function cardGlyphs(markup: string): string {
  return markup.replace(/<[^>]*>/g, "") + "…";
}
