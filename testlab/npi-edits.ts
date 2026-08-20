/**
 * ClaudeChart — NPI edit scenario producer.
 *
 * Emits the sequence of edits that built up testlab/npi.ts (a Non-Public-Info
 * detector) as ChangeEvents, enriched with structural context from a snapshot
 * of the testlab folder. Snippets mirror the real edits applied to the files.
 *
 * Run from the repo root:
 *   node testlab/npi-edits.ts                              human-readable
 *   node testlab/npi-edits.ts --json | node src/render-terminal.ts    terminal viz
 *   node testlab/npi-edits.ts --html > testlab/npi-viewer.html        self-contained webview
 */

import { normalizeEdit, render, emitJson, resetSeq, type ChangeEvent } from "../src/events.ts";
import { DependencyGraph, enrich } from "../src/structure.ts";
import { viewerHtml } from "../src/viewer.ts";

const mode = process.argv.includes("--html") ? "html" : process.argv.includes("--json") ? "json" : "human";

const MASK_TS = `// Mask a value so detector output never echoes raw non-public data.
export function mask(value: string): string {
  if (value.length <= 4) return "****";
  return value.slice(0, 2) + "****" + value.slice(-2);
}
`;

const NEW_CONSTS = String.raw`const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const PHONE = /\b\d{3}[-.\s]?\d{3,4}\b/;
const SSN_FORMAT = /\b\d{3}-\d{2}-\d{4}\b/;
const SENSITIVE_FIELDS = new Set(["ssn", "dob", "account", "accountNumber"]);`;

// Snapshot of testlab BEFORE the edits (only import lines matter for structure).
// pipeline.ts imports npi.ts, so editing npi.ts has a real blast radius.
const graph = new DependencyGraph({
  "testlab/npi.ts": "",
  "testlab/pipeline.ts": 'import { classify } from "./npi.ts";',
});

interface Fixture {
  tool: string;
  input: any;
  rationale: string;
  /** After processing, set the file's import-bearing content so later edges resolve. */
  graphContent?: { path: string; source: string };
}

const fixtures: Fixture[] = [
  {
    tool: "Write",
    rationale: "Add a masking helper so detector output never echoes raw values.",
    input: { file_path: "testlab/mask.ts", content: MASK_TS },
    graphContent: { path: "testlab/mask.ts", source: MASK_TS },
  },
  {
    tool: "Edit",
    rationale: "Import the masking helper into the detector.",
    input: {
      file_path: "testlab/npi.ts",
      old_string: "export interface DataRecord {",
      new_string: 'import { mask } from "./mask.ts";\n\nexport interface DataRecord {',
    },
    graphContent: { path: "testlab/npi.ts", source: 'import { mask } from "./mask.ts";' },
  },
  {
    tool: "MultiEdit",
    rationale: "Broaden detection: phone numbers, SSN-format values, and known sensitive field names.",
    input: {
      file_path: "testlab/npi.ts",
      edits: [
        {
          old_string: String.raw`const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;`,
          new_string: NEW_CONSTS,
        },
        {
          old_string:
            '  if (typeof value !== "string") continue;\n' +
            '  if (EMAIL.test(value)) reasons.push(`email in "${field}"`);',
          new_string:
            '  if (SENSITIVE_FIELDS.has(field)) reasons.push(`sensitive field "${field}"`);\n' +
            '  if (typeof value !== "string") continue;\n' +
            '  if (EMAIL.test(value)) reasons.push(`email (${mask(value)}) in "${field}"`);\n' +
            '  if (PHONE.test(value)) reasons.push(`phone (${mask(value)}) in "${field}"`);\n' +
            '  if (SSN_FORMAT.test(value)) reasons.push(`ssn-format value in "${field}"`);',
        },
      ],
    },
  },
  {
    tool: "Edit",
    rationale: "Add a severity level so downstream can prioritize high-risk records.",
    input: {
      file_path: "testlab/npi.ts",
      old_string: "  return { id: rec.id, isNpi: reasons.length > 0, reasons };",
      new_string:
        '  const severity = reasons.some((r) => r.startsWith("sensitive") || r.includes("ssn"))\n' +
        '    ? "high"\n' +
        '    : reasons.length > 0\n' +
        '      ? "low"\n' +
        '      : "none";\n' +
        "  return { id: rec.id, isNpi: reasons.length > 0, severity, reasons };",
    },
  },
];

resetSeq();
const events: ChangeEvent[] = [];
for (const f of fixtures) {
  const ev = normalizeEdit(f.tool, f.input, f.rationale);
  if (!ev) continue;
  ev.structure = enrich(ev.filePath, ev.hunks, graph);
  ev.sessionId = "npi-detector";
  events.push(ev);
  if (f.graphContent) graph.setFile(f.graphContent.path, f.graphContent.source);
}

if (mode === "html") {
  process.stdout.write(viewerHtml(events, "NPI detector — edit replay"));
} else {
  for (const ev of events) (mode === "json" ? emitJson(ev) : render(ev));
  if (mode === "human") console.error(`\n=== ${events.length} NPI edit event(s) ===`);
}