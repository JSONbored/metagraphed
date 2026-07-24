// Shared between responsive-overflow.spec.ts and generate-overflow-baseline.ts
// so the two can't silently drift apart.
//
export const ROUTES = ["/", "/subnets/1", "/endpoints", "/status", "/settings", "/explorer"];

export const VIEWPORTS = [
  { name: "mobile", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop-md", width: 1024, height: 800 },
  { name: "desktop-lg", width: 1280, height: 800 },
];
