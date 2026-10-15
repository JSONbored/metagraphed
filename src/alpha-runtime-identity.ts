import { createHash } from "node:crypto";
/** Exact audited deployed identities, shared by ingestion and quantity reads. */
export const ALPHA_GENESIS =
  "0x2f0555cc76fc2840a25a6ea3b9637146806f1f44b090c175ffde2a7e5ab36c03";
export const ALPHA_RUNTIMES = {
  454: {
    code: "0x725e3d1eca8d5c29c1f0fa6476d5360661b852f52aebad979d6636e227a431ef",
    metadata:
      "b592bafacd0f3cce1340a91f237f82a531968bd833cbd27339328c80ce92b1cf",
  },
  478: {
    code: "0x7e722b3aa5c9192c98665a5d65fa91364bf9055e21fc90efce6d59bf4ef414e1",
    metadata:
      "2513780705c9e9c1b9fb7e701670fee88cf8419b945100fc26ab87218b03e35a",
  },
} as const;

export function alphaRuntimeOriginalMatches(
  spec: unknown,
  code: unknown,
  digest: unknown,
  scale?: unknown,
): boolean {
  const identity =
    spec === 454 || spec === 478 ? ALPHA_RUNTIMES[spec] : undefined;
  if (!identity || code !== identity.code || digest !== identity.metadata)
    return false;
  if (scale === undefined) return true;
  return (
    typeof scale === "string" &&
    scale.length <= 2_097_154 &&
    /^0x6d6574610e(?:[0-9a-f]{2})+$/.test(scale) &&
    createHash("sha256")
      .update(Buffer.from(scale.slice(2), "hex"))
      .digest("hex") === digest
  );
}
