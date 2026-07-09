// Shared between responsive-overflow.spec.ts and generate-overflow-baseline.mjs
// so the two can't silently drift apart.
//
// /explorer deliberately excluded: its default query params
// (?window=7d&pallet=&method=&events_cursor=) never return a response at all
// in local dev (confirmed with curl and Playwright's earliest "commit"
// navigation signal, both hang past 15-45s) -- a real, separate finding, not
// something this check can route around. Re-add once that's resolved.
export const ROUTES = ["/", "/subnets/1", "/endpoints", "/status", "/settings"];

export const VIEWPORTS = [
  { name: "mobile", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop-md", width: 1024, height: 800 },
  { name: "desktop-lg", width: 1280, height: 800 },
];
