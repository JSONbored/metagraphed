import { formatLlmMarkdownText } from "./formatting.mjs";

export function escapeMarkdownLinkText(value, { maxLength = 240 } = {}) {
  return formatLlmMarkdownText(String(value ?? ""), { maxLength });
}

function truncateText(value, maxLength) {
  return Array.from(String(value ?? "")).slice(0, maxLength).join("");
}

// CommonMark-safe inline code: lengthen the backtick fence until the literal
// content fits, and pad with spaces when it starts/ends with a backtick/space.
export function markdownInlineCode(value, { maxLength = 120 } = {}) {
  let content = truncateText(value, maxLength);
  let fence = "`";
  while (content.includes(fence)) {
    fence += "`";
  }
  if (/^[` ]|[` ]$/.test(content)) {
    content = ` ${content} `;
  }
  return `${fence}${content}${fence}`;
}

export function escapeMarkdownHref(value) {
  return encodeURI(String(value ?? "")).replace(/\)/g, "%29");
}

export function markdownLink(label, href) {
  return `[${escapeMarkdownLinkText(label)}](${escapeMarkdownHref(href)})`;
}
