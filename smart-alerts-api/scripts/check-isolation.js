#!/usr/bin/env node
"use strict";

/**
 * Fails CI if smart-alerts-api source ever imports from sibling
 * services. This is the last-line defense against accidental
 * coupling (e.g. require("../../api/src/lib/db")).
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "src");
const FORBIDDEN = [
  /\brequire\(["'](?:\.\.\/){2,}api\//,
  /\brequire\(["'](?:\.\.\/){2,}providers-api\//,
  /\brequire\(["'](?:\.\.\/){2,}bot\//,
  /from\s+["'](?:\.\.\/){2,}api\//,
];

let failures = 0;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile() && /\.(m?js|ts)$/.test(entry.name)) check(full);
  }
}

function check(file) {
  const src = fs.readFileSync(file, "utf8");
  for (const rx of FORBIDDEN) {
    if (rx.test(src)) {
      failures++;
      console.error(`[isolation] ${file} matches forbidden import: ${rx}`);
    }
  }
}

walk(ROOT);
if (failures > 0) {
  console.error(`[isolation] ${failures} violation(s) — aborting`);
  process.exit(1);
}
console.log("[isolation] ok");
