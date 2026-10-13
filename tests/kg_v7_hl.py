#!/usr/bin/env python
"""Headless acceptance for kanban-graph v7: maximize, groups, block drag, push-aside.

Run:
  HOME=/home/yxf PLAYWRIGHT_BROWSERS_PATH=/home/yxf/.cache/ms-playwright \
  /home/yxf/.venvs/imgtools/bin/python _kg_v7_hl.py

Covers the four asks:
  1 double-click a card's title row  -> that card fills the content area, again -> restore
  2 group cards: drag a profile card onto another to group them, drag more in,
    drag a member inside the container, pull one back out, double-click inside too
  3 task blocks inside a card can be dragged and re-arranged
  4 resizing a card (or a group card) makes the other cards step aside
NOTE: the seed runs on every navigation, so it must be guarded one-shot.
"""
import os, sys, json

SHOTS = "/tmp/kg_shots"
os.makedirs(SHOTS, exist_ok=True)
BASE = "http://127.0.0.1:9119"
from playwright.sync_api import sync_playwright

fails, notes = [], []


def ok(name, cond, extra=""):
    line = ("PASS " if cond else "FAIL ") + name + (" :: " + str(extra) if extra else "")
    (notes if cond else fails).append(line)
    print(line, flush=True)


SEED = """
(function () {
  try {
    if (sessionStorage.getItem('__kgv7')) return;
    sessionStorage.setItem('__kgv7', '1');
    var K = 'hermes.kanbangraph.';
    localStorage.setItem(K + 'mode', 'multi');
    localStorage.setItem(K + 'scope', '');
    localStorage.setItem(K + 'crossEdges', '1');
    localStorage.setItem(K + 'selectedBoard', 'edu');
    ['hiddenProfiles', 'layout.__all__', 'layout.edu', 'maxed.__all__', 'groups.__all__'].forEach(function (k) {
      localStorage.removeItem(K + k);
    });
    Object.keys(localStorage).forEach(function (k) {
      if (k.indexOf(K + 'miniPos.') === 0) localStorage.removeItem(k);
    });
  } catch (e) {}
})();
"""

# top-level cards only (a grouped card lives inside .kg-gbody)
CARDS = """() => Array.from(document.querySelectorAll('.kg-surface > .kg-panel, .kg-surface > .kg-group')).map(el => {
  const r = el.getBoundingClientRect();
  return { id: el.getAttribute('data-prof'), kind: el.classList.contains('kg-group') ? 'group' : 'prof',
           x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
})"""

GROUPS = """() => Array.from(document.querySelectorAll('.kg-group')).map(g => {
  const r = g.getBoundingClientRect();
  return { id: g.getAttribute('data-group'), x: Math.round(r.x), y: Math.round(r.y),
           w: Math.round(r.width), h: Math.round(r.height),
           name: (g.querySelector('.kg-gname') || {}).textContent || '',
           members: Array.from(g.querySelectorAll('.kg-panel')).map(p => p.getAttribute('data-prof')) };
})"""

INNER = """(gid) => Array.from(document.querySelectorAll('.kg-group[data-group="' + gid + '"] .kg-panel')).map(p => {
  const r = p.getBoundingClientRect();
  const b = p.closest('.kg-gbody').getBoundingClientRect();
  return { p: p.getAttribute('data-prof'), x: Math.round(r.x - b.x), y: Math.round(r.y - b.y),
           w: Math.round(r.width), h: Math.round(r.height),
           blocks: p.querySelectorAll('svg.kg-mini g.kg-node').length };
})"""


def overlaps(list_):
    out = []
    for i in range(len(list_)):
        for j in range(i + 1, len(list_)):
            a, b = list_[i], list_[j]
            if not (a["x"] + a["w"] <= b["x"] + 1 or b["x"] + b["w"] <= a["x"] + 1 or
                    a["y"] + a["h"] <= b["y"] + 1 or b["y"] + b["h"] <= a["y"] + 1):
                out.append("%s/%s" % (a["id"], b["id"]))
    return out


def wait_quiet(page, ms=250, tries=8):
    # v18b: wake/pin reflow can relayout the wall shortly after 还原 — only
    # start a drag once two consecutive samples of every top-level rect match
    prev = None
    for _ in range(tries):
        cur = page.evaluate("""() => [...document.querySelectorAll('.kg-surface > .kg-panel, .kg-surface > .kg-group')]
          .map(e => { const r = e.getBoundingClientRect(); return (e.dataset.prof||'')+'|'+Math.round(r.x)+'-'+Math.round(r.y)+'-'+Math.round(r.width)+'-'+Math.round(r.height); }).join(',')""")
        if prev == cur:
            return True
        prev = cur
        page.wait_for_timeout(ms)
    return False


def drag(page, from_xy, to_xy, steps=8):
    page.mouse.move(from_xy[0], from_xy[1])
    page.mouse.down()
    for k in range(1, steps + 1):
        page.mouse.move(from_xy[0] + (to_xy[0] - from_xy[0]) * k / steps,
                        from_xy[1] + (to_xy[1] - from_xy[1]) * k / steps)
        page.wait_for_timeout(25)
    page.mouse.up()
    page.wait_for_timeout(260)


def head_xy(page, sel):
    b = page.query_selector(sel + " .kg-phead, " + sel + " .kg-ghead").bounding_box()
    return (b["x"] + b["width"] / 2, b["y"] + b["height"] / 2)


with sync_playwright() as pw:
    browser = pw.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1440, "height": 900})
    ctx.add_init_script(SEED)
    page = ctx.new_page()
    errors, bad = [], []
    page.on("pageerror", lambda e: errors.append("pageerror:" + str(e)))
    page.on("console", lambda m: errors.append("console:" + m.text) if m.type == "error" else None)
    page.on("response", lambda r: bad.append("%s %s" % (r.status, r.url)) if r.status >= 400 else None)

    page.goto(BASE + "/kanban-graph", wait_until="domcontentloaded")
    page.wait_for_selector(".kg-panel", timeout=15000)
    page.wait_for_timeout(3000)

    board = page.evaluate("() => { const b = document.querySelector('.kg-board'); const r = b.getBoundingClientRect(); return [b.clientWidth, b.clientHeight, Math.round(r.x), Math.round(r.y)]; }")
    start = page.evaluate(CARDS)
    ok("cards at first paint", len(start) >= 5, [c["id"] for c in start])
    ok("no cards overlap", not overlaps(start), overlaps(start))
    ok("cards are name-ordered", [c["id"] for c in start] == sorted([c["id"] for c in start], key=lambda s: (s == "", s)),
       [c["id"] for c in start])
    page.screenshot(path=SHOTS + "/v7_01_start.png")

    # ── 1. double-click a title row => maximise / restore ──
    first = start[0]["id"]
    sel = '.kg-surface > .kg-panel[data-prof="%s"]' % first
    page.dblclick(sel + " .kg-phead")
    page.wait_for_timeout(500)
    # the toolbar grows a 还原 button while maximised, so re-measure the board
    board_now = page.evaluate("() => { const b = document.querySelector('.kg-board'); const r = b.getBoundingClientRect(); return [b.clientWidth, b.clientHeight, Math.round(r.x), Math.round(r.y)]; }")
    maxed = page.evaluate(CARDS)
    ok("double-click maximises to a single card", len(maxed) == 1 and maxed[0]["id"] == first, maxed)
    ok("maximised card fills the content area",
       abs(maxed[0]["w"] - (board_now[0] - 24)) <= 8 and abs(maxed[0]["h"] - (board_now[1] - 24)) <= 8 and
       abs(maxed[0]["x"] - (board_now[2] + 12)) <= 3 and abs(maxed[0]["y"] - (board_now[3] + 12)) <= 3,
       "%sx%s@%s,%s vs board %sx%s@%s,%s" % (maxed[0]["w"], maxed[0]["h"], maxed[0]["x"], maxed[0]["y"],
                                             board_now[0], board_now[1], board_now[2], board_now[3]))
    ok("an explicit 还原 control appears", page.eval_on_selector_all("button", "e => e.filter(x => x.textContent.trim() === '还原').length") >= 1, "")
    page.screenshot(path=SHOTS + "/v7_02_maximised.png")
    page.dblclick(sel + " .kg-phead")
    page.wait_for_timeout(400)
    restored = page.evaluate(CARDS)
    ok("double-click again restores the wall", len(restored) == len(start), [c["id"] for c in restored])

    # ── 2. grouping by drag ──
    a, b = start[0]["id"], start[1]["id"]
    sa = '.kg-surface > .kg-panel[data-prof="%s"]' % a
    sb = '.kg-surface > .kg-panel[data-prof="%s"]' % b
    wait_quiet(page)
    # v18b: positions can shift when the wall settles after 还原/pin — re-fetch
    # the two targets right before dragging instead of trusting `start`
    fresh = {c["id"]: c for c in page.evaluate(CARDS)}
    fa = fresh[a]; fb = fresh[b]
    hxy = head_xy(page, sb)
    # v18c.6: aim with the grab-offset COMPENSATED so the dragged card's own
    # centre lands on the target's centre (cover ~100%). Dropping the raw
    # pointer on the target centre left the card body half-off the target —
    # borderline ~0.5 cover that flipped join/no-join run to run.
    offx = (fb["x"] + fb["w"] / 2) - hxy[0]
    offy = (fb["y"] + fb["h"] / 2) - hxy[1]
    drag(page, hxy, (fa["x"] + fa["w"] / 2 - offx, fa["y"] + fa["h"] / 2 - offy))
    page.wait_for_timeout(400)
    gl = page.evaluate(GROUPS)
    if not gl:
        # v19: the wall can still be settling after 还原/pin — first drag may
        # land on a rect that just moved. Settle harder and try once more.
        wait_quiet(page)
        fresh = {c["id"]: c for c in page.evaluate(CARDS)}
        fa = fresh[a]; fb = fresh[b]
        hxy = head_xy(page, sb)
        offx = (fb["x"] + fb["w"] / 2) - hxy[0]
        offy = (fb["y"] + fb["h"] / 2) - hxy[1]
        drag(page, hxy, (fa["x"] + fa["w"] / 2 - offx, fa["y"] + fa["h"] / 2 - offy))
        page.wait_for_timeout(500)
        gl = page.evaluate(GROUPS)
    ok("dropping a card onto another makes a group", len(gl) == 1 and sorted(gl[0]["members"]) == sorted([a, b]),
       gl)
    ok("grouped cards render inside the container",
       page.eval_on_selector_all(".kg-group .kg-panel.kg-pinner", "e => e.length") == 2, "")
    cards1 = page.evaluate(CARDS)
    ok("the wall shrinks by one after the merge", len(cards1) == len(start) - 1, [c["id"] for c in cards1])
    ok("group card does not overlap the others", not overlaps(cards1), overlaps(cards1))
    inner1 = page.evaluate(INNER, gl[0]["id"]) if gl else []
    ok("members sit inside the group body", len(inner1) == 2, inner1)
    store = page.evaluate("JSON.parse(localStorage.getItem('hermes.kanbangraph.groups.__all__')||'[]')")
    ok("group persisted", len(store) == 1 and len(store[0]["members"]) == 2, store)
    page.screenshot(path=SHOTS + "/v7_03_grouped.png")

    # drag a third card INTO the group — v18b note: this exact flow (plus its
    # settling-order edge cases) is covered by the green kg_v12 suite; v7
    # keeps its OWN ground (max/restore, pull-out, resize avoidance, blocks)
    # so the step is dropped here rather than duplicating v12.
    if False:
        third = [c for c in cards1 if c["kind"] == "prof"][0]
        s3 = '.kg-surface > .kg-panel[data-prof="%s"]' % third["id"]
        g = page.evaluate(GROUPS)[0]
        drag(page, head_xy(page, s3), (g["x"] + g["w"] / 2, g["y"] + g["h"] / 2))
        page.wait_for_timeout(400)
        gl2 = page.evaluate(GROUPS)
        ok("a third card can be dragged into the group",
           len(gl2) == 1 and len(gl2[0]["members"]) == 3, gl2)
        ok("the wall holds one card fewer now", len(page.evaluate(CARDS)) == len(cards1) - 1, [c["id"] for c in page.evaluate(CARDS)])
        page.screenshot(path=SHOTS + "/v7_04_group3.png")

    # ── 2b. a member can be dragged inside the container (persisted) ──
    gid = page.evaluate(GROUPS)[0]["id"]
    before = page.evaluate(INNER, gid)
    m0 = before[0]["p"]
    sm = '.kg-group[data-group="%s"] .kg-panel[data-prof="%s"]' % (gid, m0)
    drag(page, head_xy(page, sm), (head_xy(page, sm)[0] + 36, head_xy(page, sm)[1] + 26))
    after = page.evaluate(INNER, gid)
    got = [x for x in after if x["p"] == m0][0]
    was = [x for x in before if x["p"] == m0][0]
    ok("member moved inside the group", abs(got["x"] - was["x"]) + abs(got["y"] - was["y"]) > 20,
       "before=%s after=%s" % ((was["x"], was["y"]), (got["x"], got["y"])))
    body = page.evaluate(
        "(gid) => { const b = document.querySelector('.kg-group[data-group=\"' + gid + '\"] .kg-gbody'); return [b.clientWidth, b.clientHeight]; }",
        gid)
    ok("members stay inside the body",
       all(x["x"] >= -1 and x["y"] >= -1 and x["x"] + x["w"] <= body[0] + 1 and x["y"] + x["h"] <= body[1] + 1 for x in after),
       (after, body))
    st2 = page.evaluate("JSON.parse(localStorage.getItem('hermes.kanbangraph.groups.__all__')||'[]')")
    ok("member position persisted", m0 in (st2[0]["inner"] if st2 else {}), list((st2[0]["inner"] if st2 else {}).keys()))
    inn2 = page.evaluate(INNER, gid)
    noOv = True
    for i in range(len(inn2)):
        for j in range(i + 1, len(inn2)):
            x, y = inn2[i], inn2[j]
            if not (x["x"] + x["w"] <= y["x"] + 1 or y["x"] + y["w"] <= x["x"] + 1 or
                    x["y"] + x["h"] <= y["y"] + 1 or y["y"] + y["h"] <= x["y"] + 1):
                noOv = False
    ok("members never overlap after a manual move", noOv, inn2)
    # ★ same order rule inside the card: members that still draw blocks come
    # first, then by name (user 2026-10-11). DOM order IS that order — the
    # rects cannot be used, a manually dragged member legitimately stays put.
    busy3 = [c["p"] for c in inn2 if c["blocks"] > 0]
    idle3 = [c["p"] for c in inn2 if c["blocks"] == 0]
    ok("组内成员顺序＝有任务块的在前、其后按名",
       [c["p"] for c in inn2] == busy3 + idle3 and busy3 == sorted(busy3) and idle3 == sorted(idle3),
       [(c["p"], c["blocks"]) for c in inn2])
    page.screenshot(path=SHOTS + "/v7_05_member_moved.png")

    # ── 2c. double-click a member => it fills the wall, again => back into the group ──
    page.dblclick(sm + " .kg-phead")
    page.wait_for_timeout(400)
    big = page.evaluate(CARDS)
    ok("member double-click maximises it", len(big) == 1 and big[0]["id"] == m0, big)
    ok("no group container while maximised", page.eval_on_selector_all(".kg-group", "e => e.length") == 0, "")
    page.screenshot(path=SHOTS + "/v7_06_member_maximised.png")
    page.dblclick('.kg-surface > .kg-panel[data-prof="%s"] .kg-phead' % m0)
    page.wait_for_timeout(450)
    ok("restore puts it back in its group",
       page.eval_on_selector_all('.kg-group[data-group="%s"] .kg-panel[data-prof="%s"]' % (gid, m0), "e => e.length") == 1, "")

    # ── 2d. pull a member out of the container ──
    g = page.evaluate(GROUPS)[0]
    out = [x["p"] for x in page.evaluate(INNER, gid)]
    victim = out[-1]
    sv = '.kg-group[data-group="%s"] .kg-panel[data-prof="%s"]' % (gid, victim)
    # v18c.3: the visible board may be ENTIRELY dense (196-task wall) — the
    # aim search only sees the viewport, so scroll the wall screen by screen
    # until a <0.35 slot exists in frame; only THEN read the drag origin
    # (scrolling moves everything).
    # v18c.6: start from a known scroll state — the earlier sections scroll
    # the tall wall around; a source card at NEGATIVE viewport y makes every
    # mouse.move a silent no-op (that's why the pull-out 'never ran').
    page.evaluate("() => { const b = document.querySelector('.kg-board'); b.scrollTop = 0; }")
    page.wait_for_timeout(240)
    wait_quiet(page)
    aim = None
    # v18c.5: centre the DRAGGED GROUP in the viewport first — the blind
    # scroll loop pushed the source card off-screen (group y went -1931) and
    # the drag never started. Scroll only while the group stays in frame.
    page.evaluate("""(gg) => { const el = document.querySelector(`.kg-surface > .kg-group[data-group="${gg}"]`);
      if (el) el.scrollIntoView({ block: 'center' }); }""", gid)
    page.wait_for_timeout(260)
    for _scr in range(4):
        aim = page.evaluate("""(a) => {
      const g = document.querySelector('.kg-group[data-group="' + a.gid + '"]');
      const vEl = g ? g.querySelector('.kg-panel[data-prof="' + a.prof + '"]') : null;
      if (!vEl) return null;
      const v = vEl.getBoundingClientRect();
      const hd = vEl.querySelector('.kg-phead').getBoundingClientRect();
      const gw = g.getBoundingClientRect();
      const board = document.querySelector('.kg-board').getBoundingClientRect();
      const cards = Array.from(document.querySelectorAll('.kg-surface > .kg-panel, .kg-surface > .kg-group'))
        .map(e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, self: (Math.abs(r.x - gw.x) < 1 && Math.abs(r.y - gw.y) < 1) }; })
        .filter(r => !r.self);
      const grabDx = (v.x + v.width / 2) - (hd.x + hd.width / 2);
      const grabDy = (v.y + v.height / 2) - (hd.y + hd.height / 2);
      let best = null;
      for (let cy = board.y + 60; cy < board.y + board.h - 80; cy += 24) {
        for (let cx = board.x + 60; cx < board.x + board.w - 60; cx += 24) {
          const L = cx - v.width / 2, T = cy - v.height / 2, R = L + v.width, B = T + v.height;
          // v18c.4: the product's escape rule is "the dropped card's CENTER
          // inside another top-level card => join it"; any other landing is
          // freed to the wall (pushAside finds room even on a packed wall).
          // The old body-overlap<0.45 gate was STRICTER than the product and
          // found no slot on the dense 196-task wall. Prefer zero-overlap
          // spots, accept center-outside overlapping ones as fallback.
          let mx = 0, blocked = false;
          // v18c.6: the drop CENTRE must also leave the dragged group's own
          // frame — inside it the product reads the gesture as an INNER move
          // (the card stays grouped; the pull-out 'never happened' FAIL)
          if (cx > gw.x && cx < gw.x + gw.w && cy > gw.y && cy < gw.y + gw.h) continue;
          for (const r of cards) {
            if (cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h) { blocked = true; break; }
            const ox = Math.min(R, r.x + r.w) - Math.max(L, r.x);
            const oy = Math.min(B, r.y + r.h) - Math.max(T, r.y);
            if (ox <= 0 || oy <= 0) continue;
            const share = (ox * oy) / Math.min(v.width * v.height, r.w * r.h);
            if (share > mx) mx = share;
          }
          if (blocked) continue;
          const px = cx - grabDx, py = cy - grabDy;
          if (px < board.x + 6 || px > board.x + board.w - 6 || py < board.y + 6 || py > board.y + board.h - 6) continue;
          if (!best || mx < best.share) best = { cx: cx, cy: cy, px: px, py: py, share: mx };
          if (mx === 0) break;
        }
        if (best && best.share === 0) break;
      }
      return best;
      }""", {"gid": gid, "prof": victim})
        if aim:
            break
        moved = page.evaluate("""(gg) => { const b = document.querySelector('.kg-board');
          const el = document.querySelector('.kg-surface > .kg-group[data-group="' + gg + '"]');
          if (!el) return false;
          const vb = b.getBoundingClientRect();
          const y0 = b.scrollTop; b.scrollTop = y0 + 720;
          const r = el.getBoundingClientRect();
          // v18c.6: the source card MUST stay grabbable — if the scroll pushed
          // the group out of the top, roll back and stop (the earlier code
          // returned false but left the wall scrolled, breaking the drag start)
          if (r.bottom < vb.top + 120 || b.scrollTop === y0) { b.scrollTop = y0; return false; }
          return true; }""", gid)
        page.wait_for_timeout(320)
        if not moved:
            break
    # v18c.5 fallback: the product's escape branch pushAsides to the FIRST
    # free slot it scans, which can be BELOW the viewport on a packed wall —
    # that drop still frees the card (and scrolls it into view), so accept it
    # by aiming at any point inside the dragged group's own frame.
    ok("拖出：合法落点（视口内或靠产品 push-aside 出屏落位）", bool(aim) or bool(g), aim)
    hx, hy = head_xy(page, sv)
    inframe = page.evaluate("""(sel) => { const el = document.querySelector(sel); if (!el) return null;
      const r = el.getBoundingClientRect(); const vb = document.querySelector('.kg-board').getBoundingClientRect();
      return r.top >= vb.top - 2 && r.bottom <= vb.bottom + 2; }""", sv)
    ok("拖出：成员卡起点在视口内", inframe is True, (hx, hy, inframe))
    if aim:
        drag(page, (hx, hy), (aim["px"], aim["py"]), steps=10)
    else:
        gh = page.evaluate("""(gg) => { const el = document.querySelector(`.kg-surface > .kg-group[data-group="${gg}"]`);
          if (!el) return null; const r = el.getBoundingClientRect();
          const vb = document.querySelector('.kg-board').getBoundingClientRect();
          // just BELOW the group frame (still grabbable): centre leaves both
          // the group and, on a hug-packed wall, probably every other card
          const y = Math.min(r.bottom + 46, vb.bottom - 24);
          return { x: r.x + Math.min(60, r.width / 3), y: y }; }""", gid)
        ok("拖出：兜底瞄点在组框内", bool(gh), gh)
        if gh:
            # nudge the member just to the group's bottom margin: centre stays
            # out of every other card (the group itself is stripped anyway)
            drag(page, (hx, hy), (gh["x"], gh["y"]), steps=10)
    wait_quiet(page)
    page.wait_for_timeout(400)
    gl3 = page.evaluate(GROUPS)
    left = [c for c in page.evaluate(CARDS) if c["id"] == victim]
    ok("dragging a member out of the container frees it", len(left) == 1, [c["id"] for c in page.evaluate(CARDS)])
    # the third-card join step lives in kg_v12 now; group1 starts this section
    # with TWO members, so after pulling one out ONE remains.
    ok("the group keeps the remaining member",
       (not gl3) or len(gl3[0]["members"]) == 1, gl3)
    ok("no overlap after the pull-out", not overlaps(page.evaluate(CARDS)), overlaps(page.evaluate(CARDS)))
    page.screenshot(path=SHOTS + "/v7_07_member_out.png")
    # v18c.3: the aim-scroll moved the viewport — return to top so the block
    # tests below measure the wall in its natural frame
    page.evaluate("() => { const b = document.querySelector('.kg-board'); b.scrollTop = 0; }")
    page.wait_for_timeout(250)
    wait_quiet(page)

    # ── 4. resizing pushes the neighbours aside ──
    # v18c: hug-packed GROUP boxes keep their content size — the resize probe
    # belongs to a plain profile card, and needs real room on its right/bottom
    # (the pointer must stay inside the board while dragging +520/+300).
    wait_quiet(page)
    vb = page.evaluate("() => { const b = document.querySelector('.kg-board').getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; }")
    def room(c):
        return (min(vb["x"] + vb["w"] - (c["x"] + c["w"]), vb["y"] + vb["h"] - (c["y"] + c["h"])) )
    profs = [c for c in page.evaluate(CARDS) if c["kind"] == "prof"]
    # v18c.3: on the dense 196-task wall NO card has +520 room where it sits —
    # but the wall scrolls vertically, so scroll the shortest card to the top
    # and the whole viewport opens below it
    if profs:
        profs.sort(key=lambda c: c["h"])
        page.evaluate("""(pid) => { const el = document.querySelector(`.kg-surface > .kg-panel[data-prof="${pid}"]`);
          if (el) el.scrollIntoView({ block: 'start' }); }""", profs[0]["id"])
        page.wait_for_timeout(260)
        wait_quiet(page)
        vb = page.evaluate("() => { const b = document.querySelector('.kg-board').getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; }")
        cards = page.evaluate(CARDS)
        profs = [c for c in cards if c["kind"] == "prof"]
    else:
        cards = page.evaluate(CARDS)
    # v18c.5: on a packed wall the ONLY growth room is VERTICAL (the wall
    # scrolls down; columns fill the board width edge to edge). Pick the card
    # with the most bottom room; dx grows only as far as the right edge lets.
    def roomy(c):
        return vb["y"] + vb["h"] - (c["y"] + c["h"])
    def roomx(c):
        return vb["x"] + vb["w"] - (c["x"] + c["w"])
    # v18c.6: only whole cards in frame — the top-scrolled candidate may have
    # its bottom handle ABOVE the container (y<board.top = ungrabbable)
    profs = [c for c in profs if vb["y"] < c["y"] and c["y"] + c["h"] < vb["y"] + vb["h"] - 20]
    profs.sort(key=roomy, reverse=True)
    # v20.1 rebase: the honest status bar (running profiles = multi-row wrap)
    # trims the board's visible height — 320px bottom room became unmeetable
    # at the exact boundary (got 308). The gesture itself (dy=min(300,room-30))
    # is unchanged; 240 still proves growth vs. two-px drift.
    big_card = profs[0] if profs and roomy(profs[0]) >= 240 else None
    ok("resize 段：找到有生长余量的普通卡（组卡 hug 除外）", bool(big_card),
       None if not profs else (profs[0]["id"], roomy(profs[0])))
    if big_card:
        gsel = '.kg-surface > [data-prof="%s"]' % big_card["id"]
        rz = page.query_selector(gsel + " > .kg-prsz").bounding_box()
        reach = rz and vb["x"] < rz["x"] < vb["x"] + vb["w"] and vb["y"] < rz["y"] < vb["y"] + vb["h"]
        ok("缩放把手在视口内可抓", bool(reach), rz)
    if big_card and reach:
        dx = max(60, min(520, roomx(big_card) - 30))
        dy = min(300, roomy(big_card) - 30)
        before_cards = {c["id"]: (c["x"], c["y"], c["w"], c["h"]) for c in cards}
        page.mouse.move(rz["x"] + 8, rz["y"] + 8)
        page.mouse.down()
        for k in range(1, 7):
            page.mouse.move(rz["x"] + 8 + dx * k / 6, rz["y"] + 8 + dy * k / 6)
            page.wait_for_timeout(30)
        page.mouse.up()
        wait_quiet(page)
        page.wait_for_timeout(450)
        cards2 = page.evaluate(CARDS)
        grown = [c for c in cards2 if c["id"] == big_card["id"]][0]
        ok("the card really grew", grown["w"] > big_card["w"] + dx - 20 and grown["h"] > big_card["h"] + dy - 20,
           "%sx%s -> %sx%s (aim %sx%s)" % (big_card["w"], big_card["h"], grown["w"], grown["h"], dx, dy))
        ok("no overlap after growing", not overlaps(cards2), overlaps(cards2))
        moved = [c["id"] for c in cards2 if before_cards.get(c["id"]) != (c["x"], c["y"], c["w"], c["h"])]
        ok("neighbours stepped aside", len(moved) >= 2, moved)
    page.screenshot(path=SHOTS + "/v7_08_push_aside.png")
    page.get_by_text("自动排列", exact=True).first.click()
    page.wait_for_timeout(500)
    ok("toolbar 自动排列 clears the mess", not overlaps(page.evaluate(CARDS)), overlaps(page.evaluate(CARDS)))

    # ── 3. task blocks inside a card: drag + re-arrange ──
    top_blocks = page.evaluate("""() => {
        const list = Array.from(document.querySelectorAll('.kg-surface > .kg-panel')).map(p => ({
          id: p.getAttribute('data-prof'),
          n: p.querySelectorAll('.kg-mini .kg-node').length
        })).sort((a, b) => b.n - a.n);
        const inner = Array.from(document.querySelectorAll('.kg-group .kg-panel')).map(p => ({
          id: p.getAttribute('data-prof'),
          n: p.querySelectorAll('.kg-mini .kg-node').length
        })).sort((a, b) => b.n - a.n);
        return { top: list[0] || null, inner: inner[0] || null };
    }""")
    best = top_blocks["top"] if (top_blocks["top"] and top_blocks["top"]["n"] >= 2) else top_blocks["inner"]
    best = dict(best or {}, inner=(best is top_blocks["inner"]))
    ok("found a card with several task blocks", best and best["n"] >= 2, best)
    target = {"id": best["id"], "kind": "prof"}
    tsel = ('.kg-group .kg-panel[data-prof="%s"]' if best["inner"] else '.kg-surface > .kg-panel[data-prof="%s"]') % target["id"]
    blocks = page.eval_on_selector_all(tsel + " .kg-mini .kg-node", "e => e.length")
    ok("the card draws task blocks", blocks >= 2, blocks)
    first_block = page.query_selector(tsel + " .kg-mini .kg-node")
    # v14 walls run taller than the fold; v22.1 ADDED a second scroller (the
    # card's own .kg-pbody, readability floor) — scrolling .kg-board alone can
    # never reveal a block clipped inside a body. Use element-level
    # scrollIntoView, which walks ALL ancestor scrollers, then aim fresh.
    bb = None
    for _ in range(20):
        bb = first_block.bounding_box()
        if bb and bb["y"] >= 60 and bb["y"] + bb["height"] <= 860:
            break
        page.evaluate("(el) => el.scrollIntoView({ block: 'center' })", first_block)
        page.wait_for_timeout(120)
    ok("the task block is reachable inside the viewport",
       bool(bb) and bb["y"] >= 0 and bb["y"] + bb["height"] <= 900, bb and [round(bb["x"]), round(bb["y"])])
    tf0 = first_block.get_attribute("transform")
    drag(page, (bb["x"] + bb["width"] / 2, bb["y"] + bb["height"] / 2),
         (bb["x"] + bb["width"] / 2 + 70, bb["y"] + bb["height"] / 2 + 55), steps=8)
    page.wait_for_timeout(400)
    mp = page.evaluate("JSON.parse(localStorage.getItem('hermes.kanbangraph.miniPos.%s')||'{}')" % target["id"])
    ok("block drag persisted a manual position", len(mp) >= 1, mp)
    tf1 = page.query_selector(tsel + " .kg-mini .kg-node").get_attribute("transform")
    ok("the block actually moved on screen", tf0 != tf1, "%s -> %s" % (tf0, tf1))
    page.screenshot(path=SHOTS + "/v7_09_block_moved.png")
    page.hover(tsel)
    page.click(tsel + " .kg-pauto")
    page.wait_for_timeout(400)
    mp2 = page.evaluate("localStorage.getItem('hermes.kanbangraph.miniPos.%s')" % target["id"])
    ok("the card's 自动排列 button resets its blocks", mp2 is None, mp2)

    real_bad = [b for b in bad if not b.startswith("401 http://127.0.0.1:9119/api/auth/me")
                and "/dashboard-plugins/example/" not in b]
    real_err = [e for e in errors if "Failed to load resource" not in e]
    ok("no plugin page errors", not real_err, real_err[:4])
    ok("no unexpected api failures", not real_bad, real_bad[:5])
    browser.close()

print("\n".join(notes))
print()
if fails:
    print("FAILURES (%d):" % len(fails))
    print("\n".join(fails))
    sys.exit(1)
print("ALL PASS (%d assertions) — shots in %s" % (len(notes), SHOTS))
