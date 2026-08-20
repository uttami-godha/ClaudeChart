/**
 * ClaudeChart — self-contained viewer generator.
 *
 * Bundles a set of ChangeEvents with the shared webview renderer + styles into a
 * single HTML file that plays them back in any browser (no server, no VS Code).
 * Used by the scenario generators (testlab/*). Reads webview assets relative to
 * the current working directory — run generators from the repo root.
 */

import * as fs from "node:fs";
import type { ChangeEvent } from "./events.ts";

export function viewerHtml(events: ChangeEvent[], subtitle = "edit replay"): string {
  const css = fs.readFileSync("webview/style.css", "utf8");
  const app = fs.readFileSync("webview/app.js", "utf8");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ClaudeChart — ${subtitle}</title>
<style>${css}</style></head>
<body>
  <header>
    <span class="brand">ClaudeChart</span>
    <span class="dim">${subtitle}</span>
    <span class="totals" id="totals"></span>
  </header>
  <div id="lanes"><div class="empty">waiting for sessions…</div></div>
  <script>window.__CLAUDECHART_EVENTS__ = ${JSON.stringify(events)};</script>
  <script>${app}</script>
</body></html>
`;
}