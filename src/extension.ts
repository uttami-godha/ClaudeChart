/*
 * ClaudeChart — VS Code extension host (multi-session dashboard).
 *
 * "ClaudeChart: Open" opens one dashboard panel. "ClaudeChart: New Session"
 * spawns a producer, tags its ChangeEvents with a sessionId, and streams them
 * into the panel as a new lane. Approve/reject decisions from the webview are
 * routed back to the matching producer's stdin. Session start/end are sent as
 * control messages so the webview can add/close lanes.
 *
 * ⚠ Requires the VS Code extension host + @types/vscode, and a `tsc` build to
 * dist/extension.js (see package.json `build:ext`). Cannot run outside VS Code.
 */

import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import * as readline from "node:readline";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

let panel: vscode.WebviewPanel | undefined;
const children = new Map<string, ChildProcessWithoutNullStreams>(); // sessionId -> producer
let counter = 0;

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("claudechart.open", () => {
      ensurePanel(context);
      if (children.size === 0) startSession(context); // convenience: first lane
    }),
    vscode.commands.registerCommand("claudechart.newSession", () => {
      ensurePanel(context);
      startSession(context);
    }),
  );
}

export function deactivate(): void {
  for (const c of children.values()) c.kill();
  children.clear();
}

function ensurePanel(context: vscode.ExtensionContext): vscode.WebviewPanel {
  if (panel) { panel.reveal(vscode.ViewColumn.Beside); return panel; }

  const webviewDir = vscode.Uri.joinPath(context.extensionUri, "webview");
  panel = vscode.window.createWebviewPanel("claudechart", "ClaudeChart", vscode.ViewColumn.Beside, {
    enableScripts: true,
    localResourceRoots: [webviewDir],
    retainContextWhenHidden: true,
  });
  panel.webview.html = buildHtml(panel.webview, webviewDir);

  // Route webview approve/reject decisions to the matching producer's stdin.
  panel.webview.onDidReceiveMessage((msg) => {
    if (msg && msg.type === "decision" && typeof msg.seq === "number") {
      const child = children.get(msg.sessionId);
      child?.stdin.write(JSON.stringify({ seq: msg.seq, behavior: msg.behavior, message: msg.message }) + "\n");
    }
  });

  panel.onDidDispose(() => {
    for (const c of children.values()) c.kill();
    children.clear();
    panel = undefined;
  });

  return panel;
}

function startSession(context: vscode.ExtensionContext): void {
  if (!panel) return;
  const sessionId = "s" + ++counter;

  const cfg = vscode.workspace.getConfiguration("claudechart");
  const producer = cfg.get<string[]>("producer", ["src/demo.ts", "--gate", "--json"]);
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? context.extensionUri.fsPath;
  const label = `session ${counter}`;

  const child = spawn("node", [...producer, `--session=${sessionId}`], { cwd });
  children.set(sessionId, child);

  panel.webview.postMessage({ type: "session-start", sessionId, label });

  const rl = readline.createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    const s = line.trim().replace(/^event:\s*/, "");
    if (!s.startsWith("{")) return;
    try {
      const ev = JSON.parse(s);
      if (ev && ev.filePath && Array.isArray(ev.hunks)) {
        ev.sessionId = sessionId; // authoritative tag from the transport
        panel?.webview.postMessage(ev);
      }
    } catch {
      /* not a ChangeEvent line — ignore */
    }
  });
  child.stderr.on("data", (d) => console.error(`[claudechart ${sessionId}]`, String(d)));
  child.on("exit", () => {
    rl.close();
    children.delete(sessionId);
    panel?.webview.postMessage({ type: "session-end", sessionId });
  });
}

// Read webview/index.html and adapt it for the webview sandbox: rewrite asset
// references to webview URIs and add a CSP with a per-load nonce.
function buildHtml(webview: vscode.Webview, webviewDir: vscode.Uri): string {
  const htmlPath = vscode.Uri.joinPath(webviewDir, "index.html").fsPath;
  const appUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, "app.js"));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, "style.css"));
  const nonce = getNonce();

  const csp =
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; ` +
    `style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">`;

  return fs
    .readFileSync(htmlPath, "utf8")
    .replace("</head>", `${csp}\n</head>`)
    .replace('href="style.css"', `href="${styleUri}"`)
    .replace('<script src="app.js"></script>', `<script nonce="${nonce}" src="${appUri}"></script>`);
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}