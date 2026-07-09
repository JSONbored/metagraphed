#!/usr/bin/env node
// Regenerates overflow-baseline.json against a running dev server (start one
// first: `npm run dev --workspace=apps/ui`). Run after intentionally fixing a
// tracked overflow bug (shrinks the baseline) or after confirming a new
// finding is an accepted layout choice, not a bug (grows it). Review the diff
// before committing -- a shrinking baseline should correspond to a real fix
// you made, and a growing one should correspond to a finding you deliberately
// accepted, not just "make the test pass."
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import prettier from "prettier";
import { findOverflowViolations } from "./find-overflow-violations.js";
import { ROUTES, VIEWPORTS } from "./overflow-check.config.js";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:8080";

const browser = await chromium.launch();
const page = await browser.newPage();
const baseline = {};

for (const route of ROUTES) {
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(BASE_URL + route);
    await page.waitForLoadState("networkidle");
    const violations = await page.evaluate(findOverflowViolations, viewport.width);
    const fingerprints = [...new Set(violations.map((v) => `${v.tag}:${v.cls}`))].sort();
    baseline[`${route}@${viewport.width}`] = fingerprints;
    console.log(`${route}@${viewport.width}: ${fingerprints.length} known violation(s)`);
  }
}

await browser.close();

const outPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "overflow-baseline.json");
// Prettier-formatted, not plain JSON.stringify: apps/ui's format:check gates
// this file too, and Prettier collapses short arrays onto one line where
// JSON.stringify always expands them -- writing raw JSON.stringify output
// here previously failed CI's format:check every time the baseline changed.
const formatted = await prettier.format(JSON.stringify(baseline, null, 2), {
  ...(await prettier.resolveConfig(outPath)),
  filepath: outPath,
});
writeFileSync(outPath, formatted);
console.log(`\nWrote ${outPath}`);
