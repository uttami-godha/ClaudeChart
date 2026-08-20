/**
 * ClaudeChart — SDK-driven runner (option A).
 *
 * Runs the Claude Agent SDK on a coding task, enriches every proposed edit with
 * structural context, and feeds it through the normalized-event core. Edits are
 * intercepted via `canUseTool` BEFORE they apply. Emits human-readable output,
 * or JSONL with `--json` for piping into a frontend.
 *
 * Requires @anthropic-ai/claude-agent-sdk (install it to use this runner).
 * Until then, `src/demo.ts` exercises the same core+structure with synthetic
 * inputs and no dependency.
 *
 * ⚠️ VERIFY-AGAINST-INSTALLED-TYPES — after install, confirm the tagged spots
 * against node_modules/@anthropic-ai/claude-agent-sdk types:
 *   [V1] query import + options names   [V3] canUseTool signature + return
 *   [V2] tool-input field names live in events.ts
 */

import { query } from "@anthropic-ai/claude-agent-sdk"; // [V1] confirm package name + export
import * as fs from "node:fs";
import * as path from "node:path";
import { normalizeEdit, emitJson, render, resetSeq } from "./events.ts";
import { DependencyGraph, enrich } from "./structure.ts";
import { stdinGate, autoAllowGate } from "./gate.ts";

const jsonMode = process.argv.includes("--json");
const SESSION =
  process.argv.find((a) => a.startsWith("--session="))?.split("=")[1] ??
  process.env.CLAUDECHART_SESSION ??
  "default";
// `--gate` awaits a frontend Decision per edit on stdin; default auto-allows.
const gate = process.argv.includes("--gate") ? stdinGate() : autoAllowGate();
let latestRationale = "";

// Seed an import graph from the workspace so dependents/blast-radius are real.
function scanWorkspace(root: string): DependencyGraph {
  const graph = new DependencyGraph();
  const skip = new Set(["node_modules", ".git", "dist", ".claude"]);
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) {
        graph.setFile(path.relative(root, abs).split(path.sep).join("/"), fs.readFileSync(abs, "utf8"));
      }
    }
  };
  walk(root);
  return graph;
}

async function main() {
  const task =
    process.argv.filter((a) => a !== "--json").slice(2).join(" ") ||
    "Create a file greeting.txt containing a friendly one-line hello, then add a second line with today's purpose.";

  resetSeq();
  const root = process.cwd();
  const graph = scanWorkspace(root);

  const response = query({
    prompt: task,
    options: {
      // [V1] confirm these option names exist in the installed SDK version.
      model: "claude-opus-4-8",
      permissionMode: "default", // route edits through canUseTool instead of auto-applying

      // [V3] canUseTool: called with the PROPOSED tool + input before it runs.
      canUseTool: async (toolName: string, input: any) => {
        const ev = normalizeEdit(toolName, input, latestRationale);
        if (!ev) return { behavior: "allow" as const, updatedInput: input }; // non-edit tools pass through

        ev.structure = enrich(ev.filePath, ev.hunks, graph);
        ev.sessionId = SESSION;
        jsonMode ? emitJson(ev) : render(ev);

        // Block until the frontend approves/rejects this specific edit.
        const d = await gate.decide(ev.seq);
        if (d.behavior === "deny") {
          return {
            behavior: "deny" as const,
            message: d.message ?? "rejected in ClaudeChart",
          };
        }

        // Approved: reflect the pending change in the graph so later edges resolve.
        const after = ev.hunks.map((h) => h.after).join("\n");
        if (after) graph.setFile(ev.filePath, after);
        return { behavior: "allow" as const, updatedInput: input };
      },
    },
  });

  // [V2 lives in events.ts] Confirm message.type values + assistant content shape.
  for await (const message of response) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text") latestRationale = block.text; // "why" for the next edit
      }
    } else if (message.type === "result" && !jsonMode) {
      console.log(`\n=== done (${message.subtype ?? "ok"}) ===`);
    }
  }

  gate.close();
}

main().catch((err) => {
  console.error("ClaudeChart failed:", err);
  process.exit(1);
});