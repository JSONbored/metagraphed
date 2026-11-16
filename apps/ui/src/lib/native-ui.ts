import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import { createElement, type ReactNode } from "react";

/** The UI asks for cached logos and its pre-rendered failure image. */
export function createNativeUiAssets(fetchInternal: (request: Request) => Promise<Response>) {
  return Object.freeze({
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
      }
      if (
        url.pathname.length > 2048 ||
        (!url.pathname.startsWith("/logos/") && url.pathname !== "/og-fallback.png") ||
        url.pathname.includes("%")
      )
        return new Response(null, { status: 404 });
      // Nitro dispatches the asset locally. The caller's host, credentials,
      // request body and headers can never turn this into an outbound fetch.
      return fetchInternal(
        new Request(`http://native-ui.invalid${url.pathname}`, {
          method: request.method,
          signal: request.signal,
        }),
      );
    },
  });
}

/** Match workers-og's HTML input shape without its Worker-only HTMLRewriter. */
export function nativeOgElement(markup: string): ReactNode {
  if (markup.length > 2 * 1024 * 1024) throw new RangeError("Native OG markup is too large");
  let count = 0;
  const convert = (node: DefaultTreeAdapterMap["childNode"], depth: number): ReactNode => {
    if (++count > 16384 || depth > 64) throw new RangeError("Native OG tree exceeds its budget");
    if (node.nodeName === "#text" && "value" in node) {
      const location = node.sourceCodeLocation;
      if (!location) throw new Error("Native OG text has no source location");
      // workers-og deliberately preserves literal entities. Keep exactly the
      // text used for font subsetting instead of parse5's decoded node.value.
      return markup.slice(location.startOffset, location.endOffset);
    }
    if (!("tagName" in node)) return null;
    const attrs = Object.fromEntries(node.attrs.map((attr) => [attr.name, attr.value]));
    const props: {
      style?: Record<string, string>;
      src?: string;
      width?: string;
      height?: string;
      children: ReactNode[];
    } = {
      children: node.childNodes
        .map((child) => convert(child, depth + 1))
        .filter((child) => child !== null),
    };
    if (attrs.style) {
      const entries: [string, string][] = [];
      for (const part of attrs.style
        .replace(/\n/g, "")
        .replace(/\s\s+/g, " ")
        .split(/;(?![^(]*\))/)) {
        const [key, value] = part.split(/:(.+)/);
        if (key && value)
          entries.push([
            key.trim().replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase()),
            value.trim(),
          ]);
      }
      if (entries.length) props.style = Object.fromEntries(entries);
    }
    if (attrs.src) {
      props.src = attrs.src;
      if (attrs.width && attrs.height) {
        props.width = attrs.width;
        props.height = attrs.height;
      }
    }
    return createElement(node.tagName, props);
  };
  return createElement("div", {
    style: { display: "flex", flexDirection: "column" },
    children: parseFragment(markup, { sourceCodeLocationInfo: true })
      .childNodes.map((node) => convert(node, 0))
      .filter((child) => child !== null),
  });
}
