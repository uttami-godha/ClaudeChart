/**
 * ClaudeChart — dependency-free demo producer.
 *
 * Feeds synthetic tool inputs (the shape the Agent SDK's canUseTool hands you)
 * through the normalized-event core, enriches each with structural context from
 * a synthetic workspace snapshot, and renders or emits the result. Validates the
 * whole spine — schema + structure + render — with no SDK and no registry.
 *
 * Run:  node src/demo.ts             (human-readable)
 *       node src/demo.ts --json      (JSONL for piping into a frontend)
 */

import { normalizeEdit, render, emitJson, resetSeq } from "./events.ts";
import { DependencyGraph, enrich } from "./structure.ts";
import { stdinGate, autoAllowGate } from "./gate.ts";

const jsonMode = process.argv.includes("--json");
const SESSION =
  process.argv.find((a) => a.startsWith("--session="))?.split("=")[1] ??
  process.env.CLAUDECHART_SESSION ??
  "default";

// --gate blocks after each edit until a Decision arrives on stdin (from a
// parent relaying a frontend's approve/reject). Default: auto-allow.
const gate = process.argv.includes("--gate") ? stdinGate() : autoAllowGate();

// Synthetic workspace snapshot → gives dependents/blast-radius real values.
//   main.ts imports app.ts + util.ts, app.ts imports util.ts.
// So editing app.ts has main.ts as a dependent, and app.ts imports util.ts.
const graph = new DependencyGraph({
  "src/main.ts": 'import { run } from "./app";\nimport { util } from "./util";',
  "src/app.ts": 'import { foo } from "./util";\nexport function run() { return foo(1); }',
  "src/util.ts": "export const util = 1;\nexport function foo(x: number) { return x; }",
  "src/log.ts": "export function log(...a: unknown[]) { console.log(...a); }",
  "greeting.txt": "",
});

const fixtures: Array<{ tool: string; input: any; rationale: string }> = [
  {
    tool: "Write",
    rationale: "Starting with a greeting file so there's an entry point to extend.",
    input: { file_path: "greeting.txt", content: "Hello from ClaudeChart!\n" },
  },
  {
    tool: "Edit",
    rationale: "Adding a purpose line so the file states what today's work is.",
    input: {
      file_path: "greeting.txt",
      old_string: "Hello from ClaudeChart!\n",
      new_string: "Hello from ClaudeChart!\nToday: prove the visualizer spine end to end.\n",
    },
  },
  {
    tool: "MultiEdit",
    rationale: "Adding tracing to app.ts — pulls in a new dependency on ./log.",
    input: {
      file_path: "src/app.ts",
      edits: [
        {
          old_string: 'import { foo } from "./util";',
          new_string: 'import { foo } from "./util";\nimport { log } from "./log";',
        },
        { old_string: "return foo(1);", new_string: 'log("call"); return foo(1);' },
      ],
    },
  },
  {
    tool: "Bash",
    rationale: "This one is NOT a file edit — the core should ignore it.",
    input: { command: "npm test" },
  },
];

resetSeq();
for (const f of fixtures) {
  const ev = normalizeEdit(f.tool, f.input, f.rationale);
  if (!ev) {
    if (!jsonMode) console.log(`\n(ignored non-edit tool: ${f.tool})`);
    continue;
  }

  ev.structure = enrich(ev.filePath, ev.hunks, graph);
  ev.sessionId = SESSION;
  if (jsonMode) emitJson(ev);
  else render(ev);

  // Block until the frontend decides. Outcome goes to stderr so stdout stays a
  // clean event stream. (A real producer would apply the edit only on allow.)
  const d = await gate.decide(ev.seq);
  console.error(`[gate] #${ev.seq} ${d.behavior}${d.message ? ` — ${d.message}` : ""}`);
}
gate.close();
if (!jsonMode) console.log("\n=== demo done ===");