import { describe, expect, it } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { AccountAddress } from "@/components/metagraphed/account-address";

// #6424: blocks.$ref.tsx's "Author" and extrinsics.$hash.tsx's "Signer" rendered
// their ss58 through a bare CopyableCode — copy-only, no navigation — while the
// events table further down the SAME page linked its ss58 values via
// AccountAddress. Both fields were dead ends.
//
// AccountAddress composes TanStack's <Link>, which needs a router context to
// render; this suite is node-environment with no DOM. So these CREATE the
// element and walk the returned tree — the wiring (does it produce a
// /accounts/$ss58 link, with what text) is exactly what regressed.
const SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";

type AnyProps = Record<string, unknown>;

/** Depth-first search for the first element whose props satisfy `match`. */
function findElement(
  node: ReactNode,
  match: (props: AnyProps) => boolean,
): ReactElement<AnyProps> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findElement(child, match);
      if (hit) return hit;
    }
    return undefined;
  }
  if (!isValidElement(node)) return undefined;
  const el = node as ReactElement<AnyProps>;
  if (match(el.props)) return el;
  return findElement(el.props.children as ReactNode, match);
}

const linkIn = (node: ReactNode) => findElement(node, (p) => p.to === "/accounts/$ss58");

describe("AccountAddress links ss58 values to their account page", () => {
  it("renders a /accounts/$ss58 link for a valid ss58", () => {
    const tree = AccountAddress({ ss58: SS58, fallback: "—" });
    const link = linkIn(tree);
    expect(link).toBeDefined();
    expect(link?.props.params).toEqual({ ss58: SS58 });
    // The full value stays reachable via title, however the text is shortened.
    expect(link?.props.title).toBe(SS58);
  });

  it("truncate={false} shows the whole address — the Author/Signer field's existing treatment", () => {
    const link = linkIn(AccountAddress({ ss58: SS58, fallback: "—", truncate: false }));
    expect(link?.props.children).toBe(SS58);
  });

  it("still truncates by default, so table cells are unaffected", () => {
    const link = linkIn(AccountAddress({ ss58: SS58, fallback: "—" }));
    expect(link?.props.children).not.toBe(SS58);
    expect(String(link?.props.children)).toMatch(/…/);
  });

  it("renders the fallback — not a link — when the value is missing or invalid", () => {
    for (const bad of [null, undefined, "", "not-an-ss58"]) {
      const tree = AccountAddress({ ss58: bad, fallback: "—" });
      expect(linkIn(tree), `expected no link for ${JSON.stringify(bad)}`).toBeUndefined();
      // The component returns <>{fallback}</>, so the fallback is the fragment's
      // child -- this is what keeps the fields' existing "—" for an absent value.
      expect((tree as ReactElement<AnyProps>).props.children).toBe("—");
    }
  });

  it("valueClassName merges onto the link's own hover:underline class", () => {
    const link = linkIn(
      AccountAddress({
        ss58: SS58,
        fallback: "—",
        truncate: false,
        valueClassName: "truncate min-w-0",
      }),
    );
    expect(link?.props.className).toBe("hover:underline truncate min-w-0");
  });

  it("omits valueClassName from the link's className when not passed", () => {
    const link = linkIn(AccountAddress({ ss58: SS58, fallback: "—" }));
    expect(link?.props.className).toBe("hover:underline");
  });

  it("keeps a copy affordance carrying the untruncated value", () => {
    // The issue requires the untruncated copy affordance CopyableCode offered to
    // survive the switch: the copy button must still copy the FULL ss58, even
    // when the visible text is shortened.
    const copy = findElement(
      AccountAddress({ ss58: SS58, fallback: "—" }),
      (p) => p.value === SS58 && p.label === "account",
    );
    expect(copy).toBeDefined();
  });
});
