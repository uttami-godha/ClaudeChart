# ClaudeChart

**A live, explained, vetoable view of an AI agent editing your code, across sessions.**

ClaudeChart visualizes the changes a Claude agent proposes and makes — not as a static diff after the fact, but as an animated **change map** that shows, in real time, **what** is changing, **why**, **what it ripples into** — and lets you approve or reject each edit before it lands.

The same normalized event stream drives multiple frontends: a terminal renderer and a VS Code webview dashboard. Everything except the live Agent SDK integration runs with zero dependencies.

---

## Features

- **Live change map** — a file tree that animates as each edit arrives (create / edit / multi-edit), with growing add/delete bars and per-file counts.
- **Rationale ("why")** — every change carries the reasoning that produced it, shown alongside a before/after diff.
- **Structural impact** — each change is enriched with dependency-graph context: what the file imports, **who depends on it (blast radius)**, and which import edges the edit added or removed.
- **Approval gating** — a reverse channel lets a frontend approve/reject each proposed edit; the producer blocks until you decide, so *reject* actually stops the edit.
- **Multi-session dashboard** — one panel per concurrent agent session, each with its own tree, blast-radius badges, rationale, and gating.
- **Two frontends, one contract** — a terminal viewer and a VS Code webview consume the identical `ChangeEvent` wire format; neither depends on the agent SDK.

---

## Quick start

Requires **Node ≥ 22.6** (runs `.ts` directly via native type stripping; developed on Node 26). No install needed for the demos.

```bash
# Terminal: watch the demo change map animate
npm run viz

# Terminal control surface: approve/reject each edit interactively (type a / d)
npm run gate
```

### View the webview

The webview is a self-contained HTML file — open it in any browser, no server or VS Code required.

```bash
# Generate and open the multi-session dashboard (two sessions side by side)
npm run dashboard
open testlab/dashboard.html          # macOS; or just open the file in a browser

# Or the single-session NPI-detector edit replay
npm run npi:viewer
open testlab/npi-viewer.html
```

Opened standalone, the page auto-plays a bundled event feed. `webview/index.html` is the same UI wired for VS Code (it plays a builtin sample when opened directly).

### Inside VS Code (live agent)

Requires `@anthropic-ai/claude-agent-sdk` and a build:

```bash
npm install
npm run build:ext
```

Then run the extension and use the commands **"ClaudeChart: Open Dashboard"** and **"ClaudeChart: New Session."** Each session spawns a producer whose proposed edits stream into the dashboard as a new lane; the default producer is set by the `claudechart.producer` setting (defaults to the dependency-free demo — swap to `src/visualize.ts` to drive the real agent).

---

## What makes it different from `git diff`

`git diff` shows what **already** changed. ClaudeChart shows what's **about to** change, **why**, and **what it ripples into** — and lets you stop it.

| | `git diff` | ClaudeChart |
|---|---|---|
| Tense | Past — changes already on disk | Live — each edit intercepted **before** it applies |
| Why | Just the lines | Rationale attached to each change |
| Control | Read-only | A gate — approve/reject in the loop |
| Context | Line-oriented, file-local | Structure: imports, **blast radius**, edges ± |
| Shape | Static aggregate snapshot | Animated sequence, step by step |
| Scope | One working tree | Many concurrent agent sessions, side by side |

It's not a replacement for `git diff` — it's about understanding and steering an agent's edits at the moment they happen.

---

## …vs. just watching the agent's terminal

The Claude terminal already streams edits as they happen — so why a separate view?

- **A map, not a scroll.** The terminal is linear scrollback: edits stream past interleaved with reasoning, tool output, and retries, then vanish above the fold. ClaudeChart keeps a **persistent, spatial file tree** that accumulates state, so you see the current shape of *all* changes at once instead of reconstructing it from history.
- **Just the signal.** It isolates the file changes — what / why / impact — and filters out the surrounding noise (thinking, bash output, retries) the transcript mixes in.
- **Structural impact the terminal never shows.** The terminal shows the diff of the file being touched; it doesn't tell you who *depends* on that file. ClaudeChart overlays the dependency graph — blast radius and added/removed import edges.
- **Intercept, don't just observe.** It taps the agent loop (`canUseTool`) rather than reading printed output, so it sees each edit **before it applies** and can block it. Reading the terminal is after-the-fact.
- **A control surface, not a readout.** Approve/reject is a structured, per-edit gate that can live in a separate window or your editor — and works across many sessions — rather than an inline prompt buried in one session's transcript.
- **Many sessions, one view.** Watching N agents means N terminal panes, each its own scrollback. ClaudeChart fans them into one dashboard with a lane each.
- **A reusable surface.** The edit stream is a normalized event contract you can render in the terminal, a browser, or VS Code — and record and replay as a self-contained page — not read-only console text.

Complementary, like above: the terminal is the full agent trajectory (reasoning, every tool call, errors); ClaudeChart is a focused, structured, steerable view of the **edits**.

---

## How it works

A **producer** emits a stream of normalized `ChangeEvent`s (one JSON line each). A **frontend** consumes that stream and renders it. They're fully decoupled at the wire contract, which is why one contract serves many UIs.

```text
Producer ──ChangeEvent JSONL──▶ frontend        (terminal / VS Code webview)
   ▲                              │
   └────────Decision──────────────┘             (approve / reject, gated mode)
```

- **Interception** — the live producer (`src/visualize.ts`) drives the Agent SDK and taps `canUseTool`, so it sees each Edit/Write/MultiEdit **before** it applies and can gate it.
- **Enrichment** — `src/structure.ts` builds a lightweight import graph (regex-based, no external parser) to compute imports, dependents (blast radius), and per-edit edge deltas.
- **Reverse channel** — `src/gate.ts` defines a `Decision` protocol; the frontend's approve/reject travels back over the producer's stdin, and the producer blocks until it arrives.
- **Multi-session** — every `ChangeEvent` and `Decision` carries a `sessionId`, so one dashboard can fan in several producers into separate lanes and route decisions back to the right one.

---

## Project layout

```text
src/
  events.ts          ChangeEvent contract + normalize + terminal render + JSONL wire
  structure.ts       import graph: imports / dependents (blast radius) / edge deltas
  gate.ts            Decision reverse-channel protocol (approve / reject)
  demo.ts            dependency-free demo producer (synthetic fixtures)
  visualize.ts       Agent SDK producer — intercepts edits via canUseTool
  render-terminal.ts terminal frontend (animated tree)
  gate-terminal.ts   terminal control surface (prompts + relays decisions)
  viewer.ts          self-contained HTML viewer generator
  extension.ts       VS Code extension host (multi-session dashboard)
webview/
  index.html          dashboard shell
  style.css           shared styles
  app.js              multi-lane dashboard renderer (consumes the wire format only)
testlab/
  demo scenarios + generated viewers (dashboard.html, npi-viewer.html)
```

---

## Scripts

| Script | What it does |
|---|---|
| `npm run demo` | Run the demo producer (human-readable) |
| `npm run viz` | Demo → terminal change map |
| `npm run gate` | Interactive terminal control surface (approve/reject) |
| `npm run dashboard` | Generate `testlab/dashboard.html` (two-session webview) |
| `npm run npi` / `npm run npi:viewer` | NPI-detector edit scenario → terminal / webview |
| `npm run dev` | Run the Agent SDK producer (requires the SDK) |
| `npm run build:ext` | Build the VS Code extension |
| `npm run typecheck` | Type-check the sources |
