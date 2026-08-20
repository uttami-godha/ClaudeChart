/**
 * ClaudeChart — approval gate (reverse channel).
 *
 * The producer emits a ChangeEvent, then BLOCKS in canUseTool until a Decision
 * for that event's `seq` arrives. Decisions travel back over the producer's
 * stdin — the parent that owns the child's stdio (VS Code extension, or the
 * terminal control surface) relays the frontend's approve/reject there.
 *
 * Wire format (one JSON line per decision, on the producer's stdin):
 *   {"seq": 3, "behavior": "allow"}
 *   {"seq": 3, "behavior": "deny", "message": "not this file"}
 */

import * as readline from "node:readline";

export interface Decision {
  seq: number;
  /** Which session this decision is for — used by the transport to route it to
   *  the right producer. A producer's stdin only carries its own session, so the
   *  gate itself still matches by seq. */
  sessionId?: string;
  behavior: "allow" | "deny";
  message?: string;
}

export interface Gate {
  decide(seq: number): Promise<Decision>;
  close(): void;
}

/** No human in the loop — approve everything immediately (default). */
export function autoAllowGate(): Gate {
  return { decide: async (seq) => ({ seq, behavior: "allow" }), close() {} };
}

/** Await Decision lines on `input` (the producer's stdin), matched by seq. */
export function stdinGate(input: NodeJS.ReadableStream = process.stdin): Gate {
  const waiting = new Map<number, (d: Decision) => void>(); // seq -> resolver (decision not yet arrived)
  const early = new Map<number, Decision>(); // seq -> decision that arrived before it was awaited
  const rl = readline.createInterface({ input });

  rl.on("line", (line) => {
    const s = line.trim();
    if (!s.startsWith("{")) return;
    try {
      const d = JSON.parse(s) as Decision;
      if (typeof d.seq !== "number" || (d.behavior !== "allow" && d.behavior !== "deny")) return;
      const resolve = waiting.get(d.seq);
      if (resolve) { waiting.delete(d.seq); resolve(d); }
      else early.set(d.seq, d);
    } catch {
      /* not a decision line — ignore */
    }
  });

  return {
    decide(seq) {
      const e = early.get(seq);
      if (e) { early.delete(seq); return Promise.resolve(e); }
      return new Promise<Decision>((res) => waiting.set(seq, res));
    },
    close() { rl.close(); },
  };
}