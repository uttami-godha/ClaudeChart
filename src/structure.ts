/**
 * ClaudeChart — codebase-structure analysis (pure, no external parser).
 *
 * Two things a change touches structurally:
 *   1. Edges this edit ADDS or REMOVES — computed from the event's own hunks.
 *   2. The file's place in the import graph — what it imports, and who depends
 *      on it (blast radius) — computed from a workspace snapshot.
 *
 * Regex-based import scanning (JS/TS): good enough to drive a visualization,
 * with zero dependencies. A producer feeds a snapshot; the enriched delta rides
 * along on each ChangeEvent so every frontend gets it for free.
 */

import * as path from "node:path";

export interface StructureDelta {
  imports: string[]; // modules this file imports (resolved to workspace paths where possible)
  dependents: string[]; // files that import this file — the blast radius
  addedImports: string[]; // import edges this edit introduced
  removedImports: string[]; // import edges this edit removed
}

// import x from "y" | export ... from "y" | import "y" | require("y") | import("y")
const IMPORT_RE =
  /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

export function extractImports(src: string): string[] {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(src)) !== null) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (spec) out.add(spec);
  }
  return [...out];
}

export class DependencyGraph {
  private specifiers = new Map<string, Set<string>>(); // path -> raw import specifiers
  private paths = new Set<string>();

  constructor(files?: Record<string, string>) {
    if (files) for (const [p, src] of Object.entries(files)) this.setFile(p, src);
  }

  setFile(filePath: string, source: string): void {
    this.paths.add(filePath);
    this.specifiers.set(filePath, new Set(extractImports(source)));
  }

  /** Resolve a relative specifier to a known workspace path, or null if external/unresolved. */
  resolveSpec(fromPath: string, spec: string): string | null {
    if (!spec.startsWith(".")) return null; // bare specifier => external package
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), spec));
    const candidates = [
      base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`,
      path.posix.join(base, "index.ts"), path.posix.join(base, "index.js"),
    ];
    return candidates.find((c) => this.paths.has(c)) ?? null;
  }

  /** Display list of what `filePath` imports — resolved workspace path, else the raw specifier. */
  importsOf(filePath: string): string[] {
    const specs = this.specifiers.get(filePath) ?? new Set<string>();
    const out = new Set<string>();
    for (const s of specs) out.add(this.resolveSpec(filePath, s) ?? s);
    return [...out].sort();
  }

  /** Files that import `filePath` — the blast radius of changing it. */
  dependentsOf(filePath: string): string[] {
    const out: string[] = [];
    for (const [p, specs] of this.specifiers) {
      if (p === filePath) continue;
      for (const s of specs) {
        if (this.resolveSpec(p, s) === filePath) { out.push(p); break; }
      }
    }
    return out.sort();
  }
}

/** Import edges added/removed by an edit, from its hunks alone (no snapshot needed). */
export function importDelta(hunks: Array<{ before: string; after: string }>): {
  added: string[];
  removed: string[];
} {
  const before = new Set(extractImports(hunks.map((h) => h.before).join("\n")));
  const after = new Set(extractImports(hunks.map((h) => h.after).join("\n")));
  return {
    added: [...after].filter((x) => !before.has(x)),
    removed: [...before].filter((x) => !after.has(x)),
  };
}

/** Combine edge-delta (from hunks) with graph context (from snapshot) into a StructureDelta. */
export function enrich(
  filePath: string,
  hunks: Array<{ before: string; after: string }>,
  graph?: DependencyGraph,
): StructureDelta {
  const { added, removed } = importDelta(hunks);
  const display = (spec: string) => graph?.resolveSpec(filePath, spec) ?? spec;
  return {
    imports: graph ? graph.importsOf(filePath) : [],
    dependents: graph ? graph.dependentsOf(filePath) : [],
    addedImports: added.map(display),
    removedImports: removed.map(display),
  };
}