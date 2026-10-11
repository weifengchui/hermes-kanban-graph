(function () {
  "use strict";
  var SDK = window.__HERMES_PLUGIN_SDK__;
  if (!SDK) return;
  var React = SDK.React;
  var h = React.createElement;
  var hooks = SDK.hooks || {};
  var useState = hooks.useState, useEffect = hooks.useEffect, useCallback = hooks.useCallback, useRef = hooks.useRef;
  var useMemo = hooks.useMemo || React.useMemo;
  var comps = SDK.components || {};
  var Badge = comps.Badge, Button = comps.Button, Select = comps.Select, SelectOption = comps.SelectOption;
  var API = "/api/plugins/kanban-graph";

  // ─────────────────────────── geometry ───────────────────────────
  // Two coordinate systems share one engine:
  //  · GEO_MAIN — the single-board canvas (and the lattice drag-snapping uses)
  //  · GEO_MINI — compact boxes drawn inside a profile panel
  var GEO_MAIN = { W: 210, H: 56, GX: 96, GY: 20, M: 24, RAD: 10, ULC: 0, UNITS: 28, PAD: 14, TY: 20, MY: 51, DY: 15 };
  var GEO_MINI = { W: 168, H: 48, GX: 52, GY: 14, M: 12, RAD: 8, ULC: 2, UNITS: 26, PAD: 12, TY: 17, MY: 41, DY: 13, KTF: 1 };
  function cellW(G) { return G.W + G.GX; }
  function cellH(G) { return G.H + G.GY; }
  var NODE_W = GEO_MAIN.W, NODE_H = GEO_MAIN.H, GAP_X = GEO_MAIN.GX, GAP_Y = GEO_MAIN.GY, MARGIN = GEO_MAIN.M;
  var CELL_W = cellW(GEO_MAIN), CELL_H = cellH(GEO_MAIN);

  // rounded-rect outline the running light streak rides on (pathLength=100)
  function cometD(G) {
    var x = -2.5, y = -2.5, W = G.W + 5, H = G.H + 5, r = G.RAD;
    return "M " + (x + r) + " " + y +
      " H " + (x + W - r) + " A " + r + " " + r + " 0 0 1 " + (x + W) + " " + (y + r) +
      " V " + (y + H - r) + " A " + r + " " + r + " 0 0 1 " + (x + W - r) + " " + (y + H) +
      " H " + (x + r) + " A " + r + " " + r + " 0 0 1 " + x + " " + (y + H - r) +
      " V " + (y + r) + " A " + r + " " + r + " 0 0 1 " + (x + r) + " " + y + " Z";
  }
  var COMET_D = cometD(GEO_MAIN), COMET_D_MINI = cometD(GEO_MINI);

  var MIN_ZOOM = 0.4, MAX_ZOOM = 2.5, POLL_MS = 5000;
  var MAGNET = 16; // px (model space) within which free node dragging magnetises to the lattice
  var STATUS_ORDER = ["running", "blocked", "ready", "todo", "scheduled", "review", "triage", "done", "cancelled", "archived"];
  var TERMINAL = { done: 1, cancelled: 1, archived: 1 }; // finished history: never occupies the dependency canvas
  var LABEL = {
    triage: "待分诊", todo: "待办", scheduled: "已排期", ready: "就绪",
    running: "执行中", blocked: "阻塞", review: "评审", done: "完成", archived: "归档", cancelled: "取消"
  };
  var ICON = {
    triage: "◇", todo: "○", scheduled: "□", ready: "◉", running: "▶",
    blocked: "⚠", review: "✎", done: "✓", cancelled: "✕", archived: "▢"
  };
  var STATUS_COLOR = {
    triage: "#9ca3af", todo: "#6b7280", scheduled: "#8b5cf6", ready: "#3b82f6",
    running: "#06b6d4", blocked: "#ef4444", review: "#f59e0b", done: "#10b981",
    cancelled: "#a1a1aa", archived: "#9ca3af"
  };

  var LS_KEY = "hermes.kanbangraph.selectedBoard";
  var LS_BORROW = "hermes.kanban.selectedBoard";
  var LS_POS = "hermes.kanbangraph.pos.";
  var LS_UL = "hermes.kanbangraph.showUl";
  var LS_HIDE = "hermes.kanbangraph.hideSt"; // status chip filter: hidden statuses
  var LS_MODE = "hermes.kanbangraph.mode"; // "multi" | "single"
  var LS_SCOPE = "hermes.kanbangraph.scope"; // "" = every board
  var LS_HIDEP = "hermes.kanbangraph.hiddenProfiles";
  var LS_LAYOUT = "hermes.kanbangraph.layout."; // + scope key
  var LS_XEDGE = "hermes.kanbangraph.crossEdges"; // "1" = draw cross-profile wires
  var LS_GROUPS = "hermes.kanbangraph.groups."; // + scope key => [{id,name,members,inner}]
  var LS_MAXED = "hermes.kanbangraph.maxed."; // + scope key => maximised card id ("" = none)
  var LS_MINIPOS = "hermes.kanbangraph.miniPos."; // + profile => { nodeId: {x,y} } inside a panel
  var LS_GRID = "hermes.kanbangraph.grid"; // "0" = no drag reference grid
  var GKEY = "@g"; // layout-map key prefix marking a group card

  // wall-of-panels tuning
  var GRID = 8, SNAP = 8, PMIN_W = 240, PMIN_H = 150, PDEF_W = 460, PDEF_H = 330, PGAP = 12, MINI_SCALE_MIN = 0.5, MINI_SCALE_MAX = 1.4;
  // group cards + maximised cards
  var GMIN_W = 320, GMIN_H = 230, GHEAD = 30, GBODY_PAD = 8, INNER_PAD = 6;
  var IMIN_W = 180, IMIN_H = 108; // an inner (grouped) card may be smaller than a free one
  var MINI_SCALE_MAX_BIG = 2.4; // a maximised card may blow its mini graph up further

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function errMsg(e) { return e && e.message ? e.message : String(e); }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }

  // ── double-tap detection ──
  // Deliberately NOT the browser's dblclick: every drag inside this view calls
  // preventDefault() on pointerdown, which suppresses the compatibility mouse
  // events (and with them click / dblclick) in Chromium. Counting pointerdowns
  // ourselves is the only trigger that fires in both views.
  var _tapKey = "", _tapAt = 0;
  function isDoubleTap(key) {
    var now = Date.now();
    var hit = _tapKey === key && (now - _tapAt) < 420;
    _tapKey = hit ? "" : key;
    _tapAt = hit ? 0 : now;
    return hit;
  }

  function readStored() { return lsGet(LS_KEY) || lsGet(LS_BORROW) || null; }
  function writeStored(v) { lsSet(LS_KEY, v); }
  function readMode() { return lsGet(LS_MODE) === "single" ? "single" : "multi"; }
  function readScope() { return lsGet(LS_SCOPE) || ""; }
  function readGrid() { return lsGet(LS_GRID) !== "0"; }

  // per-board manual node positions: { id: {x,y} }
  function readPos(b) {
    if (!b) return {};
    try {
      var raw = lsGet(LS_POS + b);
      if (!raw) return {};
      var obj = JSON.parse(raw), out = {};
      if (obj && typeof obj === "object") {
        Object.keys(obj).forEach(function (k) {
          var p = obj[k];
          if (p && typeof p.x === "number" && typeof p.y === "number") out[k] = { x: p.x, y: p.y };
        });
      }
      return out;
    } catch (e) { return {}; }
  }
  function writePos(b, ov) {
    if (!b) return;
    if (ov && Object.keys(ov).length > 0) lsSet(LS_POS + b, JSON.stringify(ov));
    else { try { localStorage.removeItem(LS_POS + b); } catch (e) { /* ignore */ } }
  }

  // persisted status filter: { status: 1 } for hidden statuses
  function readHide() {
    try {
      var arr = JSON.parse(lsGet(LS_HIDE) || "[]"), m = {};
      if (Array.isArray(arr)) arr.forEach(function (st) { m[st] = 1; });
      return m;
    } catch (e) { return {}; }
  }
  function writeHide(m) { lsSet(LS_HIDE, JSON.stringify(Object.keys(m || {}))); }

  // persisted hidden profiles
  function readHiddenProf() {
    try {
      var arr = JSON.parse(lsGet(LS_HIDEP) || "[]"), m = {};
      if (Array.isArray(arr)) arr.forEach(function (k) { m[k] = 1; });
      return m;
    } catch (e) { return {}; }
  }
  function writeHiddenProf(m) { lsSet(LS_HIDEP, JSON.stringify(Object.keys(m || {}))); }

  // per-scope panel layout: { profileName: {x,y,w,h} }
  function scopeKey(scope) { return scope || "__all__"; }
  function readLayout(k) {
    try {
      var o = JSON.parse(lsGet(LS_LAYOUT + k) || "{}"), out = {};
      if (o && typeof o === "object") {
        Object.keys(o).forEach(function (p) {
          var r = o[p];
          if (r && typeof r.x === "number" && typeof r.y === "number" &&
              typeof r.w === "number" && typeof r.h === "number") {
            out[p] = { x: r.x, y: r.y, w: r.w, h: r.h };
          }
        });
      }
      return out;
    } catch (e) { return {}; }
  }
  function writeLayout(k, lay) { lsSet(LS_LAYOUT + k, JSON.stringify(lay || {})); }

  // ── group cards ──────────────────────────────────────────────────────────
  // groups.<scope> = [{ id, name, members:[profile…], inner:{ profile:{x,y,w,h} } }]
  // `inner` rects are relative to the group body box (see groupBody).
  function readGroups(k) {
    try {
      var arr = JSON.parse(lsGet(LS_GROUPS + k) || "[]"), out = [];
      if (Array.isArray(arr)) {
        arr.forEach(function (g) {
          if (!g || !g.id || !Array.isArray(g.members) || g.members.length < 2) return;
          var inner = {};
          Object.keys(g.inner || {}).forEach(function (p) {
            var r = g.inner[p];
            if (r && typeof r.x === "number" && typeof r.y === "number" &&
                typeof r.w === "number" && typeof r.h === "number") inner[p] = { x: r.x, y: r.y, w: r.w, h: r.h };
          });
          out.push({ id: String(g.id), name: String(g.name || "分组"), members: g.members.map(String), inner: inner });
        });
      }
      return out;
    } catch (e) { return []; }
  }
  function writeGroups(k, arr) {
    if (arr && arr.length) lsSet(LS_GROUPS + k, JSON.stringify(arr));
    else { try { localStorage.removeItem(LS_GROUPS + k); } catch (e) { /* ignore */ } }
  }

  function readMaxed(k) { return lsGet(LS_MAXED + k) || ""; }
  function writeMaxed(k, id) {
    if (id) lsSet(LS_MAXED + k, id);
    else { try { localStorage.removeItem(LS_MAXED + k); } catch (e) { /* ignore */ } }
  }

  // per-profile manual task-block positions drawn inside that profile's card
  function readMiniPos(prof) {
    if (!prof) return {};
    try {
      var o = JSON.parse(lsGet(LS_MINIPOS + prof) || "{}"), out = {};
      Object.keys(o || {}).forEach(function (id) {
        var p = o[id];
        if (p && typeof p.x === "number" && typeof p.y === "number") out[id] = { x: p.x, y: p.y };
      });
      return out;
    } catch (e) { return {}; }
  }
  function writeMiniPos(prof, ov) {
    if (!prof) return;
    if (ov && Object.keys(ov).length) lsSet(LS_MINIPOS + prof, JSON.stringify(ov));
    else { try { localStorage.removeItem(LS_MINIPOS + prof); } catch (e) { /* ignore */ } }
  }

  // stable, muted accent per profile name (decor only)
  function profHue(name) {
    var s = String(name || "-"), x = 0;
    for (var i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) % 360;
    return x;
  }
  function profColor(name) { return "hsl(" + profHue(name) + " 52% 62%)"; }
  function profLabel(name) { return name ? name : "未指派"; }

  // ─────────────────────────── text metrics ───────────────────────────
  function charW(ch) { var c = ch.charCodeAt(0); return (c > 0x2e7f || c >= 0xff00) ? 2 : 1; }
  function isLatin(ch) { return /[A-Za-z0-9._-]/.test(ch); }
  function takeUnits(s, max) {
    var u = 0, i = 0;
    while (i < s.length && u + charW(s[i]) <= max) { u += charW(s[i]); i++; }
    // don't split an ASCII word in the middle if a space exists in the cut
    if (i < s.length && isLatin(s[i - 1]) && isLatin(s[i])) {
      for (var j = i - 1; j > i / 2; j--) {
        if (s[j] === " ") { i = j; break; }
      }
    }
    return [s.slice(0, i), s.slice(i)];
  }
  function wrapTitle(title, units) {
    var s = title == null ? "" : String(title);
    var r = takeUnits(s, units);
    var lines = [r[0]];
    s = r[1];
    if (s.length > 0) {
      r = takeUnits(s, units - 1);
      lines.push(r[0] + (r[1].length > 0 ? "\u2026" : ""));
    }
    return lines;
  }

  // pixel width of a string drawn at fontPx — 1 unit ≈ .55 em, CJK counts 2
  function textPx(s, fontPx) {
    var t = s == null ? "" : String(s), u = 0;
    for (var i = 0; i < t.length; i++) u += charW(t[i]);
    return u * fontPx * 0.55;
  }
  function takePx(s, maxPx, fontPx) {
    var t = s == null ? "" : String(s), u = 0, i = 0, per = fontPx * 0.55;
    while (i < t.length && (u + charW(t[i])) * per <= maxPx) { u += charW(t[i]); i++; }
    return t.slice(0, i);
  }

  // ─────────────────────────── edge routing ───────────────────────────
  // Orthogonal route with rounded corners: verticals live in inter-column gaps,
  // horizontals in reserved (dummy) rows => never crosses a foreign node box.
  function orthPath(pts) {
    var p = [], i;
    for (i = 0; i < pts.length; i++) {
      if (p.length && Math.abs(pts[i].x - p[p.length - 1].x) < 0.5 && Math.abs(pts[i].y - p[p.length - 1].y) < 0.5) continue;
      p.push(pts[i]);
    }
    var q = [p[0]];
    for (i = 1; i < p.length - 1; i++) {
      var a = p[i - 1], b = p[i], c = p[i + 1];
      var d0 = Math.hypot(b.x - a.x, b.y - a.y), d1 = Math.hypot(c.x - b.x, c.y - b.y);
      var cross = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
      if (cross < 0.5) { q.push(b); continue; } // collinear
      var r = Math.min(10, d0 / 2, d1 / 2);
      q.push({ x: b.x + (a.x - b.x) / d0 * r, y: b.y + (a.y - b.y) / d0 * r, qc: b,
               xe: b.x + (c.x - b.x) / d1 * r, ye: b.y + (c.y - b.y) / d1 * r });
    }
    q.push(p[p.length - 1]);
    var d = "M " + q[0].x + " " + q[0].y;
    for (i = 1; i < q.length; i++) {
      if (q[i - 1].qc) d += " L " + q[i - 1].x + " " + q[i - 1].y + " Q " + q[i - 1].qc.x + " " + q[i - 1].qc.y + " " + q[i - 1].xe + " " + q[i - 1].ye;
      d += " L " + q[i].x + " " + q[i].y;
    }
    return d;
  }

  // Sort one column by the average position of its neighbours in an adjacent column.
  function sortByBary(col, neigh, posOf) {
    var cur = new Map(), bc = new Map(), i, j, k;
    for (i = 0; i < col.length; i++) cur.set(col[i], i);
    for (j = 0; j < col.length; j++) {
      var id = col[j], ns = neigh(id) || [], sum = 0, n = 0;
      for (k = 0; k < ns.length; k++) {
        var p = posOf.get(ns[k]);
        if (p !== undefined) { sum += p; n++; }
      }
      bc.set(id, n ? sum / n : j);
    }
    return col.slice().sort(function (a, b) {
      var d = bc.get(a) - bc.get(b);
      return d !== 0 ? d : cur.get(a) - cur.get(b);
    });
  }

  // Layered DAG layout: split linked / unlinked, rank by longest path, barycenter ordering.
  function buildModel(graph, showUl, G) {
    G = G || GEO_MAIN;
    var CW = cellW(G), CH = cellH(G);
    var nodes = (graph && graph.nodes) || [];
    var edges = (graph && graph.edges) || [];
    var backEdges = (graph && graph.back_edges) || [];
    var joined = edges.concat(backEdges);
    var linkedIds = new Set();
    var i, j, k, e;
    for (i = 0; i < joined.length; i++) { linkedIds.add(joined[i].parent); linkedIds.add(joined[i].child); }
    var linked = [], unlinkedAll = [];
    for (j = 0; j < nodes.length; j++) {
      if (linkedIds.has(nodes[j].id)) linked.push(nodes[j]); else unlinkedAll.push(nodes[j]);
    }
    // done/cancelled/archived tasks are settled history — drop them from the canvas
    var unlinked = [], ulHiddenTerm = 0;
    for (j = 0; j < unlinkedAll.length; j++) {
      if (TERMINAL[unlinkedAll[j].status]) ulHiddenTerm++; else unlinked.push(unlinkedAll[j]);
    }
    // compact panels (G.KTF): a profile whose work is entirely settled still
    // deserves boxes instead of a blank frame
    if (G.KTF && linked.length === 0 && unlinked.length === 0 && ulHiddenTerm > 0) {
      unlinked = unlinkedAll.slice();
      ulHiddenTerm = 0;
    }
    var ulActive = unlinked.length;
    if (!showUl) unlinked = [];
    var ids = new Set(), nodeMap = new Map();
    for (k = 0; k < linked.length; k++) { ids.add(linked[k].id); nodeMap.set(linked[k].id, linked[k]); }
    var es = [], bes = [];
    for (i = 0; i < edges.length; i++) {
      e = edges[i];
      if (e.parent !== e.child && ids.has(e.parent) && ids.has(e.child)) es.push(e);
    }
    for (i = 0; i < backEdges.length; i++) {
      e = backEdges[i];
      if (e.parent !== e.child && ids.has(e.parent) && ids.has(e.child)) bes.push(e);
    }
    var parents = new Map(), children = new Map();
    for (k = 0; k < linked.length; k++) {
      parents.set(linked[k].id, []);
      children.set(linked[k].id, []);
    }
    for (i = 0; i < es.length; i++) {
      children.get(es[i].parent).push(es[i].child);
      parents.get(es[i].child).push(es[i].parent);
    }
    // ranks: longest path from an indegree-0 root, via topological order
    var rank = new Map(), indeg = new Map(), queue = [];
    for (k = 0; k < linked.length; k++) {
      var nid = linked[k].id, deg = parents.get(nid).length;
      rank.set(nid, 0); indeg.set(nid, deg);
      if (deg === 0) queue.push(nid);
    }
    var qi = 0;
    while (qi < queue.length) {
      var u = queue[qi++], ch = children.get(u);
      for (i = 0; i < ch.length; i++) {
        var v = ch[i];
        if (rank.get(v) < rank.get(u) + 1) rank.set(v, rank.get(u) + 1);
        indeg.set(v, indeg.get(v) - 1);
        if (indeg.get(v) === 0) queue.push(v);
      }
    }
    var maxRank = 0;
    for (k = 0; k < linked.length; k++) if (rank.get(linked[k].id) > maxRank) maxRank = rank.get(linked[k].id);
    var columns = [];
    for (i = 0; i <= maxRank; i++) columns.push([]);
    for (k = 0; k < linked.length; k++) columns[rank.get(linked[k].id)].push(linked[k].id);
    for (i = 0; i < columns.length; i++) {
      columns[i].sort(function (a, b) {
        var na = nodeMap.get(a), nb = nodeMap.get(b);
        var pd = (nb.priority || 0) - (na.priority || 0);
        if (pd !== 0) return pd;
        return (na.created_at || 0) - (nb.created_at || 0);
      });
    }
    // dummy chains: edges spanning >1 rank get empty lane slots in between,
    // so the curve routes through free rows instead of crossing other nodes
    var lay = [];
    for (i = 0; i < columns.length; i++) lay.push(columns[i].slice());
    var par2 = new Map(), ch2 = new Map(), chains = [], did = 0, r, prevN, dname;
    for (k = 0; k < linked.length; k++) { par2.set(linked[k].id, []); ch2.set(linked[k].id, []); }
    function link2(a, b) { ch2.get(a).push(b); par2.get(b).push(a); }
    for (i = 0; i < es.length; i++) {
      var pr = rank.get(es[i].parent), cr = rank.get(es[i].child);
      if (cr - pr <= 1) { link2(es[i].parent, es[i].child); chains.push([]); continue; }
      prevN = es[i].parent;
      var dl = [];
      for (r = pr + 1; r < cr; r++) {
        dname = "\u00a7" + (did++);
        // seed the lane right next to the chain's previous node so the
        // vertical transit stays short and sweeps converge fast
        var at = lay[r - 1].indexOf(prevN);
        if (at < 0) at = 0;
        lay[r].splice(Math.min(at, lay[r].length), 0, dname);
        par2.set(dname, []); ch2.set(dname, []);
        link2(prevN, dname); dl.push(dname); prevN = dname;
      }
      link2(prevN, es[i].child);
      chains.push(dl);
    }
    // barycenter sweeps x4 (forward by parents, backward by children), dummies included
    for (var sweep = 0; sweep < 4; sweep++) {
      for (i = 1; i < lay.length; i++) {
        var prevPos = new Map();
        for (j = 0; j < lay[i - 1].length; j++) prevPos.set(lay[i - 1][j], j);
        lay[i] = sortByBary(lay[i], function (id) { return par2.get(id); }, prevPos);
      }
      for (i = lay.length - 2; i >= 0; i--) {
        var nxtPos = new Map();
        for (j = 0; j < lay[i + 1].length; j++) nxtPos.set(lay[i + 1][j], j);
        lay[i] = sortByBary(lay[i], function (id) { return ch2.get(id); }, nxtPos);
      }
    }
    // geometry (lattice cells shared with drag snapping)
    var placed = new Map(), dummyPos = new Map(), maxRows = 0;
    for (i = 0; i < lay.length; i++) {
      if (lay[i].length > maxRows) maxRows = lay[i].length;
      for (j = 0; j < lay[i].length; j++) {
        var cell = { x: G.M + i * CW, y: G.M + j * CH };
        if (lay[i][j].charCodeAt(0) === 0x00a7) dummyPos.set(lay[i][j], cell);
        else placed.set(lay[i][j], cell);
      }
    }
    var width = lay.length ? G.M * 2 + lay.length * G.W + (lay.length - 1) * G.GX : 0;
    var height = maxRows ? G.M * 2 + maxRows * G.H + (maxRows - 1) * G.GY : 0;
    // unlinked tasks become real boxes on the same lattice, in a tidy grid below
    var ulPos = new Map(), unCols = 0;
    if (unlinked.length) {
      unlinked.sort(function (a, b) {
        var pd = (b.priority || 0) - (a.priority || 0);
        if (pd !== 0) return pd;
        return (a.created_at || 0) - (b.created_at || 0);
      });
      unCols = G.ULC ? Math.min(unlinked.length, G.ULC)
                     : Math.max(3, Math.min(unlinked.length, Math.round(Math.sqrt(unlinked.length * 2.2))));
      // same parity as the graph width => the centring shift is then EXACT in cells
      // (compact panel geometry opts out: the half-cell fallback below keeps it tidy)
      if (!G.ULC && lay.length && (unCols - lay.length) % 2 !== 0) unCols += 1;
      var yStart = G.M + (maxRows > 0 ? (maxRows + 1) * CH : 0);
      for (var u = 0; u < unlinked.length; u++) {
        ulPos.set(unlinked[u].id, { x: G.M + (u % unCols) * CW, y: yStart + Math.floor(u / unCols) * CH });
      }
      var ulRows = Math.ceil(unlinked.length / unCols);
      height = Math.max(height, yStart + (ulRows - 1) * CH + G.H + G.M);
      width = Math.max(width, G.M * 2 + unCols * G.W + (unCols - 1) * G.GX);
    }
    // centre the narrower area against the wider one on whole-cell steps
    // (integral CELL_W keeps the magnet lattice shared by both regions)
    var xShift = 0;
    if (unlinked.length) {
      var nCols = lay.length;
      if (nCols > unCols) {
        var ux = Math.floor((nCols - unCols) / 2) * CW;
        ulPos.forEach(function (p) { p.x += ux; });
      } else if (unCols > nCols) {
        xShift = G.ULC ? Math.round((unCols - nCols) / 2) : Math.floor((unCols - nCols) / 2);
        placed.forEach(function (p) { p.x += xShift * CW; });
      }
    }
    // header anchor for the unlinked region (top-left of its grid, above first row)
    var ulHdrX = 0, ulHdrY = 0;
    ulPos.forEach(function (p) {
      if (!ulHdrX || p.x < ulHdrX) ulHdrX = p.x;
      if (!ulHdrY || p.y < ulHdrY) ulHdrY = p.y;
    });
    if (ulHdrY) ulHdrY -= Math.round(G.H * 0.18);
    // per-edge routing spec: gap lanes + row y ("P"/"C" = live parent/child centre)
    var routes = [];
    for (i = 0; i < es.length; i++) {
      var a2 = rank.get(es[i].parent), b2 = rank.get(es[i].child);
      var spec = [{ gap: a2, y: "P" }];
      for (j = 0; j < chains[i].length; j++) {
        var rho = a2 + 1 + j;
        var dp2 = dummyPos.get(chains[i][j]);
        var lcy = dp2 ? dp2.y + G.H / 2 : 0;
        spec.push({ gap: rho - 1, y: lcy });
        spec.push({ gap: rho, y: lcy });
      }
      spec.push({ gap: b2 - 1, y: "C" });
      routes.push(spec);
    }
    return {
      placed: placed, ulPos: ulPos, width: width, height: height, xShift: xShift,
      parents: parents, children: children, nodeMap: nodeMap,
      unlinked: unlinked, edges: es, backEdges: bes, routes: routes,
      ulActive: ulActive, ulHiddenTerm: ulHiddenTerm, ulHdrX: ulHdrX, ulHdrY: ulHdrY,
      geo: G
    };
  }

  function snapCell(p, G) {
    G = G || GEO_MAIN;
    var CW = cellW(G), CH = cellH(G);
    var cx = Math.max(0, Math.round((p.x - G.M) / CW));
    var cy = Math.max(0, Math.round((p.y - G.M) / CH));
    return { x: G.M + cx * CW, y: G.M + cy * CH };
  }

  // Merge free/magneted drag positions over the layered layout. Manual positions
  // render verbatim (smooth while dragging); their nearest cell is claimed so
  // auto/lattice nodes shift down instead of ever sharing a cell with anything.
  function buildView(mdl, ov) {
    var G = (mdl && mdl.geo) || GEO_MAIN, CW = cellW(G), CH = cellH(G);
    var placed = new Map(), occ = new Set(), ids = [], maxX = 0, maxY = 0;
    mdl.nodeMap.forEach(function (n, id) { ids.push(id); });
    mdl.unlinked.forEach(function (n) { ids.push(n.id); });
    var i, p;
    for (i = 0; i < ids.length; i++) {
      var o = ov && ov[ids[i]];
      if (!o) continue;
      var k0 = snapCell(o, G);
      occ.add(k0.x + "," + k0.y);
      placed.set(ids[i], { x: o.x, y: o.y });
    }
    for (i = 0; i < ids.length; i++) {
      if (placed.has(ids[i])) continue;
      p = mdl.placed.get(ids[i]) || mdl.ulPos.get(ids[i]);
      if (!p) continue;
      while (occ.has(p.x + "," + p.y)) p = { x: p.x, y: p.y + CH };
      occ.add(p.x + "," + p.y);
      placed.set(ids[i], p);
    }
    placed.forEach(function (q) {
      if (q.x + G.W > maxX) maxX = q.x + G.W;
      if (q.y + G.H > maxY) maxY = q.y + G.H;
    });
    if (placed.size === 0) return { placed: placed, width: mdl.width, height: mdl.height };
    return {
      placed: placed,
      width: Math.max(mdl.width, maxX + G.M),
      height: Math.max(mdl.height, maxY + G.M)
    };
  }

  // ancestors + descendants of startId along edges (two BFS passes)
  function collect(startId, childrenMap, parentsMap) {
    var set = new Set([startId]), q = [startId], i;
    while (q.length) {
      var u = q.shift(), cs = childrenMap.get(u) || [];
      for (i = 0; i < cs.length; i++) if (!set.has(cs[i])) { set.add(cs[i]); q.push(cs[i]); }
    }
    q = [startId];
    while (q.length) {
      var w = q.shift(), ps = parentsMap.get(w) || [];
      for (i = 0; i < ps.length; i++) if (!set.has(ps[i])) { set.add(ps[i]); q.push(ps[i]); }
    }
    return set;
  }

  // ─────────────────── multi-profile model builders (pure) ───────────────────
  function neededSlugs(mode, board, scope, boards) {
    if (mode === "single") return board ? [board] : [];
    if (scope) return [scope];
    return (boards || []).map(function (b) { return b.slug; });
  }

  // Union of several boards' graphs. Ids are board-prefixed only when >1 board is
  // in scope, so single-board labels stay the raw task ids.
  function mergeGraphs(graphs, slugs) {
    var multi = slugs.length > 1;
    var nodes = [], edges = [], back = [];
    for (var i = 0; i < slugs.length; i++) {
      var sl = slugs[i], g = graphs[sl];
      if (!g) continue;
      var pfx = multi ? sl + ":" : "";
      var ns = g.nodes || [], es = g.edges || [], bs = g.back_edges || [], j;
      for (j = 0; j < ns.length; j++) {
        var n = ns[j];
        nodes.push({ id: pfx + n.id, oid: n.id, board: sl, title: n.title, status: n.status,
                     assignee: n.assignee, priority: n.priority, created_at: n.created_at,
                     tag: n.tag, tagFull: n.tagFull, tagColor: n.tagColor });
      }
      for (j = 0; j < es.length; j++) edges.push({ parent: pfx + es[j].parent, child: pfx + es[j].child });
      for (j = 0; j < bs.length; j++) back.push({ parent: pfx + bs[j].parent, child: pfx + bs[j].child });
    }
    return { nodes: nodes, edges: edges, back_edges: back, multi: multi };
  }

  function pkey(n) { return n && n.assignee ? String(n.assignee) : ""; }

  // Split a merged graph into one subgraph per profile (assignee) + the
  // cross-profile wires between them.
  // how many task blocks a card actually draws: a status hidden by the legend
  // takes its blocks off the card, and a card with none left is an empty card
  function blockCount(g, hideSt) {
    var n = 0, i;
    for (i = 0; i < g.nodes.length; i++) if (!(hideSt && hideSt[g.nodes[i].status])) n++;
    return n;
  }

  function groupByProfile(merged, hideSt) {
    var nodes = (merged && merged.nodes) || [];
    var byK = {}, order = [], owner = {}, i;
    for (i = 0; i < nodes.length; i++) {
      var k = pkey(nodes[i]);
      if (!byK[k]) { byK[k] = { name: k, nodes: [], edges: [], backEdges: [], active: false, running: 0 }; order.push(k); }
      byK[k].nodes.push(nodes[i]);
      owner[nodes[i].id] = k;
      if (nodes[i].status === "running") { byK[k].active = true; byK[k].running++; }
    }
    var all = [];
    var es = (merged && merged.edges) || [], bs = (merged && merged.back_edges) || [];
    for (i = 0; i < es.length; i++) all.push({ parent: es[i].parent, child: es[i].child, back: false });
    for (i = 0; i < bs.length; i++) all.push({ parent: bs[i].parent, child: bs[i].child, back: true });
    var cross = [];
    for (i = 0; i < all.length; i++) {
      var e = all[i], a = owner[e.parent], b = owner[e.child];
      if (a === undefined || b === undefined) continue;
      if (a === b) (e.back ? byK[a].backEdges : byK[a].edges).push({ parent: e.parent, child: e.child });
      else cross.push({ parent: e.parent, child: e.child, from: a, to: b, back: e.back });
    }
    var groups = order.map(function (k) {
      var g = byK[k], counts = {};
      for (i = 0; i < g.nodes.length; i++) counts[g.nodes[i].status] = (counts[g.nodes[i].status] || 0) + 1;
      g.counts = counts;
      var n = 0;
      for (i = 0; i < cross.length; i++) if (cross[i].from === k || cross[i].to === k) n++;
      g.cross = n;
      return g;
    });
    groups.sort(function (a, b) {
      // cards that still draw task blocks come first (auto-arrange tiles in this
      // order, so the busy profiles land in the top-left slots); then by profile
      // name — numeric suffixes compare numerically, unassigned last
      var ab = blockCount(a, hideSt) > 0, bb = blockCount(b, hideSt) > 0;
      if (ab !== bb) return ab ? -1 : 1;
      if ((a.name === "") !== (b.name === "")) return a.name === "" ? 1 : -1;
      return String(a.name).localeCompare(String(b.name), "en", { numeric: true, sensitivity: "base" });
    });
    return { groups: groups, cross: cross };
  }

  function buildPanels(groups, G) {
    var out = {};
    for (var i = 0; i < groups.length; i++) {
      var g = groups[i];
      var sub = { nodes: g.nodes, edges: g.edges, back_edges: g.backEdges };
      var mdl = buildModel(sub, true, G || GEO_MINI);
      out[g.name] = { model: mdl, view: buildView(mdl, {}), group: g };
    }
    return out;
  }

  // ─────────────────── panel geometry: tile / snap (pure) ───────────────────
  function tileRects(n, W, H, gap, minW, minH) {
    var out = [];
    if (n <= 0) return out;
    gap = gap || PGAP;
    minW = minW || PMIN_W;
    minH = minH || PMIN_H;
    var cols = Math.max(1, Math.min(n, Math.round(Math.sqrt(n * (Math.max(320, W) / Math.max(240, H)))) ));
    var rows = Math.ceil(n / cols);
    var w = Math.max(minW, Math.floor((W - (cols + 1) * gap) / cols));
    var h = Math.max(minH, Math.floor((H - (rows + 1) * gap) / rows));
    for (var i = 0; i < n; i++) {
      out.push({ x: gap + (i % cols) * (w + gap), y: gap + Math.floor(i / cols) * (h + gap), w: w, h: h });
    }
    return out;
  }

  function overlaps(a, b) {
    return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
  }

  // First free slot on a stable PDEF-sized lattice; extends past the fold when
  // the visible canvas is full.
  function pickFreeSlot(placed, W, H) {
    var cols = Math.max(1, Math.floor((W - PGAP) / (PDEF_W + PGAP)));
    var rows = Math.max(1, Math.floor((H - PGAP) / (PDEF_H + PGAP)));
    var i, j, k, ok;
    for (j = 0; j < rows + 8; j++) {
      for (i = 0; i < cols; i++) {
        var cand = { x: PGAP + i * (PDEF_W + PGAP), y: PGAP + j * (PDEF_H + PGAP), w: PDEF_W, h: PDEF_H };
        ok = true;
        for (k = 0; k < placed.length; k++) if (overlaps(cand, placed[k])) { ok = false; break; }
        if (ok) return cand;
      }
    }
    var maxY = 0;
    for (k = 0; k < placed.length; k++) maxY = Math.max(maxY, placed[k].y + placed[k].h);
    return { x: PGAP, y: maxY + PGAP, w: PDEF_W, h: PDEF_H };
  }

  function hasOverlap(rect, list) {
    for (var i = 0; i < list.length; i++) if (overlaps(rect, list[i])) return true;
    return false;
  }

  function axisTargets(rects, canvas, axis) {
    var t = [];
    for (var i = 0; i < rects.length; i++) {
      var r = rects[i];
      if (axis === "x") t.push(r.x, r.x + r.w / 2, r.x + r.w);
      else t.push(r.y, r.y + r.h / 2, r.y + r.h);
    }
    var C = axis === "x" ? canvas.w : canvas.h;
    t.push(0, C / 2, C);
    return t;
  }

  function snapAxis(v, size, targets, tol) {
    var edges = [v, v + size / 2, v + size];
    var best = null;
    for (var i = 0; i < edges.length; i++) {
      for (var j = 0; j < targets.length; j++) {
        var d = targets[j] - edges[i];
        if (Math.abs(d) <= tol && (!best || Math.abs(d) < Math.abs(best.d))) best = { d: d, at: targets[j] };
      }
    }
    return best;
  }

  // Free move + magnet to neighbouring panel edges/centres, then to the 8px grid.
  function snapMove(rect, others, canvas, tol, grid) {
    var out = { x: rect.x, y: rect.y, w: rect.w, h: rect.h }, guides = [];
    var bx = snapAxis(rect.x, rect.w, axisTargets(others, canvas, "x"), tol);
    if (bx) { out.x = rect.x + bx.d; guides.push({ dir: "v", at: bx.at }); }
    else out.x = Math.round(rect.x / grid) * grid;
    var by = snapAxis(rect.y, rect.h, axisTargets(others, canvas, "y"), tol);
    if (by) { out.y = rect.y + by.d; guides.push({ dir: "h", at: by.at }); }
    else out.y = Math.round(rect.y / grid) * grid;
    out.x = Math.max(0, out.x);
    out.y = Math.max(0, out.y);
    return { rect: out, guides: guides };
  }

  // Resize from the bottom-right corner: only the dragged edges snap.
  function snapResize(rect, dx, dy, others, canvas, tol, grid, minW, minH) {
    var w = Math.max(minW, rect.w + dx), hh = Math.max(minH, rect.h + dy);
    var right = rect.x + w, bot = rect.y + hh;
    var guides = [];
    var bx = snapAxis(right, 0, axisTargets(others, canvas, "x"), tol);
    if (bx) { w = Math.max(minW, right + bx.d - rect.x); guides.push({ dir: "v", at: bx.at }); }
    else w = Math.max(minW, Math.round(w / grid) * grid);
    var by = snapAxis(bot, 0, axisTargets(others, canvas, "y"), tol);
    if (by) { hh = Math.max(minH, bot + by.d - rect.y); guides.push({ dir: "h", at: by.at }); }
    else hh = Math.max(minH, Math.round(hh / grid) * grid);
    return { rect: { x: rect.x, y: rect.y, w: w, h: hh }, guides: guides };
  }

  // wire between two panels, drawn behind them
  function crossPath(a, b) {
    var ax, ay, bx, by;
    if (a.x + a.w <= b.x) { ax = a.x + a.w; ay = a.y + a.h / 2; bx = b.x; by = b.y + b.h / 2; }
    else if (b.x + b.w <= a.x) { ax = a.x; ay = a.y + a.h / 2; bx = b.x + b.w; by = b.y + b.h / 2; }
    else { ax = a.x + a.w / 2; ay = a.y + a.h; bx = b.x + b.w / 2; by = b.y; }
    var d = Math.max(22, Math.abs(bx - ax) * 0.35);
    var sx = bx >= ax ? 1 : -1;
    return "M " + ax + " " + ay + " C " + (ax + d * sx) + " " + ay + " " + (bx - d * sx) + " " + by + " " + bx + " " + by;
  }

  function fitsHide(n, hideSt) { return !!(n && hideSt && hideSt[n.status]); }

  // ────────────────── card geometry: groups / push-aside / inner ──────────────────
  function unionRect(a, b) {
    var x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    return { x: x, y: y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
  }

  // the box inside a group card that holds the member cards (group-relative)
  function groupBody(rect) {
    return {
      x: GBODY_PAD, y: GHEAD,
      w: Math.max(120, rect.w - 2 * GBODY_PAD),
      h: Math.max(80, rect.h - GHEAD - GBODY_PAD)
    };
  }

  function clampInnerRect(r, body) {
    var w = Math.min(Math.max(1, r.w), Math.max(1, body.w));
    var h = Math.min(Math.max(1, r.h), Math.max(1, body.h));
    return { x: clamp(r.x, 0, Math.max(0, body.w - w)), y: clamp(r.y, 0, Math.max(0, body.h - h)), w: w, h: h };
  }

  // squarified treemap (Bruls/Huizing/van Wijk): areas -> tidily proportioned
  // rectangles that fill the box exactly, in the order the areas were given.
  function squarifyRects(areas, W, H) {
    var n = areas.length, out = new Array(n);
    if (!n) return out;
    var i = 0, cx = 0, cy = 0, cw = Math.max(1, W), ch = Math.max(1, H), k;
    while (i < n) {
      var short = Math.min(cw, ch);
      if (!(short > 0)) { for (; i < n; i++) out[i] = { x: cx, y: cy, w: 0, h: 0 }; break; }
      var rowArea = 0, j = i, bestWorst = Infinity;
      while (j < n) {
        var na = rowArea + areas[j];
        var side = na / short;
        var worst = 0;
        for (k = i; k <= j; k++) {
          var len = (areas[k] / side) || 1e-6;
          var rr = Math.max(side / len, len / side);
          if (rr > worst) worst = rr;
        }
        if (j > i && worst > bestWorst) break;
        bestWorst = worst; rowArea = na; j++;
      }
      // the row runs along the SHORT side and its depth measures along the LONG
      // side, so clamping it to `short` overflowed the box and left a gap
      // (found by the v9 acceptance run: a 498px-wide member in a 688px body)
      var depth = Math.min(Math.max(cw, ch), rowArea / short);
      if (cw >= ch) {
        var yy = cy;
        for (k = i; k < j; k++) {
          var hh = areas[k] / depth;
          out[k] = { x: cx, y: yy, w: depth, h: hh };
          yy += hh;
        }
        cx += depth; cw -= depth;
      } else {
        var xx = cx;
        for (k = i; k < j; k++) {
          var ww = areas[k] / depth;
          out[k] = { x: xx, y: cy, w: ww, h: depth };
          xx += ww;
        }
        cy += depth; ch -= depth;
      }
      i = j;
    }
    return out;
  }

  // share the body out by weight, then inset every cell by half the gap;
  // null = "too cramped to be worth weighting", caller falls back to even tiling
  function weightedSlots(weights, W, H, gap) {
    var n = weights.length, i, sum = 0;
    if (!n) return [];
    for (i = 0; i < n; i++) sum += Math.max(0, weights[i]);
    if (!(sum > 0)) return null;
    W = Math.max(1, W); H = Math.max(1, H);
    var areas = [];
    for (i = 0; i < n; i++) areas.push(Math.max(0, weights[i]) / sum * W * H);
    var raw = squarifyRects(areas, W, H), out = [];
    for (i = 0; i < n; i++) {
      var r = raw[i] || { x: 0, y: 0, w: 0, h: 0 };
      var s = {
        x: Math.round(r.x + gap / 2), y: Math.round(r.y + gap / 2),
        w: Math.max(1, Math.round(r.w - gap)), h: Math.max(1, Math.round(r.h - gap))
      };
      if (s.w < 60 || s.h < 46) return null;
      out.push(s);
    }
    return out;
  }

  // a member's claim on the group body: 1 unit with no task blocks, up to 3 with
  // plenty — so busy profiles grow and empty ones shrink (user 2026-10-11)
  var PROF_W_EMPTY = 1, PROF_W_BUSY = 3;
  function profWeight(count) {
    var k = typeof count === "number" && count > 0 ? count : 0;
    if (!k) return PROF_W_EMPTY;
    return PROF_W_EMPTY + (PROF_W_BUSY - PROF_W_EMPTY) * Math.min(1, k / 4);
  }

  // keep a member where the layout wants it — its own slot, then any free slot,
  // then the nearest free spot — and shrink it only when the card really has no
  // room left. Without this a manual rect that lands on the slots left the other
  // members stacked on top of it (caught by the v7 acceptance run 2026-10-11).
  function freeSpot(want, slots, claimed, body, gap) {
    var i, c = clampInnerRect(want, body);
    if (!hasOverlap(c, claimed)) return c;
    for (i = 0; i < slots.length; i++) {
      if (!slots[i] || hasOverlap(slots[i], claimed)) continue;
      c = clampInnerRect(slots[i], body);
      if (!hasOverlap(c, claimed)) return c;
    }
    var scales = [1, 0.8, 0.65, 0.5, 0.4], s, xx, yy;
    for (s = 0; s < scales.length; s++) {
      var w = Math.max(64, Math.round(want.w * scales[s]));
      var h = Math.max(48, Math.round(want.h * scales[s]));
      if (w > body.w || h > body.h) continue;
      var best = null, bestD = Infinity;
      for (yy = 0; yy <= body.h - h; yy += 6) {
        for (xx = 0; xx <= body.w - w; xx += 6) {
          var t = { x: xx, y: yy, w: w, h: h };
          if (hasOverlap(t, claimed)) continue;
          var d = Math.abs(xx - want.x) + Math.abs(yy - want.y);
          if (d < bestD) { bestD = d; best = t; }
        }
      }
      if (best) return best;
    }
    return c;
  }

  // member rects inside a group: stored (manual) ones win, the rest tile, and
  // everything is clamped inside the body so a member can never escape the card.
  // `weights` (optional, one per member) switches the tiling to a weighted
  // treemap; without it the plain even tiling is used.
  function innerLayout(members, stored, body, gap, weights) {
    stored = stored || {};
    gap = gap == null ? INNER_PAD : gap;
    var out = {}, claimed = [], i, k;
    var slots = (weights && weights.length === members.length)
      ? weightedSlots(weights, body.w, body.h, gap) : null;
    if (!slots) {
      slots = tileRects(members.length, body.w, body.h, gap, IMIN_W, IMIN_H);
      for (i = 0; i < slots.length; i++) {
        if (slots[i].x + slots[i].w > body.w + 0.5 || slots[i].y + slots[i].h > body.h + 0.5) {
          slots = tileRects(members.length, body.w, body.h, gap, 1, 1); // too cramped for the minimums
          break;
        }
      }
    }
    for (i = 0; i < members.length; i++) {
      if (stored[members[i]]) claimed.push(clampInnerRect(stored[members[i]], body));
    }
    for (i = 0; i < members.length; i++) {
      var m = members[i], r = stored[m] ? clampInnerRect(stored[m], body) : null;
      if (!r) {
        var want = slots[i] || { x: gap, y: gap, w: Math.max(40, Math.min(IMIN_W, body.w)), h: Math.max(30, Math.min(IMIN_H, body.h)) };
        r = freeSpot(want, slots, claimed, body, gap);
      }
      out[m] = r;
      claimed.push(r);
    }
    return out;
  }

  // nearest grid-aligned spot for `rect` that touches nothing in `placed`
  // (rings outwards on the grid, so a displaced card moves as little as possible)
  function nearestFree(rect, placed, grid, reach) {
    reach = reach || 64;
    if (!hasOverlap(rect, placed)) return { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
    var best = null, r, dx, dy;
    for (r = 1; r <= reach && !best; r++) {
      for (dy = -r; dy <= r && !best; dy++) {
        for (dx = -r; dx <= r && !best; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // ring only
          var cand = { x: Math.max(0, rect.x + dx * grid), y: Math.max(0, rect.y + dy * grid), w: rect.w, h: rect.h };
          if (!hasOverlap(cand, placed)) best = cand;
        }
      }
    }
    if (!best) best = pickFreeSlot(placed, 2000, 2000);
    return best;
  }

  // every card the moved/resized `rect` now covers steps aside: returns
  // { id: rect } for the cards that must move (closest-to-the-rect first)
  function pushAside(rect, others, grid) {
    var placed = [{ x: rect.x, y: rect.y, w: rect.w, h: rect.h }], moves = {};
    others.slice().sort(function (a, b) {
      return (Math.abs(a.rect.x - rect.x) + Math.abs(a.rect.y - rect.y)) -
             (Math.abs(b.rect.x - rect.x) + Math.abs(b.rect.y - rect.y));
    }).forEach(function (o) {
      if (!hasOverlap(o.rect, placed)) { placed.push(o.rect); return; }
      var spot = nearestFree(o.rect, placed, grid);
      moves[o.id] = spot;
      placed.push(spot);
    });
    return moves;
  }

  function insideRect(rect, pt) {
    return pt.x >= rect.x && pt.x <= rect.x + rect.w && pt.y >= rect.y && pt.y <= rect.y + rect.h;
  }

  // ─────────────────────────── node rendering ───────────────────────────
  function renderNode(n, pos, G, opts) {
    var units = G.UNITS;
    var lines = wrapTitle(n.title, units);
    var tspans = lines.map(function (ln, i) {
      return h("tspan", { key: i, x: G.PAD, dy: i === 0 ? 0 : G.DY }, ln);
    });
    var cls = "kg-node kg-s-" + n.status + (opts.cls || "");
    var props = { key: n.id, className: cls, transform: "translate(" + pos.x + "," + pos.y + ")" };
    if (opts.handlers) {
      props.onPointerDown = opts.handlers.onPointerDown;
      props.onClick = opts.handlers.onClick;
    }
    var barY = Math.round(G.H * 0.18);
    var meta = String(opts.metaOf ? (opts.metaOf(n) || "") : (n.assignee || "—"));
    var stTxt = (ICON[n.status] || "●") + " " + (LABEL[n.status] || n.status);
    var cf = G.UNITS >= 28 ? 9.5 : 8, mf = G.UNITS >= 28 ? 11 : 9, sf = G.UNITS >= 28 ? 10.5 : 8.8;
    // ★ keep cf in step with .kg-node .kg-mtag / .kg-mini .kg-mtag in style.css
    // the API provider/model chip (nodes carry tag/tagFull/tagColor from the graph api)
    var tag = n.tag ? String(n.tag) : "";
    var tagW = tag ? Math.round(textPx(tag, cf)) + 10 : 0;
    var metaX = G.PAD + (tagW ? tagW + 6 : 0);
    var avail = G.W - 12 - textPx(stTxt, sf) * 1.14 - 5 - metaX;
    var metaTxt = "";
    if (avail > 12) {
      metaTxt = takePx(meta, avail, mf);
      if (metaTxt.length < meta.length) metaTxt = takePx(meta, Math.max(0, avail - textPx("\u2026", mf)), mf) + "\u2026";
    }
    var chroma = n.tagColor || "#9ca3af";
    var chip = tag ? h("g", { key: "tag" },
      h("rect", {
        className: "kg-mpill", x: G.PAD, y: G.MY - cf + 1, width: tagW, height: cf + 2.6, rx: 3,
        fill: chroma, fillOpacity: 0.15, stroke: chroma, strokeOpacity: 0.34, strokeWidth: 0.7
      }),
      h("text", { className: "kg-mtag", x: G.PAD + 5, y: G.MY - 1, fill: chroma }, tag)) : null;
    return h("g", props,
      h("title", null, (n.oid || n.id) + " · " + (LABEL[n.status] || n.status) + " · " + (n.assignee || "—") +
        (n.tagFull ? " · " + n.tagFull : "")),
      n.status === "running"
        ? h("g", { key: "cmt" },
            h("path", { className: "kg-comet-tail", d: opts.comet, pathLength: 100 }),
            h("path", { className: "kg-comet", d: opts.comet, pathLength: 100 }))
        : null,
      h("rect", { className: "kg-box", x: 0, y: 0, width: G.W, height: G.H, rx: G.RAD }),
      h("rect", { className: "kg-bar", x: 0, y: barY, width: 4, height: G.H - 2 * barY, rx: 2 }),
      h("text", { className: "kg-title", x: G.PAD, y: G.TY }, tspans),
      chip,
      metaTxt ? h("text", { className: "kg-asg", x: metaX, y: G.MY }, metaTxt) : null,
      h("text", { className: "kg-st", x: G.W - 12, y: G.MY, "text-anchor": "end" }, stTxt)
    );
  }

  // dimOne(e) => true hides the edge's emphasis (selection neighbourhood)
  function renderEdges(model, view, hideSt, marker, dimOne) {
    var out = [];
    if (!(model.edges.length || model.backEdges.length)) return out;
    var G = model.geo || GEO_MAIN;
    // lane slot per (edge, gap): offset verticals so lines don't ride each other
    var gxMap = new Map(), gcnt = {};
    model.edges.forEach(function (e2, i2) {
      var spec2 = model.routes[i2] || [], gs = [];
      spec2.forEach(function (s2) { if (gs.indexOf(s2.gap) < 0) gs.push(s2.gap); });
      gs.forEach(function (g2) {
        gcnt[g2] = gcnt[g2] || 0;
        gxMap.set(i2 + ":" + g2, G.M + (g2 + (model.xShift || 0)) * cellW(G) + G.W + G.GX / 2 + (((gcnt[g2]++ % 5) - 2) * 14));
      });
    });
    function one(e, back, idx) {
      var p = view.placed.get(e.parent), c = view.placed.get(e.child);
      if (!p || !c) return null;
      var pn = model.nodeMap.get(e.parent), cn = model.nodeMap.get(e.child);
      if (fitsHide(pn, hideSt) || fitsHide(cn, hideSt)) return null;
      var pts = [{ x: p.x + G.W, y: p.y + G.H / 2 }];
      if (!back) {
        (model.routes[idx] || []).forEach(function (s) {
          pts.push({
            x: gxMap.get(idx + ":" + s.gap),
            y: s.y === "P" ? p.y + G.H / 2 : s.y === "C" ? c.y + G.H / 2 : s.y
          });
        });
      }
      pts.push({ x: c.x, y: c.y + G.H / 2 });
      var dim = dimOne && dimOne(e);
      return h("path", {
        key: (back ? "b" : "e") + idx,
        className: "kg-edge" + (back ? " kg-back" : "") + (dim ? " kg-dim" : ""),
        d: orthPath(pts),
        markerEnd: marker ? "url(#" + marker + ")" : undefined
      });
    }
    model.edges.forEach(function (e, i) { var x = one(e, false, i); if (x) out.push(x); });
    model.backEdges.forEach(function (e, i) { var x = one(e, true, i); if (x) out.push(x); });
    return out;
  }

  // ─────────────────────────── single-board view ───────────────────────────
  function SingleBoardView(props) {
    var s;
    var boards = props.boards, board = props.board, error = props.error;
    var hideSt = props.hideSt;
    s = useState(null); var graph = s[0], setGraph = s[1];
    s = useState(null); var selected = s[0], setSelected = s[1];
    s = useState({ x: 0, y: 0 }); var pan = s[0], setPan = s[1];
    s = useState(1); var zoom = s[0], setZoom = s[1];
    s = useState(false); var dragging = s[0], setDragging = s[1];
    s = useState(false); var ndragging = s[0], setNDragging = s[1];
    s = useState({}); var posOv = s[0], setPosOv = s[1];
    s = useState(function () { return lsGet(LS_UL) === "1"; }); var showUl = s[0], setShowUl = s[1];
    s = useState(readGrid); var gridOn = s[0], setGridOn = s[1];

    var containerRef = useRef(null);
    var zoomRef = useRef(1);
    var panRef = useRef({ x: 0, y: 0 });
    var dragRef = useRef(null);
    var lastFit = useRef(null);
    var ndRef = useRef(null);
    var ndSuppressClick = useRef(false);
    var pendingFit = useRef(false);

    // the page owns the fetch; the view just mirrors the selected board's graph
    useEffect(function () { setGraph((props.graphs || {})[board] || null); }, [props.graphs, board]);

    var model = useMemo(function () { return buildModel(graph, showUl); }, [graph, showUl]);
    var view = useMemo(function () { return buildView(model, posOv); }, [model, posOv]);
    var viewRef = useRef(view);
    viewRef.current = view;
    var posOvRef = useRef(posOv);
    posOvRef.current = posOv;

    var highlight = useMemo(function () {
      if (!selected) return null;
      return collect(selected, model.children, model.parents);
    }, [selected, model]);

    var fitView = useCallback(function () {
      var el = containerRef.current, mdl = viewRef.current, scale = 1;
      if (el && mdl && mdl.width > 0 && mdl.height > 0) {
        var rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          scale = clamp(Math.min(1, (rect.width - 16) / mdl.width, (rect.height - 16) / mdl.height), MIN_ZOOM, MAX_ZOOM);
          zoomRef.current = scale; setZoom(scale);
          var cx = Math.max(0, (rect.width - mdl.width * scale) / 2);
          var cy = Math.max(0, (rect.height - mdl.height * scale) / 2);
          panRef.current = { x: cx, y: cy }; setPan({ x: cx, y: cy });
          return;
        }
      }
      zoomRef.current = scale; setZoom(scale);
      panRef.current = { x: 0, y: 0 }; setPan({ x: 0, y: 0 });
    }, []);

    // per-board manual positions ride on the board switch (legacy free positions
    // from v1 get normalised onto the lattice once, then persisted)
    useEffect(function () {
      var raw = readPos(board), fixed = {}, changed = false;
      Object.keys(raw).forEach(function (k) {
        var sq = snapCell(raw[k]);
        if (sq.x !== raw[k].x || sq.y !== raw[k].y) changed = true;
        fixed[k] = sq;
      });
      if (changed) writePos(board, fixed);
      setPosOv(fixed);
      if (lastFit.current !== board) { lastFit.current = board; pendingFit.current = true; }
    }, [board]);

    // keep selection valid across refreshes / status filtering
    useEffect(function () {
      if (!graph || !selected) return;
      var ns = graph.nodes || [];
      for (var i = 0; i < ns.length; i++) {
        if (ns[i].id !== selected) continue;
        if (!hideSt[ns[i].status]) return;
        break;
      }
      setSelected(null);
    }, [graph, selected, hideSt]);

    // auto fit the first time a board's graph shows up
    useEffect(function () {
      if (!graph || graph.board !== board) return;
      if (lastFit.current === board) return;
      lastFit.current = board;
      fitView();
    }, [graph, board, fitView]);

    // wheel zoom must be non-passive, so bind natively
    useEffect(function () {
      var el = containerRef.current;
      if (!el) return;
      function onWheel(e) {
        e.preventDefault();
        var factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        var next = clamp(zoomRef.current * factor, MIN_ZOOM, MAX_ZOOM);
        zoomRef.current = next; setZoom(next);
      }
      el.addEventListener("wheel", onWheel, { passive: false });
      return function () { el.removeEventListener("wheel", onWheel); };
    }, []);

    // drag panning
    useEffect(function () {
      if (!dragging) return;
      function move(e) {
        var d = dragRef.current;
        if (!d) return;
        var dx = e.clientX - d.sx, dy = e.clientY - d.sy;
        if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
        var nx = d.px + dx, ny = d.py + dy;
        panRef.current = { x: nx, y: ny }; setPan({ x: nx, y: ny });
      }
      function up() { setDragging(false); }
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
      return function () {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
      };
    }, [dragging]);

    // node dragging (positions override the layered layout, persisted per board)
    useEffect(function () {
      if (!ndragging) return;
      function move(e) {
        var d = ndRef.current;
        if (!d) return;
        var ddx = e.clientX - d.sx, ddy = e.clientY - d.sy;
        if (!d.moved && Math.abs(ddx) + Math.abs(ddy) > 4) d.moved = true;
        if (!d.moved) return;
        var z = zoomRef.current || 1;
        // free 1:1 tracking, magnetise per-axis when close to the lattice
        var fx = d.ox + ddx / z, fy = d.oy + ddy / z;
        var gx = snapCell({ x: fx, y: fy });
        if (Math.abs(fx - gx.x) <= MAGNET) fx = gx.x;
        if (Math.abs(fy - gx.y) <= MAGNET) fy = gx.y;
        fx = Math.max(0, fx); fy = Math.max(0, fy);
        if (d.last && d.last.x === fx && d.last.y === fy) return;
        var np = { x: fx, y: fy };
        d.last = np;
        var nxt = Object.assign({}, posOvRef.current);
        nxt[d.id] = np;
        posOvRef.current = nxt;
        setPosOv(nxt);
      }
      function up() {
        var d = ndRef.current;
        setNDragging(false);
        if (d && d.moved) {
          ndSuppressClick.current = true;
          // settle on release: nearest cell, yielding downward if taken
          var cur = (posOvRef.current || {})[d.id] || { x: d.ox, y: d.oy };
          var fp = snapCell(cur);
          var occ = new Set();
          viewRef.current.placed.forEach(function (q, qid) {
            if (qid === d.id) return;
            var kc = snapCell(q);
            occ.add(kc.x + "," + kc.y);
          });
          while (occ.has(fp.x + "," + fp.y)) fp = { x: fp.x, y: fp.y + CELL_H };
          var nxt = Object.assign({}, posOvRef.current);
          nxt[d.id] = fp;
          posOvRef.current = nxt;
          setPosOv(nxt);
          var out = {};
          viewRef.current.placed.forEach(function (q, id) { if (nxt[id]) out[id] = nxt[id]; });
          out[d.id] = fp;
          writePos(board, out);
        }
      }
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
      return function () {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
      };
    }, [ndragging, board]);

    var onBgDown = useCallback(function (e) {
      dragRef.current = {
        sx: e.clientX, sy: e.clientY,
        px: panRef.current.x, py: panRef.current.y, moved: false
      };
      setDragging(true);
    }, []);

    var onBgClick = useCallback(function () {
      var d = dragRef.current;
      if (d && d.moved) return;
      setSelected(null);
    }, []);

    var onSelectBoard = useCallback(function (v) {
      setSelected(null);
      lastFit.current = null;
      props.setBoard(v);
    }, []);

    // one-click: drop all manual positions, back to layered layout + fit screen
    var onAutoLayout = useCallback(function () {
      posOvRef.current = {};
      setPosOv({});
      writePos(board, {});
      pendingFit.current = true;
    }, [board]);

    useEffect(function () {
      if (pendingFit.current) {
        pendingFit.current = false;
        fitView();
      }
    }, [view, fitView]);

    function nodeHandlers(id) {
      return {
        onPointerDown: function (e) {
          if (isDoubleTap("n:" + id)) {
            e.stopPropagation();
            if (props.onTask) props.onTask(id, board);
            return;
          }
          e.stopPropagation();
          ndSuppressClick.current = false;
          if (e.pointerType === "mouse" && e.button != null && e.button !== 0) return;
          var p = viewRef.current.placed.get(id);
          if (!p) return;
          ndRef.current = { id: id, sx: e.clientX, sy: e.clientY, ox: p.x, oy: p.y, moved: false };
          setNDragging(true);
        },
        onClick: function (e) {
          e.stopPropagation();
          if (ndSuppressClick.current) { ndSuppressClick.current = false; return; }
          setSelected(function (prev) { return prev === id ? null : id; });
        }
      };
    }

    // legend chips: one per status actually present, icon + label + count, tinted
    var counts = useMemo(function () {
      var c = {}, ns = (graph && graph.nodes) || [];
      for (var i = 0; i < ns.length; i++) c[ns[i].status] = (c[ns[i].status] || 0) + 1;
      return c;
    }, [graph]);
    var present = Object.keys(counts);
    present.sort(function (a, b) {
      var ia = STATUS_ORDER.indexOf(a), ib = STATUS_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    var chips = present.map(function (st) {
      return h("button", {
        key: st, type: "button",
        className: "kg-chip kg-chip-btn kg-s-" + st + (hideSt[st] ? " kg-chip-off" : ""),
        title: (LABEL[st] || st) + " · 点击" + (hideSt[st] ? "显示" : "隐藏"),
        onClick: function () { props.toggleSt(st); }
      }, (ICON[st] || "●") + " " + (LABEL[st] || st) + " " + counts[st]);
    });

    var boardList = boards.length ? boards : [{ slug: board || "default", title: board || "default" }];
    var top = h("div", { className: "kg-top" },
      h("span", { className: "kg-brand" }, "依赖大屏"),
      modeSwitch(props),
      h(Select, { value: board || undefined, onValueChange: onSelectBoard },
        boardList.map(function (b) { return h(SelectOption, { key: b.slug, value: b.slug }, b.title || b.slug); })),
      h(Button, { size: "sm", variant: "outline", onClick: props.onReload }, "刷新"),
      h(Button, { size: "sm", variant: "outline", onClick: fitView }, "适配"),
      h(Button, { size: "sm", variant: "outline", onClick: onAutoLayout }, "自动排列"),
      h(Button, {
        size: "sm", variant: gridOn ? "default" : "outline",
        title: "拖动时显示参考格子（节点按 " + CELL_W + "×" + CELL_H + "px 格吸附）",
        onClick: function () { var v = !gridOn; setGridOn(v); lsSet(LS_GRID, v ? "1" : "0"); }
      }, "网格"),
      h("span", { className: "kg-chips" }, chips),
      h("span", { className: "kg-chip" }, "边 " + ((graph && graph.edges) ? graph.edges.length : 0)),
      model.ulActive > 0 ? h(Button, {
        size: "sm", variant: showUl ? "default" : "outline",
        onClick: function () {
          var v = !showUl; setShowUl(v);
          lsSet(LS_UL, v ? "1" : "0");
          pendingFit.current = true;
        }
      }, "无依赖 " + model.ulActive) : null,
      model.backEdges.length ? h(Badge, { variant: "destructive" }, "环路 " + model.backEdges.length + " 条（已断开绘制）") : null,
      error ? h(Badge, { variant: "destructive" }, error) : null
    );

    var nodeCount = (graph && graph.nodes) ? graph.nodes.length : 0;
    var edgeCount = (graph && graph.edges) ? graph.edges.length : 0;
    var hasLinks = edgeCount > 0 || model.backEdges.length > 0;
    var hasBoxes = hasLinks || model.unlinked.length > 0;
    var emptyMsg = null;
    if (!graph) emptyMsg = "加载中…";
    else if (nodeCount === 0) emptyMsg = "这块板还没有任务";
    else if (!hasBoxes) emptyMsg = model.ulActive > 0
      ? "这块板还没有依赖关系 · " + model.ulActive + " 个任务无依赖（点上方「无依赖」展开）"
      : "这块板还没有依赖关系";

    var dimOf = highlight ? function (e) { return !(highlight.has(e.parent) && highlight.has(e.child)); } : null;
    var svgChildren = renderEdges(model, view, hideSt, "kg-arrow", dimOf);
    function nodeEl(n, extraCls) {
      var pos = view.placed.get(n.id);
      if (!pos) return null;
      if (hideSt[n.status]) return null;
      var dim = highlight && !highlight.has(n.id);
      var isDrag = ndragging && ndRef.current && ndRef.current.id === n.id;
      return renderNode(n, pos, GEO_MAIN, {
        cls: (dim ? " kg-dim" : "") + (selected === n.id ? " kg-sel" : "") + (isDrag ? " kg-ndrag" : "") + (extraCls || ""),
        comet: COMET_D,
        handlers: nodeHandlers(n.id)
      });
    }
    var ordered = [];
    model.nodeMap.forEach(function (n) { ordered.push(n); });
    ordered.forEach(function (n) { var x = nodeEl(n); if (x) svgChildren.push(x); });
    model.unlinked.forEach(function (n) { var x = nodeEl(n, " kg-uln"); if (x) svgChildren.push(x); });
    if (model.unlinked.length) {
      svgChildren.push(h("text", { key: "ulhdr", className: "kg-ulhdr", x: model.ulHdrX, y: model.ulHdrY }, "无依赖任务"));
    }

    var canvas = h("div", { className: "kg-canvas", ref: containerRef, onPointerDown: onBgDown, onClick: onBgClick },
      (gridOn && (ndragging || dragging)) ? h("div", {
        className: "kg-grid kg-grid-lattice",
        style: {
          backgroundImage: "linear-gradient(to right, rgba(255,255,255,.06) 1px, transparent 1px),"
            + "linear-gradient(to bottom, rgba(255,255,255,.06) 1px, transparent 1px)",
          backgroundSize: CELL_W + "px " + CELL_H + "px"
        }
      }) : null,
      hasBoxes
        ? h("svg", {
            className: "kg-svg",
            width: Math.max(1, view.width),
            height: Math.max(1, view.height)
          },
            h("defs", null,
              h("marker", {
                id: "kg-arrow", viewBox: "0 0 10 10", refX: 9, refY: 5,
                markerWidth: 6, markerHeight: 6, orient: "auto-start-reverse"
              }, h("path", { className: "kg-arrow", d: "M 0 0 L 10 5 L 0 10 z" }))
            ),
            h("g", { transform: "translate(" + pan.x + "," + pan.y + ") scale(" + zoom + ")" }, svgChildren)
          )
        : h("div", { className: "kg-empty" }, emptyMsg || "")
    );

    return h("div", { className: "kg-root" }, top, canvas);
  }

  // ─────────────────── one profile panel (measured + fitted) ───────────────────
  function PanelBody(props) {
    var s, p = props.panel, G = GEO_MINI;
    s = useState({ w: 0, h: 0 }); var size = s[0], setSize = s[1];
    s = useState(function () { return readMiniPos(props.pid); }); var ov = s[0], setOv = s[1];
    s = useState(false); var ndrag = s[0], setNdrag = s[1];
    var ref = useRef(null);
    var ovRef = useRef(ov); ovRef.current = ov;
    var ndRef = useRef(null);
    var view = useMemo(function () { return buildView(p.model, ov); }, [p.model, ov]);
    var viewRef = useRef(view); viewRef.current = view;

    useEffect(function () {
      var el = ref.current;
      if (!el) return;
      function m() {
        setSize(function (q) {
          var w = el.clientWidth, hh = el.clientHeight;
          return (q.w === w && q.h === hh) ? q : { w: w, h: hh };
        });
      }
      m();
      var ro = null;
      if (typeof ResizeObserver !== "undefined") { ro = new ResizeObserver(m); ro.observe(el); }
      return function () { if (ro) ro.disconnect(); };
    }, []);

    // "排列" on the card clears this profile's manual block positions
    useEffect(function () { setOv(readMiniPos(props.pid)); }, [props.ver, props.pid]);

    // the drawing area is pinned to the *auto* layout box (not the live view box)
    // so dragging a block never rescales the whole card mid-gesture
    var vw = Math.max(1, p.model.width), vh = Math.max(1, p.model.height);
    var cap = props.big ? MINI_SCALE_MAX_BIG : MINI_SCALE_MAX;
    var scale = 1;
    if (size.w > 4 && size.h > 4) {
      scale = clamp(Math.min((size.w - 4) / vw, (size.h - 4) / vh), MINI_SCALE_MIN, cap);
    }
    var scaleRef = useRef(scale); scaleRef.current = scale;
    function blockBox() { return { w: Math.max(0, vw - G.W), h: Math.max(0, vh - G.H) }; }

    // ── block dragging inside the card (persisted per profile) ──
    useEffect(function () {
      if (!ndrag) return;
      function move(e) {
        var d = ndRef.current;
        if (!d) return;
        var ddx = e.clientX - d.sx, ddy = e.clientY - d.sy;
        if (!d.moved && Math.abs(ddx) + Math.abs(ddy) > 4) d.moved = true;
        if (!d.moved) return;
        var z = scaleRef.current || 1;
        var fx = d.ox + ddx / z, fy = d.oy + ddy / z;
        var gx = snapCell({ x: fx, y: fy }, G);
        if (Math.abs(fx - gx.x) <= MAGNET) fx = gx.x;
        if (Math.abs(fy - gx.y) <= MAGNET) fy = gx.y;
        var box = blockBox();
        fx = clamp(fx, 0, box.w); fy = clamp(fy, 0, box.h);
        if (d.last && d.last.x === fx && d.last.y === fy) return;
        d.last = { x: fx, y: fy };
        var nxt = Object.assign({}, ovRef.current);
        nxt[d.id] = { x: fx, y: fy };
        ovRef.current = nxt;
        setOv(nxt);
      }
      function up() {
        var d = ndRef.current;
        setNdrag(false);
        if (!d || !d.moved) return;
        var box = blockBox(), CW = cellW(G), CH = cellH(G);
        var occ = new Set();
        viewRef.current.placed.forEach(function (q, qid) {
          if (qid === d.id) return;
          var kc = snapCell(q, G);
          occ.add(kc.x + "," + kc.y);
        });
        var cur = (ovRef.current || {})[d.id] || { x: d.ox, y: d.oy };
        var seed = snapCell(cur, G), fp = null, r, dx, dy;
        // settle on the nearest free cell that still fits inside the card
        for (r = 0; r <= 30 && !fp; r++) {
          for (dy = -r; dy <= r && !fp; dy++) {
            for (dx = -r; dx <= r && !fp; dx++) {
              if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
              var cand = snapCell({ x: clamp(seed.x + dx * CW, 0, box.w), y: clamp(seed.y + dy * CH, 0, box.h) }, G);
              if (cand.x > box.w + 0.5 || cand.y > box.h + 0.5) continue;
              if (!occ.has(cand.x + "," + cand.y)) fp = cand;
            }
          }
        }
        if (!fp) fp = seed;
        var nxt = Object.assign({}, ovRef.current);
        nxt[d.id] = fp;
        ovRef.current = nxt;
        setOv(nxt);
        var out = {};
        viewRef.current.placed.forEach(function (q, id) { if (nxt[id]) out[id] = nxt[id]; });
        out[d.id] = fp;
        writeMiniPos(props.pid, out);
      }
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
      return function () {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
      };
    }, [ndrag, props.pid]);

    function onBlockDown(n, e) {
      if (e.pointerType === "mouse" && e.button != null && e.button !== 0) return;
      var cur = (ovRef.current || {})[n.id] || viewRef.current.placed.get(n.id);
      if (!cur) return;
      e.stopPropagation();
      e.preventDefault();
      ndRef.current = { id: n.id, sx: e.clientX, sy: e.clientY, ox: cur.x, oy: cur.y, moved: false };
      setNdrag(true);
    }

    function handlersFor(n) {
      return {
        onPointerDown: function (e) {
          if (isDoubleTap("p:" + props.pid + ":" + (n.oid || n.id))) {
            e.stopPropagation();
            if (props.onTask) props.onTask(n);
            return;
          }
          onBlockDown(n, e);
        }
      };
    }
    var kids = [];
    if (p.group.nodes.length) {
      var defs = h("defs", { key: "d" },
        h("marker", {
          id: "kga-" + props.pid, viewBox: "0 0 10 10", refX: 9, refY: 5,
          markerWidth: 6, markerHeight: 6, orient: "auto-start-reverse"
        }, h("path", { className: "kg-arrow", d: "M 0 0 L 10 5 L 0 10 z" })));
      kids.push(defs);
      kids = kids.concat(renderEdges(p.model, view, props.hideSt, "kga-" + props.pid, ""));
      var ordered = [];
      p.model.nodeMap.forEach(function (n) { ordered.push(n); });
      ordered.forEach(function (n) {
        var pos = view.placed.get(n.id);
        if (!pos || fitsHide(n, props.hideSt)) return;
        kids.push(renderNode(n, pos, G, { cls: "", comet: COMET_D_MINI, metaOf: props.metaOf, handlers: handlersFor(n) }));
      });
      p.group.nodes.forEach(function (n) {
        if (p.model.nodeMap.has(n.id)) return;
        var pos = view.placed.get(n.id);
        if (!pos || fitsHide(n, props.hideSt)) return;
        kids.push(renderNode(n, pos, G, { cls: " kg-uln", comet: COMET_D_MINI, metaOf: props.metaOf, handlers: handlersFor(n) }));
      });
    }
    var body;
    if (!p.group.nodes.length) body = h("div", { className: "kg-pempty" }, "无任务");
    else if (view.placed.size === 0) body = h("div", { className: "kg-pempty" }, "仅剩已结历史");
    else body = h("div", { className: "kg-pfit" + (ndrag ? " kg-grabbing" : ""), style: { width: (vw * scale) + "px", height: (vh * scale) + "px" } },
          h("svg", {
            className: "kg-mini", width: vw * scale, height: vh * scale,
            viewBox: "0 0 " + vw + " " + vh
          }, kids));
    return h("div", { className: "kg-pbody", ref: ref }, body);
  }

  // ─────────────────────────── multi-profile view ───────────────────────────
  function MultiProfileView(props) {
    var boards = props.boards || [], scope = props.scope, graphs = props.graphs, error = props.error;
    var s;
    s = useState(readHiddenProf); var hidden = s[0], setHidden = s[1];
    s = useState(lsGet(LS_XEDGE) === "1"); var showCross = s[0], setShowCross = s[1];
    s = useState(readGrid); var gridOn = s[0], setGridOn = s[1];
    s = useState(function () { return readLayout(scopeKey(props.scope)); }); var layout = s[0], setLayout = s[1];
    s = useState(function () { return readGroups(scopeKey(props.scope)); }); var gcfg = s[0], setGcfg = s[1];
    s = useState(function () { return readMaxed(scopeKey(props.scope)); }); var maxed = s[0], setMaxed = s[1];
    s = useState({}); var miniVer = s[0], setMiniVer = s[1];
    s = useState({ w: 1200, h: 640 }); var csize = s[0], setCsize = s[1];
    s = useState(null); var guides = s[0], setGuides = s[1];
    s = useState(null); var activeOp = s[0], setActiveOp = s[1];
    s = useState(""); var editG = s[0], setEditG = s[1]; // group id whose title is being renamed

    var boardRef = useRef(null);
    var editRef = useRef(null);
    var escRef = useRef(false); // Esc cancels: the blur that follows must not save
    var layoutRef = useRef(layout); layoutRef.current = layout;
    var gcfgRef = useRef(gcfg); gcfgRef.current = gcfg;
    var csizeRef = useRef(csize); csizeRef.current = csize;
    var opRef = useRef(null);
    var tapRef = useRef(null);
    var seqRef = useRef(1);
    var frozenRef = useRef(null);   // top-level cards pinned where they were when a drag began
    var frozenInRef = useRef(null); // ... same, for the members inside the dragged container
    var rawRef = useRef(null);      // the dragged member renders free (it may leave the card)
    var keyRef = useRef(scopeKey(props.scope)); keyRef.current = scopeKey(props.scope);

    // measure the scroll container
    useEffect(function () {
      var el = boardRef.current;
      if (!el) return;
      function m() {
        setCsize(function (p) {
          var w = el.clientWidth, hh = el.clientHeight;
          return (p.w === w && p.h === hh) ? p : { w: w, h: hh };
        });
      }
      m();
      var ro = null;
      if (typeof ResizeObserver !== "undefined") { ro = new ResizeObserver(m); ro.observe(el); }
      window.addEventListener("resize", m);
      return function () {
        if (ro) ro.disconnect();
        window.removeEventListener("resize", m);
      };
    }, []);

    // scope switch => that scope's own layout / groups / maximised card
    useEffect(function () {
      var k = scopeKey(scope);
      setLayout(readLayout(k));
      setGcfg(readGroups(k));
      setMaxed(readMaxed(k));
    }, [scope]);

    var slugs = useMemo(function () { return neededSlugs("multi", "", scope, boards); }, [scope, boards]);
    var merged = useMemo(function () { return mergeGraphs(graphs, slugs); }, [graphs, slugs]);
    var grouped = useMemo(function () { return groupByProfile(merged, props.hideSt); }, [merged, props.hideSt]);
    var groups = grouped.groups;
    var panels = useMemo(function () { return buildPanels(groups, GEO_MINI); }, [groups]);
    var multiBoard = merged.multi;

    var byName = useMemo(function () {
      var m = {};
      groups.forEach(function (g) { m[g.name] = g; });
      return m;
    }, [groups]);

    var visible = useMemo(function () {
      return groups.filter(function (g) { return !hidden[g.name]; });
    }, [groups, hidden]);

    // ── cards: group containers + free profiles, ordered by profile name ──
    var items = useMemo(function () {
      var owner = {};
      gcfg.forEach(function (c) { c.members.forEach(function (m) { if (!owner[m]) owner[m] = c.id; }); });
      var out = [], seen = {};
      visible.forEach(function (g) {
        var gid = owner[g.name];
        if (!gid) { out.push({ id: g.name, kind: "prof", prof: g }); return; }
        if (seen[gid]) return;
        seen[gid] = 1;
        var cfg = null, i;
        for (i = 0; i < gcfg.length; i++) if (gcfg[i].id === gid) cfg = gcfg[i];
        if (!cfg) { out.push({ id: g.name, kind: "prof", prof: g }); return; }
        var members = [];
        cfg.members.forEach(function (m) { if (byName[m] && !hidden[m]) members.push(byName[m]); });
        if (!members.length) return;
        out.push({ id: GKEY + gid, kind: "group", cfg: cfg, members: members });
      });
      return out;
    }, [visible, gcfg, byName, hidden]);

    // stored (manual) rects win; anything without one takes the first free slot
    var rects = useMemo(function () {
      var base = {}, out = {}, claimed = [];
      Object.keys(layout).forEach(function (k) { if (layout[k]) base[k] = layout[k]; });
      var slots = tileRects(items.length, csize.w, csize.h, PGAP);
      items.forEach(function (it) { if (base[it.id]) claimed.push(base[it.id]); });
      items.forEach(function (it) {
        if (base[it.id]) { out[it.id] = base[it.id]; return; }
        var cand = null, k;
        for (k = 0; k < slots.length; k++) if (!hasOverlap(slots[k], claimed)) { cand = slots[k]; break; }
        out[it.id] = cand || pickFreeSlot(claimed, csize.w, csize.h);
        claimed.push(out[it.id]);
      });
      return out;
    }, [layout, items, csize]);

    // ── double-click maximise: one card owns the whole content area ──
    var maxIt = null, maxProf = null;
    if (maxed) {
      if (maxed.slice(0, 2) === GKEY) {
        for (var mi = 0; mi < items.length; mi++) if (items[mi].id === maxed) maxIt = items[mi];
      } else if (byName[maxed]) {
        maxProf = byName[maxed];
      }
    }
    var isMax = !!(maxIt || maxProf);

    var shown = useMemo(function () {
      if (!isMax) return rects;
      var id = maxIt ? maxIt.id : maxed;
      var o = {};
      o[id] = { x: PGAP, y: PGAP, w: Math.max(PMIN_W, csize.w - 2 * PGAP), h: Math.max(PMIN_H, csize.h - 2 * PGAP) };
      return o;
    }, [rects, isMax, maxIt, maxed, csize]);

    // while a card is being dragged the others stay exactly where they are
    // (otherwise the auto-slots would slide out from under the cursor)
    var view = useMemo(function () {
      if (!frozenRef.current) return shown;
      var out = Object.assign({}, shown);
      Object.keys(frozenRef.current).forEach(function (k) { if (out[k]) out[k] = frozenRef.current[k]; });
      return out;
    }, [shown]);

    // member rects inside every group card (relative to the group body box)
    var innerRects = useMemo(function () {
      var out = {};
      items.forEach(function (it) {
        if (it.kind !== "group") return;
        var r = shown[it.id];
        if (!r) return;
        var body = groupBody(r);
        out[it.cfg.id] = innerLayout(
          it.members.map(function (m) { return m.name; }),
          it.cfg.inner, body, INNER_PAD,
          it.members.map(function (m) { return profWeight(m.nodes ? m.nodes.length : 0); }));
      });
      return out;
    }, [items, shown]);

    var inv = useMemo(function () {
      if (!frozenInRef.current) return innerRects;
      var f = frozenInRef.current, out = Object.assign({}, innerRects);
      if (!out[f.gid]) return innerRects;
      var m = Object.assign({}, out[f.gid]);
      Object.keys(f.rects).forEach(function (k) { if (m[k]) m[k] = f.rects[k]; });
      out[f.gid] = m;
      return out;
    }, [innerRects]);

    var surfaceH = useMemo(function () {
      if (isMax) return Math.max(csize.h, PMIN_H + 2 * PGAP);
      var maxY = 0;
      Object.keys(shown).forEach(function (k) { maxY = Math.max(maxY, shown[k].y + shown[k].h); });
      return Math.max(csize.h, maxY + PGAP);
    }, [shown, csize, isMax]);

    // ── persistence ──
    function applyLayout(nxt) {
      layoutRef.current = nxt;
      setLayout(nxt);
      writeLayout(keyRef.current, nxt);
    }
    function applyGroups(arr) {
      var clean = arr.filter(function (c) { return c.members && c.members.length >= 2; });
      gcfgRef.current = clean;
      setGcfg(clean);
      writeGroups(keyRef.current, clean);
    }
    function saveInner(gid, prof, rect) {
      var arr = gcfgRef.current.map(function (c) {
        if (c.id !== gid) return c;
        var inner = Object.assign({}, c.inner);
        if (rect) inner[prof] = rect; else delete inner[prof];
        return { id: c.id, name: c.name, members: c.members, inner: inner };
      });
      gcfgRef.current = arr;
      setGcfg(arr);
      writeGroups(keyRef.current, arr);
    }
    // inline rename of a group card ("分组 1" -> whatever the user types)
    function renameGroup(gid, name) {
      var v = String(name == null ? "" : name).replace(/\s+/g, " ").trim();
      if (!v) return;
      var arr = gcfgRef.current.map(function (c) {
        return c.id === gid ? { id: c.id, name: v.slice(0, 24), members: c.members, inner: c.inner } : c;
      });
      applyGroups(arr);
    }
    useEffect(function () {
      if (!editG) return;
      var el = editRef.current;
      if (el) { el.focus(); if (el.select) el.select(); }
      // commit on the first pointerdown outside the editor: a card's own
      // pointerdown calls preventDefault(), which suppresses the blur event —
      // without this the editor would stay open while the user drags another card
      function away(e) {
        var t = e && e.target;
        if (t && editRef.current && t === editRef.current) return;
        if (editRef.current) renameGroup(editG, editRef.current.value);
        escRef.current = true; // the blur that follows must not save/cancel again
        setEditG("");
      }
      window.addEventListener("pointerdown", away, true);
      return function () { window.removeEventListener("pointerdown", away, true); };
    }, [editG]);

    function setInnerLive(gid, prof, rect) {
      var arr = gcfgRef.current.map(function (c) {
        if (c.id !== gid) return c;
        var inner = Object.assign({}, c.inner);
        inner[prof] = rect;
        return { id: c.id, name: c.name, members: c.members, inner: inner };
      });
      gcfgRef.current = arr;
      setGcfg(arr);
    }

    // ── grouping ops ──
    function mintGroup(names) {
      var used = {}, n = 1;
      gcfgRef.current.forEach(function (c) { used[c.name] = 1; });
      while (used["分组 " + n]) n++;
      return {
        id: "g" + Date.now().toString(36) + "-" + (seqRef.current++),
        name: "分组 " + n, members: names.slice(), inner: {}
      };
    }
    // the group card wraps what its members used to occupy
    function groupRectFor(a, b) {
      var u = (a && b) ? unionRect(a, b) : (a || b || { x: PGAP, y: PGAP, w: PDEF_W, h: PDEF_H });
      var w = Math.max(GMIN_W, u.w + 2 * GBODY_PAD);
      var hh = Math.max(GMIN_H, u.h + GHEAD + 2 * GBODY_PAD);
      var x = Math.max(0, Math.min(u.x - GBODY_PAD, Math.max(0, csizeRef.current.w - w)));
      return { x: x, y: Math.max(0, u.y - GHEAD), w: w, h: hh };
    }
    function addToGroup(gid, prof) {
      var arr = gcfgRef.current.map(function (c) {
        if (c.id === gid) {
          if (c.members.indexOf(prof) >= 0) return c;
          return { id: c.id, name: c.name, members: c.members.concat([prof]), inner: {} };
        }
        if (c.members.indexOf(prof) < 0) return c;
        return { id: c.id, name: c.name, members: c.members.filter(function (m) { return m !== prof; }), inner: c.inner };
      });
      var lay = Object.assign({}, layoutRef.current);
      delete lay[prof];
      applyGroups(arr);
      applyLayout(lay);
    }
    function mergeGroups(fromId, toId) {
      var src = null;
      gcfgRef.current.forEach(function (c) { if (c.id === fromId) src = c; });
      if (!src || fromId === toId) return;
      var arr = gcfgRef.current.filter(function (c) { return c.id !== fromId; }).map(function (c) {
        if (c.id !== toId) return c;
        var mem = c.members.slice();
        src.members.forEach(function (m) { if (mem.indexOf(m) < 0) mem.push(m); });
        return { id: c.id, name: c.name, members: mem, inner: {} };
      });
      var lay = Object.assign({}, layoutRef.current);
      delete lay[GKEY + fromId];
      applyGroups(arr);
      applyLayout(lay);
    }
    function dissolve(gid) {
      var arr = gcfgRef.current.filter(function (c) { return c.id !== gid; });
      var lay = Object.assign({}, layoutRef.current);
      delete lay[GKEY + gid];
      applyGroups(arr);
      applyLayout(lay);
    }
    // pulled out of its container by hand -> free card again (drop it where released)
    function leaveGroup(prof, atRect) {
      var arr = [], gone = [];
      gcfgRef.current.forEach(function (c) {
        if (c.members.indexOf(prof) < 0) { arr.push(c); return; }
        var rest = c.members.filter(function (m) { return m !== prof; });
        if (rest.length >= 2) {
          var inner = Object.assign({}, c.inner);
          delete inner[prof];
          arr.push({ id: c.id, name: c.name, members: rest, inner: inner });
        } else {
          gone.push(c);
        }
      });
      var lay = Object.assign({}, layoutRef.current);
      gone.forEach(function (c) { delete lay[GKEY + c.id]; });
      if (atRect) lay[prof] = atRect;
      applyGroups(arr);
      layoutRef.current = lay;
      setLayout(lay);
      writeLayout(keyRef.current, lay);
    }

    // ── drag / resize (pointer) ──
    function othersOf(id) {
      var out = [];
      Object.keys(view).forEach(function (k) { if (k !== id) out.push({ id: k, rect: view[k] }); });
      return out;
    }
    function innerOthersOf(id, gid) {
      var out = [], inn = inv[gid] || {};
      Object.keys(inn).forEach(function (k) { if (k !== id) out.push({ id: k, rect: inn[k] }); });
      return out;
    }

    useEffect(function () {
      if (!activeOp) return;
      function move(e) {
        var op = opRef.current;
        if (!op) return;
        var dx = e.clientX - op.sx, dy = e.clientY - op.sy;
        if (!op.moved && Math.abs(dx) + Math.abs(dy) > 3) op.moved = true;
        if (!op.moved) return;
        var base = { x: op.ox + dx, y: op.oy + dy, w: op.ow, h: op.oh };
        if (op.scope === "inner") {
          // free follow inside the container: leaving it is how a card escapes
          setGuides(null);
          var body = groupBody(view[GKEY + op.gid] || view[op.gid] || { w: GMIN_W, h: GMIN_H });
          var ires = op.kind === "move"
            ? snapMove(base, innerOthersOf(op.id, op.gid), body, SNAP, GRID)
            : snapResize({ x: op.ox, y: op.oy, w: op.ow, h: op.oh }, dx, dy,
                innerOthersOf(op.id, op.gid), body, SNAP, GRID, IMIN_W, IMIN_H);
          rawRef.current = { gid: op.gid, id: op.id, rect: ires.rect };
          setInnerLive(op.gid, op.id, ires.rect);
          return;
        }
        var mg = op.id.slice(0, 2) === GKEY;
        var minW = mg ? GMIN_W : PMIN_W, minH = mg ? GMIN_H : PMIN_H;
        // ★ resize must be measured from the ORIGINAL box: passing `base` (already
        // offset by dx/dy) made the right/bottom edge drift at twice the pointer
        // delta and dragged the card's left/top along with the grip.
        var res = op.kind === "move"
          ? snapMove(base, othersOf(op.id), csizeRef.current, SNAP, GRID)
          : snapResize({ x: op.ox, y: op.oy, w: op.ow, h: op.oh }, dx, dy,
              othersOf(op.id), csizeRef.current, SNAP, GRID, minW, minH);
        setGuides(res.guides);
        var nxt = Object.assign({}, layoutRef.current);
        nxt[op.id] = res.rect;
        layoutRef.current = nxt;
        setLayout(nxt);
      }
      function up(e) {
        var op = opRef.current;
        var fzIn = frozenInRef.current;
        opRef.current = null;
        setActiveOp(null);
        setGuides(null);
        frozenRef.current = null;
        frozenInRef.current = null;
        rawRef.current = null;
        if (!op || !op.moved) return;

        if (op.scope === "inner") {
          var live = innerRects[op.gid] || {};
          var prev = (fzIn && fzIn.gid === op.gid) ? fzIn.rects : live;
          var r = live[op.id];
          var it = null;
          items.forEach(function (x) { if (x.kind === "group" && x.cfg.id === op.gid) it = x; });
          if (!r || !it) return;
          var gr = view[it.id] || view[GKEY + op.gid];
          if (!gr) return;
          var body = groupBody(gr);
          var rw = (rawRef.current && rawRef.current.gid === op.gid && rawRef.current.id === op.id)
            ? rawRef.current.rect : r;
          var abs = { x: gr.x + body.x + rw.x, y: gr.y + body.y + rw.y, w: rw.w, h: rw.h };
          var pad = 6, ptr = null;
          if (e && typeof e.clientX === "number") ptr = { x: e.clientX - op.org.x, y: e.clientY - op.org.y };
          var escaped = ptr
            ? !insideRect({ x: gr.x - pad, y: gr.y - pad, w: gr.w + 2 * pad, h: gr.h + 2 * pad }, ptr)
            : !insideRect(gr, { x: abs.x + abs.w / 2, y: abs.y + abs.h / 2 });
          if (op.kind === "move" && escaped) {
            // pulled clean out of the container -> a free card again; it must land
            // next to the container, never on top of it
            var othersT = items.filter(function (x) { return x.id !== it.id; })
              .map(function (x) { return { id: x.id, rect: view[x.id] }; })
              .filter(function (o) { return o.rect; });
            var obstacles = othersT.map(function (o) { return o.rect; }).concat([gr]);
            var drop = nearestFree({ x: Math.max(0, abs.x), y: Math.max(0, abs.y), w: abs.w, h: abs.h }, obstacles, GRID, 80);
            var moves = pushAside(drop, othersT, GRID);
            leaveGroup(op.id, drop);
            var lay2 = Object.assign({}, layoutRef.current);
            lay2[op.id] = drop;
            Object.keys(moves).forEach(function (id) { lay2[id] = moves[id]; });
            applyLayout(lay2);
            return;
          }
          // stayed inside: clamp it, then let the members it covers step aside
          var fixed = clampInnerRect(rw, body);
          var othersIn = [], k2;
          for (k2 in prev) if (prev.hasOwnProperty(k2) && k2 !== op.id) othersIn.push({ id: k2, rect: prev[k2] });
          var pushed = pushAside(fixed, othersIn, GRID);
          var arr = gcfgRef.current.map(function (c) {
            if (c.id !== op.gid) return c;
            var inner = Object.assign({}, c.inner);
            inner[op.id] = fixed;
            Object.keys(pushed).forEach(function (k3) {
              var rr3 = clampInnerRect(pushed[k3], body);
              if (hasOverlap(rr3, [fixed])) delete inner[k3]; // nowhere to go -> back to auto
              else inner[k3] = rr3;
            });
            return { id: c.id, name: c.name, members: c.members, inner: inner };
          });
          gcfgRef.current = arr;
          setGcfg(arr);
          writeGroups(keyRef.current, arr);
          return;
        }

        var fin = layoutRef.current[op.id];
        if (!fin) return;
        // dropped onto another card => group them / join that group
        // only a *move* can land on another card: a resize keeps its own corner
        var tgt = null;
        if (op.kind === "move") {
          var pt = (e && typeof e.clientX === "number")
            ? { x: e.clientX - op.org.x, y: e.clientY - op.org.y }
            : { x: fin.x + fin.w / 2, y: fin.y + fin.h / 2 };
          items.forEach(function (it2) {
            if (it2.id === op.id) return;
            var rr = view[it2.id];
            if (rr && insideRect(rr, pt)) tgt = it2;
          });
          if (!tgt) {
            items.forEach(function (it2) {
              if (it2.id === op.id || tgt) return;
              var rr2 = view[it2.id];
              if (rr2 && insideRect(rr2, { x: fin.x + fin.w / 2, y: fin.y + fin.h / 2 })) tgt = it2;
            });
          }
        }
        if (tgt) {
          var isG = op.id.slice(0, 2) === GKEY;
          if (tgt.kind === "group") {
            if (isG) mergeGroups(op.id.slice(2), tgt.cfg.id);
            else addToGroup(tgt.cfg.id, op.id);
            return;
          }
          if (isG) { addToGroup(op.id.slice(2), tgt.id); return; }
          var g = mintGroup([tgt.id, op.id]);
          var lay = Object.assign({}, layoutRef.current);
          lay[GKEY + g.id] = groupRectFor(view[tgt.id], view[op.id]);
          delete lay[tgt.id];
          delete lay[op.id];
          applyGroups(gcfgRef.current.concat([g]));
          applyLayout(lay);
          return;
        }
        // nothing to join: everyone the card now covers steps aside
        var mv = pushAside(fin, othersOf(op.id), GRID);
        var nxt2 = Object.assign({}, layoutRef.current);
        Object.keys(mv).forEach(function (id) { nxt2[id] = mv[id]; });
        applyLayout(nxt2);
      }
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
      return function () {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
      };
    }, [activeOp, rects, shown, items, innerRects, hidden]);

    function opDown(kind, id, e, scope2, gid) {
      if (isMax) return;
      scope2 = scope2 || "top";
      var r = scope2 === "inner" ? ((inv[gid] || {})[id]) : view[id];
      if (!r) return;
      if (e.pointerType === "mouse" && e.button != null && e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      var org = { x: 0, y: 0 };
      if (boardRef.current) {
        var br = boardRef.current.getBoundingClientRect();
        org = { x: br.left - boardRef.current.scrollLeft, y: br.top - boardRef.current.scrollTop };
      }
      if (scope2 === "top") {
        var snap = {};
        Object.keys(shown).forEach(function (k) { if (k !== id) snap[k] = shown[k]; });
        frozenRef.current = snap;
        frozenInRef.current = null;
      } else {
        var snapIn = {}, inn = innerRects[gid] || {};
        Object.keys(inn).forEach(function (k) { if (k !== id) snapIn[k] = inn[k]; });
        frozenInRef.current = { gid: gid, rects: snapIn };
        frozenRef.current = null;
      }
      opRef.current = {
        kind: kind, id: id, scope: scope2, gid: gid, org: org,
        sx: e.clientX, sy: e.clientY, ox: r.x, oy: r.y, ow: r.w, oh: r.h, moved: false
      };
      setActiveOp({ kind: kind, id: id, gid: gid });
    }

    // double-tap on a title bar toggles maximise (pointerdown holds the gesture)
    function dblTap(k, fn) {
      var t = Date.now();
      if (tapRef.current && tapRef.current.k === k && t - tapRef.current.t < 420) {
        tapRef.current = null;
        fn();
        return;
      }
      tapRef.current = { k: k, t: t };
    }
    function toggleMax(id) {
      var nxt = maxed === id ? "" : id;
      setMaxed(nxt);
      writeMaxed(keyRef.current, nxt);
    }
    function arrangeBlocks(prof) {
      writeMiniPos(prof, {});
      setMiniVer(function (p) { var n = Object.assign({}, p); n[prof] = (n[prof] || 0) + 1; return n; });
    }

    // the card size its content deserves: area grows with the block count,
    // snapped onto the 8px lattice so the wall stays on-grid
    function fitCardSize(id, nodeCount) {
      var scale = clamp(Math.sqrt(Math.max(1, nodeCount) / 6), 0.66, 1.5);
      var cur = layoutRef.current[id] || view[id] || null;
      return {
        x: cur ? Math.round(cur.x / GRID) * GRID : PGAP,
        y: cur ? Math.round(cur.y / GRID) * GRID : PGAP,
        w: Math.round(clamp(PDEF_W * scale, PMIN_W, 900) / GRID) * GRID,
        h: Math.round(clamp(PDEF_H * scale, PMIN_H, 660) / GRID) * GRID
      };
    }

    // 自动排列 on ONE card (user 2026-10-11):
    //  · a free profile card -> its blocks re-tile and the card resizes to fit
    //  · a group card        -> the manual member rects are dropped so the
    //    content-aware tiling enlarges the busy members and shrinks the empty ones
    function autoArrangeCard(gid, name, inner) {
      // a member card inside a group takes its size from the group layout, so
      // its own 自动排列 only puts its task blocks back on the lattice
      if (inner) { arrangeBlocks(name); return; }
      if (!gid) {
        arrangeBlocks(name);
        var g = byName[name];
        var r = fitCardSize(name, g ? g.nodes.length : 0);
        var mv = pushAside(r, othersOf(name), GRID);
        var nxt = Object.assign({}, layoutRef.current);
        nxt[name] = r;
        Object.keys(mv).forEach(function (k) { nxt[k] = mv[k]; });
        applyLayout(nxt);
        return;
      }
      applyGroups(gcfgRef.current.map(function (c) {
        return c.id === gid ? { id: c.id, name: c.name, members: c.members, inner: {} } : c;
      }));
      var it = null;
      items.forEach(function (x) { if (x.kind === "group" && x.cfg.id === gid) it = x; });
      if (it) it.members.forEach(function (m) { arrangeBlocks(m.name); });
    }

    function toggleProf(name) {
      setHidden(function (prev) {
        var nxt = Object.assign({}, prev);
        if (nxt[name]) delete nxt[name]; else nxt[name] = 1;
        writeHiddenProf(nxt);
        return nxt;
      });
    }

    var onAutoArrange = useCallback(function () {
      var slots = tileRects(items.length, csizeRef.current.w, csizeRef.current.h, PGAP);
      var nxt = Object.assign({}, layoutRef.current);
      items.forEach(function (it, i) { if (slots[i]) nxt[it.id] = slots[i]; });
      applyLayout(nxt);
      applyGroups(gcfgRef.current.map(function (c) { return { id: c.id, name: c.name, members: c.members, inner: {} }; }));
      if (maxed) { setMaxed(""); writeMaxed(keyRef.current, ""); }
    }, [items, maxed]);

    // ── toolbar ──
    var boardList = boards.length ? boards : [];
    var scopeOptions = [h(SelectOption, { key: "__all__", value: "__all__" }, "全部板")].concat(
      boardList.map(function (b) { return h(SelectOption, { key: b.slug, value: b.slug }, b.title || b.slug); }));
    var scopeValue = scope || "__all__";

    var profChips = groups.map(function (g) {
      var col = profColor(g.name);
      return h("button", {
        key: g.name, type: "button",
        className: "kg-chip kg-chip-btn" + (hidden[g.name] ? " kg-chip-off" : ""),
        style: { borderColor: col },
        title: profLabel(g.name) + " · 点击" + (hidden[g.name] ? "显示" : "隐藏"),
        onClick: function () { toggleProf(g.name); }
      },
        h("span", { className: "kg-pdot", style: { background: col } }),
        " " + profLabel(g.name) + " " + g.nodes.length
      );
    });

    var totals = useMemo(function () {
      var n = 0, e2 = 0;
      for (var i = 0; i < groups.length; i++) { n += groups[i].nodes.length; e2 += groups[i].edges.length + groups[i].backEdges.length; }
      return { nodes: n, edges: e2 };
    }, [groups]);

    var top = h("div", { className: "kg-top" },
      h("span", { className: "kg-brand" }, "依赖大屏"),
      modeSwitch(props),
      h(Select, { value: scopeValue, onValueChange: function (v) { props.setScope(v === "__all__" ? "" : v); } }, scopeOptions),
      h(Button, { size: "sm", variant: "outline", onClick: props.onReload }, "刷新"),
      h(Button, { size: "sm", variant: "outline", onClick: onAutoArrange }, "自动排列"),
      h(Button, {
        size: "sm", variant: gridOn ? "default" : "outline",
        title: "拖动时显示参考格子（卡片按 " + GRID + "px 吸附）",
        onClick: function () { var v = !gridOn; setGridOn(v); lsSet(LS_GRID, v ? "1" : "0"); }
      }, "网格"),
      h(Button, {
        size: "sm", variant: showCross ? "default" : "outline",
        title: "跨 profile 依赖连线",
        onClick: function () { var v = !showCross; setShowCross(v); lsSet(LS_XEDGE, v ? "1" : "0"); }
      }, "跨链 " + grouped.cross.length),
      h("span", { className: "kg-chips" }, profChips),
      h("span", { className: "kg-chip" }, "任务 " + totals.nodes),
      h("span", { className: "kg-chip" }, "边 " + totals.edges),
      isMax ? h(Button, {
        size: "sm", variant: "outline", title: "还原这张卡片",
        onClick: function () { toggleMax(maxed); }
      }, "还原") : null,
      error ? h(Badge, { variant: "destructive" }, error) : null
    );

    // ── cross-profile wires (drawn behind the cards) ──
    var overlay = null;
    if (showCross && !isMax && grouped.cross.length) {
      var seen = {}, wires = [];
      grouped.cross.forEach(function (c, i) {
        if (hidden[c.from] || hidden[c.to]) return;
        var a = rects[c.from], b = rects[c.to];
        if (!a || !b) return;
        var k = c.from + ">" + c.to;
        seen[k] = (seen[k] || 0) + 1;
        wires.push(h("path", {
          key: "x" + i,
          className: "kg-xedge" + (c.back ? " kg-xback" : ""),
          d: crossPath(
            { x: a.x, y: a.y + (seen[k] - 1) * 6, w: a.w, h: a.h },
            { x: b.x, y: b.y + (seen[k] - 1) * 6, w: b.w, h: b.h }),
          stroke: profColor(c.from),
          markerEnd: "url(#kg-xarrow)"
        }));
      });
      overlay = h("svg", { className: "kg-overlay", width: Math.max(1, csize.w), height: Math.max(1, surfaceH) },
        h("defs", null,
          h("marker", {
            id: "kg-xarrow", viewBox: "0 0 10 10", refX: 9, refY: 5,
            markerWidth: 5, markerHeight: 5, orient: "auto-start-reverse"
          }, h("path", { className: "kg-arrow", d: "M 0 0 L 10 5 L 0 10 z" }))),
        wires);
    }

    var guideEls = (guides || []).map(function (g, i) {
      return h("div", {
        key: "g" + i,
        className: "kg-guide " + (g.dir === "v" ? "kg-guide-v" : "kg-guide-h"),
        style: g.dir === "v" ? { left: g.at + "px" } : { top: g.at + "px" }
      });
    });

    function headBar(g, gid) {
      var col = profColor(g.name);
      var dots = Object.keys(g.counts).sort(function (a, b) {
        return STATUS_ORDER.indexOf(a) - STATUS_ORDER.indexOf(b);
      }).map(function (st) {
        return h("span", {
          key: st, className: "kg-pmini", title: (LABEL[st] || st) + " " + g.counts[st],
          style: { color: STATUS_COLOR[st] || "#9ca3af" }
        }, (ICON[st] || "●") + g.counts[st]);
      });
      return h("div", {
        className: "kg-phead", title: "双击放大 / 还原",
        onPointerDown: function (e) { opDown("move", g.name, e, gid ? "inner" : "top", gid); },
        onPointerUp: function () { dblTap(gid ? gid + "/" + g.name : g.name, function () { toggleMax(g.name); }); }
      },
        h("span", { className: "kg-pdot", style: { background: col } }),
        h("span", { className: "kg-ptitle" }, profLabel(g.name)),
        h("span", { className: "kg-pcount" }, g.nodes.length),
        h("span", { className: "kg-pdots" }, dots),
        g.cross ? h("span", { className: "kg-plink", title: "跨 profile 依赖 " + g.cross + " 条" }, "↔" + g.cross) : null,
        h("button", {
          className: "kg-pauto", type: "button",
          title: gid ? "自动排列这张卡片：任务块归位"
                     : "自动排列这张卡片：任务块归位 + 卡片按内容调整大小",
          onPointerDown: function (e) { e.stopPropagation(); },
          onClick: function (e) { e.stopPropagation(); autoArrangeCard(gid, g.name, !!gid); }
        }, "自动排列"),
        h("button", {
          className: "kg-pclose", title: "隐藏该 profile", type: "button",
          onPointerDown: function (e) { e.stopPropagation(); },
          onClick: function (e) { e.stopPropagation(); toggleProf(g.name); }
        }, "×")
      );
    }

    function renderProf(g, r, big, gid) {
      var col = profColor(g.name);
      var isAct = activeOp && activeOp.id === g.name && (!gid || activeOp.gid === gid);
      return h("div", {
        key: (gid ? gid + "/" : "") + g.name,
        className: "kg-panel" + (isAct ? " kg-pactive" : "") + (gid ? " kg-pinner" : "") + (big ? " kg-pbig" : ""),
        "data-prof": g.name,
        "data-in-group": gid || "",
        style: { left: r.x + "px", top: r.y + "px", width: r.w + "px", height: r.h + "px", borderTopColor: col }
      },
        headBar(g, gid),
        h(PanelBody, {
          pid: g.name, panel: panels[g.name], hideSt: props.hideSt,
          metaOf: multiBoard ? function (n) { return n.board; } : null,
          big: !!big, ver: miniVer[g.name] || 0, onArrange: arrangeBlocks, onTask: props.onTask
        }),
        h("div", {
          className: "kg-prsz", title: "拖动缩放",
          onPointerDown: function (e) { opDown("resize", g.name, e, gid ? "inner" : "top", gid); }
        })
      );
    }

    function renderGroup(it, r, big) {
      var cfg = it.cfg, body = groupBody(r);
      var inn = inv[cfg.id] || {};
      var isAct = activeOp && activeOp.id === it.id;
      var rw = rawRef.current;
      var mem = it.members.map(function (m) {
        var ir = inn[m.name];
        if (rw && rw.gid === cfg.id && rw.id === m.name) ir = rw.rect;
        return ir ? renderProf(m, ir, false, cfg.id) : null;
      });
      return h("div", {
        key: it.id,
        className: "kg-group" + (isAct ? " kg-pactive" : "") + (big ? " kg-gbig" : ""),
        "data-group": cfg.id, "data-prof": it.id,
        style: { left: r.x + "px", top: r.y + "px", width: r.w + "px", height: r.h + "px" }
      },
        h("div", {
          className: "kg-ghead", title: "双击标题改名 · 双击空白处放大 / 还原 · 拖到别的卡片上可合并",
          onPointerDown: function (e) { opDown("move", it.id, e, "top"); },
          onPointerUp: function (e) {
            var t = e && e.target;
            if (t && String(t.className || "").indexOf("kg-gname") >= 0) {
              dblTap(it.id + "/name", function () { escRef.current = false; setEditG(cfg.id); });
              return;
            }
            dblTap(it.id, function () { toggleMax(it.id); });
          }
        },
          editG === cfg.id
            ? h("input", {
                className: "kg-gname-edit", ref: editRef, defaultValue: cfg.name, spellCheck: false,
                onPointerDown: function (e) { e.stopPropagation(); },
                onClick: function (e) { e.stopPropagation(); },
                onKeyDown: function (e) {
                  e.stopPropagation();
                  if (e.key === "Enter") { renameGroup(cfg.id, e.currentTarget.value); setEditG(""); }
                  else if (e.key === "Escape") { escRef.current = true; setEditG(""); }
                },
                onBlur: function (e) {
                  if (escRef.current) { escRef.current = false; return; }
                  renameGroup(cfg.id, e.currentTarget.value);
                  setEditG("");
                }
              })
            : h("span", { className: "kg-gname", title: "双击改名" }, cfg.name),
          h("span", { className: "kg-gn" }, it.members.length),
          h("span", { className: "kg-gmem" }, it.members.map(function (m) { return m.name; }).join(" · ")),
          h("button", {
            className: "kg-gauto", type: "button",
            title: "自动排列：有任务块的卡片放大 · 无任务块的卡片缩小",
            onPointerDown: function (e) { e.stopPropagation(); },
            onClick: function (e) { e.stopPropagation(); autoArrangeCard(cfg.id, it.id); }
          }, "自动排列"),
          h("button", {
            className: "kg-gx", type: "button", title: "解散分组",
            onPointerDown: function (e) { e.stopPropagation(); },
            onClick: function (e) { e.stopPropagation(); dissolve(cfg.id); }
          }, "×")
        ),
        h("div", {
          className: "kg-gbody",
          style: { left: body.x + "px", top: body.y + "px", width: body.w + "px", height: body.h + "px" }
        }, (gridOn && activeOp && activeOp.gid === cfg.id) ? h("div", { className: "kg-grid" }) : null, mem),
        h("div", {
          className: "kg-prsz", title: "拖动缩放",
          onPointerDown: function (e) { opDown("resize", it.id, e, "top"); }
        })
      );
    }

    var cardEls = [];
    if (isMax) {
      var mrect = shown[maxIt ? maxIt.id : maxed];
      if (mrect) cardEls.push(maxIt ? renderGroup(maxIt, mrect, true) : renderProf(maxProf, mrect, true, ""));
    } else {
      items.forEach(function (it) {
        var r = view[it.id];
        if (!r) return;
        cardEls.push(it.kind === "group" ? renderGroup(it, r, false) : renderProf(it.prof, r, false, ""));
      });
    }

    var empty = !groups.length
      ? h("div", { className: "kg-empty" }, "所选范围里还没有任务")
      : (!items.length
        ? h("div", { className: "kg-empty" }, "全部 profile 都被隐藏了 · 点上方胶囊显示")
        : null);

    return h("div", { className: "kg-root" }, top,
      h("div", { className: "kg-board", ref: boardRef },
        h("div", { className: "kg-surface", style: { height: surfaceH + "px" }, "data-ct": "1" },
          (gridOn && activeOp) ? h("div", { className: "kg-grid" }) : null,
          overlay,
          guideEls,
          cardEls,
          empty
        )
      )
    );
  }

  // ─────────────────── task detail popup (double-click a task block) ───────────────────
  function fmtTs(v) {
    if (!v) return "";
    var m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
    return m ? m[3] + "-" + m[2] + " " + m[4] + ":" + m[5] : String(v);
  }

  function TaskModal(props) {
    var d = props.detail, onClose = props.onClose;
    useEffect(function () {
      if (!d) return;
      function key(e) { if (e.key === "Escape") onClose(); }
      window.addEventListener("keydown", key);
      return function () { window.removeEventListener("keydown", key); };
    }, [d, onClose]);
    if (!d) return null;

    var t = d.task || {}, st = t.status || "";
    var rows = [], secs = [];
    function row(k, v) {
      if (v === null || v === undefined || v === "") return null;
      rows.push(h("div", { className: "kg-mrow", key: k }, h("span", { className: "kg-mk" }, k), h("span", { className: "kg-mv" }, String(v))));
    }
    function sec(title, kids) {
      if (!kids || (kids.length === 0)) return;
      secs.push(h("div", { className: "kg-msec", key: title }, h("h4", null, title), kids));
    }
    function txt(s) { return h("div", { className: "kg-mtxt" }, String(s)); }
    function slim(list) {
      return list.map(function (x) {
        return h("div", { className: "kg-mitem", key: x.id },
          h("span", { className: "kg-mst kg-s-" + (x.status || "") }, (ICON[x.status] || "●")),
          h("span", { className: "kg-mid" }, x.id),
          h("span", { className: "kg-mtt" }, x.title || ""));
      });
    }

    if (d.loading) {
      secs.push(h("div", { className: "kg-mnote" }, "读取中…"));
    } else if (d.error) {
      secs.push(h("div", { className: "kg-mnote" }, "读取失败：" + d.error));
    } else {
      row("状态", (ICON[st] || "●") + " " + (LABEL[st] || st));
      row("板", d.board);
      row("指派", t.assignee || "未指派");
      row("模型", d.tagFull || "");
      row("优先级", t.priority);
      row("创建", fmtTs(t.created_at));
      row("开始", fmtTs(t.started_at) + (t.last_heartbeat_at ? "（心跳 " + fmtTs(t.last_heartbeat_at) + "）" : ""));
      row("完成", fmtTs(t.completed_at));
      row("连续失败", t.consecutive_failures ? String(t.consecutive_failures) : "");
      row("工作区", t.workspace_path || t.workspace_kind || "");
      row("分支", t.branch_name || "");
      row("会话", t.session_id || "");
      row("技能", t.skills || "");
      sec("描述", t.body ? txt(t.body) : null);
      sec("结果", t.result ? txt(t.result) : null);
      sec("最近错误", t.last_failure_error ? txt(t.last_failure_error) : null);
      sec("依赖（" + ((d.parents || []).length) + "）", (d.parents || []).length ? slim(d.parents) : null);
      sec("被依赖（" + ((d.children || []).length) + "）", (d.children || []).length ? slim(d.children) : null);
      sec("最近运行", (d.runs || []).length ? d.runs.map(function (r, i) {
        return h("div", { className: "kg-mrun", key: "r" + i },
          h("span", { className: "kg-mid" }, (r.profile || "?") + " · " + (r.status || "")),
          h("span", { className: "kg-mtt" }, fmtTs(r.started_at) + (r.ended_at ? " → " + fmtTs(r.ended_at) : "")),
          r.summary ? h("div", { className: "kg-mtxt kg-msub" }, r.summary) : null,
          r.error ? h("div", { className: "kg-mtxt kg-msub" }, r.error) : null);
      }) : null);
      sec("评论", (d.comments || []).length ? d.comments.map(function (c, i) {
        return h("div", { className: "kg-mrun", key: "c" + i },
          h("span", { className: "kg-mid" }, (c.author || "?") + " · " + fmtTs(c.at)),
          h("div", { className: "kg-mtxt kg-msub" }, c.body));
      }) : null);
      sec("事件", (d.events || []).length ? d.events.map(function (e, i) {
        return h("div", { className: "kg-mitem", key: "e" + i },
          h("span", { className: "kg-mid" }, fmtTs(e.at)),
          h("span", { className: "kg-mtt" }, e.kind + (e.payload ? " · " + e.payload : "")));
      }) : null);
    }

    return h("div", { className: "kg-modal", onClick: onClose },
      h("div", { className: "kg-mbox", onClick: function (e) { e.stopPropagation(); } },
        h("div", { className: "kg-mhead" },
          h("span", { className: "kg-mdot", style: { background: profColor(t.assignee || "") } }),
          h("span", { className: "kg-mtitle" }, t.title || d.id || ""),
          h("button", { className: "kg-mx", type: "button", title: "关闭（Esc）", onClick: onClose }, "×")),
        h("div", { className: "kg-mmeta" },
          h("span", { className: "kg-chip kg-s-" + st }, (ICON[st] || "●") + " " + (LABEL[st] || st)),
          d.tag ? h("span", { className: "kg-chip", style: { borderColor: d.tagColor || "transparent", color: d.tagColor || "inherit" } }, d.tagFull || d.tag) : null,
          h("span", { className: "kg-chip" }, "板 " + (d.board || "")),
          h("span", { className: "kg-chip" }, d.id || "")),
        h("div", { className: "kg-mrows" }, rows),
        secs));
  }

  function modeSwitch(props) {
    return h("span", { className: "kg-mode" },
      h(Button, {
        size: "sm", variant: props.mode === "multi" ? "default" : "outline",
        title: "每个 profile 一块面板，可拖动/缩放/吸附",
        onClick: function () { props.setMode("multi"); }
      }, "多 Profile"),
      h(Button, {
        size: "sm", variant: props.mode === "single" ? "default" : "outline",
        title: "单块板的完整依赖图（可拖节点）",
        onClick: function () { props.setMode("single"); }
      }, "单板")
    );
  }

  // ─────────────────────────── page ───────────────────────────
  function KanbanGraphPage() {
    var s;
    s = useState(readMode); var mode = s[0], setMode = s[1];
    s = useState([]); var boards = s[0], setBoards = s[1];
    s = useState(""); var board = s[0], setBoard = s[1];
    s = useState(readScope); var scope = s[0], setScope = s[1];
    s = useState({}); var graphs = s[0], setGraphs = s[1];
    s = useState(null); var error = s[0], setError = s[1];
    s = useState(0); var reloadKey = s[0], setReloadKey = s[1];
    s = useState(readHide); var hideSt = s[0], setHideSt = s[1];
    s = useState(null); var detail = s[0], setDetail = s[1];

    // board list once, then pick the board (single-board view)
    useEffect(function () {
      var alive = true;
      SDK.fetchJSON(API + "/boards").then(function (data) {
        if (!alive) return;
        var list = (data && data.boards) || [];
        setBoards(list);
        var stored = readStored(), pick = null, i;
        for (i = 0; i < list.length; i++) if (list[i].slug === stored) { pick = stored; break; }
        if (!pick) {
          var cur = data && data.current;
          for (i = 0; i < list.length; i++) if (list[i].slug === cur) { pick = cur; break; }
        }
        if (!pick) pick = (list[0] && list[0].slug) || "default";
        setBoard(pick);
      }).catch(function (e) {
        if (!alive) return;
        setError(errMsg(e));
        setBoard("default");
      });
      return function () { alive = false; };
    }, []);

    useEffect(function () { if (board) writeStored(board); }, [board]);
    useEffect(function () { lsSet(LS_MODE, mode); }, [mode]);
    useEffect(function () { lsSet(LS_SCOPE, scope); }, [scope]);

    var slugs = neededSlugs(mode, board, scope, boards);
    var slugKey = slugs.join(",");

    // one poller for whatever the current mode/scope needs
    useEffect(function () {
      var list = slugKey ? slugKey.split(",") : [];
      if (!list.length) return;
      var alive = true;
      function one(sl) {
        return SDK.fetchJSON(API + "/graph?board=" + encodeURIComponent(sl)).then(function (g) {
          if (!alive) return;
          setGraphs(function (prev) {
            if (prev[sl] === g) return prev;
            var nxt = Object.assign({}, prev);
            nxt[sl] = g;
            return nxt;
          });
        });
      }
      function tick(silent) {
        if (silent && typeof document !== "undefined" && document.hidden) return;
        Promise.all(list.map(one)).then(function () { if (alive) setError(null); })
          .catch(function (e) { if (alive) setError(errMsg(e)); });
      }
      tick(false);
      var t = setInterval(function () { tick(true); }, POLL_MS);
      return function () { alive = false; clearInterval(t); };
    }, [slugKey, reloadKey]);

    var toggleSt = useCallback(function (st) {
      setHideSt(function (prev) {
        var nxt = Object.assign({}, prev);
        if (nxt[st]) delete nxt[st]; else nxt[st] = 1;
        writeHide(nxt);
        return nxt;
      });
    }, []);
    var onReload = useCallback(function () { setReloadKey(function (n) { return n + 1; }); }, []);

    // double-click a task block -> one panel holding everything about that task
    var boardRef = useRef(board);
    boardRef.current = board;
    var openTask = useCallback(function (a, b) {
      var id, bd;
      if (a && typeof a === "object") { id = a.oid || a.id; bd = a.board; }
      else { id = a; bd = b; }
      if (!id) return;
      bd = bd || boardRef.current;
      setDetail({ loading: true, id: id, board: bd });
      SDK.fetchJSON(API + "/task?board=" + encodeURIComponent(bd) + "&id=" + encodeURIComponent(id))
        .then(function (d) {
          setDetail(function (cur) { return cur && cur.id === id ? Object.assign({ loading: false }, d) : cur; });
        })
        .catch(function (e) {
          setDetail(function (cur) { return cur && cur.id === id ? { loading: false, error: errMsg(e), id: id, board: bd } : cur; });
        });
    }, []);
    var closeTask = useCallback(function () { setDetail(null); }, []);

    var shared = {
      mode: mode, setMode: setMode,
      boards: boards, board: board, setBoard: setBoard,
      scope: scope, setScope: setScope,
      graphs: graphs, error: error,
      hideSt: hideSt, toggleSt: toggleSt, onReload: onReload, onTask: openTask
    };

    return h("div", { className: "kg-root" },
      mode === "single" ? h(SingleBoardView, shared) : h(MultiProfileView, shared),
      h(TaskModal, { detail: detail, onClose: closeTask }));
  }

  // internals exposed for headless acceptance tests (no UI dependency)
  window.__KG_TEST__ = {
    buildModel: buildModel, buildView: buildView, orthPath: orthPath, snapCell: snapCell,
    groupByProfile: groupByProfile, mergeGraphs: mergeGraphs, buildPanels: buildPanels,
    neededSlugs: neededSlugs, tileRects: tileRects, pickFreeSlot: pickFreeSlot,
    snapMove: snapMove, snapResize: snapResize, crossPath: crossPath, overlaps: overlaps,
    unionRect: unionRect, groupBody: groupBody, clampInnerRect: clampInnerRect,
    innerLayout: innerLayout, nearestFree: nearestFree, pushAside: pushAside, insideRect: insideRect,
    hasOverlap: hasOverlap, GKEY: GKEY,
    squarifyRects: squarifyRects, weightedSlots: weightedSlots, profWeight: profWeight,
    isDoubleTap: isDoubleTap, PROF_W_EMPTY: PROF_W_EMPTY, PROF_W_BUSY: PROF_W_BUSY,
    blockCount: blockCount,
    freeSpot: freeSpot,
    GMIN_W: GMIN_W, GMIN_H: GMIN_H, GHEAD: GHEAD, GBODY_PAD: GBODY_PAD, INNER_PAD: INNER_PAD,
    IMIN_W: IMIN_W, IMIN_H: IMIN_H, GRID: GRID, PGAP: PGAP,
    GEO_MAIN: GEO_MAIN, GEO_MINI: GEO_MINI,
    NODE_W: NODE_W, NODE_H: NODE_H, CELL_W: CELL_W, CELL_H: CELL_H, GAP_X: GAP_X, MARGIN: MARGIN
  };

  if (window.__HERMES_PLUGINS__ && typeof window.__HERMES_PLUGINS__.register === "function") {
    window.__HERMES_PLUGINS__.register("kanban-graph", KanbanGraphPage);
  }
})();
