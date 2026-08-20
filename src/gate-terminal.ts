/**
 * ClaudeChart — terminal control surface (approval gating).
 *
 * Spawns a gated producer, renders each PROPOSED edit, prompts you on the TTY to
 * allow/deny, and relays the Decision back over the child's stdin. The producer
 * blocks in canUseTool until it hears back — so deny actually stops the edit.
 * This is the terminal analog of the VS Code approve/reject flow; both use the
 * same reverse-channel protocol (src/gate.ts).
 *
 * Run:  node src/gate-terminal.ts                 (drives src/demo.ts --gate)
 *       node src/gate-terminal.ts src/visualize.ts --gate --json   (drives the SDK runner)
 *
 * Answers can be typed interactively, or piped for scripted runs: printf 'a\nd\na\n' | node src/gate-terminal.ts
 */

import * as readline from "node:readline";
import { spawn } from "node:child_process";

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
};

const producerArgs = process.argv.slice(2);
const args = producerArgs.length ? producerArgs : ["src/demo.ts", "--gate", "--json"];

const child = spawn("node", args, { stdio: ["pipe", "pipe", "inherit"] });

// Decouple reading answers from prompting so a piped EOF can't crash a later
// prompt: buffer answers, hand them out as edits arrive, default to allow on EOF.
const answers: string[] = [];
const waiters: Array<(a: string) => void> = [];
let inputClosed = false;

const userRl = readline.createInterface({ input: process.stdin });
userRl.on("line", (line) => {
  const w = waiters.shift();
  if (w) w(line);
  else answers.push(line);
});
userRl.on("close", () => {
  inputClosed = true;
  while (waiters.length) waiters.shift()!(""); // empty => default allow
});

function nextAnswer(): Promise<string> {
  if (answers.length) return Promise.resolve(answers.shift()!);
  if (inputClosed) return Promise.resolve("");
  return new Promise((res) => waiters.push(res));
}

// The producer blocks after each event awaiting its decision, so events arrive
// one at a time — handle them strictly in order.
const fromProducer = readline.createInterface({ input: child.stdout });
fromProducer.on("line", (line) => {
  const s = line.trim().replace(/^event:\s*/, "");
  if (!s.startsWith("{")) return;
  let ev: any;
  try {
    ev = JSON.parse(s);
  } catch {
    return;
  }
  if (ev && ev.filePath && Array.isArray(ev.hunks)) void showAndAsk(ev);
});

child.on("exit", () => {
  userRl.close();
  process.exit(0);
});

async function showAndAsk(ev: any): Promise<void> {
  const bar = "─".repeat(56);
  console.log(
    `\n${bar}\n${C.bold}#${ev.seq} ${ev.kind} ${C.cyan}${ev.filePath}${C.reset}  ${C.dim}(${ev.tool})${C.reset}`,
  );
  if (ev.rationale) console.log(`${C.dim}why:${C.reset} ${ev.rationale}`);

  const st = ev.structure;
  if (st && st.dependents.length)
    console.log(`${C.yellow}blast radius:${C.reset} ${st.dependents.join(", ")}`);
  if (st && st.addedImports.length)
    console.log(`${C.green}+edge${C.reset} ${st.addedImports.join(", ")}`);

  const h = ev.hunks[0] || { before: "", after: "" };
  if (h.before)
    h.before
      .replace(/\n$/, "")
      .split("\n")
      .forEach((l: string) => console.log(`${C.red}  - ${l}${C.reset}`));
  if (h.after)
    h.after
      .replace(/\n$/, "")
      .split("\n")
      .forEach((l: string) => console.log(`${C.green}  + ${l}${C.reset}`));

  process.stdout.write(`${C.bold}approve? [a]llow / [d]eny:${C.reset} `);

  const ans = await nextAnswer();
  const deny = /^d/i.test(ans.trim());
  const decision: any = { seq: ev.seq, behavior: deny ? "deny" : "allow" };
  if (deny) decision.message = "rejected in ClaudeChart";

  child.stdin.write(JSON.stringify(decision) + "\n");
  console.log(
    deny
      ? `${C.red}✗ denied${C.reset}`
      : `${C.green}✓ allowed${C.reset}`,
  );
}