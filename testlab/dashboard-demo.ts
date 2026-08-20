/**
 * ClaudeChart — multi-session dashboard demo.
 *
 * Builds two independent agent sessions (an auth refactor + the NPI detector),
 * enriches each with its own dependency graph, tags every event with a sessionId,
 * and interleaves them so both lanes fill concurrently. Generates a self-contained
 * dashboard you can open in a browser.
 *
 * Run from the repo root:
 *   node testlab/dashboard-demo.ts --json | node src/render-terminal.ts   (merged terminal view)
 *   node testlab/dashboard-demo.ts --html > testlab/dashboard.html       (browser dashboard)
 */

import { normalizeEdit, render, emitJson, resetSeq, type ChangeEvent } from "../src/events.ts";
import { DependencyGraph, enrich } from "../src/structure.ts";
import { viewerHtml } from "../src/viewer.ts";

const mode = process.argv.includes("--html") ? "html" : process.argv.includes("--json") ? "json" : "human";

interface Fixture {
  tool: string;
  input: any;
  rationale: string;
  graphContent?: { path: string; source: string };
}

function buildSession(sessionId: string, graph: DependencyGraph, fixtures: Fixture[]): ChangeEvent[] {
  resetSeq(); // seq restarts per session — sessions are independent lanes
  const out: ChangeEvent[] = [];
  for (const f of fixtures) {
    const ev = normalizeEdit(f.tool, f.input, f.rationale);
    if (!ev) continue;
    ev.structure = enrich(ev.filePath, ev.hunks, graph);
    ev.sessionId = sessionId;
    out.push(ev);
    if (f.graphContent) graph.setFile(f.graphContent.path, f.graphContent.source);
  }
  return out;
}

// ── Session A: an auth refactor ────────────────────────────────────────
const authGraph = new DependencyGraph({
  "auth/login.ts": 'import { hash } from "./crypto";',
  "auth/crypto.ts": "",
  "auth/routes.ts": 'import { login } from "./login";', // dependent of login.ts
});

const authSession = buildSession("auth-refactor", authGraph, [
  {
    tool: "Edit",
    rationale: "Add a constant-time comparison to avoid password timing leaks.",
    input: {
      file_path: "auth/crypto.ts",
      old_string: "export function hash(s: string): string {",
      new_string:
        "export function timingSafeEqual(a: string, b: string): boolean {\n" +
        "  let d = a.length ^ b.length;\n" +
        "  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);\n" +
        "  return d === 0;\n}\n\nexport function hash(s: string): string {",
    },
  },
  {
    tool: "Edit",
    rationale: "Use the constant-time compare when checking passwords.",
    input: {
      file_path: "auth/login.ts",
      old_string: "  return stored === attempt;",
      new_string: "  return timingSafeEqual(stored, attempt);",
    },
  },
  {
    tool: "Write",
    rationale: "Add an MFA code check module.",
    input: {
      file_path: "auth/mfa.ts",
      content:
        "export function verifyMfa(code: string): boolean {\n" +
        "  return code.length === 6;\n}\n",
    },
    graphContent: {
      path: "auth/mfa.ts",
      source: "",
    },
  },
  {
    tool: "Edit",
    rationale: "Wire MFA verification into the login path.",
    input: {
      file_path: "auth/login.ts",
      old_string: 'import { hash } from "./crypto";',
      new_string:
        'import { hash } from "./crypto";\n' +
        'import { verifyMfa } from "./mfa";',
    },
    graphContent: {
      path: "auth/login.ts",
      source:
        'import { hash } from "./crypto";\n' +
        'import { verifyMfa } from "./mfa";',
    },
  },
]);

// ── Session B: the NPI detector (compact) ──────────────────────────────
const npiGraph = new DependencyGraph({
  "testlab/npi.ts": "",
  "testlab/pipeline.ts": 'import { classify } from "./npi";', // dependent of npi.ts
});

const npiSession = buildSession("npi-detector", npiGraph, [
  {
    tool: "Write",
    rationale: "Add a masking helper so detector output never echoes raw values.",
    input: {
      file_path: "testlab/mask.ts",
      content:
        "export function mask(v: string): string {\n" +
        '  return v.length <= 4 ? "****" : v.slice(0, 2) + "****" + v.slice(-2);\n' +
        "}\n",
    },
    graphContent: { path: "testlab/mask.ts", source: "" },
  },
  {
    tool: "Edit",
    rationale: "Import the masking helper into the detector.",
    input: {
      file_path: "testlab/npi.ts",
      old_string: "export interface DataRecord {",
      new_string:
        'import { mask } from "./mask.ts";\n\n' +
        "export interface DataRecord {",
    },
    graphContent: {
      path: "testlab/npi.ts",
      source: 'import { mask } from "./mask.ts";',
    },
  },
  {
    tool: "Edit",
    rationale: "Broaden detection to phone numbers and known sensitive field names.",
    input: {
      file_path: "testlab/npi.ts",
      old_string:
        '    if (EMAIL.test(value)) reasons.push("email in " + field);',
      new_string:
        '    if (SENSITIVE_FIELDS.has(field)) reasons.push("sensitive field " + field);\n' +
        '    if (EMAIL.test(value)) reasons.push("email " + mask(value) + " in " + field);\n' +
        '    if (PHONE.test(value)) reasons.push("phone " + mask(value) + " in " + field);',
    },
  },
]);

// Interleave so both lanes advance together in the animation.
function interleave(a: ChangeEvent[], b: ChangeEvent[]): ChangeEvent[] {
  const out: ChangeEvent[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (i < a.length) out.push(a[i]);
    if (i < b.length) out.push(b[i]);
  }
  return out;
}

const events = interleave(authSession, npiSession);

if (mode === "html") {
  process.stdout.write(viewerHtml(events, "multi-session dashboard demo"));
} else {
  for (const ev of events) mode === "json" ? emitJson(ev) : render(ev);
  if (mode === "human") console.error(`\n=== ${events.length} events across 2 sessions ===`);
}