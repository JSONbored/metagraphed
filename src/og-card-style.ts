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

/** Text nodes only: remove tag delimiters; neither renderer decodes entities. */
export function cardLabel(value: string, limit: number): string {
  const text = value.replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
  const chars = Array.from(text);
  return chars.length > limit ? chars.slice(0, limit - 1).join("") + "…" : text;
}

export interface CardLayout {
  title: string;
  eyebrow: string;
  subtitle?: string;
  stats: { label: string; value: string }[];
  logo?: string | null;
  mark?: string | null;
}

/** The landing and entity cards share artwork, without sharing their data reads. */
export function renderCardLayout(card: CardLayout): string {
  const title = cardLabel(card.title, CARD_LIMITS.title);
  const eyebrow = cardLabel(card.eyebrow.toUpperCase(), CARD_LIMITS.eyebrow);
  const titleSize = title.length <= 24 ? 68 : title.length <= 48 ? 54 : 42;
  const stats = card.stats.slice(0, 4);
  const statWidth = stats.length > 3 ? 190 : stats.length > 2 ? 244 : 300;
  const statCells = stats
    .map((stat) => {
      const label = cardLabel(stat.label.toUpperCase(), CARD_LIMITS.statLabel);
      const value = cardLabel(stat.value, CARD_LIMITS.statValue);
      // Keep large counts on one line when they fit; very long values retain
      // a readable floor and can wrap inside their own bounded column.
      const valueSize = Math.max(
        22,
        Math.min(
          36,
          Math.floor((statWidth - 24) / (Math.max(value.length, 1) * 0.62)),
        ),
      );
      return `<div style="display:flex;flex-direction:column;width:${statWidth}px;padding-right:24px;">
      <div style="display:flex;font-size:16px;font-weight:500;line-height:1.2;color:${OG_THEME.muted};letter-spacing:1px;word-break:break-word;">${label}</div>
      <div style="display:flex;font-family:'Geist Mono','Inter';font-size:${valueSize}px;font-weight:500;color:${OG_THEME.accent};line-height:1.2;margin-top:10px;word-break:break-all;">${value}</div>
    </div>`;
    })
    .join("");
  // Only the handler's inlined PNG bytes reach this attribute. No remote URL is
  // ever resolved by the layout, even if a caller supplies one accidentally.
  const logo =
    card.logo && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(card.logo)
      ? card.logo
      : null;
  const mark = card.mark ? cardLabel(card.mark, CARD_LIMITS.mark) : null;
  const markSize = mark && mark.length > 3 ? 24 : 32;
  const tile =
    logo || mark
      ? `<div style="display:flex;align-items:center;justify-content:center;width:88px;height:88px;flex-shrink:0;margin-right:28px;background:${logo ? "#ffffff" : OG_THEME.raised};border:1px solid ${OG_THEME.rule};border-radius:4px;">
    ${logo ? '<img src="' + logo + '" width="64" height="64" style="width:64px;height:64px;object-fit:contain;" />' : '<div style="display:flex;font-size:' + markSize + "px;font-weight:700;color:" + OG_THEME.accent + ';">' + mark + "</div>"}
  </div>`
      : "";
  return `<div style="display:flex;flex-direction:column;width:1200px;height:630px;background:${OG_THEME.canvas};color:${OG_THEME.ink};font-family:'Geist','Inter';overflow:hidden;">
    <div style="display:flex;height:4px;width:1200px;background:${OG_THEME.rule};flex-shrink:0;"><div style="display:flex;width:192px;height:4px;background:${OG_THEME.brand};"></div></div>
    <div style="display:flex;align-items:center;justify-content:space-between;height:104px;padding:0 64px;border-bottom:1px solid ${OG_THEME.rule};flex-shrink:0;">
      <div style="display:flex;align-items:center;"><img src="${LOGO_DATA_URI}" width="50" height="50" style="width:50px;height:50px;" /><div style="display:flex;font-size:30px;font-weight:700;letter-spacing:-0.5px;margin-left:8px;">${WORDMARK}</div></div>
      <div style="display:flex;max-width:440px;word-break:break-word;padding:8px 12px;border:1px solid ${OG_THEME.rule};font-size:18px;font-weight:500;color:${OG_THEME.accent};letter-spacing:1px;">${eyebrow}</div>
    </div>
    <div style="display:flex;flex:1;align-items:center;padding:32px 64px;">
      ${tile}<div style="display:flex;flex-direction:column;width:${tile ? 956 : 1072}px;">
        <div style="display:flex;font-size:${titleSize}px;font-weight:700;line-height:1.08;letter-spacing:-1px;word-break:break-word;">${title}</div>
        ${card.subtitle ? '<div style="display:flex;font-size:28px;font-weight:500;line-height:1.35;color:' + OG_THEME.muted + ';margin-top:22px;max-width:940px;word-break:break-word;">' + cardLabel(card.subtitle, 90) + "</div>" : ""}
      </div>
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between;height:152px;padding:24px 64px;background:${OG_THEME.layer};border-top:1px solid ${OG_THEME.rule};flex-shrink:0;">
      <div style="display:flex;">${statCells}</div>
      <div style="display:flex;align-items:center;flex-shrink:0;"><div style="display:flex;width:8px;height:8px;background:${OG_THEME.brand};margin-right:12px;"></div><div style="display:flex;font-size:20px;font-weight:500;color:${OG_THEME.muted};">api.metagraph.sh</div></div>
    </div>
  </div>`.replace(/>\s+</g, "><");
}

/** Derive glyphs after normalization so brand text and ellipses cannot drift. */
export function cardGlyphs(markup: string): string {
  return markup.replace(/<[^>]*>/g, "");
}
