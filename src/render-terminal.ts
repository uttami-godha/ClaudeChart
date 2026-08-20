/**
 * ClaudeChart — terminal frontend.
 *
 * Consumes the frozen ChangeEvent contract as JSONL on stdin and renders the
 * codebase structure as a live tree, animating each change as it arrives:
 * the touched file lights up, its +/- line counts update, and the rationale
 * ("why") is shown. This is one of the thin per-IDE frontends — it depends only
 * on the wire format, not on the Agent SDK or the event core.
 *
 * Run (animated, in a real terminal):
 *   node src/demo.ts --json | node src/render-terminal.ts
 *
 * When stdout is not a TTY (piped/captured), it prints one plain frame per
 * event instead of doing full-screen animation, so logs stay readable.
 */

import * as readline from "node:readline";

// — ANSI helpers (no dependency) —————————————————————————————————————
const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  green: "\x1b[32m", red: "\x1b[31m", cyan: "\x1b[36m", yellow: "\x1b[33m",
  invert: "\x1b[7m",
};
const isTTY = Boolean(process.stdout.isTTY);
const clearHome = "\x1b[2J\x1b[H";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface StructureDelta {
  imports: string[]; dependents: string[]; addedImports: string[]; removedImports: string[];
}
interface ChangeEvent {
  seq: number; tool: string; kind: string; filePath: string;
  hunks: Array<{ before: string; after: string }>; rationale: string;
  structure?: StructureDelta;
}

interface FileState { kind: string; adds: number; dels: number; seq: number; dependents: number; }

const files = new Map<string, FileState>(); // filePath -> cumulative state
let lastEvent: ChangeEvent | null = null;

function countLines(s: string): number {
  if (!s) return 0;
  return s.replace(/\n$/, "").split("\n").length;
}

function applyEvent(ev: ChangeEvent): void {
  let adds = 0, dels = 0;
  for (const h of ev.hunks) { adds += countLines(h.after); dels += countLines(h.before); }
  const prev = files.get(ev.filePath) ?? { kind: ev.kind, adds: 0, dels: 0, seq: 0, dependents: 0 };
  files.set(ev.filePath, {
    kind: ev.kind,
    adds: prev.adds + adds,
    dels: prev.dels + dels,
    seq: ev.seq,
    dependents: ev.structure?.dependents.length ?? prev.dependents,
  });
  lastEvent = ev;
}

// — Build an indented tree from the touched file paths —————————————————
interface Node { name: string; children: Map<string, Node>; path?: string; }

function buildTree(): Node {
  const root: Node = { name: "", children: new Map() };
  for (const path of [...files.keys()].sort()) {
    let node = root;
    const parts = path.split("/");
    parts.forEach((part, i) => {
      let child = node.children.get(part);
      if (!child) { child = { name: part, children: new Map() }; node.children.set(part, child); }
      if (i === parts.length - 1) child.path = path;
      node = child;
    });
  }
  return root;
}

function badge(fs: FileState, active: boolean): string {
  const plus = fs.adds ? `${C.green}+${fs.adds}${C.reset}` : "";
  const minus = fs.dels ? `${C.red}-${fs.dels}${C.reset}` : "";
  const bar = `${C.green}${"▮".repeat(Math.min(fs.adds, 20))}${C.red}${"▮".repeat(Math.min(fs.dels, 20))}${C.reset}`;
  const kind = `${C.dim}${fs.kind}${C.reset}`;
  const blast = fs.dependents ? `${C.yellow}↳${fs.dependents}${C.reset}` : "";
  const dot = active ? `${C.cyan}${C.bold}◆${C.reset}` : " ";
  return `${dot}${plus} ${minus} ${bar} ${kind}${blast}`;
}

function renderTreeLines(node: Node, depth: number, activePath: string | null, out: string[]): void {
  const kids = [...node.children.values()].sort((a, b) => {
    const ad = a.children.size ? 0 : 1, bd = b.children.size ? 0 : 1; // dirs first
    return ad - bd || a.name.localeCompare(b.name);
  });

  for (const child of kids) {
    const indent = "  ".repeat(depth);
    if (child.path) {
      const fs = files.get(child.path)!;
      const active = child.path === activePath;
      const name = active ? `${C.cyan}${C.bold}${child.name}${C.reset}` : `${C.bold}${child.name}${C.reset}`;
      out.push(`${indent}${name}  ${badge(fs, active)}`);
    } else {
      out.push(`${indent}${C.dim}${child.name}/${C.reset}`);
    }
    renderTreeLines(child, depth + 1, activePath, out);
  }
}

function frame(activePath: string | null): string {
  const out: string[] = [];
  out.push(`${C.bold}${C.cyan}ClaudeChart${C.reset}  ${C.dim}live change map${C.reset}`);
  out.push("");
  renderTreeLines(buildTree(), 0, activePath, out);
  out.push("");

  if (lastEvent) {
    out.push(`${C.yellow}  #${lastEvent.seq} ${lastEvent.kind} ${lastEvent.filePath}${C.reset}`);
    if (lastEvent.rationale) out.push(`${C.dim}why:${C.reset} ${lastEvent.rationale}`);

    const st = lastEvent.structure;
    if (st) {
      const seg = [`${C.dim}imports${C.reset} ${st.imports.length}`, `${C.dim}dependents${C.reset} ${st.dependents.length}`];
      if (st.addedImports.length) seg.push(`${C.green}+edge ${st.addedImports.join(", ")}${C.reset}`);
      if (st.removedImports.length) seg.push(`${C.red}-edge ${st.removedImports.join(", ")}${C.reset}`);
      out.push("  " + seg.join("  •  "));
      if (st.dependents.length) out.push(`  ${C.dim}blast radius:${C.reset} ${st.dependents.join(", ")}`);
    }
  }

  const totals = [...files.values()].reduce((a, f) => ({ adds: a.adds + f.adds, dels: a.dels + f.dels }), { adds: 0, dels: 0 });
  out.push(`${C.dim}${files.size} file(s)  ${C.green}+${totals.adds}${C.reset} ${C.red}-${totals.dels}${C.reset}`);
  return out.join("\n");
}

function draw(activePath: string | null): void {
  if (isTTY) process.stdout.write(clearHome + frame(activePath) + "\n");
  else process.stdout.write("\n" + frame(activePath) + "\n");
}

async function main() {
  // Buffer incoming events, then play them back with pacing so the tree animates
  // even when the producer emits everything at once (a pipe delivers in a burst).
  const queue: ChangeEvent[] = [];
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const s = line.trim().replace(/^event:\s*/, "");
    if (!s.startsWith("{")) return;
    try {
      const ev = JSON.parse(s) as ChangeEvent;
      if (ev && ev.filePath && Array.isArray(ev.hunks)) queue.push(ev);
    } catch { /* not a ChangeEvent line — ignore */ }
  });

  const closed = new Promise<void>((res) => rl.on("close", res));

  const stepMs = isTTY ? 700 : 0;
  let done = false;
  closed.then(() => { done = true; });

  while (!done || queue.length) {
    if (queue.length) {
      const ev = queue.shift()!;
      applyEvent(ev);
      draw(ev.filePath);       // highlight the just-changed file
      await sleep(stepMs);
    } else {
      await sleep(20);
    }
  }

  draw(null);                  // final frame, nothing highlighted
}

main();