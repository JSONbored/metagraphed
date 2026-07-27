// Shared between responsive-overflow.spec.ts and generate-overflow-baseline.ts
// so the two can't silently drift apart.
//
export const ROUTES = [
  "/",
  "/subnets/1",
  "/endpoints",
  "/status",
  "/settings",
  "/explorer",
  // #8357: the three templates the 2026-07-27 instrumented audit found
  // escaping the viewport (extrinsic signer row, schemas drift chip,
  // validators table header) -- a real hash/no-param route each so the
  // fixed elements actually render, not an empty/not-found fallback.
  "/extrinsics/0x986f1f7da3d93882e8c19bbe3b303ef8ba5454062272446598d17aa599ca4428",
  "/apis/schemas",
  "/validators",
];

export const VIEWPORTS = [
  { name: "mobile", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop-md", width: 1024, height: 800 },
  { name: "desktop-lg", width: 1280, height: 800 },
];
