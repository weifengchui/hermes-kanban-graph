#!/usr/bin/env python
"""Headless acceptance for kanban-graph v23 (2026-10-21): rubber-band multi-select
inside a card + group drag, and dependency-aware auto-arrange.

Asks this round (user):
  在卡片内部，允许鼠标框选多个任务块然后一起拖动移动位置；
  自动排列时，有依赖关系时最优化布局，尽量避免连续越过多个不相关的任务块再抵达另一个任务块

Mechanism:
  · buildModel's KTF branch packs each CONNECTED COMPONENT of the dependency
    graph as one contiguous run (layered + barycentre inside the component), so
    a wire never crosses the blocks of an unrelated chain, and a parent sits
    right above its child.
  · PanelBody gained a rubber band (pointerdown on the card canvas) that
    selects every block it touches; dragging a selected block moves the whole
    selection rigidly and persists all of them in one write.

Run:
  HOME=/home/yxf PLAYWRIGHT_BROWSERS_PATH=/home/yxf/.cache/ms-playwright \
  /home/yxf/.venvs/imgtools/bin/python kg_v23_hl.py
"""
import atexit
import json
import os
import sys

SHOTS = "/tmp/kg_shots"
os.makedirs(SHOTS, exist_ok=True)
BASE = os.environ.get("KG_BASE", "http://127.0.0.1:9119")
from playwright.sync_api import sync_playwright  # noqa: E402

fails, notes = [], []


def ok(name, cond, extra=""):
    (notes if cond else fails).append(("PASS " if cond else "FAIL ") + name + (" :: " + str(extra) if extra else ""))


def _dump():
    print("\n".join(notes))
    print()
    if fails:
        print("FAILURES (%d):" % len(fails))
        print("\n".join(fails))
    else:
        print("ALL PASS (%d assertions) — shots in %s" % (len(notes), SHOTS))


atexit.register(_dump)

SEED = """
(function () {
  try {
    if (sessionStorage.getItem('__kgv23')) return;
    sessionStorage.setItem('__kgv23', '1');
    var K = 'hermes.kanbangraph.';
    localStorage.setItem(K + 'mode', 'multi');
    localStorage.setItem(K + 'scope', '');
    localStorage.setItem(K + 'selectedBoard', 'edu');
    localStorage.setItem(K + 'hideSt', '[]');
    localStorage.removeItem(K + 'hiddenProfiles');
    localStorage.removeItem(K + 'layout.__all__');
    localStorage.removeItem(K + 'layout.edu');
  } catch (e) {}
})();
"""

# the blocks of every card, in DOM order, with their client rects.
# React strips the `key` prop, so a block is identified by its <title> head
# ("<task id> · <status> · <assignee>").
BLOCKS = """() => Array.from(document.querySelectorAll('.kg-panel')).map(p => {
  const prof = p.getAttribute('data-prof');
  const svg = p.querySelector('svg.kg-mini');
  if (!svg) return {prof: prof, blocks: []};
  const sr = svg.getBoundingClientRect();
  const bs = Array.from(svg.querySelectorAll('g.kg-node')).map(g => {
    const r = g.getBoundingClientRect();
    const t = g.querySelector('title');
    const tr = (g.getAttribute('transform') || '').match(/translate\\(([-\\d.]+),([-\\d.]+)\\)/);
    return {id: t ? (t.textContent || '').split(' · ')[0] : null,
            x: r.left, y: r.top, w: r.width, h: r.height,
            mx: tr ? parseFloat(tr[1]) : 0, my: tr ? parseFloat(tr[2]) : 0,
            sel: g.classList.contains('kg-sel')};
  });
  return {prof: prof, svg: {x: sr.left, y: sr.top, w: sr.width, h: sr.height}, blocks: bs};
})"""


def panels(page):
    return page.evaluate(BLOCKS)


def find_block(page, prof, bid):
    """the live rect of one block (the wall re-tiles on every poll)"""
    for p in panels(page):
        if p["prof"] != prof:
            continue
        for b in p["blocks"]:
            if b["id"] == bid:
                return b
    return None


def sel_ids(page):
    return page.evaluate(
        "Array.from(document.querySelectorAll('.kg-panel g.kg-node.kg-sel'))"
        ".map(g => { const t = g.querySelector('title');"
        " return t ? (t.textContent || '').split(' · ')[0] : null; })")


def sel_count(page):
    return len(sel_ids(page))


def stored_ids(page, prof):
    raw = page.evaluate("(p) => localStorage.getItem('hermes.kanbangraph.miniPos.' + p)", prof)
    if not raw:
        return []
    try:
        return list(json.loads(raw).keys())
    except Exception:
        return []


with sync_playwright() as pw:
    browser = pw.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1600, "height": 1200})
    ctx.add_init_script(SEED)
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append("pageerror:" + str(e)))
    page.on("console", lambda m: errors.append("console:" + m.text) if m.type == "error" else None)

    page.goto(BASE + "/kanban-graph", wait_until="domcontentloaded")
    page.wait_for_selector(".kg-surface > .kg-panel", timeout=30000)
    page.wait_for_timeout(1500)

    # ── A. the layout rule (pure, no network): components stay contiguous ──
    layout = page.evaluate("""() => {
      const T = window.__KG_TEST__, G = T.GEO_MINI;
      function mk(id, title, status) {
        return {id: id, oid: id, title: title, status: status || 'todo', assignee: 'p'};
      }
      // three INDEPENDENT chains + two unrelated tasks
      const nodes = [mk('A','A root'), mk('A1','A child'), mk('A2','A grandchild'),
                     mk('B','B root'), mk('B1','B child'),
                     mk('C','C root'), mk('C1','C child'),
                     mk('X','free one'), mk('Y','free two')];
      const edges = [{parent:'A', child:'A1'}, {parent:'A1', child:'A2'},
                     {parent:'B', child:'B1'}, {parent:'C', child:'C1'}];
      const m = T.buildModel({nodes: nodes, edges: edges, back_edges: []}, true, G, {cols: 1});
      const order = Array.from(m.placed.entries())
        .map(e => ({id: e[0], y: e[1].y, x: e[1].x}))
        .sort((a, b) => a.y - b.y || a.x - b.x).map(o => o.id);
      return {order: order};
    }""")
    order = layout["order"]
    ok("A1 the column order holds every block", isinstance(order, list) and len(order) == 9, order)
    pos = {i: n for n, i in enumerate(order)}
    comp = {"A": "A", "A1": "A", "A2": "A", "B": "B", "B1": "B", "C": "C", "C1": "C",
            "X": "X", "Y": "Y"}
    crossings = []
    for p, c in (("A", "A1"), ("A1", "A2"), ("B", "B1"), ("C", "C1")):
        lo, hi = sorted((pos[p], pos[c]))
        for k in range(lo + 1, hi):
            if comp[order[k]] != comp[p]:
                crossings.append("%s->%s crosses %s" % (p, c, order[k]))
    ok("A2 no wire crosses an unrelated block", not crossings, crossings)
    ok("A3 each chain is contiguous", all(
        abs(pos[a] - pos[b]) == 1 for a, b in (("A", "A1"), ("A1", "A2"), ("B", "B1"), ("C", "C1"))), order)
    ok("A4 a parent sits directly above its child",
       pos["A1"] == pos["A"] + 1 and pos["A2"] == pos["A1"] + 1, order)
    ok("A5 the unrelated tasks sit after the chains",
       pos["X"] > pos["C1"] and pos["Y"] > pos["X"], order)

    branch = page.evaluate("""() => {
      const T = window.__KG_TEST__, G = T.GEO_MINI;
      const mk = (id, t) => ({id: id, oid: id, title: t, status: 'todo', assignee: 'p'});
      const nodes = [mk('P','P'), mk('Q','Q'), mk('R','R'), mk('S','S')];
      const edges = [{parent:'P', child:'Q'}, {parent:'P', child:'R'}, {parent:'Q', child:'S'}];
      const m = T.buildModel({nodes: nodes, edges: edges, back_edges: []}, true, G, {cols: 1});
      return Array.from(m.placed.entries())
        .map(e => ({id: e[0], y: e[1].y, x: e[1].x}))
        .sort((a, b) => a.y - b.y || a.x - b.x).map(o => o.id);
    }""")
    bpos = {i: n for n, i in enumerate(branch)}
    ok("A6 a branching parent stays adjacent to its first child",
       bpos["Q"] == bpos["P"] + 1, branch)

    # ── B. the live card: rubber band + group drag ──
    cand = None
    for p in panels(page):
        if len(p["blocks"]) >= 2:
            cand = p
            break
    ok("B0 a card with 2+ task blocks exists", cand is not None,
       [(p["prof"], len(p["blocks"])) for p in panels(page)][:6])
    if cand is None:
        sys.exit(1)

    prof = cand["prof"]
    b0id = cand["blocks"][0]["id"]
    b1id = cand["blocks"][1]["id"]

    # ── B1: rubber band over the first block ──
    b0 = find_block(page, prof, b0id)
    ok("B1a the first block is on screen", b0 is not None, b0id)
    if b0 is None:
        sys.exit(1)
    # start on EMPTY canvas: the row gap just under the block
    gap_y = b0["y"] + b0["h"] + 3
    page.mouse.move(b0["x"] + 6, gap_y)
    page.mouse.down()
    page.mouse.move(b0["x"] + 16, b0["y"] + 8, steps=8)
    band = page.evaluate("!!document.querySelector('.kg-marquee')")
    page.mouse.up()
    page.wait_for_timeout(150)
    ok("B1b the rubber band is drawn while dragging", band)
    ids = sel_ids(page)
    ok("B1c the band selects the block it covers", b0id in ids, ids)
    page.screenshot(path=SHOTS + "/v23_marquee.png")

    # a click on empty canvas clears the selection
    b0 = find_block(page, prof, b0id)
    page.mouse.click(b0["x"] + 6, b0["y"] + b0["h"] + 3)
    page.wait_for_timeout(200)
    ok("B2 a click on empty canvas clears the selection", sel_count(page) == 0, sel_ids(page))

    # ── C. two blocks selected -> dragged together ──
    b0 = find_block(page, prof, b0id)
    page.mouse.click(b0["x"] + 10, b0["y"] + 8)
    page.wait_for_timeout(500)   # outside the 420ms double-tap window
    ok("C1 a click selects one block", sel_count(page) == 1, sel_ids(page))
    b1 = find_block(page, prof, b1id)
    page.keyboard.down("Shift")
    page.mouse.click(b1["x"] + 10, b1["y"] + 8)
    page.keyboard.up("Shift")
    page.wait_for_timeout(500)
    ok("C2 shift-click adds a second block", sel_count(page) == 2, sel_ids(page))

    p0 = find_block(page, prof, b0id)
    p1 = find_block(page, prof, b1id)
    dx, dy = 90, 60
    page.mouse.move(p0["x"] + 10, p0["y"] + 8)
    page.mouse.down()
    page.mouse.move(p0["x"] + 10 + dx, p0["y"] + 8 + dy, steps=12)
    page.mouse.up()
    page.wait_for_timeout(400)

    q0 = find_block(page, prof, b0id)
    q1 = find_block(page, prof, b1id)
    d0 = (round(q0["x"] - p0["x"], 1), round(q0["y"] - p0["y"], 1))
    d1 = (round(q1["x"] - p1["x"], 1), round(q1["y"] - p1["y"], 1))
    ok("C3 the grabbed block moved", abs(d0[0]) > 20 or abs(d0[1]) > 20, d0)
    ok("C4 the OTHER selected block moved too (group drag)",
       abs(d1[0]) > 20 or abs(d1[1]) > 20, d1)
    ok("C5 both moved by the SAME delta (rigid group)",
       abs(d0[0] - d1[0]) <= 2 and abs(d0[1] - d1[1]) <= 2, (d0, d1))
    page.screenshot(path=SHOTS + "/v23_group_drag.png")

    # ── D. the drop persists (both blocks, one store write) ──
    # the store keys are "<board>:<task id>", the DOM title carries the bare id
    stored = stored_ids(page, prof)
    ok("D1 both blocks are persisted",
       any(k.endswith(b0id) for k in stored) and any(k.endswith(b1id) for k in stored), stored)

    # ── E. 自动排列 on the card puts them back on the lattice ──
    arr = page.evaluate("""(prof) => {
      const panel = document.querySelector('.kg-panel[data-prof=' + JSON.stringify(prof) + ']');
      if (!panel) return false;
      const b = Array.from(panel.querySelectorAll('button'))
        .find(x => (x.innerText || '').trim() === '自动排列');
      if (!b) return false;
      b.click();
      return true;
    }""", prof)
    page.wait_for_timeout(800)
    ok("E1 the card has a 自动排列 button", arr)
    stored2 = stored_ids(page, prof)
    ok("E2 自动排列 cleared the manual positions",
       not any(k.endswith(b0id) for k in stored2) and not any(k.endswith(b1id) for k in stored2), stored2)

    ok("Z1 no page errors", not errors, errors[:4])
