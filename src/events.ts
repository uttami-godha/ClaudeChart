/**
 * ClaudeChart — normalized event core.
 *
 * No SDK dependency. Defines the ChangeEvent contract that every frontend
 * (VS Code / JetBrains / terminal) consumes, the mapping from a raw tool input
 * to a ChangeEvent, and a terminal renderer. Both the SDK-driven runner
 * (visualize.ts) and the dependency-free demo (demo.ts) feed through here.
 */

import type { StructureDelta } from "./structure.ts";

export type ChangeKind = "create" | "edit" | "multi-edit" | "unknown";

export interface ChangeEvent {
  seq: number;
  /** Which agent session produced this — lets one dashboard show many at once. */
  sessionId?: string;
  tool: string; // raw tool name (Edit / Write / MultiEdit / ...)
  kind: ChangeKind;
  filePath: string;
  /** One entry per contiguous change within the file. */
  hunks: Array<{ before: string; after: string }>;
  /** Assistant text seen just before this edit — the "why". */
  rationale: string;
  /** Structural context — imports, dependents (blast radius), edge delta. Added by a producer via structure.enrich(). */
  structure?: StructureDelta;
}

let seq = 0;
export function resetSeq(): void {
  seq = 0;
}

// Map a proposed tool input to a ChangeEvent (or null if it isn't a file edit).
// [V2] Field names per tool — confirm against the installed SDK's tool-input types:
//   Edit      -> { file_path, old_string, new_string }
//   Write     -> { file_path, content }
//   MultiEdit -> { file_path, edits: [{ old_string, new_string }] }
export function normalizeEdit(tool: string, input: any, rationale = ""): ChangeEvent | null {
  const filePath: string | undefined = input?.file_path ?? input?.path;
  if (!filePath) return null;

  let kind: ChangeKind = "unknown";
  let hunks: Array<{ before: string; after: string }> = [];

  switch (tool) {
    case "Write":
      kind = "create";
      hunks = [{ before: "", after: String(input.content ?? "") }];
      break;
    case "Edit":
      kind = "edit";
      hunks = [{ before: String(input.old_string ?? ""), after: String(input.new_string ?? "") }];
      break;
    case "MultiEdit":
      kind = "multi-edit";
      hunks = (input.edits ?? []).map((e: any) => ({
        before: String(e.old_string ?? ""),
        after: String(e.new_string ?? ""),
      }));
      break;
    default:
      return null; // not a file-mutating tool we visualize
  }

  return { seq: ++seq, tool, kind, filePath, hunks, rationale: rationale.trim() };
}

// Machine output: one ChangeEvent per line (JSONL). This is the wire format a
// frontend consumes — pipe a producer's stdout into a renderer's stdin.
export function emitJson(ev: ChangeEvent): void {
  process.stdout.write(JSON.stringify(ev) + "\n");
}

// Terminal renderer. A real IDE frontend draws the ChangeEvent instead.
export function render(ev: ChangeEvent): void {
  const bar = "─".repeat(60);
  console.log(`\n${bar}\n#${ev.seq}  ${ev.kind.toUpperCase()}  ${ev.filePath}   (${ev.tool})`);
  if (ev.rationale) console.log(`why: ${ev.rationale.slice(0, 300)}`);
  ev.hunks.forEach((h, i) => {
    const tag = ev.hunks.length > 1 ? ` [hunk ${i + 1}/${ev.hunks.length}]` : "";
    console.log(`  ---${tag} before ---`);
    if (h.before) h.before.split("\n").forEach((l) => console.log(`  - ${l}`));
    console.log(`  +++${tag} after  +++`);
    if (h.after) h.after.split("\n").forEach((l) => console.log(`  + ${l}`));
  });

  const st = ev.structure;
  if (st) {
    const parts = [`imports ${st.imports.length}`, `dependents ${st.dependents.length}`];
    if (st.addedImports.length) parts.push(`+edge ${st.addedImports.join(", ")}`);
    if (st.removedImports.length) parts.push(`-edge ${st.removedImports.join(", ")}`);
    console.log(`  ↳ ${parts.join("  ·  ")}`);
    if (st.dependents.length) console.log(`     blast radius: ${st.dependents.join(", ")}`);
  }

  // The machine-readable event the IDE frontend actually consumes:
  console.log(`event: ${JSON.stringify(ev)}`);
}