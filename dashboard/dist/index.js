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

  // ── Hermes 运行状态条 ──
  // 绿点=该 profile 的 gateway 进程在跑（后端 GET /api/plugins/kanban-graph/api/status
  // 扫 /proc：cwd=<home>/.hermes/profiles/<name> 且 HOME 匹配）。桌面版 Hermes 无独立
  // gateway 进程（AppImage 内嵌），故「桌面主对话」不亮绿——如实不造假。
  // 2026-10-12 教训：此组件曾在被清理的工作区写完未入库而丢失，未 commit 不算存在。
  // curated chips (name, short desc). The rendered set = curated + EVERY
  // running profile the backend reports: v20.1 (user: study 亮不起来、
  // lunaloo 按钮都没有) — a hardcoded list hid running sessions entirely.
  var SB_PROFILES = [["liteguard", "当前会话"], ["default", "桌面主对话"], ["study", "学科"], ["lunaloo", "站点"]];
  var SB_CURRENT = "liteguard";  // dashboard 会话所属 profile；换 profile 时改这里
  function StatusBar() {
    var s = useState({ run: [], tot: null, cnt: null, hid: readHiddenProf() });
    var data = s[0], setData = s[1];
    // v20.2: chips double as the wall's show/hide switches — the SAME store the
    // profile filter chips use (hiddenProfiles), synced via a window event so
    // toggling from either side keeps both rows honest.
    useEffect(function () {
      function sync() { setData(function (p) { return { run: p.run, tot: p.tot, cnt: p.cnt, hid: readHiddenProf() }; }); }
      window.addEventListener("kg-hidep", sync);
      return function () { window.removeEventListener("kg-hidep", sync); };
    }, []);
    function toggle(name) {
      var nxt = readHiddenProf();
      if (nxt[name]) delete nxt[name]; else nxt[name] = 1;
      writeHiddenProf(nxt);
      setData(function (p) { return { run: p.run, tot: p.tot, cnt: p.cnt, hid: nxt }; });
      window.dispatchEvent(new CustomEvent("kg-hidep"));
    }
    useEffect(function () {
      var alive = true;
      function tick() {
        SDK.fetchJSON(API + "/status").then(function (d) {
          if (alive) setData(function (p) { return { run: (d && d.running) || [], tot: p.tot, cnt: p.cnt, hid: p.hid }; });
        }).catch(function () { if (alive) setData(function (p) { return { run: [], tot: p.tot, cnt: p.cnt, hid: p.hid }; }); });
        SDK.fetchJSON(API + "/boards").then(function (d) {
          var bs = (d && d.boards) || [], t = 0, r = 0;
          bs.forEach(function (b) { t += (b.task_count || 0); r += (b.running || 0); });
          if (alive) setData(function (p) { return { run: p.run, tot: t, cnt: r, hid: p.hid }; });
        }).catch(function () {});
      }
      tick();
      var t2 = setInterval(tick, 30000);
      return function () { alive = false; clearInterval(t2); };
    }, []);
    return h("div", { className: "kg-status-bar" },
      h("span", { className: "kg-sb-title" }, "会话运行状态"),
      (function () {
        var run = data.run || [];
        var names = SB_PROFILES.slice();
        run.forEach(function (r) {
          for (var i = 0; i < names.length; i++) if (names[i][0] === r) return;
          names.push([r, ""]);
        });
        return names.map(function (p) {
          var on = run.indexOf(p[0]) >= 0;
          var off = !!(data.hid || {})[p[0]];
          return h("span", { key: p[0], className: "kg-sb-item" + (p[0] === SB_CURRENT ? " kg-sb-cur" : "") + (off ? " kg-sb-hid" : ""),
            onClick: function () { toggle(p[0]); } },
            h("span", { className: "kg-sb-dot" + (on ? " kg-sb-on" : "") }),
            h("span", { className: "kg-sb-name" }, p[0]),
            p[1] ? h("span", null, " · " + p[1]) : null,
            p[0] === SB_CURRENT ? h("span", { className: "kg-sb-tag" }, " ▸当前") : null);
        });
      })(),
      h("span", { className: "kg-sb-counts" },
        data.tot == null ? "全部任务 – / 在办 –" : "全部任务 " + data.tot + " / 在办 " + data.cnt),
      h("span", { className: "kg-sb-hint" }, "绿点=本机有该会话的服务进程；桌面版会话内嵌、无独立进程"));
  }

  // ─────────────────────────── geometry ───────────────────────────
  // Two coordinate systems share one engine:
  //  · GEO_MAIN — the single-board canvas (and the lattice drag-snapping uses)
  //  · GEO_MINI — compact boxes drawn inside a profile panel
  var GEO_MAIN = { W: 210, H: 56, GX: 96, GY: 20, M: 24, RAD: 10, ULC: 0, UNITS: 28, PAD: 14, TY: 20, MY: 51, DY: 15 };
  // v19 (user 2026-10-12, 3rd ask): M 12 -> 6. Width-fit cards showed a 2*M*scale
  // side margin that GREW with the block (33-70 CSS px) — the "blocks do not fill
  // the card" complaint at its core. Half the margin lifts single/double column
  // fill from ~87-88% to ~93-94% and tightens top/bottom alike.
  var GEO_MINI = { W: 168, H: 48, GX: 52, GY: 14, M: 6, RAD: 8, ULC: 2, UNITS: 26, PAD: 12, TY: 17, MY: 41, DY: 13, KTF: 1 };
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
  var GRID = 8, SNAP = 8, PMIN_W = 240, PMIN_H = 150, PDEF_W = 460, PDEF_H = 330, PGAP = 12, MINI_SCALE_MIN = 1.0, MINI_SCALE_MAX = 3.0; // v22.1 (user 10-13): READABILITY FLOOR — blocks used to shrink to 0.5x on busy walls (text unreadable). scale is now clamped to >= 1: a card always shows blocks at their natural readable size and the .kg-pbody (overflow:auto) scrolls instead. cap stays 3.0 (single-block sanity fill).
  // v13 (user 2026-10-11): cards hug their content, blocks render as large as
  // possible. HUG_TS is the target on-screen scale (block ≈ 168*1.3 ≈ 218px
  // wide vs ≈185 under the old fixed 2-col tile), HUG_PAD the small gap the
  // card keeps around the block grid, HUG_HEAD the title row's pixel height.
  var HUG_TS = 1.3, HUG_PAD = 6, HUG_HEAD = 29;
  // group cards + maximised cards
  var GMIN_W = 320, GMIN_H = 230, GHEAD = 30, GBODY_PAD = 8, INNER_PAD = 6;
  var STRIP_H = 32, STRIP_H_IN = 28; // a collapsed card is just its title row (border 2 + head 28/24 + hairline 1 + border 1)
  var STRIP_MIN_W = 260, STRIP_VGAP = 8; // v11 shelf constants (STRIP_MIN_W kept for layout compat)
  var STRIP_GAP = 6, STRIP_RESIZE_MIN = 90; // v13: shelf strips sit TIGHT (6px) and may be width-dragged (≥90px)
  // v12 (user 2026-10-11): wall strips are CONTENT width, not stretched rows —
  // a collapsed card must not keep the footprint of an expanded one. Chrome =
  // dot + title padding + count chip + × button; the 自动排列 button hides via
  // .kg-pstrip.narrow CSS when the box cannot fit it.
  var STRIP_BASE_W = 118, STRIP_MAX_W = 340, STRIP_AUTO_W = 62;
  function stripW(name) {
    return clamp(Math.round(STRIP_BASE_W + textPx(profLabel(name), 11)) + 4, STRIP_AUTO_W + 60, STRIP_MAX_W);
  }
  // v12 nesting: a group's members may hold profile names OR "§"+gid tokens
  // (a nested group). A group has at most ONE parent (first ref wins); depth
  // is capped so corrupt localStorage data can never loop the renderer.
  var GTOK = "\u00a7";
  var NEST_MAX = 4;
  function isTok(m) { return typeof m === "string" && m.slice(0, 1) === GTOK; }
  function tokGid(m) { return m.slice(1); }
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
  // v13: shelf strips may be width-dragged; that width lives HERE (per scope),
  // NOT in layout — layout rects would pin the strip out of the flow. The
  // shelf flow always re-packs; only the strip's WIDTH becomes manual.
  var LS_STRIPW = "hermes.kanbangraph.stripW."; // + scope key
  function readStripWs(k) {
    try {
      var o = JSON.parse(lsGet(LS_STRIPW + k) || "{}"), out = {};
      if (o && typeof o === "object") Object.keys(o).forEach(function (p) {
        if (typeof o[p] === "number" && o[p] >= STRIP_RESIZE_MIN) out[p] = o[p];
      });
      return out;
    } catch (e) { return {}; }
  }
  function writeStripWs(k, m) { lsSet(LS_STRIPW + k, JSON.stringify(m || {})); }

  // ── group cards ──────────────────────────────────────────────────────────
  // groups.<scope> = [{ id, name, members:[profile | "§"+gid …], inner:{ token:{x,y,w,h} } }]
  // `inner` rects are relative to the group body box (see groupBody).
  // v12: a member may be a NESTED group token ("§"+gid). Sanitizer drops
  // dangling/duplicate tokens so corrupt data cannot crash the recursive
  // renderer (a group has at most one parent — first reference wins).
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
      return sanitizeGroups(out);
    } catch (e) { return []; }
  }
  // shared sanitizer: drop dangling/duplicate/cyclic nested-group tokens, then
  // drop containers that fell under the 2-member floor (read + every mutation
  // path run through this so the store is ALWAYS a legal forest — the renderer
  // never has to guess which edge of a broken cycle to honour).
  function sanitizeGroups(out) {
    var ids = {};
    out.forEach(function (g) { ids[g.id] = 1; });
    var parentOf = {};
    function ancOf(id) { var s = {}, up = id; while (up) { s[up] = 1; up = parentOf[up]; } return s; }
    out.forEach(function (g) {
      var keep = [];
      (g.members || []).forEach(function (m) {
        if (!isTok(m)) { keep.push(m); return; }
        var gid = tokGid(m);
        if (!ids[gid] || gid === g.id || parentOf[gid]) return;
        var a1 = ancOf(gid), a2 = ancOf(g.id);
        if (a1[g.id] || a2[gid]) return; // this edge would close a cycle
        parentOf[gid] = g.id;
        keep.push(m);
      });
      g.members = keep;
      Object.keys(g.inner || {}).forEach(function (p) { if (isTok(p) && g.members.indexOf(p) < 0) delete g.inner[p]; });
    });
    var floor = out.filter(function (g) { return g.members.length >= 2; });
    // dropping a container can dangle tokens that referenced it — run back
    // through until the store is a fixed point (each pass only removes)
    if (floor.length !== out.length) return sanitizeGroups(floor);
    return floor;
  }
  // is wantGid inside the subtree rooted at rootGid? (cycle guard for nesting)
  function groupSubtreeHas(arr, rootGid, wantGid, depth) {
    if (depth > NEST_MAX) return false;
    var hit = false;
    arr.forEach(function (c) {
      if (c.id !== rootGid) return;
      c.members.forEach(function (m) {
        if (!isTok(m)) return;
        if (tokGid(m) === wantGid) { hit = true; return; }
        if (groupSubtreeHas(arr, tokGid(m), wantGid, depth + 1)) hit = true;
      });
    });
    return hit;
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
        // v17: entries may now carry w/h (manual block resize)
        if (p && typeof p.x === "number" && typeof p.y === "number") {
          var e = { x: p.x, y: p.y };
          if (typeof p.w === "number" && p.w >= 60 && p.w <= 900) e.w = p.w;
          if (typeof p.h === "number" && p.h >= 36 && p.h <= 700) e.h = p.h;
          out[id] = e;
        }
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
  // 1 unit = 0.55 em (see textPx). Latin at font-weight 600 measures ~0.62-0.65
  // em per char on average (m/w/caps/._- are wide), so plain 1.0 under-budgeted
  // and long path-like titles overflowed the node box (measured 105% fill).
  // 1.15 brings worst-case Latin titles back to ~91%. CJK keeps 2 (1.1em vs
  // real 1.0em — the pre-existing conservative headroom).
  function charW(ch) { var c = ch.charCodeAt(0); return (c > 0x2e7f || c >= 0xff00) ? 2 : 1.15; }
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
  function buildModel(graph, showUl, G, opts) {
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
    if (G.KTF) {
      // v10 (user 2026-10-11): blocks inside a card go home sorted by STATUS_ORDER
      // first, then by title. v13 (user again): fill COLUMN-FIRST — a queue of
      // ≤4 blocks takes ONE column (the card turns tall and narrow, and the fit
      // scale stops being width-capped, so blocks render noticeably bigger);
      // longer queues wrap into a second column at the same lattice.
      // v17 (user again): DEPENDENCY FIRST — tasks in a relation hug one
      // column (longest-path layer over forward edges, a barycentre sweep
      // keeps siblings adjacent), so a chain draws bottom→top in one line and
      // the queue only wraps when the column is full. Status/title stay as
      // tie-breakers for unrelated blocks.
      var drawn = linked.concat(unlinked);
      var lmap = new Map();
      for (k = 0; k < linked.length; k++) lmap.set(linked[k].id, 0);
      var guard = linked.length + 1;
      while (guard-- > 0) {
        var ch2 = false;
        for (i = 0; i < es.length; i++) {
          var lP = lmap.get(es[i].parent);
          if (lP === undefined) continue;
          var lC = lmap.get(es[i].child);
          if (lC !== undefined && lC < lP + 1) { lmap.set(es[i].child, lP + 1); ch2 = true; }
        }
        if (!ch2) break;
      }
      var parOf = new Map();
      for (k = 0; k < linked.length; k++) parOf.set(linked[k].id, []);
      for (i = 0; i < es.length; i++) if (parOf.has(es[i].child)) parOf.get(es[i].child).push(es[i].parent);
      function stCmp(a, b) {
        var sa = STATUS_ORDER.indexOf(a.status), sb = STATUS_ORDER.indexOf(b.status);
        if (sa < 0) sa = STATUS_ORDER.length;
        if (sb < 0) sb = STATUS_ORDER.length;
        if (sa !== sb) return sa - sb;
        return String(a.title || "").localeCompare(String(b.title || ""), "en", { numeric: true, sensitivity: "base" });
      }
      var maxL = 0; lmap.forEach(function (v) { if (v > maxL) maxL = v; });
      var ordered2 = [], posIdx = new Map();
      for (k = 0; k <= maxL; k++) {
        (function (lvl) {
          var bucket = [];
          for (var q2 = 0; q2 < linked.length; q2++) if (lmap.get(linked[q2].id) === lvl) bucket.push(linked[q2]);
          bucket.sort(function (a, b) {
            var ba = baryOf(a), bb = baryOf(b);
            if (Math.abs(ba - bb) > 1e-9) return ba - bb;
            return stCmp(a, b);
          });
          for (var j2 = 0; j2 < bucket.length; j2++) posIdx.set(bucket[j2].id, ordered2.length + j2);
          ordered2 = ordered2.concat(bucket);
        })(k);
      }
      function baryOf(nd) {
        var ps = parOf.get(nd.id) || [], sum = 0, n = 0;
        for (var q3 = 0; q3 < ps.length; q3++) {
          var pv = posIdx.get(ps[q3]);
          if (pv !== undefined) { sum += pv; n++; }
        }
        return n ? sum / n : 1e9;
      }
      unlinked.sort(stCmp);
      drawn = ordered2.concat(unlinked);
      var dmap = new Map(), pl2 = new Map(),
          colsN = Math.max(1, Math.min(drawn.length || 1, (opts && opts.cols) || ktfCols(drawn.length)));
      var colRows = Math.ceil(drawn.length / colsN);
      for (k = 0; k < drawn.length; k++) {
        dmap.set(drawn[k].id, drawn[k]);
        pl2.set(drawn[k].id, { x: G.M + Math.floor(k / colRows) * CW, y: G.M + (k % colRows) * CH });
      }
      return {
        placed: pl2, ulPos: new Map(),
        width: colsN ? G.M * 2 + colsN * G.W + (colsN - 1) * G.GX : 0,
        height: colRows ? G.M * 2 + colRows * G.H + (colRows - 1) * G.GY : 0,
        xShift: 0, parents: new Map(), children: new Map(), nodeMap: dmap,
        unlinked: [], edges: es, backEdges: bes, routes: [],
        ulActive: ulActive, ulHiddenTerm: ulHiddenTerm, ulHdrX: 0, ulHdrY: 0, geo: G
      };
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

  // v10: the rectangle a task block's TOP-LEFT may occupy inside the card, in
  // model coordinates. The canvas covers the whole card body; the content bbox
  // (0..vw/0..vh) sits centred inside it via the viewBox offset offX/offY.
  function blockBoxOf(cw, ch, offX, offY, G) {
    // v19: the viewBox origin sits ~2.4 units LEFT of the panel rect (measured:
    // a block clamped to -offX rendered 3.28 CSS px outside the border, and the
    // leak scales with the fit). Hold the left wall 3 units in — the leak is
    // proportional so a unit constant covers every scale; visually still flush.
    var x0 = -offX + 3, y0 = -offY;
    return { x0: x0, y0: y0, x1: Math.max(x0, cw - offX - G.W), y1: Math.max(y0, ch - offY - G.H) };
  }

  // Merge free/magneted drag positions over the layered layout. v21 (user
  // 2026-10-13): manual positions render verbatim and NEVER make siblings move
  // — auto/lattice nodes keep their home cell even when a manual rect overlaps
  // it. The old rescue/yield chains re-flowed the card under the cursor and
  // are removed by demand; "自动排列" on the card is the way back to a tidy grid.
  function buildView(mdl, ov) {
    var G = (mdl && mdl.geo) || GEO_MAIN, CW = cellW(G), CH = cellH(G);
    var placed = new Map(), occ = new Set(), ids = [], maxX = 0, maxY = 0;
    mdl.nodeMap.forEach(function (n, id) { ids.push(id); });
    mdl.unlinked.forEach(function (n) { ids.push(n.id); });
    var i, p;
    for (i = 0; i < ids.length; i++) {
      var o = ov && ov[ids[i]];
      if (!o) continue;
      // v17: a manual entry may also carry w/h (block resize); the occupancy
      // footprint it protects grows with the block, not with the lattice.
      var OW = (o.w && o.w >= 60) ? o.w : G.W, OH = (o.h && o.h >= 36) ? o.h : G.H;
      // v10: a manual rect claims EVERY cell it visually overlaps (free drops can
      // sit between cells now), so no auto node is ever laid on top of it.
      for (var cxx = G.M; cxx <= o.x + OW; cxx += CW) {
        for (var cyy = G.M; cyy <= o.y + OH; cyy += CH) {
          if (cxx < o.x + OW && cyy < o.y + OH && cxx + G.W > o.x && cyy + G.H > o.y) occ.add(cxx + "," + cyy);
        }
      }
      placed.set(ids[i], { x: o.x, y: o.y, w: o.w, h: o.h });
    }
    for (i = 0; i < ids.length; i++) {
      if (placed.has(ids[i])) continue;
      p = mdl.placed.get(ids[i]) || mdl.ulPos.get(ids[i]);
      if (!p) continue;
      // v21: NO rescue/yield around manual rects — auto nodes keep their home
      // cell. Manual-priority used to shove every overlapping sibling to the
      // "nearest free cell"; the user found that uncontrollable (2026-10-13).
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

  // v10: blocks a card actually paints = every node buildModel put on the
  // lattice (placed ∪ ulPos) whose status is not hidden by the legend.
  function visibleBlocks(model, hideSt) {
    if (!model) return 0;
    var n = 0;
    function count(id) {
      var node = (model.nodeMap && model.nodeMap.get(id)) || null;
      if (!node && model.unlinked) {
        for (var i = 0; i < model.unlinked.length; i++) if (model.unlinked[i].id === id) { node = model.unlinked[i]; break; }
      }
      if (!node || !(hideSt && hideSt[node.status])) n++;
    }
    if (model.placed) model.placed.forEach(function (p, id) { count(id); });
    if (model.ulPos) model.ulPos.forEach(function (p, id) { count(id); });
    return n;
  }

  // shared card order: unassigned last, otherwise name with numeric suffixes
  // comparing numerically (lab2 < lab10) and case-insensitive
  function nameCmp(a, b) {
    if ((a === "") !== (b === "")) return a === "" ? 1 : -1;
    return String(a).localeCompare(String(b), "en", { numeric: true, sensitivity: "base" });
  }

  // the card order rule, for any set of profile groups: cards that still draw
  // task blocks come first, then by name. Used for the wall AND inside a group.
  function orderCards(list, hideSt) {
    return list.slice().sort(function (a, b) {
      var ab = blockCount(a, hideSt) > 0, bb = blockCount(b, hideSt) > 0;
      if (ab !== bb) return ab ? -1 : 1;
      return nameCmp(a.name, b.name);
    });
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
    // cards that still draw task blocks come first (auto-arrange tiles in this
    // order, so the busy profiles land in the top-left slots); then by name
    groups = orderCards(groups, hideSt);
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

  // v11 (user 2026-10-11): ROW-FIRST packing for 自动排列. tileRects above
  // balances columns via sqrt and stretches rows to fill the canvas height,
  // so two busy cards sat one per row and the strip shelf fell off-screen.
  // rowPack fills as many cards into a row as fit at minW, wraps only when the
  // row is full, and keeps every row at a fixed comfortable cardH.
  function rowPack(n, W, minW, cardH, gap) {
    var out = [];
    if (n <= 0) return out;
    gap = gap || PGAP; minW = minW || PDEF_W; cardH = cardH || PDEF_H;
    var cols = Math.max(1, Math.min(n, Math.floor((W + gap) / (minW + gap))));
    var w = Math.floor((W - (cols + 1) * gap) / cols);
    for (var i = 0; i < n; i++) {
      out.push({ x: gap + (i % cols) * (w + gap), y: gap + Math.floor(i / cols) * (cardH + gap), w: w, h: cardH });
    }
    return out;
  }

  // v12: the collapsed-shelf flow — strips keep their CONTENT width (widths[])
  // and pack left-to-right below y0, wrapping when the next one stops fitting.
  // v11 stretched each strip to a full row; for collapsed cards that left huge
  // empty footprints (user 2026-10-11: 收起的卡片也小一点、放到一起).
  function shelfPack(widths, W, y0, stripH, gap, vgap) {
    var out = [];
    if (!widths || !widths.length) return out;
    gap = gap == null ? PGAP : gap;
    stripH = stripH || STRIP_H;
    vgap = vgap == null ? STRIP_VGAP : vgap;
    W = Math.max(1, W);
    var x = PGAP, rowY = y0; // v13: left margin aligns with the busy cards; INNER gap stays the tight one
    for (var i = 0; i < widths.length; i++) {
      // clamp into the canvas: a strip wider than the wall would start the
      // next row at the same y and overlap
      var w = Math.max(60, Math.min(widths[i], W - 2 * gap));
      if (x + w > W - gap) { rowY += stripH + vgap; x = PGAP; }
      out.push({ x: x, y: rowY, w: w, h: stripH });
      x += w + gap;
    }
    return out;
  }
  // how many rows the flow needs (for wallPlan's shelf-height reservation)
  function shelfRows(widths, W, gap) {
    gap = gap == null ? PGAP : gap;
    var out = shelfPack(widths, W, 0, STRIP_H, gap, STRIP_VGAP);
    if (!out.length) return 0;
    return Math.round((out[out.length - 1].y - out[0].y) / (STRIP_H + STRIP_VGAP)) + 1;
  }

  // v13 (user 2026-10-11): a card's NATURAL size around its block grid — the
  // content bbox scaled toward HUG_TS plus a small breathing gap. mw/mh come
  // from the model bbox (units), the returned rect is wall px. Width floors at
  // PMIN_W (chips/close button need it), height at PMIN_H.
  function cardHugSize(mw, mh) {
    return {
      w: clamp(Math.round(mw * HUG_TS) + 2 * HUG_PAD, PMIN_W, 900),
      h: clamp(Math.round(mh * HUG_TS) + HUG_HEAD + 2 * HUG_PAD, PMIN_H, 660)
    };
  }

  // ── v22 (user 2026-10-13): consumable height ──────────────────────────────
  // The card grid scale is min(width-fit, height-fit) capped at MINI_SCALE_MAX;
  // past that, EXTRA card height renders as a dead band under the blocks (the
  // survey measured 4282px of it on a fresh 1440x900 wall). cardUsefulH(n, w)
  // mirrors PanelBody's math (same ktfEffGeo cols choice + scale) and answers:
  // at width w, how tall can this card get BEFORE its grid stops growing?
  function cardUsefulH(n, w) {
    if (!(n > 0 && w > 4)) return PMIN_H;
    var eff = ktfEffGeo(n, w, 1e6, MINI_SCALE_MAX);
    var G = eff.geo, c = Math.max(1, eff.cols);
    var r = Math.ceil(n / c);
    var vw = G.M * 2 + c * G.W + (c - 1) * G.GX;
    var vh = G.M * 2 + r * G.H + (r - 1) * G.GY;
    var s = Math.min((w - 4) / vw, MINI_SCALE_MAX);
    return Math.round(vh * s) + HUG_HEAD + 2 * HUG_PAD + 8;
  }

  // ── v15 (user 2026-10-12): 任务块尽量占满卡片的宽度 ──────────────────────
  // The KTF lattice had fixed block width, so after v14 stretched cards into
  // full rows the HEIGHT fit governs scale in most busy cards and the blocks
  // leave a side margin (real wall 2026-10-12: only 53–94% of the card width
  // covered). Fix: when a card is height-fit-governed, widen the BLOCK itself
  // into the leftover width — never a pixel stretch, so no text distortion —
  // capped at KTF_WIDE_MAX so a huge card can't turn blocks into flat bands,
  // with UNITS scaling by the same ratio so titles use the new room.
  // v15.1 (user 2026-10-12, again): when the aspect cap binds and a side
  // margin STILL remains (few blocks in a very wide / manually widened card —
  // real case: the unassigned card at 31% fill on a 1920 wall), PACK MORE
  // COLUMNS (up to 3) — fill first, then the fewest columns (biggest blocks).
  // Width-fit-governed cards keep base width (that blank is BELOW, v14 note).
  var KTF_WIDE_MAX = 450; // units — v19: 370 left a hard blank on 1-2 block wide
  // cards (few blocks can't add columns past cmax, so the cap IS the fill loss);
  // 450 keeps blocks <9.4:1 aspect while letting them eat the real leftover.
  var KTF_COLS_MAX = 3;   // in-card columns stay calm: max 3
  function ktfCols(n) { return n <= 4 ? 1 : 2; }
  function ktfEffGeo(n, w, h, cap) {
    var G0 = GEO_MINI;
    if (!(n > 0 && w > 4 && h > 4)) return { geo: G0, changed: false, cols: 1 };
    var c0 = ktfCols(n), cmax = Math.max(c0, Math.min(n, KTF_COLS_MAX));
    // v18c (v15 probe): the 200px block-width floor is the release promise —
    // extra columns may only win while a block still paints >=200 CSS px.
    // The old "smallest slack" pick happily chose a 3rd/4th column that shrank
    // blocks to 124px. Candidates >=floor compete on slack; if none reach it,
    // try DOWNSHIFTING (fewer columns = bigger blocks, the wall scrolls);
    // only then fall back to the widest rejected candidate.
    function cand(c) {
      var r = Math.ceil(n / c);
      var vw0 = G0.M * 2 + c * G0.W + (c - 1) * G0.GX;
      var vh0 = G0.M * 2 + r * G0.H + (r - 1) * G0.GY;
      var s0 = clamp(Math.min((w - 4) / vw0, (h - 4) / vh0), MINI_SCALE_MIN, cap || MINI_SCALE_MAX);
      if (!(s0 > 0)) return null;
      var Wr = Math.floor(((w - 4) / s0 - G0.M * 2 - (c - 1) * G0.GX) / c);
      var effW = Math.min(Math.max(Wr, G0.W), KTF_WIDE_MAX);
      return { cols: c, W: effW, slack: (w - 4) - (G0.M * 2 + c * effW + (c - 1) * G0.GX) * s0, domW: effW * s0 };
    }
    var best = null, inband = null, capped = false;
    for (var c = c0; c <= cmax; c++) {
      var cd = cand(c);
      if (!cd) break;
      // v18c.2 floor policy: >=240 = clearly fine; 196-240 = "just missed"
      // (a hair under v13's 200 promise) -> keep as last resort; <196 = the
      // base geometry simply cannot do better at this column count, accept
      // but TRY TO DOWNSHIFT below (fewer columns paint bigger blocks).
      if (cd.domW >= 240 || cd.domW < 196) {
        if (!best || cd.slack < best.slack - 1) best = cd;
      } else if (!inband || cd.slack < inband.slack - 1) {
        inband = cd;
      }
      capped = cd.W >= KTF_WIDE_MAX;
      if (!capped) break; // fills without hitting the width cap → stop, keep it
    }
    if (best && best.domW < 196 && best.cols > 1) {
      for (var c2 = best.cols - 1; c2 >= 1; c2--) {
        var cd2 = cand(c2);
        if (cd2 && cd2.domW >= 240) { best = cd2; break; }
      }
    }
    if (!best) best = inband;
    if (!best || (best.W <= G0.W && best.cols <= c0)) return { geo: G0, changed: false, cols: best ? best.cols : c0 };
    return {
      geo: Object.assign({}, G0, { W: best.W, UNITS: Math.max(G0.UNITS, Math.round(G0.UNITS * best.W / G0.W)) }),
      changed: true, cols: best.cols
    };
  }
  // v13: row-first packing for VARIABLE-width hug cards. Cards pack into a row
  // until the next one would not fit, rows top-align, each row is exactly as
  // tall as its tallest card (plus PGAP). Deterministic: same inputs → same
  // slots, so "auto-arrange" and the unstored defaults agree.
  function hugPack(sizes, W, gap) {
    var out = [];
    if (!sizes || !sizes.length) return out;
    gap = gap == null ? PGAP : gap;
    W = Math.max(1, W);
    var x = gap, y = gap, rowH = 0;
    for (var i = 0; i < sizes.length; i++) {
      var w = Math.max(PMIN_W, Math.min(sizes[i].w, W - 2 * gap));
      var h = sizes[i].h;
      if (x + w > W - gap && x > gap) { y += rowH + gap; x = gap; rowH = 0; }
      out.push({ x: x, y: y, w: w, h: h });
      x += w + gap;
      rowH = Math.max(rowH, h);
    }
    return out;
  }

  // ── v22 SKYLINE packing (user 2026-10-13: 自动排版有很多空白区间 浪费) ────
  // The uniform-height row (hugPack) makes every card pay its tallest
  // neighbour's height: a 1-block card in a 660px row dead-band 500px (the
  // quiet survey measured 4282px of dead band on a fresh wall). Height-bucketed
  // rows were tried first and FAILED the wide-screen fold metric (bfleet at
  // 1.7 ratio wraps alone and eats 2241px of width).
  // skyPack is a deterministic classic skyline: a horizontal skyline of
  // segments; each card lands at the LOWEST position, tie-broken LEFTMOST, and
  // raises the skyline across its own span. No bands ⇒ no forced height, the
  // wall is the area its content deserves, order (blocks-first → name) is
  // preserved, and the next card slides into whatever pocket is free.
  function skyPack(sizes, W, gap) {
    var out = [];
    if (!sizes || !sizes.length) return out;
    gap = gap == null ? PGAP : gap;
    W = Math.max(1, W);
    var inner = Math.max(PMIN_W, W - 2 * gap);
    var segs = [{ x0: gap, x1: W - gap, y: gap }];
    for (var i = 0; i < sizes.length; i++) {
      var w = Math.max(PMIN_W, Math.min(sizes[i].w, inner));
      var h = sizes[i].h;
      // candidate x positions: every segment start (and x1-w, to slot into
      // pockets flush-right against a tall neighbour) that fits its span
      var cands = [], c, q;
      for (q = 0; q < segs.length; q++) {
        c = segs[q].x0;
        if (c + w <= W - gap && cands.indexOf(c) < 0) cands.push(c);
        c = segs[q].x1 - w;
        if (c >= gap && c + w <= W - gap && cands.indexOf(c) < 0) cands.push(c);
      }
      var best = null;
      for (q = 0; q < cands.length; q++) {
        var x0 = cands[q], y0 = gap, ok = true;
        for (var s2 = 0; s2 < segs.length; s2++) {
          var sg = segs[s2];
          if (sg.x1 <= x0 || sg.x0 >= x0 + w) continue; // no x-overlap
          if (sg.y > y0) y0 = sg.y;
        }
        if (!ok) continue;
        if (!best || y0 < best.y - 0.5 || (Math.abs(y0 - best.y) <= 0.5 && x0 < best.x)) best = { x: x0, y: y0 };
      }
      if (!best) best = { x: gap, y: segsReduceMax(segs) + gap };
      out.push({ x: best.x, y: best.y, w: w, h: h });
      // raise the skyline across [best.x, best.x+w+gap) — the horizontal gap
      // is paid into the raised span so the NEXT card's segment starts clear
      // of this one (v22 unit caught the flush-touch version)
      var top = best.y + h + gap;
      var rx1 = best.x + w + gap;
      var ns = [];
      for (s2 = 0; s2 < segs.length; s2++) {
        var s3 = segs[s2], x0s = s3.x0, x1s = s3.x1;
        if (x1s <= best.x || x0s >= rx1) { ns.push(s3); continue; }
        if (x0s < best.x) ns.push({ x0: x0s, x1: best.x, y: s3.y });
        if (x1s > rx1) ns.push({ x0: rx1, x1: x1s, y: s3.y });
        ns.push({ x0: Math.max(x0s, best.x), x1: Math.min(x1s, rx1), y: Math.max(s3.y, top) });
      }
      segs = ns;
    }
    return out;
  }
  function segsReduceMax(segs) {
    var m = gap;
    for (var q = 0; q < segs.length; q++) m = Math.max(m, segs[q].y);
    return m;
  }

  // v14 (user 2026-10-12): 自动排列 must SPREAD the busy cards over the whole
  // usable screen — cards fill their row edge-to-edge and the busy area fills
  // the height the shelf leaves — so the mini graph inside a card gets room to
  // grow and the text is readable without zooming. v13 hugged content (dense,
  // but left dead wall and pinned blocks at 1.3x).
  // Invariants that must NOT break:
  //  · never squeeze below the natural hug height (v13.1 lesson: "blocks as
  //    large as possible" beats "no scrolling" — a crowded wall simply scrolls);
  //  · rows stay row-first + top-aligned, one row = one height (tidy grid);
  //  · collapsed strips keep their content width on the shelf below.
  // Deterministic: same inputs → same rects, so 自动排列 and the unstored
  // defaults agree.
  function fillWall(W, H, sizes, slimWidths, gap) {
    gap = gap == null ? PGAP : gap;
    var lay = hugPack(sizes, W, gap); // natural hug slots, input order kept
    if (!lay.length) return lay;
    var inner = Math.max(1, W - 2 * gap);
    // group by row (hugPack emits rows top-aligned, so equal y == same row)
    var order = [], rows = {}, i, key;
    for (i = 0; i < lay.length; i++) {
      key = String(lay[i].y);
      if (!rows[key]) { rows[key] = []; order.push(key); }
      rows[key].push(i);
    }
    // 1) horizontal: a row spans the wall exactly; the leftover goes to its
    //    cards PROPORTIONALLY to their natural width, so relative emphasis
    //    (more/wider content ⇒ wider card) survives the stretch. hugPack only
    //    adds a card while it fits, so extra >= 0 always.
    var rowH = {};
    order.forEach(function (k) {
      var idxs = rows[k], sum = 0;
      idxs.forEach(function (j) { sum += lay[j].w; });
      // the row holds n cards => n-1 INNER gaps must stay paid for, or the
      // last card lands past W-gap (v14 first cut: 1200-wide wall, row ended
      // at 1212 — caught by the geometry survey)
      var extra = inner - gap * (idxs.length - 1) - sum, used = 0;
      idxs.forEach(function (j, t) {
        var add = extra > 0 ? (t === idxs.length - 1 ? extra - used : Math.floor(extra * (lay[j].w / sum))) : 0;
        used += add;
        lay[j].w = lay[j].w + add;
      });
      var hh = 0;
      idxs.forEach(function (j) { hh = Math.max(hh, lay[j].h); });
      rowH[k] = hh;
    });
    // 2) vertical: the shelf keeps its natural spot under the busy area, so
    //    the busy rows may use H - gap - shelfH. Distribute the leftover to
    //    rows proportionally to their natural height. No leftover ⇒ no stretch
    //    (and NEVER shrink: that was the v11.1 squeeze the user rejected).
    //    v22 (user 2026-10-13): when the caller hands us block counts (`n`),
    //    each row may only grow to the height ALL its cards can still DIGEST
    //    (min cardUsefulH at the stretched widths) — past that the extra is a
    //    dead band under the blocks. Uncapped legacy callers keep the old
    //    proportional spread.
    var natTotal = gap;
    order.forEach(function (k) { natTotal += rowH[k]; });
    natTotal += gap * (order.length - 1);
    var shelfN = shelfRows(slimWidths || [], W, STRIP_GAP);
    var shelfH = shelfN > 0 ? shelfN * (STRIP_H + STRIP_VGAP) - STRIP_VGAP + STRIP_GAP : 0;
    var availH = Math.max(0, H - shelfH);
    var extraH = availH - natTotal;
    var capped = false;
    for (i = 0; i < sizes.length; i++) if (sizes[i] && sizes[i].n > 0) { capped = true; break; }
    if (extraH > 0) {
      if (capped) {
        var wants = {}, wantSum = 0;
        order.forEach(function (k) {
          var cap = Infinity;
          rows[k].forEach(function (j) {
            var s = sizes[j];
            var c = s && s.n > 0 ? cardUsefulH(s.n, lay[j].w) : lay[j].h;
            if (c < cap) cap = c;
          });
          wants[k] = Math.max(0, Math.round(Math.max(cap, rowH[k]) - rowH[k]));
          wantSum += wants[k];
        });
        var wratio = wantSum > 0 ? Math.min(1, extraH / wantSum) : 0;
        order.forEach(function (k) { rowH[k] += Math.round(wants[k] * wratio); });
      } else {
        var usedH = 0;
        order.forEach(function (k, t) {
          var add = t === order.length - 1 ? extraH - usedH : Math.floor(extraH * (rowH[k] / natTotal));
          usedH += add;
          rowH[k] += add;
        });
      }
    }
    // 3) re-stack BOTH axes: the widths above changed, so the row's x chain has
    //    to be rebuilt too (v14 first cut kept hugPack's natural x and the
    //    stretched cards overlapped — caught by the unit layer), and after any
    //    rounding y is RE-STACKED, never scaled (v13 lesson: scaling
    //    coordinates after a floor() makes rows overlap).
    var y = gap;
    order.forEach(function (k) {
      var x = gap;
      rows[k].forEach(function (j) {
        lay[j].x = x; lay[j].y = y; lay[j].h = rowH[k];
        x += lay[j].w + gap;
      });
      y += rowH[k] + gap;
    });
    return lay;
  }

  // v11.1: one plan for the whole wall (top 自动排列 + the unstored default
  // slots). v13: busy cards take their HUG size (content-driven, column-first
  // grids), pack row-first top-aligned. v14: the hug rows are then STRETCHED
  // to fill the screen (fillWall) — cards edge-to-edge, free height shared.
  // `slimWidths` is the shelf strips' widths (manual strip resize wins).
  function wallPlan(W, H, fullSizes, slimWidths) {
    fullSizes = fullSizes || [];
    slimWidths = slimWidths || [];
    // v22: busy area = SKYLINE (every card at its content-hug size, pockets
    // filled — see skyPack). fillWall's uniform-row + stretch stays exported
    // for legacy unit probes but no longer shapes the wall.
    var busy = skyPack(fullSizes, W, PGAP);
    var shelfRowsN = shelfRows(slimWidths, W, STRIP_GAP);
    var shelfH = shelfRowsN > 0 ? shelfRowsN * (STRIP_H + STRIP_VGAP) - STRIP_VGAP + STRIP_GAP : 0;
    // v13.1: NO height squeeze — the user asked for blocks as large as possible,
    // so hug heights are final and a crowded wall simply scrolls (v11.1's
    // fit-without-scrolling squeeze is what made blocks tiny at 16 profiles).
    void shelfH;
    var busyBottom2 = PGAP;
    busy.forEach(function (r) { busyBottom2 = Math.max(busyBottom2, r.y + r.h); });
    var shelf = shelfPack(slimWidths, W, busyBottom2 + STRIP_GAP, STRIP_H, STRIP_GAP, STRIP_VGAP);
    return { busy: busy, shelf: shelf, busyBottom: busyBottom2 };
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
      // callers pass either bare rects or {id, rect} wrappers (othersOf);
      // reading through the wrapper used to yield NaN and SILENTLY drop every
      // neighbour candidate — the magnet then only saw canvas edges (v11 found
      // this when a row-first gap of 6.5px beat a neighbour edge of 1px)
      var r = rects[i] && rects[i].rect ? rects[i].rect : rects[i];
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

  // ── v16 (user 2026-10-12): 组内列优先，折叠沉底，两轴余量都喂给内容 ────
  // The weighted treemap tiled EVERY member of a group side by side, so a
  // six-member group squeezed busy cards into narrow ribbons and the blocks
  // in them became unreadable (real board 2026-10-12). New contract inside a
  // group body of W×H: busy members (meta = their hug size) stack
  // COLUMN-FIRST — fill column 1 top-to-bottom, then column 2 — and BOTH
  // leftover axes go to the content: every column shares the full width, and
  // leftover height in a column grows its cards (v15/v15.1 ktfEffGeo then
  // widens or packs the blocks inside). Slim members never tile in between:
  // their strips pack tight at the BOTTOM of the body, exactly like the wall
  // shelf. `gap` is the busy gutter; strips keep STRIP_GAP.
  function colPackSlots(meta, W, H, gap) {
    var n = meta.length, out = new Array(n), busy = [], slim = [], i;
    for (i = 0; i < n; i++) {
      var m = meta[i];
      if (!m) continue;
      if (m.slim) slim.push({ i: i, sw: Math.max(90, Math.min(m.sw || 160, W)) });
      else busy.push({ i: i, w: Math.max(120, m.w), h: Math.max(46, m.h) });
    }
    var stripArea = 0, stripSlots = [];
    if (slim.length) {
      stripSlots = shelfPack(slim.map(function (s) { return s.sw; }), W, 0, STRIP_H_IN, STRIP_GAP, STRIP_VGAP);
      stripSlots.forEach(function (r) { stripArea = Math.max(stripArea, r.y + r.h); });
    }
    var availH = Math.max(60, H - (stripArea ? stripArea + gap : 0));
    var cols = [], cur = [], cy = 0;
    for (i = 0; i < busy.length; i++) {
      var bh = Math.min(busy[i].h, availH);
      if (cur.length && cy + bh > availH) { cols.push(cur); cur = []; cy = 0; }
      cur.push({ idx: busy[i].i, w: busy[i].w, h: bh });
      cy += bh + gap;
    }
    if (cur.length) cols.push(cur);
    var nC = cols.length;
    if (nC) {
      var colW = cols.map(function (c) { var mx = 0; c.forEach(function (it) { mx = Math.max(mx, it.w); }); return mx; });
      var sumW = 0; colW.forEach(function (x) { sumW += x; }); sumW += gap * (nC - 1);
      var scale = sumW > W ? W / sumW : 1;
      var share = scale < 1 ? 0 : (W - sumW) / nC;
      var xx = 0;
      cols.forEach(function (c, ci) {
        var cw = Math.max(120, Math.round(colW[ci] * scale + share));
        var usedH = 0; c.forEach(function (it) { usedH += it.h; });
        usedH += gap * (c.length - 1);
        var extra = Math.max(0, availH - usedH);
        var yy = 0;
        c.forEach(function (it) {
          var hh = Math.round(it.h + (usedH > 0 ? extra * it.h / usedH : 0));
          out[it.idx] = { x: Math.round(xx), y: Math.round(yy), w: cw, h: Math.max(46, hh) };
          yy += hh + gap;
        });
        xx += cw + gap;
      });
    }
    stripSlots.forEach(function (r, si) {
      out[slim[si].i] = { x: r.x, y: Math.round(H - stripArea + r.y), w: r.w, h: r.h };
    });
    var contentW = 0, contentH = 0;
    for (i = 0; i < n; i++) if (out[i]) { contentW = Math.max(contentW, out[i].x + out[i].w); contentH = Math.max(contentH, out[i].y + out[i].h); }
    return { rects: out, contentW: contentW, contentH: contentH };
  }

  // the group CONTAINER's own hug size for the wall: column-first greedy at
  // natural widths (no stretch — fillWall grows the card afterwards anyway),
  // strips flow underneath inside that width, chrome pads on top.
  function groupHugSize(meta, budget, Wmax) {
    var busy = [], slim = [], i;
    for (i = 0; i < meta.length; i++) {
      var m = meta[i];
      if (!m) continue;
      if (m.slim) slim.push(Math.max(90, m.sw || 160));
      else busy.push({ w: Math.max(120, m.w), h: Math.max(46, m.h) });
    }
    var availH = Math.max(120, budget || 420);
    var cols = [], cur = [], cy = 0;
    for (i = 0; i < busy.length; i++) {
      var bh = Math.min(busy[i].h, availH);
      if (cur.length && cy + bh > availH) { cols.push(cur); cur = []; cy = 0; }
      cur.push({ w: busy[i].w, h: bh });
      cy += bh + INNER_PAD;
    }
    if (cur.length) cols.push(cur);
    var bodyW = 0, bodyH = 0;
    cols.forEach(function (c, ci) {
      var mx = 0, st = 0;
      c.forEach(function (it) { mx = Math.max(mx, it.w); st += it.h; });
      st += INNER_PAD * (c.length - 1);
      bodyW += mx + (ci ? INNER_PAD : 0);
      bodyH = Math.max(bodyH, st);
    });
    if (slim.length) {
      var sr = shelfPack(slim, Math.max(1, bodyW), 0, STRIP_H_IN, STRIP_GAP, STRIP_VGAP), sa = 0;
      sr.forEach(function (r) { sa = Math.max(sa, r.y + r.h); });
      if (sa) { bodyH += INNER_PAD + sa; bodyW = Math.max(bodyW, (function () { var mxw = 0; sr.forEach(function (r) { mxw = Math.max(mxw, r.x + r.w); }); return mxw; })()); }
    }
    return {
      w: clamp(Math.round(bodyW + 2 * GBODY_PAD), GMIN_W, Math.max(GMIN_W + 1, Wmax || 900)),
      h: clamp(Math.round(bodyH + GHEAD + GBODY_PAD), GMIN_H, 2000)
    };
  }

  // slot plan + manual overrides, v16 style: stored (manual) member rects win,
  // the rest take the column-first pack; freeSpot keeps the no-overlap promise
  // when a manual rect lands where a packed card would have gone.
  function innerLayoutV16(toks, stored, body, meta, gap) {
    gap = gap == null ? INNER_PAD : gap;
    stored = stored || {};
    var slots = colPackSlots(meta, body.w, body.h, gap).rects;
    var out = {}, claimed = [], i, avail = [];
    for (i = 0; i < slots.length; i++) if (slots[i]) avail.push(slots[i]);
    for (i = 0; i < toks.length; i++) if (stored[toks[i]]) claimed.push(clampInnerRect(stored[toks[i]], body));
    for (i = 0; i < toks.length; i++) {
      var t = toks[i], r = stored[t] ? clampInnerRect(stored[t], body) : null;
      if (!r) {
        r = freeSpot(slots[i] || { x: gap, y: gap, w: Math.max(60, Math.min(IMIN_W, body.w)), h: Math.max(46, Math.min(IMIN_H, body.h)) }, avail, claimed, body, gap);
        // v16.1: freeSpot's last resort returns the CLAMPED WANT, which can
        // still bite into a full-height manual card (caught by the v7 rerun:
        // jl-qa overlapped jl-launch by 39px next to a manual strip). Carve
        // the slot against every overlapping claim along both axes and keep
        // the largest survivor; only then fall back.
        if (hasOverlap(r, claimed)) r = carveAround(r, claimed, body, gap) || r;
      }
      out[t] = r;
      claimed.push(r);
    }
    return out;
  }

  // edge-carve for a crowded group body: for each claim crossing `want`, the
  // right-of / left-of / below / above remainders are candidates; pick the
  // biggest that fits and touches nothing. null when nothing survives.
  function carveAround(want, claimed, body, gap) {
    var cands = [], i, best = null;
    for (i = 0; i < claimed.length; i++) {
      var c = claimed[i];
      if (!overlaps(want, c)) continue;
      cands.push({ x: c.x + c.w + gap, y: want.y, w: want.x + want.w - (c.x + c.w + gap), h: want.h });
      cands.push({ x: want.x, y: want.y, w: c.x - gap - want.x, h: want.h });
      cands.push({ x: want.x, y: c.y + c.h + gap, w: want.w, h: want.y + want.h - (c.y + c.h + gap) });
      cands.push({ x: want.x, y: want.y, w: want.w, h: c.y - gap - want.y });
    }
    for (i = 0; i < cands.length; i++) {
      var q = clampInnerRect({ x: Math.max(0, cands[i].x), y: Math.max(0, cands[i].y), w: cands[i].w, h: cands[i].h }, body);
      if (q.w < 60 || q.h < 46) continue;
      if (hasOverlap(q, claimed)) continue;
      if (!best || q.w * q.h > best.w * best.h) best = q;
    }
    return best;
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
    // v18b (v7/v13 probes): EVERY card is an obstacle — a shoved neighbour
    // may never land on a card that was not overlapping the original rect
    // (the old code only avoided the mover + already-moved spots, so pushes
    // into a third card went unnoticed and the wall ended up overlapped).
    others.forEach(function (o) { placed.push(o.rect); });
    var byId = {};
    others.forEach(function (o) { byId[o.id] = o.rect; });
    others.slice().sort(function (a, b) {
      return (Math.abs(a.rect.x - rect.x) + Math.abs(a.rect.y - rect.y)) -
             (Math.abs(b.rect.x - rect.x) + Math.abs(b.rect.y - rect.y));
    }).forEach(function (o) {
      if (!hasOverlap(o.rect, placed.filter(function (p) { return p !== byId[o.id]; }))) return;
      var spot = nearestFree(o.rect, placed, grid);
      moves[o.id] = spot;
      placed = placed.filter(function (p) { return p !== byId[o.id]; }).concat([spot]);
      byId[o.id] = spot;
    });
    return moves;
  }

  function insideRect(rect, pt) {
    return pt.x >= rect.x && pt.x <= rect.x + rect.w && pt.y >= rect.y && pt.y <= rect.y + rect.h;
  }

  // ─────────────────────────── node rendering ───────────────────────────
  function renderNode(n, pos, G, opts) {
    // v17 (user): a block may carry a MANUAL SIZE (pos.w/h from a corner
    // drag). Everything derives from it: title wraps to the width, the meta
    // row hugs the bottom border, extra height just becomes breathing room.
    var W = (pos.w && pos.w >= 60) ? pos.w : G.W;
    var H = (pos.h && pos.h >= 36) ? pos.h : G.H;
    var units = Math.max(10, Math.round(G.UNITS * W / G.W));
    var lines = wrapTitle(n.title, units);
    // v21 fix (live v8 red): the meta/pill band sits at MY — the old maxLines
    // formula only guarded the block BOTTOM, so a second title line slid under
    // the provider chip (measured ~7px overlap on v16-tall blocks). Reserve the
    // band: last allowed baseline = MY - cf - 2.
    var cf = G.UNITS >= 28 ? 9.5 : 8;
    var MY = Math.min(G.MY + (H - G.H), H - 7);
    var maxLines = Math.max(1, Math.floor((MY - cf - 2 - G.TY) / G.DY) + 1);
    if (lines.length > maxLines) {
      lines = lines.slice(0, maxLines);
      lines[maxLines - 1] = lines[maxLines - 1].replace(/\u2026*$/, "") + "\u2026";
    }
    var tspans = lines.map(function (ln, i) {
      return h("tspan", { key: i, x: G.PAD, dy: i === 0 ? 0 : G.DY }, ln);
    });
    var cls = "kg-node kg-s-" + n.status + (opts.cls || "");
    var props = { key: n.id, className: cls, transform: "translate(" + pos.x + "," + pos.y + ")" };
    if (opts.handlers) {
      props.onPointerDown = opts.handlers.onPointerDown;
      props.onClick = opts.handlers.onClick;
    }
    var barY = Math.round(H * 0.18);
    var meta = String(opts.metaOf ? (opts.metaOf(n) || "") : (n.assignee || "—"));
    var stTxt = (ICON[n.status] || "●") + " " + (LABEL[n.status] || n.status);
    var mf = G.UNITS >= 28 ? 11 : 9, sf = G.UNITS >= 28 ? 10.5 : 8.8;
    // ★ keep cf in step with .kg-node .kg-mtag / .kg-mini .kg-mtag in style.css
    // the API provider/model chip (nodes carry tag/tagFull/tagColor from the graph api)
    var tag = n.tag ? String(n.tag) : "";
    var tagW = tag ? Math.round(textPx(tag, cf)) + 10 : 0;
    var metaX = G.PAD + (tagW ? tagW + 6 : 0);
    var avail = W - 12 - textPx(stTxt, sf) * 1.14 - 5 - metaX;
    var metaTxt = "";
    if (avail > 12) {
      metaTxt = takePx(meta, avail, mf);
      if (metaTxt.length < meta.length) metaTxt = takePx(meta, Math.max(0, avail - textPx("\u2026", mf)), mf) + "\u2026";
    }
    var chroma = n.tagColor || "#9ca3af";
    var chip = tag ? h("g", { key: "tag" },
      h("rect", {
        className: "kg-mpill", x: G.PAD, y: MY - cf + 1, width: tagW, height: cf + 2.6, rx: 3,
        fill: chroma, fillOpacity: 0.15, stroke: chroma, strokeOpacity: 0.34, strokeWidth: 0.7
      }),
      h("text", { className: "kg-mtag", x: G.PAD + 5, y: MY - 1, fill: chroma }, tag)) : null;
    return h("g", props,
      h("title", null, (n.oid || n.id) + " · " + (LABEL[n.status] || n.status) + " · " + (n.assignee || "—") +
        (n.tagFull ? " · " + n.tagFull : "")),
      n.status === "running"
        ? h("g", { key: "cmt" },
            h("path", { className: "kg-comet-tail", d: opts.comet, pathLength: 100 }),
            h("path", { className: "kg-comet", d: opts.comet, pathLength: 100 }))
        : null,
      h("rect", { className: "kg-box", x: 0, y: 0, width: W, height: H, rx: G.RAD }),
      h("rect", { className: "kg-bar", x: 0, y: barY, width: 4, height: H - 2 * barY, rx: 2 }),
      h("text", { className: "kg-title", x: G.PAD, y: G.TY }, tspans),
      chip,
      metaTxt ? h("text", { className: "kg-asg", x: metaX, y: MY }, metaTxt) : null,
      h("text", { className: "kg-st", x: W - 12, y: MY, "text-anchor": "end" }, stTxt),
      // v17 resize handle: a corner grip that keeps a constant SCREEN size
      // (opts.hsz is already units = px/scale from the card component)
      opts.handlers && opts.handlers.onResizeDown ? h("rect", {
        className: "kg-bres", x: W - opts.hsz, y: H - opts.hsz,
        width: opts.hsz, height: opts.hsz, rx: 1.5,
        onPointerDown: opts.handlers.onResizeDown
      }) : null
    );
  }

  // ── v17 (user 2026-10-12): adaptive anchors + straight/curve edge paths ──
  // Anchors follow the RELATIVE position of the two blocks instead of the old
  // fixed right→left pair: a column stacks its chain bottom→top, a row links
  // left→right, and a pair that crosses rows AND columns exits/enters through
  // the facing edges. Aligned pairs get a dead-straight segment (auto-arrange
  // stays tidy); crossing pairs get either a clean 3-segment elbow ("straight")
  // or an eased cubic whose controls leave along the anchor normals ("curve"),
  // so lines arc around the grid instead of skating over the blocks.
  function edgeAnchors(p, c) {
    var pcx = p.x + p.w / 2, pcy = p.y + p.h / 2;
    var ccx = c.x + c.w / 2, ccy = c.y + c.h / 2;
    var dx = ccx - pcx, dy = ccy - pcy;
    var rowB = Math.max(p.h, c.h) * 0.6, colB = Math.max(p.w, c.w) * 0.6;
    var sameCol = Math.abs(dx) <= colB && Math.abs(dy) > rowB;
    var sameRow = !sameCol && Math.abs(dy) <= rowB && Math.abs(dx) > colB;
    var aligned = sameCol || sameRow;
    var a, b, na, nb;
    // vertical link when ALIGNED in a column, or when a crossing pair is
    // dominated by its vertical offset; horizontal otherwise
    if ((aligned && sameCol) || (!aligned && Math.abs(dy) >= Math.abs(dx))) {
      var sy = dy > 0 ? 1 : -1;
      a = { x: pcx, y: pcy + sy * p.h / 2 }; b = { x: ccx, y: ccy - sy * c.h / 2 };
      na = { x: 0, y: sy }; nb = { x: 0, y: -sy };
    } else {
      var sx = dx > 0 ? 1 : -1;
      a = { x: pcx + sx * p.w / 2, y: pcy }; b = { x: ccx - sx * c.w / 2, y: ccy };
      na = { x: sx, y: 0 }; nb = { x: -sx, y: 0 };
    }
    return { a: a, b: b, na: na, nb: nb, same: aligned, dist: Math.hypot(b.x - a.x, b.y - a.y) };
  }
  function edgePathGeo(p, c) {
    var A = edgeAnchors(p, c);
    var r2 = function (v) { return Math.round(v * 100) / 100; };
    var seg = "M " + r2(A.a.x) + " " + r2(A.a.y);
    if (A.same) return seg + " L " + r2(A.b.x) + " " + r2(A.b.y);
    var k = Math.max(16, A.dist * 0.42);
    return seg + " C " + r2(A.a.x + A.na.x * k) + " " + r2(A.a.y + A.na.y * k) +
      ", " + r2(A.b.x + A.nb.x * k) + " " + r2(A.b.y + A.nb.y * k) +
      ", " + r2(A.b.x) + " " + r2(A.b.y);
  }

  // dimOne(e) => true hides the edge's emphasis (selection neighbourhood)
  // v18 (user 2026-10-12): ONE edge style — curve. Same-row/col pairs get a
  // dead-straight segment between the facing edges; anything crossing rows and
  // columns arcs around the grid. The old straight/lane router is retired.
  function renderEdges(model, view, hideSt, marker, dimOne) {
    var out = [];
    if (!(model.edges.length || model.backEdges.length)) return out;
    var G = model.geo || GEO_MAIN;
    function one(e, back, idx) {
      var p = view.placed.get(e.parent), c = view.placed.get(e.child);
      if (!p || !c) return null;
      var pn = model.nodeMap.get(e.parent), cn = model.nodeMap.get(e.child);
      if (fitsHide(pn, hideSt) || fitsHide(cn, hideSt)) return null;
      // relative-position anchors; sizes ride the placed entry when a block
      // was manually resized, else the lattice box.
      var pp = { x: p.x, y: p.y, w: p.w || G.W, h: p.h || G.H };
      var cc = { x: c.x, y: c.y, w: c.w || G.W, h: c.h || G.H };
      var dim0 = dimOne && dimOne(e);
      return h("path", {
        key: (back ? "b" : "e") + idx,
        className: "kg-edge kg-curve" + (back ? " kg-back" : "") + (dim0 ? " kg-dim" : ""),
        d: edgePathGeo(pp, cc),
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

    var fitView = useCallback(function (up) {
      var el = containerRef.current, mdl = viewRef.current, scale = 1;
      if (el && mdl && mdl.width > 0 && mdl.height > 0) {
        var rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          // v20.1 (user: 全屏右侧留白): inside fullscreen allow a gentle
          // upscale (cap 1.6x) so the graph spreads into the bigger frame;
          // normal 适配 keeps the old never-above-1:1 semantics.
          var capUp = up === true ? 1.6 : 1;
          scale = clamp(Math.min(capUp, (rect.width - 16) / mdl.width, (rect.height - 16) / mdl.height), MIN_ZOOM, MAX_ZOOM);
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

    // v20: entering/leaving fullscreen jumps the viewport size — re-fit so the
    // graph fills the screen instead of sticking to the pre-fullscreen frame
    useEffect(function () {
      function onFs() { setTimeout(function () { fitView(!!document.fullscreenElement); }, 60); }
      document.addEventListener("fullscreenchange", onFs);
      return function () { document.removeEventListener("fullscreenchange", onFs); };
    }, [fitView]);

    // per-board manual positions ride on the board switch.
    // v21: read verbatim — the old snapCell "normalisation" re-snapped EVERY
    // stored position on every board switch/reload, so precisely parked
    // blocks jumped to the lattice behind the user's back. No rewrite here.
    useEffect(function () {
      var raw = readPos(board), fixed = {};
      Object.keys(raw).forEach(function (k) {
        var q = raw[k];
        fixed[k] = { x: Math.max(0, q.x), y: Math.max(0, q.y) };
      });
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
          // v21 (user 2026-10-13): release keeps the tracked position — the
          // magnet in move() already snapped it when close to the lattice.
          // The old forced nearest-cell settle + downward yield moved the block
          // away from where the pointer left it and re-flowed siblings.
          var cur = (posOvRef.current || {})[d.id] || { x: d.ox, y: d.oy };
          var fp = { x: Math.max(0, cur.x), y: Math.max(0, cur.y) };
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
        fitView(!!document.fullscreenElement);
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
      h("span", { className: "kg-brand" }, "Board+"),
      modeSwitch(props),
      h("select", { className: "kg-native-sel", value: board || boardList[0].slug, onChange: function (e) { onSelectBoard(e.target.value); } },
        boardList.map(function (b) { return h("option", { key: b.slug, value: b.slug }, b.title || b.slug); })),
      h(Button, { size: "sm", variant: "outline", onClick: props.onReload }, "刷新"),
      h(Button, { size: "sm", variant: "outline", onClick: fitView }, "适配"),
      h(Button, { size: "sm", variant: "outline", onClick: onAutoLayout }, "自动排列"),
      h(Button, {
        size: "sm", variant: gridOn ? "default" : "outline",
        title: "拖动时显示参考格子（节点按 " + CELL_W + "×" + CELL_H + "px 格吸附）",
        onClick: function () { var v = !gridOn; setGridOn(v); lsSet(LS_GRID, v ? "1" : "0"); }
      }, "网格"),
      h(Button, {
        size: "sm", variant: "outline", title: "全屏：隐藏其他信息，只显示卡片区域（Esc 退出）",
        onClick: props.onFsToggle
      }, "全屏"),
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
  // module-level twin of the in-component decision (exported for unit tests;
  // MultiProfileView calls the identical logic)
  function wakeGroupsSlim(prev, cur, gcfg) {
    var out = [], k;
    for (k in cur) {
      if (!cur.hasOwnProperty(k)) continue;
      if (prev[k] !== 1 || cur[k] !== 0) continue;
      var gid = k.slice(0, k.indexOf("/"));
      if (out.indexOf(gid) >= 0) continue;
      for (var i = 0; i < gcfg.length; i++) {
        if (gcfg[i].id === gid && gcfg[i].inner && Object.keys(gcfg[i].inner).length) { out.push(gid); break; }
      }
    }
    return out;
  }

  function PanelBody(props) {
    var s, p = props.panel;
    var cap = props.big ? MINI_SCALE_MAX_BIG : MINI_SCALE_MAX;
    var scale = 1;
    s = useState({ w: 0, h: 0 }); var size = s[0], setSize = s[1];
    s = useState(function () { return readMiniPos(props.pid); }); var ov = s[0], setOv = s[1];
    s = useState(false); var ndrag = s[0], setNdrag = s[1];
    var ref = useRef(null);
    var ovRef = useRef(ov); ovRef.current = ov;
    var ndRef = useRef(null);
    var dragPinRef = useRef(null);
    // v17 FIX (top-left-drop probe, 10-12): dragging ONE block changes the
    // recomputed truth on the next live reload (300ms), which used to flip the
    // card between column counts / widened lattices MID-gesture — the drop then
    // clamped against geometry the user never saw. Freeze the model/size inputs
    // for the duration of a gesture (same trick as the wall's frozenRef).
    if (!ndrag) dragPinRef.current = null;
    var pin = ndrag
      ? (dragPinRef.current || (dragPinRef.current =
          { model: p.model, group: p.group, w: size.w, h: size.h, cap: cap }))
      : { model: p.model, group: p.group, w: size.w, h: size.h, cap: cap };

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

    // v15 (user 2026-10-12): the block grid RE-FITS to the card. Once fillWall
    // stretched a card the height fit governed scale and blocks left a side
    // margin — ktfEffGeo hands that leftover to the block width itself (aspect
    // guarded). Width-governed cards keep the base lattice, as before.
    var eff = useMemo(function () {
      return ktfEffGeo(pin.model.nodeMap.size, pin.w, pin.h, pin.cap);
    }, [pin.model, pin.w, pin.h, pin.cap]);
    var G = eff.geo;
    var mdl = useMemo(function () {
      if (!eff.changed) return pin.model;
      return buildModel({ nodes: pin.group.nodes, edges: pin.group.edges, back_edges: pin.group.backEdges }, true, eff.geo, { cols: eff.cols });
    }, [pin.model, eff, pin.group]);
    var cometMini = eff.changed ? cometD(G) : COMET_D_MINI;

    // the drawing area is pinned to the *auto* layout box (not the live view box)
    // so dragging a block never rescales the whole card mid-gesture
    var vw = Math.max(1, mdl.width), vh = Math.max(1, mdl.height);
    if (pin.w > 4 && pin.h > 4) {
      scale = clamp(Math.min((pin.w - 4) / vw, (pin.h - 4) / vh), MINI_SCALE_MIN, pin.cap);
    }
    var scaleRef = useRef(scale); scaleRef.current = scale;
    // v10: the canvas is the CARD, not the content bbox — blocks may be parked
    // anywhere inside the card and are clamped so they never cross its border.
    var cw = pin.w > 8 ? Math.max(vw, (pin.w - 4) / scale) : vw;
    var ch = pin.h > 8 ? Math.max(vh, (pin.h - 4) / scale) : vh;
    // v14 (user 2026-10-12): the lattice stays horizontally centred, but the
    // grid TOP-ALIGNS vertically. Once cards stretch to fill the screen a card
    // with few blocks has more height than its own aspect can use — centring
    // that leftover made the blocks float in mid-air with blank ABOVE them
    // (flagged by the screenshot review); pinned to the top it reads as a
    // normal list, and the freed space below becomes parkable room for
    // manually dragged blocks (blockBoxOf grows with offY=0).
    var offX = (cw - vw) / 2, offY = 0;
    var view = useMemo(function () {
      var box = blockBoxOf(cw, ch, offX, offY, G), o2 = null, kk, q;
      if (ov) {
        o2 = {};
        for (kk in ov) {
          q = ov[kk];
          if (!q) continue;
          // v17: manual size rides along; the right/bottom border clamp uses
          // the block's OWN size so a grown block cannot hang off the card.
          var qw = (q.w && q.w >= 60) ? q.w : G.W;
          var qh = (q.h && q.h >= 36) ? q.h : G.H;
          o2[kk] = { x: clamp(q.x, box.x0, Math.max(box.x0, cw - offX - qw)),
                     y: clamp(q.y, box.y0, Math.max(box.y0, ch - offY - qh)),
                     w: q.w, h: q.h };
        }
      }
      return buildView(mdl, o2);
    }, [mdl, ov, cw, ch, offX, offY]);
    var viewRef = useRef(view); viewRef.current = view;
    var boxRef = useRef(null);
    boxRef.current = blockBoxOf(cw, ch, offX, offY, G);
    function blockBox() { return boxRef.current; }

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
        // v17: corner-grip resize — the block grows/shrinks in place; its x/y
        // stay where they are and the view-merge clamp keeps it inside the card.
        if (d.mode === "res") {
          var nw = clamp(Math.round((d.ow + ddx / z) / 2) * 2, Math.round(G.W * 0.6), G.W * 4);
          var nh = clamp(Math.round((d.oh + ddy / z) / 2) * 2, Math.round(G.H * 0.6), G.H * 4);
          if (d.last && d.last.w === nw && d.last.h === nh) return;
          d.last = { w: nw, h: nh };
          var q0 = (ovRef.current || {})[d.id] || { x: d.ox, y: d.oy };
          var nres = Object.assign({}, ovRef.current);
          nres[d.id] = { x: q0.x, y: q0.y, w: nw, h: nh };
          ovRef.current = nres;
          setOv(nres);
          return;
        }
        var fx = d.ox + ddx / z, fy = d.oy + ddy / z;
        var gx = snapCell({ x: fx, y: fy }, G);
        if (Math.abs(fx - gx.x) <= MAGNET) fx = gx.x;
        if (Math.abs(fy - gx.y) <= MAGNET) fy = gx.y;
        var box = blockBox();
        fx = clamp(fx, box.x0, box.x1); fy = clamp(fy, box.y0, box.y1);
        if (d.last && d.last.x === fx && d.last.y === fy) return;
        d.last = { x: fx, y: fy };
        var nxt = Object.assign({}, ovRef.current);
        // v21: a move gesture must NOT discard a manual resize — carry w/h.
        var q1 = nxt[d.id];
        var np = { x: fx, y: fy };
        if (q1 && q1.w) np.w = q1.w;
        if (q1 && q1.h) np.h = q1.h;
        nxt[d.id] = np;
        ovRef.current = nxt;
        setOv(nxt);
      }
      function up() {
        var d = ndRef.current;
        setNdrag(false);
        if (!d || !d.moved) return;
        // v17: a resize gesture just persists as-is — no lattice settle, the
        // block keeps its shape and spot.
        if (d.mode === "res") {
          var o1 = {};
          viewRef.current.placed.forEach(function (q, id) {
            var v = (ovRef.current || {})[id];
            if (v) o1[id] = v;
            void q;
          });
          writeMiniPos(props.pid, o1);
          return;
        }
        var box = blockBox();
        var cur = (ovRef.current || {})[d.id] || { x: d.ox, y: d.oy };
        // v21 (user 2026-10-13): the drop STAYS where the pointer left it —
        // clamped to the card border, nothing else. The old collision hop
        // spiralled the block to the "nearest free cell", so the user could
        // never park a block exactly where they wanted. Overlaps are allowed
        // by design now; "自动排列" re-tidies the card on command.
        var fp = { x: clamp(cur.x, box.x0, box.x1), y: clamp(cur.y, box.y0, box.y1) };
        if (cur.w) fp.w = cur.w;
        if (cur.h) fp.h = cur.h;
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

    // v17: corner grip — grow/shrink this block (persisted with the position)
    function onBlockResizeDown(n, e) {
      if (e.pointerType === "mouse" && e.button != null && e.button !== 0) return;
      var cur = viewRef.current.placed.get(n.id);
      if (!cur) return;
      e.stopPropagation();
      e.preventDefault();
      ndRef.current = { id: n.id, mode: "res", sx: e.clientX, sy: e.clientY,
                        ox: cur.x, oy: cur.y, ow: cur.w || G.W, oh: cur.h || G.H, moved: false };
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
        },
        onResizeDown: function (e) { onBlockResizeDown(n, e); }
      };
    }
    var kids = [];
    if (pin.group.nodes.length) {
      var defs = h("defs", { key: "d" },
        h("marker", {
          id: "kga-" + props.pid, viewBox: "0 0 10 10", refX: 9, refY: 5,
          markerWidth: 6, markerHeight: 6, orient: "auto-start-reverse"
        }, h("path", { className: "kg-arrow", d: "M 0 0 L 10 5 L 0 10 z" })));
      kids.push(defs);
      kids = kids.concat(renderEdges(mdl, view, props.hideSt, "kga-" + props.pid, ""));
      var ordered = [];
      mdl.nodeMap.forEach(function (n) { ordered.push(n); });
      ordered.forEach(function (n) {
        var pos = view.placed.get(n.id);
        if (!pos || fitsHide(n, props.hideSt)) return;
        kids.push(renderNode(n, pos, G, { cls: "", comet: cometMini, metaOf: props.metaOf, handlers: handlersFor(n), hsz: Math.max(4, Math.round(9 / (scale || 1))) }));
      });
      pin.group.nodes.forEach(function (n) {
        if (mdl.nodeMap.has(n.id)) return;
        var pos = view.placed.get(n.id);
        if (!pos || fitsHide(n, props.hideSt)) return;
        kids.push(renderNode(n, pos, G, { cls: " kg-uln", comet: cometMini, metaOf: props.metaOf, handlers: handlersFor(n), hsz: Math.max(4, Math.round(9 / (scale || 1))) }));
      });
    }
    var body;
    if (!pin.group.nodes.length) body = h("div", { className: "kg-pempty" }, "无任务");
    else if (view.placed.size === 0) body = h("div", { className: "kg-pempty" }, "仅剩已结历史");
    else body = h("div", { className: "kg-pfit" + (ndrag ? " kg-grabbing" : ""), style: { width: (cw * scale) + "px", height: (ch * scale) + "px" } },
          h("svg", {
            className: "kg-mini", width: cw * scale, height: ch * scale,
            viewBox: (-offX) + " " + (-offY) + " " + cw + " " + ch
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
    s = useState(function () { return readStripWs(scopeKey(props.scope)); }); var stripWs = s[0], setStripWs = s[1]; // v13 manual strip widths
    s = useState({}); var miniVer = s[0], setMiniVer = s[1];
    s = useState({ w: 1200, h: 640 }); var csize = s[0], setCsize = s[1];
    s = useState(null); var guides = s[0], setGuides = s[1];
    s = useState(null); var activeOp = s[0], setActiveOp = s[1];
    s = useState(""); var editG = s[0], setEditG = s[1]; // group id whose title is being renamed

    var boardRef = useRef(null);
    var editRef = useRef(null);
    var escRef = useRef(false); // Esc cancels: the blur that follows must not save
    var layoutRef = useRef(layout); layoutRef.current = layout;
    var stripWsRef = useRef(stripWs); stripWsRef.current = stripWs;
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
      setStripWs(readStripWs(k));
    }, [scope]);

    // v20.1 (user: 全屏时右侧留白): the pinned manual rects carry the OLD
    // viewport width — inside fullscreen the wall must spread to the bigger
    // board. On enter: snapshot this scope's layout and blank it, so every
    // card falls back to the auto-arrange default slots that fill the full
    // width. On exit: restore the snapshot; arrangement edits made inside
    // fullscreen are transient (the user's curated wall is never overwritten).
    var fsSnapRef = useRef(null);
    useEffect(function () {
      if (props.fsOn) {
        if (fsSnapRef.current === null) {
          fsSnapRef.current = layoutRef.current || {};
          setLayout({});
        }
        return;
      }
      if (fsSnapRef.current !== null) {
        var snap = fsSnapRef.current;
        fsSnapRef.current = null;
        setLayout(snap);
        writeLayout(keyRef.current, snap);
      }
    }, [props.fsOn]);

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

    // ── cards: group containers (recursively nested) + free profiles ──
    // v12 (user 2026-10-11): a group may sit INSIDE another group — dragging
    // group A onto group B makes A a member of B ("组合中的组合"). The store
    // keeps that as a "§"+gid token in B.members; `items` only lists the
    // TOP-LEVEL cards, each group item carries a resolved children tree.
    var nest = useMemo(function () {
      var cfgOf = {}, parentOf = {};
      gcfg.forEach(function (c) { cfgOf[c.id] = c; });
      // first-parent wins, and an edge that would CLOSE A CYCLE on the tree
      // built so far is ignored (the referenced group simply stays top-level;
      // cycles are impossible through the UI, this hardens restored stores)
      function ancIs(id, want) {
        var up = id;
        while (up) { if (up === want) return true; up = parentOf[up]; }
        return false;
      }
      gcfg.forEach(function (c) {
        c.members.forEach(function (m) {
          if (!isTok(m)) return;
          var gid = tokGid(m);
          if (!cfgOf[gid] || gid === c.id || parentOf[gid]) return;
          if (ancIs(gid, c.id) || ancIs(c.id, gid)) return;
          parentOf[gid] = c.id;
        });
      });
      var owner = {};   // profile name -> TOP-LEVEL gid that (transitively) holds it
      function walkOwner(c, depth, top) {
        c.members.forEach(function (m) {
          if (isTok(m)) { var ch = cfgOf[tokGid(m)]; if (ch && depth < NEST_MAX) walkOwner(ch, depth + 1, top); }
          else if (!owner[m]) owner[m] = top;
        });
      }
      gcfg.forEach(function (c) { if (!parentOf[c.id]) walkOwner(c, 0, c.id); });
      var visiting = {};
      function resolve(c, depth) {
        var kids = [];
        c.members.forEach(function (m) {
          if (isTok(m)) {
            var ch = cfgOf[tokGid(m)];
            if (!ch || depth >= NEST_MAX || visiting[ch.id] || parentOf[ch.id] !== c.id) return;
            visiting[ch.id] = 1;
            var sub = resolve(ch, depth + 1);
            delete visiting[ch.id];
            if (sub.length) kids.push({ kind: "group", cfg: ch, children: sub });
            return;
          }
          if (byName[m] && !hidden[m]) kids.push({ kind: "prof", prof: byName[m] });
        });
        return kids;
      }
      function visBlocks(k) {
        if (k.kind === "prof") { var pn = panels[k.prof.name]; return visibleBlocks(pn && pn.model, props.hideSt); }
        var n = 0; k.children.forEach(function (q) { n += visBlocks(q); });
        return n;
      }
      function kidName(k) { return k.kind === "prof" ? k.prof.name : k.cfg.name; }
      function orderKids(kids) {
        return kids.slice().sort(function (a, b) {
          var d = (visBlocks(b) > 0 ? 1 : 0) - (visBlocks(a) > 0 ? 1 : 0);
          if (d) return d;
          return nameCmp(kidName(a), kidName(b));
        });
      }
      function kidTok(k) { return k.kind === "prof" ? k.prof.name : GTOK + k.cfg.id; }
      // weight for the weighted treemap: profiles by own blocks, nested
      // groups by the TOTAL under them (capped like profWeight saturates)
      function kidWeight(k) { return profWeight(visBlocks(k)); }
      function collectProfs(kids, out) {
        out = out || [];
        kids.forEach(function (k) { if (k.kind === "prof") out.push(k.prof); else collectProfs(k.children, out); });
        return out;
      }
      var out = [], seen = {};
      visible.forEach(function (g) {
        var gid = owner[g.name];
        if (!gid) { out.push({ id: g.name, kind: "prof", prof: g }); return; }
        if (seen[gid]) return;
        seen[gid] = 1;
        var cfg = cfgOf[gid];
        if (!cfg) { out.push({ id: g.name, kind: "prof", prof: g }); return; }
        var kids = orderKids(resolve(cfg, 0));
        if (!kids.length) return;
        out.push({ id: GKEY + gid, kind: "group", cfg: cfg, children: kids });
      });
      return { items: out, cfgOf: cfgOf, parentOf: parentOf, visBlocks: visBlocks, kidTok: kidTok, kidWeight: kidWeight, kidName: kidName, orderKids: orderKids, collectProfs: collectProfs };
    }, [visible, gcfg, byName, hidden, panels, props.hideSt]);
    var items = nest.items;
    // debug handle (harmless; headless probes assert through this)
    window.__KG_NEST__ = { parentOf: nest.parentOf, items: items.map(function (i) { return i.id; }), byName: Object.keys(byName) };

    // v16: natural-size metadata for one group child — busy profile cards
    // report their HUG box, collapsed ones their strip width, nested groups
    // recurse through groupHugSize. Feeds colPackSlots / groupHugSize.
    function kidMeta(k) {
      if (k.kind === "prof") {
        var pn = panels[k.prof.name];
        if (visibleBlocks(pn && pn.model, props.hideSt) === 0) {
          var tok = nest.kidTok(k), manW = stripWs[tok] ? Math.max(STRIP_RESIZE_MIN, stripWs[tok]) : 0;
          return { slim: 1, sw: manW || stripW(k.prof.name) };
        }
        var m = pn && pn.model;
        var sz = (m && (m.width > 0 || m.height > 0)) ? cardHugSize(m.width, m.height) : { w: PDEF_W, h: PDEF_H };
        return { w: sz.w, h: sz.h };
      }
      if (nest.visBlocks(k) === 0) return { slim: 1, sw: stripW(nest.kidName(k)) };
      return groupHugSize(k.children.map(kidMeta), Math.max(300, csizeRef.current.h - 140), Math.max(420, csizeRef.current.w - 80));
    }

    // stored (manual) rects win; anything without one takes the first free slot
    // v10: a profile card that paints no blocks renders as a title-row strip;
    // stored rects are never rewritten, so it expands back the moment a block
    // appears. An expanded card is never shorter than the minimum panel height
    // (a strip row persisted by 自动排列 must not clip real content).
    function effRect(id, r) {
      var it = null;
      for (var z = 0; z < items.length; z++) if (items[z].id === id) { it = items[z]; break; }
      if (!it || it.kind !== "prof" || !r) return r;
      var pn = panels[it.prof.name];
      // v12: a collapsed strip shrinks to CONTENT width too (storage keeps the
      // expanded width untouched, so it grows straight back on re-entry)
      // v13: a manual strip width (dragged on the shelf) wins over content width
      if (visibleBlocks(pn && pn.model, props.hideSt) !== 0)
        return { x: r.x, y: r.y, w: r.w, h: Math.max(r.h, PMIN_H) };
      var w = stripWs[id] ? Math.max(STRIP_RESIZE_MIN, stripWs[id]) : stripW(it.prof.name);
      return { x: r.x, y: r.y, w: Math.min(w, csizeRef.current.w - 2 * STRIP_GAP), h: STRIP_H };
    }
    // v13: the shelf flow width for one collapsed item (manual drag wins)
    function shelfW(it) {
      var w = stripWs[it.id] ? Math.max(STRIP_RESIZE_MIN, stripWs[it.id]) : stripW(it.prof.name);
      return Math.min(w, Math.max(1, csizeRef.current.w - 2 * STRIP_GAP));
    }
    var rects = useMemo(function () {
      var base = {}, out = {}, claimed = [];
      Object.keys(layout).forEach(function (k) { if (layout[k]) base[k] = layout[k]; });
      // v11: the unstored default slots mirror 自动排列 — busy cards pack
      // row-first on fixed-height rows, collapsed strips sit together on the
      // shelf under the busy area (instead of holes where a strip shrank).
      var slimIds = {};
      items.forEach(function (it) {
        if (it.kind !== "prof") return;
        var pn = panels[it.prof.name];
        if (visibleBlocks(pn && pn.model, props.hideSt) === 0) slimIds[it.id] = 1;
      });
      var fulls = items.filter(function (it) { return !slimIds[it.id]; });
      var strips = items.filter(function (it) { return !!slimIds[it.id]; });
      var stripWidths = strips.map(shelfW);
      // v13: every busy card's default slot is its HUG size — profile cards
      // wrap their block grid (+ small gap); v16: group containers hug their
      // column-first content too (was a fixed PDEF box that wasted space).
      var fullSizes = fulls.map(function (it) {
        if (it.kind === "prof") {
          var pn = panels[it.prof.name];
          var m = pn && pn.model;
          if (m && (m.width > 0 || m.height > 0)) {
            var hs = cardHugSize(m.width, m.height);
            hs.n = m.nodeMap.size; // v22: fillWall digest cap
            return hs;
          }
        }
        if (it.kind === "group") return groupHugSize(it.children.map(kidMeta), Math.max(300, csize.h - 140), Math.max(560, csize.w - 2 * PGAP));
        return { w: PDEF_W, h: PDEF_H };
      });
      var plan = wallPlan(csize.w, csize.h, fullSizes, stripWidths);
      var busySlots = plan.busy;
      var busyBottom = plan.busyBottom;
      fulls.forEach(function (it) {
        if (!base[it.id]) return;
        var rr = effRect(it.id, base[it.id]);
        busyBottom = Math.max(busyBottom, rr.y + rr.h);
      });
      var shelfSlots = shelfPack(stripWidths, csize.w, busyBottom + STRIP_GAP, STRIP_H, STRIP_GAP, STRIP_VGAP);
      items.forEach(function (it) { if (base[it.id]) claimed.push(effRect(it.id, base[it.id])); });
      items.forEach(function (it) {
        if (base[it.id]) { out[it.id] = effRect(it.id, base[it.id]); return; }
        var pool = slimIds[it.id] ? shelfSlots : busySlots;
        var cand = null, k;
        for (k = 0; k < pool.length; k++) if (!hasOverlap(pool[k], claimed)) { cand = pool[k]; break; }
        var rr = effRect(it.id, cand || pickFreeSlot(claimed, csize.w, csize.h));
        out[it.id] = rr;
        claimed.push(rr);
      });
      return out;
    }, [layout, items, csize, panels, props.hideSt, stripWs]);

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

    // member rects inside every group card (relative to the group body box).
    // v12: recursion — a nested group gets its own inner map keyed by the
    // same gid scheme, plus its absolute surface rect (drag math and drop
    // hit-testing inside the up-handler need it without walking the DOM).
    var nestAbsRef = useRef({});
    var innerRects = useMemo(function () {
      var out = {}, abs = {};
      function fill(gid, cfg, kids, cardR) {
        var body = groupBody(cardR);
        var toks = kids.map(nest.kidTok);
        // v16: column-first pack (busy stacked wide, strips at the bottom) —
        // the weighted treemap is retired for the default layout.
        var ir = innerLayoutV16(toks, cfg.inner, body, kids.map(kidMeta), INNER_PAD);
        kids.forEach(function (k) {
          var t = nest.kidTok(k), q = ir[t];
          if (!q) return;
          if (k.kind === "prof") {
            var pn = panels[k.prof.name];
            ir[t] = visibleBlocks(pn && pn.model, props.hideSt) === 0
              ? { x: q.x, y: q.y, w: q.w, h: STRIP_H_IN }
              : { x: q.x, y: q.y, w: q.w, h: Math.max(q.h, IMIN_H) };
            return;
          }
          var empty = nest.visBlocks(k) === 0;
          var r2 = empty ? { x: q.x, y: q.y, w: q.w, h: STRIP_H_IN }
                         : { x: q.x, y: q.y, w: q.w, h: Math.max(q.h, Math.min(GMIN_H, body.h)) };
          ir[t] = r2;
          // v12: every nested card carries its absolute rect (also empty
          // strips — pull-out math needs it); inner maps are filled one
          // level deeper only when the child actually renders a body.
          abs[k.cfg.id] = { x: cardR.x + body.x + r2.x, y: cardR.y + body.y + r2.y, w: r2.w, h: r2.h };
          if (!empty) fill(k.cfg.id, k.cfg, k.children, r2);
        });
        out[gid] = ir;
      }
      items.forEach(function (it) {
        if (it.kind !== "group") return;
        var r = shown[it.id];
        if (!r) return;
        abs[it.cfg.id] = r;
        fill(it.cfg.id, it.cfg, it.children, r);
      });
      nestAbsRef.current = abs;
      return out;
    }, [items, shown, panels, props.hideSt, nest, stripWs]);

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
    // v18 (user 2026-10-12): a member card that was COLLAPSED to a strip and
    // just got new task blocks must not stay crammed in its shelf slot — the
    // group re-runs its 自动排列 (member rects + block tiles reset) whenever
    // any member flips strip -> busy. Only fires when the group actually has
    // stored member rects; the first survey just records the baseline.
    var slimRef = useRef(null);
    useEffect(function () {
      if (isMax) return;
      var cur = {};
      gcfg.forEach(function (c) {
        c.members.forEach(function (m) {
          if (isTok(m) || hidden[m]) return;
          var pn = panels[m];
          // a panel that has not arrived yet (first frame after reload, before
          // the poll) is NOT a collapse — recording it as one made every group
          // with stored rects take a false wake as soon as data landed.
          if (!pn) return;
          cur[c.id + "/" + m] = visibleBlocks(pn && pn.model, props.hideSt) === 0 ? 1 : 0;
        });
      });
      var prev = slimRef.current;
      slimRef.current = cur;
      if (!prev) return;
      wakeGroupsSlim(prev, cur, gcfgRef.current || []).forEach(function (gid) {
        autoArrangeCard(gid, "", false);
      });
    }, [gcfg, panels, props.hideSt, hidden]);

    // v17 (2026-10-12) auto-PINNED the first computed slot into the layout so
    // refreshes wouldn't reshuffle. That design is RETIRED (v22, user
    // 2026-10-13 "自动排版有很多空白区间浪费"): the wall grows board-by-board
    // as /graph responses land, so there is NO stable frame to pin against —
    // any frame that pins twice-in-a-row can be a partial one, and a pinned
    // partial slot never re-flows when the real content arrives. The quiet
    // survey caught it red-handed: 36 blocks pinned into a 150px strip, 1
    // block pinned at 361px. Defaults are now ALWAYS live (deterministic for
    // the same data), manual rects still win forever (v21 doctrine), and a
    // full persist happens exactly when 自动排列 is clicked.
    // (No effect here on purpose — do NOT re-add a silent auto-persist.)
    function applyGroups(arr) {
      var clean = sanitizeGroups((arr || []).filter(function (c) { return c && c.id && Array.isArray(c.members); }));
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
    // v18b (v7 probe): an escaped member that joins/creates ANOTHER container
    // must not stay in its old one too — double ownership made both groups
    // grow and collide. Below the 2-member floor sanitizeGroups drops the
    // empty husk automatically.
    function stripMember(arr, pid) {
      return arr.map(function (c) {
        if (c.members.indexOf(pid) < 0) return c;
        var inn = Object.assign({}, c.inner); delete inn[pid];
        return { id: c.id, name: c.name, members: c.members.filter(function (m) { return m !== pid; }), inner: inn };
      });
    }
    // the group card wraps what its members used to occupy
    // v18b (v7 probe): the wrapped union is often BIGGER than either member —
    // it keeps its spot and the neighbours it rides on get pushed aside
    // (a group shoved into a far free slot was unreachable / off-wall).
    function groupRectFor(a, b) {
      var u = (a && b) ? unionRect(a, b) : (a || b || { x: PGAP, y: PGAP, w: PDEF_W, h: PDEF_H });
      var w = Math.max(GMIN_W, u.w + 2 * GBODY_PAD);
      var hh = Math.max(GMIN_H, u.h + GHEAD + 2 * GBODY_PAD);
      var x = Math.max(0, Math.min(u.x - GBODY_PAD, Math.max(0, csizeRef.current.w - w)));
      return { x: x, y: Math.max(0, u.y - GHEAD), w: w, h: hh };
    }
    function otherRects(except) {
      var out = [];
      items.forEach(function (it2) {
        if (except.indexOf(it2.id) >= 0) return;
        var rr = view[it2.id];
        if (rr) out.push({ id: it2.id, rect: rr });
      });
      return out;
    }
    // place a freshly minted top-level group and step its obstacles aside;
    // returns the layout mutations (group rect + mover ids)
    function groupPlace(gid, r, exceptIds) {
      var mv = pushAside(r, otherRects(exceptIds), GRID);
      var lay = Object.assign({}, layoutRef.current);
      lay[GKEY + gid] = r;
      Object.keys(mv).forEach(function (id) { lay[id] = mv[id]; });
      return lay;
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
      var tok = GTOK + gid;
      var arr = gcfgRef.current.filter(function (c) { return c.id !== gid; }).map(function (c) {
        if (c.members.indexOf(tok) < 0) return c;
        var inner = Object.assign({}, c.inner); delete inner[tok];
        return { id: c.id, name: c.name, members: c.members.filter(function (m) { return m !== tok; }), inner: inner };
      });
      var lay = Object.assign({}, layoutRef.current);
      delete lay[GKEY + gid];
      applyGroups(arr);
      applyLayout(lay);
    }
    // v12 (user 2026-10-11): dropping a group onto another group NESTS it —
    // "组合中的组合" instead of flattening both into one container. Guards:
    // no self-nest, no cycles (target inside the mover's own subtree), one
    // parent max (token is stripped from every other container first).
    function nestInto(fromGid, toGid) {
      if (!fromGid || !toGid || fromGid === toGid) return;
      var cur = gcfgRef.current;
      var has = {}; cur.forEach(function (c) { has[c.id] = 1; });
      if (!has[fromGid] || !has[toGid]) return;
      if (groupSubtreeHas(cur, fromGid, toGid, 0)) return; // would close a cycle
      var tok = GTOK + fromGid;
      var arr = cur.map(function (c) {
        var members = c.members.filter(function (m) { return m !== tok; });
        var inner = Object.assign({}, c.inner); delete inner[tok];
        if (c.id === toGid && members.indexOf(tok) < 0) members = members.concat([tok]);
        return { id: c.id, name: c.name, members: members, inner: inner };
      });
      var lay = Object.assign({}, layoutRef.current);
      delete lay[GKEY + fromGid];
      applyGroups(arr);
      applyLayout(lay);
    }
    // pulling a nested group out of its parent onto the wall: it becomes a
    // free top-level group card again at `atRect` (surface coords)
    function extractGroup(gid, atRect) {
      var tok = GTOK + gid;
      var arr = gcfgRef.current.map(function (c) {
        if (c.members.indexOf(tok) < 0) return c;
        var inner = Object.assign({}, c.inner); delete inner[tok];
        return { id: c.id, name: c.name, members: c.members.filter(function (m) { return m !== tok; }), inner: inner };
      });
      var lay = Object.assign({}, layoutRef.current);
      lay[GKEY + gid] = atRect;
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
          // v12: the container may be a NESTED group — its surface rect is not
          // in `view` (only top-level cards are); nestAbs carries every level.
          var cRect = nestAbsRef.current[op.gid] || view[GKEY + op.gid] || view[op.gid] || { w: GMIN_W, h: GMIN_H };
          var body = groupBody(cRect);
          var ires = op.kind === "move"
            ? snapMove(base, innerOthersOf(op.id, op.gid), body, SNAP, GRID)
            : snapResize({ x: op.ox, y: op.oy, w: op.ow, h: op.oh }, dx, dy,
                innerOthersOf(op.id, op.gid), body, SNAP, GRID, IMIN_W, IMIN_H);
          rawRef.current = { gid: op.gid, id: op.id, rect: ires.rect };
          setInnerLive(op.gid, op.id, ires.rect);
          return;
        }
        // v13: a collapsed STRIP only resizes horizontally — the width rides in
        // the per-scope stripW map, the shelf flow re-packs live around it.
        if (op.strip) {
          op.moved = true;
          var wN = clamp(Math.round((op.ow + dx) / GRID) * GRID, STRIP_RESIZE_MIN,
                         Math.max(STRIP_RESIZE_MIN, csizeRef.current.w - 2 * STRIP_GAP));
          var nws = Object.assign({}, stripWsRef.current);
          nws[op.id] = wN;
          stripWsRef.current = nws;
          setStripWs(nws);
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
        // v13: strip width rides in its own map — the shelf flow owns position
        if (op.strip) {
          writeStripWs(keyRef.current, stripWsRef.current);
          return;
        }

        if (op.scope === "inner") {
          var live = innerRects[op.gid] || {};
          var prev = (fzIn && fzIn.gid === op.gid) ? fzIn.rects : live;
          var r = live[op.id];
          // v12: the container may be a NESTED group — do not look it up in
          // `items` (top-level only); the cfg map and nestAbs cover all levels.
          if (!r || !nest.cfgOf[op.gid]) return;
          var gr = nestAbsRef.current[op.gid];
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
            // v12: escaping a container over ANOTHER top-level card joins it
            // (profile -> member, nested group -> NESTED member "组合中的组合");
            // escaping over empty wall lands as a free card next to the
            // container, never on top of it.
            var ptU = (e && typeof e.clientX === "number")
              ? { x: e.clientX - op.org.x, y: e.clientY - op.org.y }
              : { x: abs.x + abs.w / 2, y: abs.y + abs.h / 2 };
            var tg = null;
            items.forEach(function (x) {
              if (x.id === GKEY + op.gid) return;
              var rr2 = view[x.id];
              if (rr2 && insideRect(rr2, ptU)) tg = x;
            });
            if (!tg) {
              items.forEach(function (x) {
                if (x.id === GKEY + op.gid || tg) return;
                var rr3 = view[x.id];
                if (rr3 && insideRect(rr3, { x: abs.x + abs.w / 2, y: abs.y + abs.h / 2 })) tg = x;
              });
            }
            if (tg) {
              if (isTok(op.id)) {
                if (tg.kind === "group") nestInto(tokGid(op.id), tg.cfg.id);
                else {
                  var g2 = mintGroup([tg.id, op.id]);
                  var lay2b = groupPlace(g2.id,
                    groupRectFor(view[tg.id], nestAbsRef.current[tokGid(op.id)]),
                    [tg.id, GKEY + tokGid(op.id)]);
                  delete lay2b[tg.id];
                  applyGroups(stripMember(gcfgRef.current, op.id).concat([g2]));
                  applyLayout(lay2b);
                }
                return;
              }
              if (tg.kind === "group") { addToGroup(tg.cfg.id, op.id); return; }
              var g3 = mintGroup([tg.id, op.id]);
              var lay3 = groupPlace(g3.id, groupRectFor(view[tg.id], abs), [tg.id, op.id]);
              delete lay3[tg.id];
              delete lay3[op.id];
              applyGroups(stripMember(gcfgRef.current, op.id).concat([g3]));
              applyLayout(lay3);
              return;
            }
            var othersT = items.filter(function (x) { return x.id !== GKEY + op.gid; })
              .map(function (x) { return { id: x.id, rect: view[x.id] }; })
              .filter(function (o) { return o.rect; });
            var obstacles = othersT.map(function (o) { return o.rect; }).concat([gr]);
            var drop = nearestFree({ x: Math.max(0, abs.x), y: Math.max(0, abs.y), w: abs.w, h: abs.h }, obstacles, GRID, 80);
            var moves = pushAside(drop, othersT, GRID);
            var lay2 = Object.assign({}, layoutRef.current);
            if (isTok(op.id)) {
              extractGroup(tokGid(op.id), drop);
              lay2[GKEY + tokGid(op.id)] = drop; // extract applied it; keep it through the moves merge
              Object.keys(moves).forEach(function (id) { lay2[id] = moves[id]; });
              applyLayout(lay2);
            } else {
              leaveGroup(op.id, drop);
              lay2[op.id] = drop;
              Object.keys(moves).forEach(function (id) { lay2[id] = moves[id]; });
              applyLayout(lay2);
            }
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
          // v18 (user 2026-10-12): JOINING takes a real overlap — the dropped
          // card must cover at least half of the target (or of itself). Anything
          // lighter means "put it down here", and the neighbours it rides on
          // PUSH ASIDE to make room (the no-target branch below already does).
          var best = 0;
          items.forEach(function (it2) {
            if (it2.id === op.id) return;
            var rr = view[it2.id];
            if (!rr) return;
            var ox = Math.min(fin.x + fin.w, rr.x + rr.w) - Math.max(fin.x, rr.x);
            var oy = Math.min(fin.y + fin.h, rr.y + rr.h) - Math.max(fin.y, rr.y);
            if (ox <= 0 || oy <= 0) return;
            var share = (ox * oy) / Math.min(fin.w * fin.h, rr.w * rr.h);
            if (share > best) { best = share; tgt = it2; }
          });
          if (best < 0.5) tgt = null;
        }
        if (tgt) {
          var isG = op.id.slice(0, 2) === GKEY;
          if (tgt.kind === "group") {
            // v12: group onto group = NEST ("组合中的组合"), no longer a flat
            // merge (user 2026-10-11). Profiles joining a group keep the old
            // addToGroup path below.
            if (isG) nestInto(op.id.slice(2), tgt.cfg.id);
            else addToGroup(tgt.cfg.id, op.id);
            return;
          }
          if (isG) { addToGroup(op.id.slice(2), tgt.id); return; }
          var g = mintGroup([tgt.id, op.id]);
          var lay = groupPlace(g.id, groupRectFor(view[tgt.id], view[op.id]), [tgt.id, op.id]);
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
        sx: e.clientX, sy: e.clientY, ox: r.x, oy: r.y, ow: r.w, oh: r.h, moved: false,
        // v13: resizing a collapsed profile STRIP only changes its width
        // (stored in the stripW map, the shelf flow re-packs around it)
        strip: kind === "resize" && scope2 === "top" && id.slice(0, 2) !== GKEY &&
          visibleBlocks((panels[id] || {}).model, props.hideSt) === 0
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
    function fitCardSize(id, panel) {
      // v13: "resize to content" = the same HUG size the wall defaults use
      var m = panel && panel.model;
      var sz = (m && (m.width > 0 || m.height > 0)) ? cardHugSize(m.width, m.height) : { w: PDEF_W, h: PDEF_H };
      var cur = layoutRef.current[id] || view[id] || null;
      return {
        x: cur ? Math.round(cur.x / GRID) * GRID : PGAP,
        y: cur ? Math.round(cur.y / GRID) * GRID : PGAP,
        w: Math.round(sz.w / GRID) * GRID,
        h: Math.round(sz.h / GRID) * GRID
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
        var pn = panels[name];
        var r;
        if (visibleBlocks(pn && pn.model, props.hideSt) === 0) {
          // v10: an empty card keeps its place but drops to a title-row strip
          var cur = layoutRef.current[name] || view[name];
          r = {
            x: cur ? Math.round(cur.x / GRID) * GRID : PGAP,
            y: cur ? Math.round(cur.y / GRID) * GRID : PGAP,
            w: cur ? Math.round(cur.w / GRID) * GRID : 300,
            h: STRIP_H
          };
        } else {
          r = fitCardSize(name, panels[name]);
        }
        var mv = pushAside(r, othersOf(name), GRID);
        var nxt = Object.assign({}, layoutRef.current);
        nxt[name] = r;
        Object.keys(mv).forEach(function (k) { nxt[k] = mv[k]; });
        applyLayout(nxt);
        return;
      }
      // v12: clearing a group's manual member rects clears the WHOLE subtree
      // (nested groups tile back too), and every profile under it re-tiles
      // its blocks — 自动排列 means "put everything below back in order".
      var toClear = {};
      (function walkClear(c, d) {
        if (!c || toClear[c.id] || d > NEST_MAX) return;
        toClear[c.id] = 1;
        c.members.forEach(function (m) { if (isTok(m)) walkClear(nest.cfgOf[tokGid(m)], d + 1); });
      })(nest.cfgOf[gid], 0);
      applyGroups(gcfgRef.current.map(function (c) {
        return toClear[c.id] ? { id: c.id, name: c.name, members: c.members, inner: {} } : c;
      }));
      (function walkProfs(c, d) {
        if (!c || d > NEST_MAX) return;
        c.members.forEach(function (m) {
          if (isTok(m)) walkProfs(nest.cfgOf[tokGid(m)], d + 1);
          else if (byName[m] && !hidden[m]) arrangeBlocks(m);
        });
      })(nest.cfgOf[gid], 0);
    }

    function toggleProf(name) {
      // v21 fix: read the store FRESH (same pattern the filter-row/StatusBar
      // toggles use). The old closure copy made every click in a synchronous
      // batch compute from the same stale map — only the LAST toggle survived
      // (v9 solo-card precondition died with 19 chips clicked / 1 hidden).
      var nxt = readHiddenProf();
      if (nxt[name]) delete nxt[name]; else nxt[name] = 1;
      writeHiddenProf(nxt);
      setHidden(nxt);
      window.dispatchEvent(new CustomEvent("kg-hidep"));  // v20.2: keep the status bar in sync
    }

    // v20.2: the status bar toggles the same store — adopt its changes
    useEffect(function () {
      function syncHidden() { setHidden(readHiddenProf()); }
      window.addEventListener("kg-hidep", syncHidden);
      return function () { window.removeEventListener("kg-hidep", syncHidden); };
    }, []);

    var onAutoArrange = useCallback(function () {
      var W = csizeRef.current.w, H = csizeRef.current.h;
      var slimSet = {};
      items.forEach(function (it) {
        if (it.kind !== "prof") return;
        var pn = panels[it.prof.name];
        if (visibleBlocks(pn && pn.model, props.hideSt) === 0) slimSet[it.id] = 1;
      });
      var full = items.filter(function (it) { return !slimSet[it.id]; });
      var slim = items.filter(function (it) { return slimSet[it.id]; });
      // v11: busy cards pack ROW-FIRST, collapsed strips sit together on a
      // shelf directly under them — top of the view = cards with blocks.
      // v13: busy cards pack at their HUG size (content-driven, column-first
      // grids, blocks as big as the card honestly needs); strips flow tight.
      var fullSizes = full.map(function (it) {
        if (it.kind === "prof") {
          var pn = panels[it.prof.name];
          var m = pn && pn.model;
          if (m && (m.width > 0 || m.height > 0)) {
            var hs = cardHugSize(m.width, m.height);
            hs.n = m.nodeMap.size; // v22: fillWall digest cap
            return hs;
          }
        }
        if (it.kind === "group") return groupHugSize(it.children.map(kidMeta), Math.max(300, H - 140), Math.max(560, W - 2 * PGAP));
        return { w: PDEF_W, h: PDEF_H };
      });
      // v22 (user 2026-10-13): 顶栏自动排列 = 一次「全部归位」——卡片重排之外，
      // 每张可见卡的 task block 也清掉旧的钉住位置回到点阵（v21 口径里顶栏按钮
      // 本就是归位入口，此前只有卡片级按钮实现了它）。不清 miniPos 的话，旧几何
      // 钉住的块会被夹到改过尺寸的卡边缘——正是这次普查出的「右缘一竖条」死区。
      // v17 pin guard: read the hidden set FRESH from the store (the callback
      // closure would see stale chips; same disease as v21 toggleProf).
      var hiddenNow = readHiddenProf();
      items.forEach(function (it) {
        if (it.kind === "prof" && !hiddenNow[it.prof.name]) arrangeBlocks(it.prof.name);
      });
      gcfgRef.current.forEach(function (c) {
        c.members.forEach(function (mm) {
          if (!isTok(mm) && byName[mm] && !hiddenNow[mm]) arrangeBlocks(mm);
        });
      });
      var plan = wallPlan(W, H, fullSizes, slim.map(shelfW));
      var slots = plan.busy;
      var nxt = Object.assign({}, layoutRef.current);
      var maxY = PGAP, i;
      full.forEach(function (it, i2) { if (slots[i2]) { nxt[it.id] = slots[i2]; maxY = Math.max(maxY, slots[i2].y + slots[i2].h); } });
      // stored h = STRIP_H, and effRect lifts it back to PMIN_H when the card
      // grows blocks again, so the persisted row never clips content.
      var shelf = shelfPack(slim.map(shelfW), W, maxY + STRIP_GAP, STRIP_H, STRIP_GAP, STRIP_VGAP);
      slim.forEach(function (it, i2) { if (shelf[i2]) nxt[it.id] = shelf[i2]; });
      applyLayout(nxt);
      applyGroups(gcfgRef.current.map(function (c) { return { id: c.id, name: c.name, members: c.members, inner: {} }; }));
      if (maxed) { setMaxed(""); writeMaxed(keyRef.current, ""); }
    }, [items, maxed, panels, props.hideSt, stripWs]);

    // ── toolbar ──
    var boardList = boards.length ? boards : [];
    var scopeOptions = [h("option", { key: "__all__", value: "__all__" }, "全部板")].concat(
      boardList.map(function (b) { return h("option", { key: b.slug, value: b.slug }, b.title || b.slug); }));
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
      h("span", { className: "kg-brand" }, "Board+"),
      modeSwitch(props),
      h("select", { className: "kg-native-sel", value: scopeValue, onChange: function (e) { props.setScope(e.target.value === "__all__" ? "" : e.target.value); } }, scopeOptions),
      h(Button, { size: "sm", variant: "outline", onClick: props.onReload }, "刷新"),
      h(Button, { size: "sm", variant: "outline", onClick: onAutoArrange }, "自动排列"),
      h(Button, {
        size: "sm", variant: gridOn ? "default" : "outline",
        title: "拖动时显示参考格子（卡片按 " + GRID + "px 吸附）",
        onClick: function () { var v = !gridOn; setGridOn(v); lsSet(LS_GRID, v ? "1" : "0"); }
      }, "网格"),
      h(Button, {
        size: "sm", variant: "outline", title: "全屏：隐藏其他信息，只显示卡片区域（Esc 退出）",
        onClick: props.onFsToggle
      }, "全屏"),
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
      var pn = panels[g.name];
      var slim = !big && visibleBlocks(pn && pn.model, props.hideSt) === 0;
      var narrow = slim && r.w < 210; // v12 shelf: hide the arrange button on content-width strips
      var kids = [headBar(g, gid)];
      if (!slim) {
        kids.push(h(PanelBody, {
          pid: g.name, panel: panels[g.name], hideSt: props.hideSt,
          metaOf: multiBoard ? function (n) { return n.board; } : null,
          big: !!big, ver: miniVer[g.name] || 0, onArrange: arrangeBlocks, onTask: props.onTask
        }));
      }
      // v13: a collapsed strip gets the grip too — width-only (see op.strip)
      kids.push(h("div", {
        className: "kg-prsz" + (slim ? " kg-srsz" : ""), title: slim ? "拖动调整宽度" : "拖动缩放",
        onPointerDown: function (e) { opDown("resize", g.name, e, gid ? "inner" : "top", gid); }
      }));
      return h("div", {
        key: (gid ? gid + "/" : "") + g.name,
        className: "kg-panel" + (isAct ? " kg-pactive" : "") + (gid ? " kg-pinner" : "") + (big ? " kg-pbig" : "") + (slim ? " kg-pstrip" : "") + (narrow ? " kg-pnarrow" : ""),
        "data-prof": g.name,
        "data-in-group": gid || "",
        style: { left: r.x + "px", top: r.y + "px", width: r.w + "px", height: r.h + "px", borderTopColor: col }
      }, kids);
    }

    // v12: recursive group renderer. A nested group is drawn inside its
    // parent body with the same machinery (weighted tiling, strips, resize,
    // gauto); `parentGid` flips the drag scope to "inner" and the double-tap
    // semantics from maximise to pull-out.
    function renderGroup(it, r, big, parentGid) {
      var cfg = it.cfg, body = groupBody(r);
      var inn = inv[cfg.id] || {};
      var nested = !!parentGid;
      var tokSelf = GTOK + cfg.id;
      var isAct = activeOp && activeOp.id === (nested ? tokSelf : it.id);
      var rw = rawRef.current;
      function pullOut() {
        var a = nestAbsRef.current[cfg.id] || { x: r.x, y: r.y, w: r.w, h: r.h };
        var obs = items.map(function (x) { return view[x.id]; }).filter(Boolean);
        extractGroup(cfg.id, nearestFree(
          { x: Math.max(0, a.x), y: Math.max(0, a.y), w: Math.max(GMIN_W, a.w), h: Math.max(GMIN_H, a.h) },
          obs, GRID, 80));
      }
      var mem = (it.children || []).map(function (k) {
        var t = nest.kidTok(k);
        var ir = inn[t];
        if (rw && rw.gid === cfg.id && rw.id === t) ir = rw.rect;
        if (!ir) return null;
        if (k.kind === "prof") return renderProf(k.prof, ir, false, cfg.id);
        if (nest.visBlocks(k) === 0) return renderGroupStrip(k, ir, cfg.id);
        return renderGroup(k, ir, false, cfg.id);
      });
      return h("div", {
        key: nested ? parentGid + "/" + tokSelf : it.id,
        className: "kg-group" + (isAct ? " kg-pactive" : "") + (big ? " kg-gbig" : "") + (nested ? " kg-gnest" : ""),
        "data-group": cfg.id, "data-prof": nested ? tokSelf : it.id,
        "data-in-group": parentGid || "",
        style: { left: r.x + "px", top: r.y + "px", width: r.w + "px", height: r.h + "px" }
      },
        h("div", {
          className: "kg-ghead" + (nested ? " kg-ghead-n" : ""),
          title: nested ? "拖动在父组内摆位 · 双击组名改名 · 双击空白移出父组 · 拖到别的卡片上可再嵌套"
                        : "双击标题改名 · 双击空白处放大 / 还原 · 拖到别的分组上=组合套组合 · 拖卡片上=并组",
          onPointerDown: function (e) {
            if (nested) opDown("move", tokSelf, e, "inner", parentGid);
            else opDown("move", it.id, e, "top");
          },
          onPointerUp: function (e) {
            var t = e && e.target;
            if (t && String(t.className || "").indexOf("kg-gname") >= 0) {
              dblTap((nested ? tokSelf : it.id) + "/name", function () { escRef.current = false; setEditG(cfg.id); });
              return;
            }
            if (nested) { dblTap("out/" + tokSelf, pullOut); return; }
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
          h("span", { className: "kg-gn" }, (it.children || []).length),
          h("span", { className: "kg-gmem" }, (it.children || []).map(nest.kidName).join(" · ")),
          h("button", {
            className: "kg-gauto", type: "button",
            title: "自动排列：整棵子树归位（含嵌套子组）",
            onPointerDown: function (e) { e.stopPropagation(); },
            onClick: function (e) { e.stopPropagation(); autoArrangeCard(cfg.id, nested ? tokSelf : it.id); }
          }, "自动排列"),
          h("button", {
            className: "kg-gx", type: "button", title: nested ? "移出父组" : "解散分组",
            onPointerDown: function (e) { e.stopPropagation(); },
            onClick: function (e) { e.stopPropagation(); if (nested) pullOut(); else dissolve(cfg.id); }
          }, "×")
        ),
        h("div", {
          className: "kg-gbody",
          style: { left: body.x + "px", top: body.y + "px", width: body.w + "px", height: body.h + "px" }
        }, (gridOn && activeOp && activeOp.gid === cfg.id) ? h("div", { className: "kg-grid" }) : null, mem),
        h("div", {
          className: "kg-prsz", title: "拖动缩放",
          onPointerDown: function (e) {
            if (nested) opDown("resize", tokSelf, e, "inner", parentGid);
            else opDown("resize", it.id, e, "top");
          }
        })
      );
    }

    // an all-filtered-out nested group shrinks to a strip INSIDE its parent
    // body (mirrors the wall shelf at level depth) — drag it out to restore
    function renderGroupStrip(node, r, parentGid) {
      var tok = GTOK + node.cfg.id;
      var isAct = activeOp && activeOp.id === tok && activeOp.gid === parentGid;
      function pullOut() {
        var a = nestAbsRef.current[node.cfg.id] || { x: r.x, y: r.y, w: GMIN_W, h: GMIN_H };
        var obs = items.map(function (x) { return view[x.id]; }).filter(Boolean);
        extractGroup(node.cfg.id, nearestFree(
          { x: Math.max(0, a.x), y: Math.max(0, a.y), w: Math.max(GMIN_W, a.w), h: GMIN_H },
          obs, GRID, 80));
      }
      return h("div", {
        key: parentGid + "/" + tok,
        className: "kg-panel kg-pstrip kg-gstrip" + (isAct ? " kg-pactive" : ""),
        "data-group": node.cfg.id, "data-prof": tok, "data-in-group": parentGid,
        style: { left: r.x + "px", top: r.y + "px", width: r.w + "px", height: r.h + "px" }
      },
        h("div", {
          className: "kg-phead", title: "空分组 · 拖出父组恢复 · 双击移出",
          onPointerDown: function (e) { opDown("move", tok, e, "inner", parentGid); },
          onPointerUp: function () { dblTap("out/" + tok, pullOut); }
        },
          h("span", { className: "kg-gdot" }, "组"),
          h("span", { className: "kg-ptitle" }, node.cfg.name),
          h("span", { className: "kg-pcount" }, nest.collectProfs(node.children).length),
          h("button", {
            className: "kg-pclose", title: "移出父组", type: "button",
            onPointerDown: function (e) { e.stopPropagation(); },
            onClick: function (e) { e.stopPropagation(); pullOut(); }
          }, "×")
        ));
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
    // v20: fullscreen the card area. The page root is the fullscreen ELEMENT;
    // CSS hides the status bar + toolbars while it is fullscreen, so only the
    // card area remains (task popup still works — it lives inside the subtree).
    s = useState(false); var fsOn = s[0], setFsOn = s[1];
    var fsRef = useRef(null);

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

    // v20: keep fsOn synced with the browser (Esc / F11 exit fire fullscreenchange)
    useEffect(function () {
      function onFsChange() {
        setFsOn(!!fsRef.current && document.fullscreenElement === fsRef.current);
      }
      document.addEventListener("fullscreenchange", onFsChange);
      return function () { document.removeEventListener("fullscreenchange", onFsChange); };
    }, []);
    var toggleFs = useCallback(function () {
      var el = fsRef.current;
      if (!el) return;
      if (document.fullscreenElement) {
        if (document.exitFullscreen) document.exitFullscreen().catch(function () {});
      } else if (el.requestFullscreen) {
        el.requestFullscreen().catch(function () {});
      }
    }, []);

    var shared = {
      mode: mode, setMode: setMode,
      boards: boards, board: board, setBoard: setBoard,
      scope: scope, setScope: setScope,
      graphs: graphs, error: error,
      hideSt: hideSt, toggleSt: toggleSt, onReload: onReload, onTask: openTask,
      fsOn: fsOn, onFsToggle: toggleFs
    };

    return h("div", { className: "kg-root kg-fsroot", ref: fsRef },
      fsOn ? h("button", {
        className: "kg-fs-exit", type: "button", title: "退出全屏（或按 Esc）",
        onClick: toggleFs
      }, "✕ 退出全屏") : null,
      mode === "single" ? h(SingleBoardView, shared) : h(MultiProfileView, shared),
      h(TaskModal, { detail: detail, onClose: closeTask }));
  }

  // internals exposed for headless acceptance tests (no UI dependency)
  window.__KG_TEST__ = {
    fsSupported: function () {
      return !!(document.documentElement.requestFullscreen && document.fullscreenEnabled !== false);
    },
    fsActive: function (el) { return !!el && document.fullscreenElement === el; },
    buildModel: buildModel, buildView: buildView, orthPath: orthPath, snapCell: snapCell,
    edgeAnchors: edgeAnchors, edgePathGeo: edgePathGeo, wakeGroupsSlim: wakeGroupsSlim,
    groupByProfile: groupByProfile, mergeGraphs: mergeGraphs, buildPanels: buildPanels,
    neededSlugs: neededSlugs, tileRects: tileRects, pickFreeSlot: pickFreeSlot,
    rowPack: rowPack, shelfPack: shelfPack, wallPlan: wallPlan,
    hugPack: hugPack, cardHugSize: cardHugSize, fillWall: fillWall,
    cardUsefulH: cardUsefulH, skyPack: skyPack,
    ktfCols: ktfCols, ktfEffGeo: ktfEffGeo, KTF_WIDE_MAX: KTF_WIDE_MAX,
    HUG_TS: HUG_TS, STRIP_GAP: STRIP_GAP, STRIP_RESIZE_MIN: STRIP_RESIZE_MIN,
    shelfRows: shelfRows, stripW: stripW,
    GTOK: GTOK, isTok: isTok, tokGid: tokGid, NEST_MAX: NEST_MAX,
    sanitizeGroups: sanitizeGroups, groupSubtreeHas: groupSubtreeHas,
    STRIP_MIN_W: STRIP_MIN_W, STRIP_VGAP: STRIP_VGAP,
    PDEF_W: PDEF_W, PDEF_H: PDEF_H, PMIN_W: PMIN_W, PMIN_H: PMIN_H,
    snapMove: snapMove, snapResize: snapResize, crossPath: crossPath, overlaps: overlaps,
    unionRect: unionRect, groupBody: groupBody, clampInnerRect: clampInnerRect,
    innerLayout: innerLayout, nearestFree: nearestFree, pushAside: pushAside, insideRect: insideRect,
    // v16: column-first group packing
    colPackSlots: colPackSlots, groupHugSize: groupHugSize, innerLayoutV16: innerLayoutV16,
    hasOverlap: hasOverlap, GKEY: GKEY,
    squarifyRects: squarifyRects, weightedSlots: weightedSlots, profWeight: profWeight,
    isDoubleTap: isDoubleTap, PROF_W_EMPTY: PROF_W_EMPTY, PROF_W_BUSY: PROF_W_BUSY,
    blockCount: blockCount, nameCmp: nameCmp, orderCards: orderCards,
    freeSpot: freeSpot,
    visibleBlocks: visibleBlocks, blockBoxOf: blockBoxOf, STATUS_ORDER: STATUS_ORDER,
    STRIP_H: STRIP_H, STRIP_H_IN: STRIP_H_IN,
    GMIN_W: GMIN_W, GMIN_H: GMIN_H, GHEAD: GHEAD, GBODY_PAD: GBODY_PAD, INNER_PAD: INNER_PAD,
    IMIN_W: IMIN_W, IMIN_H: IMIN_H, GRID: GRID, PGAP: PGAP,
    MINI_SCALE_MIN: MINI_SCALE_MIN, MINI_SCALE_MAX: MINI_SCALE_MAX, MINI_SCALE_MAX_BIG: MINI_SCALE_MAX_BIG,
    GEO_MAIN: GEO_MAIN, GEO_MINI: GEO_MINI,
    NODE_W: NODE_W, NODE_H: NODE_H, CELL_W: CELL_W, CELL_H: CELL_H, GAP_X: GAP_X, MARGIN: MARGIN
  };

  if (window.__HERMES_PLUGINS__ && typeof window.__HERMES_PLUGINS__.register === "function") {
    window.__HERMES_PLUGINS__.register("kanban-graph", KanbanGraphPage);
  }
})();
