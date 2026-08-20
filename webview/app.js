/*
 * ClaudeChart webview renderer — multi-session dashboard.
 *
 * Consumes ChangeEvents (each tagged with sessionId) and renders one lane per
 * session: its file tree, blast-radius badges, latest rationale/diff, and — in
 * VS Code gated mode — per-lane Approve/Reject controls. Also handles two
 * control messages from the host: {type:"session-start"} and {type:"session-end"}.
 *
 * In VS Code, messages arrive via postMessage. Opened in a browser, it auto-plays
 * an injected feed (window.__CLAUDECHART_EVENTS__, which may interleave sessions).
 * Depends only on the wire format — not on the SDK or the event core.
 */
(function () {
  "use strict";

  var inVsCode = typeof acquireVsCodeApi === "function";
  var vscode = inVsCode ? acquireVsCodeApi() : null;

  // sessionId -> { label, files:Map, last, pendingSeq, denied:Set, ended }
  var sessions = new Map();

  function getSession(id, label) {
    var s = sessions.get(id);
    if (!s) {
      s = {
        label: label || id,
        files: new Map(),
        last: null,
        pendingSeq: null,
        denied: new Set(),
        ended: false
      };
      sessions.set(id, s);
    } else if (label) {
      s.label = label;
    }
    return s;
  }

  function countLines(str) {
    if (!str) return 0;
    return str.replace(/\n$/, "").split("\n").length;
  }

  function applyEvent(ev) {
    var s = getSession(ev.sessionId || "default");
    var adds = 0, dels = 0;

    (ev.hunks || []).forEach(function (h) {
      adds += countLines(h.after);
      dels += countLines(h.before);
    });

    var prev = s.files.get(ev.filePath) || {
      kind: ev.kind,
      adds: 0,
      dels: 0,
      seq: 0,
      dependents: 0
    };

    s.files.set(ev.filePath, {
      kind: ev.kind,
      adds: prev.adds + adds,
      dels: prev.dels + dels,
      seq: ev.seq,
      dependents:
        (ev.structure && ev.structure.dependents.length) || prev.dependents
    });

    s.last = ev;
    s.pendingSeq = inVsCode && !s.ended ? ev.seq : null; // gate only in VS Code

    render();

    pulse(
      s === sessions.get(ev.sessionId || "default")
        ? (ev.sessionId || "default")
        : null,
      ev.filePath
    );
  }

  function handleControl(msg) {
    if (msg.type === "session-start") {
      getSession(msg.sessionId, msg.label);
      render();
    } else if (msg.type === "session-end") {
      var s = sessions.get(msg.sessionId);
      if (s) {
        s.ended = true;
        s.pendingSeq = null;
      }
      render();
    }
  }

  // ── tree building (scoped to one session's file map) ───────────────
  function buildTree(files) {
    var root = { name: "", children: new Map() };

    Array.from(files.keys()).sort().forEach(function (path) {
      var node = root;

      path.split("/").forEach(function (part, i, parts) {
        var child = node.children.get(part);

        if (!child) {
          child = { name: part, children: new Map() };
          node.children.set(part, child);
        }

        if (i === parts.length - 1) child.path = path;
        node = child;
      });
    });

    return root;
  }

  function fileRow(node, s, sessionId) {
    var fs = s.files.get(node.path);

    var row = document.createElement("div");
    row.className = "file";
    row.setAttribute("data-session", sessionId);
    row.setAttribute("data-path", node.path);

    if (s.denied.has(node.path)) row.classList.add("denied");

    var name = document.createElement("span");
    name.className = "name";
    name.textContent = node.name;

    var kind = document.createElement("span");
    kind.className = "kind";
    kind.textContent = fs.kind;

    var total = Math.max(fs.adds + fs.dels, 1);

    var bar = document.createElement("span");
    bar.className = "bar";

    var segA = document.createElement("span");
    segA.className = "seg-add";
    segA.style.width = (100 * fs.adds / total) + "%";

    var segD = document.createElement("span");
    segD.className = "seg-del";
    segD.style.width = (100 * fs.dels / total) + "%";

    bar.appendChild(segA);
    bar.appendChild(segD);

    var counts = document.createElement("span");
    counts.className = "counts";
    counts.innerHTML =
      '<span class="add">+' + fs.adds +
      '</span> <span class="del">−' + fs.dels +
      "</span>";

    row.appendChild(name);
    row.appendChild(kind);

    if (fs.dependents) {
      var blast = document.createElement("span");
      blast.className = "blast";
      blast.title = "dependents (blast radius)";
      blast.textContent = "↔" + fs.dependents;
      row.appendChild(blast);
    }

    row.appendChild(bar);
    row.appendChild(counts);

    return row;
  }

  function renderNode(node, depth, container, s, sessionId) {
    var kids = Array.from(node.children.values()).sort(function (a, b) {
      var ad = a.children.size ? 0 : 1;
      var bd = b.children.size ? 0 : 1; // dirs first
      return ad - bd || a.name.localeCompare(b.name);
    });

    kids.forEach(function (child) {
      var wrap = document.createElement("div");
      wrap.className = "node";
      wrap.style.paddingLeft = depth * 14 + "px";

      if (child.path) {
        wrap.appendChild(fileRow(child, s, sessionId));
      } else {
        var dir = document.createElement("div");
        dir.className = "dir";
        dir.textContent = child.name + "/";
        wrap.appendChild(dir);
      }

      container.appendChild(wrap);
      renderNode(child, depth + 1, container, s, sessionId);
    });
  }

  // ── rendering ───────────────────────────────────────────────────────
  function render() {
    var lanes = document.getElementById("lanes");
    lanes.innerHTML = "";

    var tAdds = 0, tDels = 0, tFiles = 0;

    sessions.forEach(function (s, id) {
      tFiles += s.files.size;

      var la = 0, ld = 0;
      s.files.forEach(function (f) {
        la += f.adds;
        ld += f.dels;
      });

      tAdds += la;
      tDels += ld;

      var lane = document.createElement("div");
      lane.className = "lane" + (s.ended ? " ended" : "");
      lane.setAttribute("data-session", id);

      var head = document.createElement("div");
      head.className = "lane-head";
      head.innerHTML =
        '<span class="lane-label">' + escapeHtml(s.label) + "</span>" +
        (s.ended ? ' <span class="ended-tag">ended</span>' : "") +
        '<span class="lane-totals">' +
        s.files.size +
        ' file(s) <span class="add">+' +
        la +
        '</span> <span class="del">−' +
        ld +
        "</span></span>";

      lane.appendChild(head);

      var tree = document.createElement("div");
      tree.className = "lane-tree";

      if (s.files.size) {
        renderNode(buildTree(s.files), 0, tree, s, id);
      } else {
        tree.innerHTML = '<span class="empty">no changes yet</span>';
      }

      lane.appendChild(tree);

      var why = document.createElement("div");
      why.className = "lane-why";
      renderWhyInto(why, s, id);
      lane.appendChild(why);

      lanes.appendChild(lane);
    });

    document.getElementById("totals").innerHTML =
      sessions.size +
      " session(s) · " +
      tFiles +
      ' file(s) <span class="add">+' +
      tAdds +
      '</span> <span class="del">−' +
      tDels +
      "</span>";
  }

  function renderWhyInto(el, s, sessionId) {
    if (!s.last) {
      el.innerHTML =
        '<span class="empty">the rationale for each change appears here.</span>';
      return;
    }

    var last = s.last;
    var h = (last.hunks && last.hunks[0]) || { before: "", after: "" };

    var beforeLines = h.before
      ? h.before.replace(/\n$/, "").split("\n")
      : [];

    var afterLines = h.after
      ? h.after.replace(/\n$/, "").split("\n")
      : [];

    el.innerHTML =
      '<div class="head">' +
      last.seq +
      " · " +
      last.kind +
      " · " +
      escapeHtml(last.filePath) +
      "</div>" +
      '<div class="rationale">' +
      escapeHtml(last.rationale || "") +
      "</div>" +
      "<pre>" +
      beforeLines
        .map(function (l) {
          return '<span class="b">−' + escapeHtml(l) + "</span>";
        })
        .join("\n") +
      (beforeLines.length && afterLines.length ? "\n" : "") +
      afterLines
        .map(function (l) {
          return '<span class="a">+' + escapeHtml(l) + "</span>";
        })
        .join("\n") +
      "</pre>" +
      structureHtml(last.structure);

    if (vscode && s.pendingSeq === last.seq && !s.ended) {
      var controls = document.createElement("div");
      controls.className = "gate";

      controls.appendChild(mkBtn("Approve", "allow", sessionId));
      controls.appendChild(mkBtn("Reject", "deny", sessionId));

      el.appendChild(controls);
    }
  }

  function chips(label, items, cls) {
    if (!items || !items.length) return "";

    return (
      '<div class="srow"><span class="slabel">' +
      label +
      "</span>" +
      items
        .map(function (i) {
          return (
            '<span class="chip ' +
            (cls || "") +
            '">' +
            escapeHtml(i) +
            "</span>"
          );
        })
        .join("") +
      "</div>"
    );
  }

  function structureHtml(st) {
    if (!st) return "";

    var out = '<h2 style="margin-top:14px">structure</h2>';

    out +=
      '<div class="srow"><span class="slabel">blast radius</span><span class="chip">' +
      (st.dependents.length || 0) +
      " dependents</span></div>";

    out += chips("dependents", st.dependents, "dep");
    out += chips("imports", st.imports, "");
    out += chips("+ edges", st.addedImports, "add-chip");
    out += chips("− edges", st.removedImports, "del-chip");

    return out;
  }

  function pulse(sessionId, path) {
    if (!sessionId) return;

    var el = document.querySelector(
      '.lane[data-session="' +
        cssEscape(sessionId) +
        '"] .file[data-path="' +
        cssEscape(path) +
        '"]'
    );

    if (!el) return;

    el.classList.add("pulse");

    setTimeout(function () {
      el.classList.remove("pulse");
    }, 600);
  }

  function decide(sessionId, behavior) {
    var s = sessions.get(sessionId);

    if (!vscode || !s || s.pendingSeq == null) return;

    vscode.postMessage({
      type: "decision",
      sessionId: sessionId,
      seq: s.pendingSeq,
      behavior: behavior,
      message: behavior === "deny" ? "rejected in ClaudeChart" : undefined
    });

    if (behavior === "deny" && s.last) {
      s.denied.add(s.last.filePath);
    }

    s.pendingSeq = null;
    render();
  }

  function mkBtn(label, behavior, sessionId) {
    var b = document.createElement("button");
    b.className = "gbtn " + behavior;
    b.textContent = label;

    b.addEventListener("click", function () {
      decide(sessionId, behavior);
    });

    return b;
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"]/g, function (c) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;"
      }[c];
    });
  }

  function cssEscape(str) {
    return String(str).replace(/["\\]/g, "\\$&");
  }

  // VS Code: control messages + tagged ChangeEvents arrive via postMessage.
  window.addEventListener("message", function (e) {
    var m = e.data;
    if (!m) return;

    if (m.type === "session-start" || m.type === "session-end") {
      handleControl(m);
      return;
    }

    if (m.filePath && Array.isArray(m.hunks)) {
      applyEvent(m);
    }
  });

  // Standalone browser: auto-play an injected feed (may interleave sessions), else a builtin sample.
  if (!inVsCode) {
    var BUILTIN = [
      {
        seq: 1,
        sessionId: "demo",
        tool: "Write",
        kind: "create",
        filePath: "greeting.txt",
        hunks: [
          {
            before: "",
            after: "Hello from ClaudeChart!\n"
          }
        ],
        rationale: "Starting with a greeting file.",
        structure: {
          imports: [],
          dependents: [],
          addedImports: [],
          removedImports: []
        }
      }
    ];

    var feed =
      (window.__CLAUDECHART_EVENTS__ &&
        window.__CLAUDECHART_EVENTS__.length)
        ? window.__CLAUDECHART_EVENTS__
        : BUILTIN;

    var i = 0;

    (function step() {
      if (i < feed.length) {
        applyEvent(feed[i++]);
        setTimeout(step, 800);
      }
    })();
  }
})();